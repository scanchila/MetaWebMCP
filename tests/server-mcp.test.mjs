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

test('generated browser recipes satisfy the Playwright MCP tool contracts', { timeout: 20_000 }, async (t) => {
  const toolCalls = [];
  const contracts = {
    browser_navigate: { required: ['url'], allowed: ['url'] },
    browser_snapshot: { required: [], allowed: [] },
    browser_type: { required: ['element', 'ref', 'text'], allowed: ['element', 'ref', 'text', 'submit', 'slowly'] },
    browser_select_option: { required: ['element', 'ref', 'values'], allowed: ['element', 'ref', 'values'] },
    browser_click: { required: ['element', 'ref'], allowed: ['element', 'ref', 'doubleClick'] },
  };

  function validateCall(name, args) {
    const contract = contracts[name];
    assert.ok(contract, `Unexpected Playwright MCP tool call: ${name}`);
    assert.deepEqual(Object.keys(args).filter((key) => !contract.allowed.includes(key)), []);
    for (const key of contract.required) assert.ok(key in args, `${name} requires ${key}`);
  }

  const mockMcp = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (message.method === 'initialize') {
      json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'contract-playwright', version: '1.0.0' },
          },
        },
        { 'mcp-session-id': 'contract-session' },
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
          tools: Object.entries(contracts).map(([name, contract]) => ({
            name,
            inputSchema: {
              type: 'object',
              required: contract.required,
              properties: Object.fromEntries(contract.allowed.map((key) => [key, {}])),
              additionalProperties: false,
            },
          })),
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      try {
        const { name, arguments: args } = message.params;
        validateCall(name, args);
        toolCalls.push({ name, args });
        const text = name === 'browser_snapshot'
          ? '- textbox "Topic" [ref=e1]\n- combobox "Level" [ref=e2]\n- button "Find sessions" [ref=e3]'
          : `${name} completed`;
        json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
      } catch (error) {
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: error.message } });
      }
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
      ALLOW_PRIVATE_TARGETS: '1',
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
  const workspaceId = 'workspace_contract_123456';
  const analyzed = await fetch(`${base}/api/mcp/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, url: 'https://shop.example/', goal: 'Find sessions.' }),
  });
  assert.equal(analyzed.status, 200);
  const analyzedPayload = await analyzed.json();
  const capability = analyzedPayload.analysis.capabilities.find((item) => item.name === 'find_sessions');
  assert.ok(capability);

  const snapshotAnalyzed = await fetch(`${base}/api/mcp/analyze-snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      snapshot: '- textbox "Query" [ref=s1]\n- button "Search" [ref=s2]',
      url: 'https://shop.example/',
      goal: 'Search the catalog.',
    }),
  });
  assert.equal(snapshotAnalyzed.status, 200);
  const snapshotPayload = await snapshotAnalyzed.json();
  assert.equal(snapshotPayload.analysis.capabilities[0].name, 'search');

  const executed = await fetch(`${base}/api/mcp/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      executor: capability.executor,
      input: { topic: 'WebMCP', level: 'Advanced' },
    }),
  });
  assert.equal(executed.status, 200);
  const executedPayload = await executed.json();
  assert.equal(executedPayload.ok, true);
  assert.deepEqual(toolCalls, [
    { name: 'browser_navigate', args: { url: 'https://shop.example/' } },
    { name: 'browser_snapshot', args: {} },
    { name: 'browser_type', args: { element: 'Topic', ref: 'e1', text: 'WebMCP' } },
    { name: 'browser_select_option', args: { element: 'Level', ref: 'e2', values: ['Advanced'] } },
    { name: 'browser_click', args: { element: 'Find sessions', ref: 'e3' } },
    { name: 'browser_snapshot', args: {} },
  ]);
});
