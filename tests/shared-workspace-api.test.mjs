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
  return response.headers.get('set-cookie')?.split(';', 1)[0] || '';
}

function workspaceRecord() {
  return {
    version: 1,
    savedAt: '2026-09-04T12:00:00.000Z',
    draft: {
      sourceKind: 'demo',
      targetUrl: 'http://metawebmcp.test/demo/',
      targetHtml: '<main>sensitive source</main>',
      targetSnapshot: 'sensitive snapshot',
      goal: 'Find matching conference sessions.',
      reviewDrafts: [],
    },
    workspace: {
      mode: 'owner',
      sourceKind: 'demo',
      analysis: {
        source: { kind: 'demo', url: 'http://metawebmcp.test/demo/', title: 'Relay Sessions' },
        capabilities: [],
      },
      contracts: [{
        name: 'find_sessions',
        description: 'Find matching conference sessions.',
        risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        executor: { type: 'dom-read', selector: '#session-grid' },
      }],
      selectedCapabilityIds: [],
      activated: true,
      verificationComplete: false,
      evals: [],
      trace: [],
      selectedToolName: 'find_sessions',
      latestTargetState: { itinerary: [] },
      hadTemporaryExport: false,
    },
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('shared workspace API hands a sanitized revision from an author browser to a separate reader', async (t) => {
  const base = await startApp(t);
  assert.equal((await fetch(`${base}/api/shared-workspaces`, { method: 'POST' })).status, 401);

  const cookie = await capabilityCookie(base);
  const createdResponse = await fetch(`${base}/api/shared-workspaces`, {
    method: 'POST',
    headers: { cookie, origin: base },
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(createdResponse.headers.get('cache-control'), 'no-store');
  const created = await createdResponse.json();
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.match(created.writeToken, /^[a-zA-Z0-9_-]{43}$/);
  assert.match(created.readToken, /^[a-zA-Z0-9_-]{43}$/);
  assert.notEqual(created.writeToken, created.readToken);

  const missing = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    headers: bearer(created.readToken),
  });
  assert.equal(missing.status, 200);
  assert.equal((await missing.json()).workspace, null);

  const readerWrite = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    method: 'PUT',
    headers: { ...bearer(created.readToken), 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: workspaceRecord() }),
  });
  assert.equal(readerWrite.status, 404);

  const updated = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    method: 'PUT',
    headers: { ...bearer(created.writeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: workspaceRecord() }),
  });
  assert.equal(updated.status, 200);
  const updatedPayload = await updated.json();
  assert.equal(updatedPayload.revision, 1);
  assert.equal(updatedPayload.expiresAt, created.expiresAt);

  const read = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    headers: bearer(created.readToken),
  });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  const visible = await read.json();
  assert.equal(visible.revision, 1);
  assert.equal(visible.workspace.workspace.contracts[0].name, 'find_sessions');
  assert.equal(visible.workspace.draft.targetHtml, '');
  assert.equal(visible.workspace.draft.targetSnapshot, '');

  const unchanged = await fetch(`${base}/api/shared-workspaces/${created.id}?after=1`, {
    headers: bearer(created.readToken),
  });
  assert.equal(unchanged.status, 204);

  const unauthorized = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    headers: bearer('z'.repeat(43)),
  });
  assert.equal(unauthorized.status, 404);
});

test('shared workspace API rejects non-demo build state', async (t) => {
  const base = await startApp(t);
  const cookie = await capabilityCookie(base);
  const created = await (await fetch(`${base}/api/shared-workspaces`, {
    method: 'POST',
    headers: { cookie, origin: base },
  })).json();
  const workspace = workspaceRecord();
  workspace.draft.sourceKind = 'agent_snapshot';
  workspace.workspace.sourceKind = 'agent_snapshot';
  workspace.workspace.analysis.source.kind = 'agent_snapshot';

  const response = await fetch(`${base}/api/shared-workspaces/${created.id}`, {
    method: 'PUT',
    headers: { ...bearer(created.writeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ workspace }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /controlled demo/i);
});
