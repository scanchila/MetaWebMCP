import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 8_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MetaWebMCP exited early with ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('MetaWebMCP did not become healthy.');
}

test('Browser MCP transport sessions are isolated by MetaWebMCP workspace', { timeout: 20_000 }, async (t) => {
  let nextSession = 1;
  const initializedSessions = [];
  const requestSessions = [];
  const deletedSessions = [];

  const mockMcp = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      deletedSessions.push(req.headers['mcp-session-id']);
      res.writeHead(204).end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const suppliedSession = req.headers['mcp-session-id'];
    requestSessions.push({ method: message.method, session: suppliedSession || null });

    if (message.method === 'initialize') {
      const session = `mock-session-${nextSession++}`;
      initializedSessions.push(session);
      json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'mock-playwright', version: '1.0.0' },
          },
        },
        { 'mcp-session-id': session },
      );
      return;
    }

    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    if (message.method === 'tools/list') {
      json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            { name: 'browser_navigate', inputSchema: { type: 'object' } },
            { name: 'browser_snapshot', inputSchema: { type: 'object' } },
            { name: 'browser_close', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;
    }

    if (message.method === 'tools/call') {
      json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'closed' }] } });
      return;
    }

    json(res, 400, { error: { message: `Unexpected method ${message.method}` } });
  });

  const mcpPort = await listen(mockMcp);
  const appProbe = http.createServer();
  const appPort = await listen(appProbe);
  await new Promise((resolve) => appProbe.close(resolve));

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(appPort),
      BROWSER_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`,
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => mockMcp.close(resolve));
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitForHealth(`${base}/health`, child);
  const alpha = 'workspace_alpha_123456';
  const beta = 'workspace_beta_1234567';

  for (const workspace of [alpha, beta, alpha]) {
    const response = await fetch(`${base}/api/mcp/status?workspace_id=${workspace}`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.configured, true);
    assert.deepEqual(payload.tools, ['browser_close', 'browser_navigate', 'browser_snapshot']);
  }

  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2']);
  const listSessions = requestSessions.filter((item) => item.method === 'tools/list').map((item) => item.session);
  assert.deepEqual(listSessions, ['mock-session-1', 'mock-session-2', 'mock-session-1']);

  const reset = await fetch(`${base}/api/mcp/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: alpha }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(deletedSessions, ['mock-session-1']);

  const restarted = await fetch(`${base}/api/mcp/status?workspace_id=${alpha}`);
  assert.equal(restarted.status, 200);
  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2', 'mock-session-3']);
});
