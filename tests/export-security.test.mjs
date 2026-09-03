import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function startApp(t, settings = {}) {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      ...settings,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MetaWebMCP exited early with ${child.exitCode}.`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return base;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('MetaWebMCP did not become healthy.');
}

async function capabilityCookie(base) {
  const response = await fetch(`${base}/api/browser-session`, {
    method: 'POST',
    headers: { origin: base },
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return cookie;
}

const exportPayload = {
  projectName: 'bounded-export',
  tools: [{
    name: 'inspect_page',
    description: 'Inspect the current page state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    risk: 'read',
    executor: { type: 'dom-read', selector: 'body' },
  }],
};

async function createExport(base, cookie, payload = exportPayload) {
  return fetch(`${base}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
}

test('exports require a page capability and downloads are owner-bound and single-use', async (t) => {
  const base = await startApp(t);
  const unauthorized = await createExport(base, '');
  assert.equal(unauthorized.status, 401);

  const ownerCookie = await capabilityCookie(base);
  const otherCookie = await capabilityCookie(base);
  const created = await createExport(base, ownerCookie);
  assert.equal(created.status, 201);
  const { downloadUrl } = await created.json();

  assert.equal((await fetch(`${base}${downloadUrl}`)).status, 401);
  assert.equal((await fetch(`${base}${downloadUrl}`, { headers: { cookie: otherCookie } })).status, 404);

  const download = await fetch(`${base}${downloadUrl}`, { headers: { cookie: ownerCookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await download.arrayBuffer()).slice(0, 2)], [0x50, 0x4b]);
  assert.equal((await fetch(`${base}${downloadUrl}`, { headers: { cookie: ownerCookie } })).status, 404);
});

test('pending export count remains bounded and consuming an archive releases capacity', async (t) => {
  const base = await startApp(t, {
    MAX_PENDING_EXPORTS: '2',
    MAX_PENDING_EXPORT_BYTES: '1000000',
    EXPORT_RATE_LIMIT_PER_MINUTE: '20',
  });
  const cookie = await capabilityCookie(base);
  const first = await createExport(base, cookie);
  const second = await createExport(base, cookie);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const full = await createExport(base, cookie);
  assert.equal(full.status, 429);
  assert.match((await full.json()).error, /storage is at capacity/i);

  const firstUrl = (await first.json()).downloadUrl;
  assert.equal((await fetch(`${base}${firstUrl}`, { headers: { cookie } })).status, 200);
  assert.equal((await createExport(base, cookie)).status, 201);
});

test('export generation has independent archive-size and request-rate limits', async (t) => {
  await t.test('archive size', async (sizeTest) => {
    const base = await startApp(sizeTest, { MAX_EXPORT_ARCHIVE_BYTES: '100' });
    const cookie = await capabilityCookie(base);
    const oversized = await createExport(base, cookie);
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /generated export exceeds 100 bytes/i);
  });

  await t.test('request rate', async (rateTest) => {
    const base = await startApp(rateTest, {
      MAX_PENDING_EXPORTS: '10',
      EXPORT_RATE_LIMIT_PER_MINUTE: '2',
    });
    const cookie = await capabilityCookie(base);
    assert.equal((await createExport(base, cookie)).status, 201);
    assert.equal((await createExport(base, cookie)).status, 201);
    const limited = await createExport(base, cookie);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /request limit reached/i);
  });
});
