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

async function startMcpApp(t, mockMcp, settings = {}) {
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
      BROWSER_MCP_EGRESS_ISOLATED: '1',
      ...settings,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    mockMcp.closeAllConnections?.();
    await new Promise((resolve) => mockMcp.close(resolve));
  });
  const base = `http://127.0.0.1:${appPort}`;
  await waitForHealth(`${base}/health`, child);
  return base;
}

async function readMcpMessage(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function pageCapabilityCookie(base) {
  const response = await fetch(`${base}/api/browser-session`, {
    method: 'POST',
    headers: { origin: base },
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).expiresInSeconds, 1200);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /metawebmcp_browser_capability=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return setCookie.split(';', 1)[0];
}

test('Browser MCP transport sessions are isolated by MetaWebMCP workspace', { timeout: 20_000 }, async (t) => {
  let nextSession = 1;
  const initializedSessions = [];
  const requestSessions = [];
  const deletedSessions = [];
  let holdNextToolList = false;
  let markHeldToolList;
  let releaseHeldToolList;
  const heldToolListArrived = new Promise((resolve) => { markHeldToolList = resolve; });
  const heldToolListReleased = new Promise((resolve) => { releaseHeldToolList = resolve; });

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
      if (holdNextToolList) {
        holdNextToolList = false;
        markHeldToolList();
        await heldToolListReleased;
      }
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
      BROWSER_MCP_EGRESS_ISOLATED: '1',
      MAX_MCP_CLIENTS: '3',
      MAX_MCP_CLIENTS_PER_CAPABILITY: '2',
      MAX_CONCURRENT_MCP_REQUESTS: '1',
    },
    stdio: 'ignore',
  });

  t.after(async () => {
    releaseHeldToolList();
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    await new Promise((resolve) => mockMcp.close(resolve));
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitForHealth(`${base}/health`, child);
  const alpha = 'workspace_alpha_123456';
  const beta = 'workspace_beta_1234567';
  const unauthorized = await fetch(`${base}/api/mcp/status?workspace_id=${alpha}`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(initializedSessions, []);
  const crossOrigin = await fetch(`${base}/api/browser-session`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.status, 403);
  const cookie = await pageCapabilityCookie(base);
  const reused = await fetch(`${base}/api/browser-session`, {
    method: 'POST',
    headers: { origin: base, cookie },
  });
  assert.equal(reused.status, 201);
  assert.equal(reused.headers.get('set-cookie'), null);
  assert.ok((await reused.json()).expiresInSeconds > 0);
  const otherCookie = await pageCapabilityCookie(base);

  for (const workspace of [alpha, beta, alpha]) {
    const response = await fetch(`${base}/api/mcp/status?workspace_id=${workspace}`, {
      headers: { cookie },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.configured, true);
    assert.deepEqual(payload.tools, ['browser_close', 'browser_navigate', 'browser_snapshot']);
  }

  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2']);
  const listSessions = requestSessions.filter((item) => item.method === 'tools/list').map((item) => item.session);
  assert.deepEqual(listSessions, ['mock-session-1', 'mock-session-2', 'mock-session-1']);

  const perCapabilityLimited = await fetch(`${base}/api/mcp/status?workspace_id=workspace_gamma_123456`, {
    headers: { cookie },
  });
  assert.equal(perCapabilityLimited.status, 429);
  assert.match((await perCapabilityLimited.json()).error, /workspace limit reached/i);
  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2']);

  const isolatedCapability = await fetch(`${base}/api/mcp/status?workspace_id=${alpha}`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(isolatedCapability.status, 200);
  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2', 'mock-session-3']);

  const thirdCookie = await pageCapabilityCookie(base);
  const globallyLimited = await fetch(`${base}/api/mcp/status?workspace_id=${alpha}`, {
    headers: { cookie: thirdCookie },
  });
  assert.equal(globallyLimited.status, 429);
  assert.match((await globallyLimited.json()).error, /session capacity reached/i);
  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2', 'mock-session-3']);

  holdNextToolList = true;
  const heldStatus = fetch(`${base}/api/mcp/status?workspace_id=${alpha}`, { headers: { cookie } });
  await heldToolListArrived;
  const concurrentStatus = await fetch(`${base}/api/mcp/status?workspace_id=${beta}`, { headers: { cookie } });
  assert.equal(concurrentStatus.status, 429);
  assert.match((await concurrentStatus.json()).error, /request capacity reached/i);
  releaseHeldToolList();
  assert.equal((await heldStatus).status, 200);

  const reset = await fetch(`${base}/api/mcp/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workspaceId: alpha }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(deletedSessions, ['mock-session-1']);

  const restarted = await fetch(`${base}/api/mcp/status?workspace_id=${alpha}`, {
    headers: { cookie },
  });
  assert.equal(restarted.status, 200);
  assert.deepEqual(initializedSessions, ['mock-session-1', 'mock-session-2', 'mock-session-3', 'mock-session-4']);

  const callsBeforeRejectedRecipe = requestSessions.filter((item) => item.method === 'tools/call').length;
  const rejectedRecipe = await fetch(`${base}/api/mcp/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      workspaceId: alpha,
      executor: {
        type: 'mcp-recipe',
        steps: [{ tool: 'browser_navigate', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } }],
      },
      input: {},
    }),
  });
  assert.equal(rejectedRecipe.status, 400);
  assert.match((await rejectedRecipe.json()).error, /browser_navigate is not allowed/);
  assert.equal(
    requestSessions.filter((item) => item.method === 'tools/call').length,
    callsBeforeRejectedRecipe,
    'rejected recipes must not reach the Browser MCP transport',
  );
});

test('Browser MCP request deadlines abort stalled clients and release capacity', { timeout: 10_000 }, async (t) => {
  let initializeAttempts = 0;
  let markClosed;
  const stalledResponseClosed = new Promise((resolve) => { markClosed = resolve; });
  const mockMcp = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const message = await readMcpMessage(req);
    if (message.method === 'initialize') {
      initializeAttempts += 1;
      if (initializeAttempts === 1) {
        res.once('close', markClosed);
        return;
      }
      return json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {} },
      }, { 'mcp-session-id': 'recovered-session' });
    }
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') {
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    }
    return json(res, 400, { error: { message: `Unexpected method ${message.method}` } });
  });
  const base = await startMcpApp(t, mockMcp, {
    MAX_MCP_CLIENTS: '1',
    MAX_MCP_CLIENTS_PER_CAPABILITY: '1',
    MAX_CONCURRENT_MCP_REQUESTS: '1',
    MCP_REQUEST_TIMEOUT_MS: '100',
  });
  const cookie = await pageCapabilityCookie(base);

  const started = Date.now();
  const timedOut = await fetch(`${base}/api/mcp/status?workspace_id=workspace_stalled_123456`, {
    headers: { cookie },
  });
  assert.equal(timedOut.status, 504);
  assert.match((await timedOut.json()).error, /timed out after 100 ms/i);
  assert.ok(Date.now() - started < 2_000);
  await stalledResponseClosed;

  const recovered = await fetch(`${base}/api/mcp/status?workspace_id=workspace_recovered_1234`, {
    headers: { cookie },
  });
  assert.equal(recovered.status, 200);
  assert.equal(initializeAttempts, 2);
});

test('failed first-use MCP initialization releases its session reservation', { timeout: 10_000 }, async (t) => {
  let initializeAttempts = 0;
  const mockMcp = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const message = await readMcpMessage(req);
    if (message.method === 'initialize') {
      initializeAttempts += 1;
      if (initializeAttempts === 1) {
        return json(res, 500, { error: { message: 'temporary initialization failure' } });
      }
      return json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {} },
      }, { 'mcp-session-id': 'healthy-session' });
    }
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') {
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    }
    return json(res, 400, { error: { message: `Unexpected method ${message.method}` } });
  });
  const base = await startMcpApp(t, mockMcp, {
    MAX_MCP_CLIENTS: '1',
    MAX_MCP_CLIENTS_PER_CAPABILITY: '1',
  });
  const cookie = await pageCapabilityCookie(base);

  const failed = await fetch(`${base}/api/mcp/status?workspace_id=workspace_failed_1234567`, {
    headers: { cookie },
  });
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /temporary initialization failure/i);

  const recovered = await fetch(`${base}/api/mcp/status?workspace_id=workspace_healthy_123456`, {
    headers: { cookie },
  });
  assert.equal(recovered.status, 200);
  assert.equal(initializeAttempts, 2);
});

test('retiring MCP clients remain reserved until teardown completes', { timeout: 10_000 }, async (t) => {
  let nextSession = 1;
  const initializedSessions = [];
  let markBrowserClose;
  let releaseBrowserClose;
  const browserCloseArrived = new Promise((resolve) => { markBrowserClose = resolve; });
  const browserCloseReleased = new Promise((resolve) => { releaseBrowserClose = resolve; });
  t.after(() => releaseBrowserClose());

  const mockMcp = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const message = await readMcpMessage(req);
    if (message.method === 'initialize') {
      const session = `retirement-session-${nextSession++}`;
      initializedSessions.push(session);
      return json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {} },
      }, { 'mcp-session-id': session });
    }
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    if (message.method === 'tools/list') {
      return json(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'browser_close', inputSchema: { type: 'object' } }] },
      });
    }
    if (message.method === 'tools/call' && message.params.name === 'browser_close') {
      markBrowserClose();
      await browserCloseReleased;
      return json(res, 200, { jsonrpc: '2.0', id: message.id, result: { content: [] } });
    }
    return json(res, 400, { error: { message: `Unexpected method ${message.method}` } });
  });
  const base = await startMcpApp(t, mockMcp, {
    MAX_MCP_CLIENTS: '1',
    MAX_MCP_CLIENTS_PER_CAPABILITY: '1',
    MAX_CONCURRENT_MCP_REQUESTS: '2',
    MCP_REQUEST_TIMEOUT_MS: '2000',
  });
  const cookie = await pageCapabilityCookie(base);
  const firstWorkspace = 'workspace_retiring_123456';
  const secondWorkspace = 'workspace_waiting_1234567';
  assert.equal((await fetch(`${base}/api/mcp/status?workspace_id=${firstWorkspace}`, { headers: { cookie } })).status, 200);

  const reset = fetch(`${base}/api/mcp/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workspaceId: firstWorkspace }),
  });
  await browserCloseArrived;
  const whileClosing = await fetch(`${base}/api/mcp/status?workspace_id=${secondWorkspace}`, {
    headers: { cookie },
  });
  assert.equal(whileClosing.status, 429);
  assert.match((await whileClosing.json()).error, /session capacity reached/i);
  assert.deepEqual(initializedSessions, ['retirement-session-1']);

  releaseBrowserClose();
  assert.equal((await reset).status, 200);
  const afterClose = await fetch(`${base}/api/mcp/status?workspace_id=${secondWorkspace}`, {
    headers: { cookie },
  });
  assert.equal(afterClose.status, 200);
  assert.deepEqual(initializedSessions, ['retirement-session-1', 'retirement-session-2']);
});

test('generated browser recipes satisfy the Playwright MCP tool contracts', { timeout: 20_000 }, async (t) => {
  const toolCalls = [];
  let markOversizedNavigationClosed;
  let oversizedNavigationCanceled = false;
  const oversizedNavigationClosed = new Promise((resolve) => { markOversizedNavigationClosed = resolve; });
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
        if (name === 'browser_navigate' && args.url.endsWith('/oversized-navigation')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write(`{"jsonrpc":"2.0","id":${message.id},"result":{"content":[{"type":"text","text":"`);
          const chunk = 'x'.repeat(64 * 1024);
          let chunksSent = 0;
          let timer;
          const writeChunk = () => {
            if (res.destroyed) return;
            chunksSent += 1;
            if (chunksSent > 40) {
              res.end('"}]}}');
              return;
            }
            res.write(chunk);
            timer = setTimeout(writeChunk, 2);
          };
          res.once('close', () => {
            clearTimeout(timer);
            oversizedNavigationCanceled = !res.writableEnded;
            markOversizedNavigationClosed();
          });
          timer = setTimeout(writeChunk, 2);
          return;
        }
        const text = name === 'browser_snapshot'
          ? '- textbox "Topic" [ref=e1]\n- combobox "Level" [ref=e2]\n- button "Find sessions" [ref=e3]'
          : name === 'browser_navigate' && args.url.endsWith('/redirect')
            ? '### Page\n- Page URL: http://127.0.0.1:8931/mcp\n- HTTP status: 403 Forbidden'
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
      BROWSER_MCP_EGRESS_ISOLATED: '1',
      ANALYSIS_RATE_LIMIT_PER_MINUTE: '4',
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
  const cookie = await pageCapabilityCookie(base);
  const workspaceId = 'workspace_contract_123456';
  const analyzed = await fetch(`${base}/api/mcp/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workspaceId, url: 'https://8.8.8.8/', goal: 'Find sessions.' }),
  });
  assert.equal(analyzed.status, 200);
  const analyzedPayload = await analyzed.json();
  const capability = analyzedPayload.analysis.capabilities.find((item) => item.name === 'find_sessions');
  assert.ok(capability);

  const snapshotAnalyzed = await fetch(`${base}/api/mcp/analyze-snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      snapshot: '- textbox "Query" [ref=s1]\n- button "Search" [ref=s2]',
      url: 'https://8.8.8.8/',
      goal: 'Search the catalog.',
    }),
  });
  assert.equal(snapshotAnalyzed.status, 200);
  const snapshotPayload = await snapshotAnalyzed.json();
  assert.equal(snapshotPayload.analysis.capabilities[0].name, 'search');

  const redirected = await fetch(`${base}/api/mcp/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ workspaceId, url: 'https://8.8.8.8/redirect', goal: 'Inspect.' }),
  });
  assert.equal(redirected.status, 400);
  assert.match((await redirected.json()).error, /Private and reserved IP targets are blocked/);

  const snapshotsBeforeOversizedNavigation = toolCalls.filter((call) => call.name === 'browser_snapshot').length;
  const oversizedNavigation = await fetch(`${base}/api/mcp/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      workspaceId,
      url: 'https://8.8.8.8/oversized-navigation',
      goal: 'Inspect.',
    }),
  });
  assert.equal(oversizedNavigation.status, 413);
  assert.match((await oversizedNavigation.json()).error, /MCP response exceeds 2000000 bytes/i);
  await oversizedNavigationClosed;
  assert.equal(oversizedNavigationCanceled, true);
  assert.equal(
    toolCalls.filter((call) => call.name === 'browser_snapshot').length,
    snapshotsBeforeOversizedNavigation,
  );

  const rateLimited = await fetch(`${base}/api/mcp/analyze-snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      snapshot: '- button "Inspect" [ref=r1]',
      url: 'https://8.8.8.8/',
    }),
  });
  assert.equal(rateLimited.status, 429);
  assert.match((await rateLimited.json()).error, /analysis request limit reached/i);

  const executed = await fetch(`${base}/api/mcp/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
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
    { name: 'browser_navigate', args: { url: 'https://8.8.8.8/' } },
    { name: 'browser_snapshot', args: {} },
    { name: 'browser_navigate', args: { url: 'https://8.8.8.8/redirect' } },
    { name: 'browser_navigate', args: { url: 'https://8.8.8.8/oversized-navigation' } },
    { name: 'browser_type', args: { element: 'Topic', ref: 'e1', text: 'WebMCP' } },
    { name: 'browser_select_option', args: { element: 'Level', ref: 'e2', values: ['Advanced'] } },
    { name: 'browser_click', args: { element: 'Find sessions', ref: 'e3' } },
    { name: 'browser_snapshot', args: {} },
  ]);
});
