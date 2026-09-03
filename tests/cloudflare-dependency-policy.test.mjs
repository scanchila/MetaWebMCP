import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

test('Cloudflare runtime dependencies stay on audited compatibility pins', async () => {
  const packageJson = JSON.parse(await readFile(new URL('deploy/cloudflare/package.json', ROOT), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('deploy/cloudflare/package-lock.json', ROOT), 'utf8'));
  const compatibilityPatch = await readFile(new URL('deploy/cloudflare/patch-dependencies.mjs', ROOT), 'utf8');
  const workflow = await readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8');

  assert.equal(packageJson.dependencies['@cloudflare/playwright'], '1.3.6');
  assert.equal(packageJson.overrides.agents, '0.22.0');
  assert.equal(packageJson.scripts.audit, 'npm audit --audit-level=low');
  assert.equal(
    packageLock.packages['node_modules/@cloudflare/playwright-mcp/node_modules/agents'].version,
    '0.22.0',
  );
  assert.equal(packageLock.packages['node_modules/@modelcontextprotocol/sdk'].version, '1.30.0');
  assert.match(compatibilityPatch, /layoutMetrics\.cssVisualViewport \?\? layoutMetrics\.visualViewport/);
  assert.match(compatibilityPatch, /if \(!visualViewport\) \{[\s\S]*Page\.captureScreenshot/);
  assert.match(workflow, /- run: npm run audit\n        working-directory: deploy\/cloudflare/);
});
