import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const rootPath = fileURLToPath(root);

test('Cloudflare deployment declares immutable version metadata and source identity', async () => {
  const config = JSON.parse(await readFile(new URL('../deploy/cloudflare/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
  assert.deepEqual(
    config.ratelimits.find((binding) => binding.name === 'ANALYSIS_RATE_LIMITER')?.simple,
    { limit: 30, period: 60 },
  );
  assert.deepEqual(
    config.durable_objects.bindings.find((binding) => binding.name === 'EXPORT_STORE'),
    { name: 'EXPORT_STORE', class_name: 'ExportStore' },
  );
  assert.deepEqual(config.migrations.at(-1), { tag: 'v2', new_sqlite_classes: ['ExportStore'] });

  const worker = await readFile(new URL('../deploy/cloudflare/worker.mjs', import.meta.url), 'utf8');
  assert.match(worker, /bindings\.CF_VERSION_METADATA\?\.id/);
  assert.match(worker, /bindings\.META_WEBMCP_SOURCE_COMMIT/);
  assert.match(worker, /'cache-control': 'no-store'/);
  assert.match(worker, /bindings\.ANALYSIS_RATE_LIMITER\.limit/);
  assert.match(worker, /bindings\.EXPORT_STORE\.idFromName/);
  assert.match(worker, /request\.headers\.get\('cf-connecting-ip'\)/);
  assert.match(worker, /'x-metawebmcp-source-key'/);
  assert.doesNotMatch(worker, /caches\.default/);
  assert.match(worker, /signal: controller\.signal/);

  const exportStore = await readFile(new URL('../deploy/cloudflare/export-store.mjs', import.meta.url), 'utf8');
  const consumeStart = exportStore.indexOf("if (operation === 'consume')");
  const consumeEnd = exportStore.indexOf("return json({ ok: false, error: 'Not found.'", consumeStart);
  assert.ok(consumeStart >= 0 && consumeEnd > consumeStart);
  assert.doesNotMatch(
    exportStore.slice(consumeStart, consumeEnd),
    /scheduleCleanup\(/,
    'download delivery must not depend on fallible post-claim cleanup scheduling',
  );
});

test('deployment wrapper rejects missing and mismatched source commits before upload', () => {
  const missing = spawnSync(process.execPath, ['deploy/cloudflare/deploy.mjs'], {
    cwd: root,
    env: { ...process.env, META_WEBMCP_SOURCE_COMMIT: '' },
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /exact full commit being deployed/);

  const mismatched = spawnSync(process.execPath, ['deploy/cloudflare/deploy.mjs'], {
    cwd: root,
    env: { ...process.env, META_WEBMCP_SOURCE_COMMIT: '0'.repeat(40) },
    encoding: 'utf8',
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /does not match the checked-out commit/);
});

test('Lighthouse summaries use verified live deployment identity', async (t) => {
  const sourceCommit = 'a'.repeat(40);
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/health');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      runtime: 'cloudflare',
      deploymentVersion: 'worker-version-123',
      sourceCommit,
      deployedAt: '2026-09-03T05:00:00.000Z',
      deploymentTag: 'source-aaaaaaaaaaaa',
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'metawebmcp-provenance-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const rawPath = path.join(temporary, 'raw.json');
  const summaryPath = path.join(temporary, 'summary.json');
  await writeFile(rawPath, JSON.stringify({
    finalUrl: 'https://production.example/',
    fetchTime: '2026-09-03T05:05:00.000Z',
    lighthouseVersion: '13.4.1',
    environment: { hostUserAgent: 'HeadlessChrome/154.0.0.0' },
    configSettings: { formFactor: 'mobile' },
    categories: {
      performance: { score: 1 },
      accessibility: { score: 1 },
      'best-practices': { score: 1 },
      seo: { score: 1 },
      'agentic-browsing': { score: 1 },
    },
    audits: { 'errors-in-console': { details: { items: [] } } },
  }));

  const child = spawn(process.execPath, [
    'scripts/summarize-lighthouse.mjs',
    rawPath,
    summaryPath,
  ], {
    cwd: rootPath,
    env: {
      ...process.env,
      META_WEBMCP_APP_URL: `http://127.0.0.1:${server.address().port}`,
      META_WEBMCP_SOURCE_COMMIT: sourceCommit,
      META_WEBMCP_DEPLOYMENT_VERSION: 'worker-version-123',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, 'exit');
  assert.equal(exitCode, 0, stderr);

  const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
  assert.equal(summary.deploymentVersion, 'worker-version-123');
  assert.equal(summary.sourceCommit, sourceCommit);
  assert.equal(summary.identityVerifiedFromHealth, true);
  assert.match(summary.summarizerSha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.categories.performance, 100);
});
