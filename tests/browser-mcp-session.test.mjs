import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeAccessibilitySnapshot } from '../lib/analyzer.mjs';
import { BrowserMcpSession } from '../public/js/browser-mcp-session.js';

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('page-scoped Browser MCP session analyzes and executes through one transport session', async () => {
  const requests = [];
  const toolCalls = [];
  let deleteCount = 0;
  const snapshot = '- textbox "Topic" [ref=e1]\n- combobox "Level" [ref=e2]\n- button "Find sessions" [ref=e3]';
  const tools = [
    'browser_navigate',
    'browser_snapshot',
    'browser_type',
    'browser_select_option',
    'browser_click',
    'browser_close',
  ].map((name) => ({ name, inputSchema: { type: 'object' } }));

  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ pathname: url.pathname, method: options.method || 'GET' });
    assert.equal(options.credentials, 'same-origin');
    if (url.pathname === '/api/browser-session') {
      return json({ ok: true, expiresInSeconds: 1200 }, { status: 201 });
    }
    if (url.pathname === '/api/config') {
      return json({ ok: true, browserMcpConfigured: true, browserMcpEndpoint: '/mcp' });
    }
    if (url.pathname === '/api/mcp/analyze-snapshot') {
      const body = JSON.parse(options.body);
      return json({ ok: true, analysis: analyzeAccessibilitySnapshot(body) });
    }
    if (url.pathname !== '/mcp') return json({ ok: false, error: 'Unexpected path' }, { status: 404 });
    if (options.method === 'DELETE') {
      assert.equal(options.headers['mcp-session-id'], 'page-session-1');
      deleteCount += 1;
      return new Response(null, { status: 204 });
    }

    const message = JSON.parse(options.body);
    if (message.method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'page-playwright', version: '1.0.0' },
        },
      }, { headers: { 'mcp-session-id': 'page-session-1' } });
    }
    assert.equal(options.headers['mcp-session-id'], 'page-session-1');
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') {
      return json({ jsonrpc: '2.0', id: message.id, result: { tools } });
    }
    if (message.method === 'tools/call') {
      toolCalls.push({ name: message.params.name, args: message.params.arguments });
      const text = message.params.name === 'browser_snapshot' ? snapshot : `${message.params.name} completed`;
      return json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
    }
    return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unexpected method' } });
  };

  const session = new BrowserMcpSession({ fetch: fetchMock, baseUrl: 'https://meta.example/studio' });
  const status = await session.status('workspace_page_1234567');
  assert.equal(status.configured, true);
  assert.equal(status.transport, 'page');
  assert.equal(status.tools.length, tools.length);

  const analysis = await session.analyze({
    url: 'https://shop.example',
    goal: 'Find sessions.',
    workspaceId: 'workspace_page_1234567',
  });
  assert.equal(analysis.mcp.transport, 'page');
  const capability = analysis.capabilities.find((item) => item.name === 'find_sessions');
  assert.ok(capability);

  const result = await session.execute({
    executor: capability.executor,
    input: { topic: 'WebMCP', level: 'Advanced' },
    workspaceId: 'workspace_page_1234567',
  });
  assert.equal(result.ok, true);
  assert.equal(result.trace.length, 4);
  await session.reset('workspace_page_1234567');
  await session.reset('workspace_page_1234567');

  assert.equal(requests.filter((request) => request.pathname === '/api/browser-session').length, 1);
  assert.equal(requests.filter((request) => request.pathname === '/api/config').length, 1);
  assert.equal(requests.filter((request) => request.pathname === '/api/mcp/analyze-snapshot').length, 1);
  assert.equal(requests.some((request) => request.pathname === '/api/mcp/analyze'), false);
  assert.equal(requests.some((request) => request.pathname === '/api/mcp/execute'), false);
  assert.equal(requests.some((request) => request.pathname === '/api/mcp/reset'), false);
  assert.deepEqual(toolCalls, [
    { name: 'browser_navigate', args: { url: 'https://shop.example/' } },
    { name: 'browser_snapshot', args: {} },
    { name: 'browser_type', args: { element: 'Topic', ref: 'e1', text: 'WebMCP' } },
    { name: 'browser_select_option', args: { element: 'Level', ref: 'e2', values: ['Advanced'] } },
    { name: 'browser_click', args: { element: 'Find sessions', ref: 'e3' } },
    { name: 'browser_snapshot', args: {} },
    { name: 'browser_close', args: {} },
  ]);
  assert.equal(deleteCount, 1);
});

test('page-scoped Browser MCP session returns an inline visual for the current target', async () => {
  const calls = [];
  const screenshot = Buffer.from('visual target').toString('base64');
  const tools = [
    { name: 'browser_navigate', inputSchema: { type: 'object' } },
    { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    { name: 'browser_take_screenshot', inputSchema: { type: 'object' } },
  ];

  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/browser-session') return json({ ok: true, expiresInSeconds: 1200 }, { status: 201 });
    if (url.pathname === '/api/config') {
      return json({ ok: true, browserMcpConfigured: true, browserMcpEndpoint: '/mcp' });
    }
    const message = JSON.parse(options.body);
    if (message.method === 'initialize') {
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
      }, { headers: { 'mcp-session-id': 'visual-session' } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') {
      return json({ jsonrpc: '2.0', id: message.id, result: { tools } });
    }
    if (message.method === 'tools/call') {
      calls.push({ name: message.params.name, args: message.params.arguments });
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'image', data: screenshot, mimeType: 'image/jpeg' }] },
      });
    }
    return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unexpected method' } });
  };

  const session = new BrowserMcpSession({ fetch: fetchMock, baseUrl: 'https://meta.example/' });
  const view = await session.captureView('workspace_visual_123456');

  assert.deepEqual(view, {
    imageUrl: `data:image/jpeg;base64,${screenshot}`,
    mimeType: 'image/jpeg',
  });
  assert.deepEqual(calls, [{ name: 'browser_take_screenshot', args: {} }]);
});

test('page-scoped Browser MCP session blocks local targets before navigation', async () => {
  const toolCalls = [];
  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/browser-session') return json({ ok: true, expiresInSeconds: 1200 }, { status: 201 });
    if (url.pathname === '/api/config') return json({ ok: true, browserMcpConfigured: true, browserMcpEndpoint: '/mcp' });
    const message = JSON.parse(options.body);
    if (message.method === 'initialize') {
      return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} } }, {
        headers: { 'mcp-session-id': 'blocked-session' },
      });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') {
      return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'browser_navigate' }, { name: 'browser_snapshot' }] } });
    }
    if (message.method === 'tools/call') toolCalls.push(message.params.name);
    return json({ jsonrpc: '2.0', id: message.id, result: {} });
  };
  const session = new BrowserMcpSession({ fetch: fetchMock, baseUrl: 'https://meta.example/' });
  for (const url of [
    'http://127.0.0.1/admin',
    'http://[::ffff:127.0.0.1]/admin',
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
    'http://169.254.169.254.nip.io/latest/meta-data/',
  ]) {
    await assert.rejects(
      session.analyze({ url, goal: 'Inspect.', workspaceId: 'workspace_page_7654321' }),
      /Private and local targets are blocked/,
    );
  }
  assert.deepEqual(toolCalls, []);
});

test('failed Browser MCP analysis closes its transport before a direct retry', async () => {
  let initialized = 0;
  const toolCalls = [];
  const deletedSessions = [];
  const tools = ['browser_navigate', 'browser_snapshot', 'browser_close']
    .map((name) => ({ name, inputSchema: { type: 'object' } }));

  const fetchMock = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/browser-session') return json({ ok: true, expiresInSeconds: 1200 }, { status: 201 });
    if (url.pathname === '/api/config') return json({ ok: true, browserMcpConfigured: true, browserMcpEndpoint: '/mcp' });
    if (url.pathname === '/api/mcp/analyze-snapshot') {
      return json({ ok: true, analysis: analyzeAccessibilitySnapshot(JSON.parse(options.body)) });
    }
    if (options.method === 'DELETE') {
      deletedSessions.push(options.headers['mcp-session-id']);
      return new Response(null, { status: 204 });
    }

    const message = JSON.parse(options.body);
    if (message.method === 'initialize') {
      initialized += 1;
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
      }, { headers: { 'mcp-session-id': `retry-session-${initialized}` } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (message.method === 'tools/list') {
      return json({ jsonrpc: '2.0', id: message.id, result: { tools } });
    }
    if (message.method === 'tools/call') {
      const name = message.params.name;
      toolCalls.push({ session: options.headers['mcp-session-id'], name });
      if (name === 'browser_navigate' && initialized === 1) {
        return json({
          jsonrpc: '2.0',
          id: message.id,
          result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] },
        });
      }
      const text = name === 'browser_snapshot'
        ? '- textbox "Query" [ref=e1]\n- button "Search" [ref=e2]'
        : `${name} complete`;
      return json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
    }
    return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unexpected method' } });
  };

  const session = new BrowserMcpSession({ fetch: fetchMock, baseUrl: 'https://meta.example/' });
  await assert.rejects(
    session.analyze({ url: 'https://shop.example', goal: 'Search.', workspaceId: 'workspace_retry_123456' }),
    /Hosted browser capacity is unavailable.*agent_snapshot/i,
  );

  const analysis = await session.analyze({
    url: 'https://shop.example',
    goal: 'Search.',
    workspaceId: 'workspace_retry_123456',
  });

  assert.equal(analysis.capabilities.some((capability) => capability.name === 'search'), true);
  assert.equal(initialized, 2);
  assert.deepEqual(deletedSessions, ['retry-session-1']);
  assert.deepEqual(toolCalls, [
    { session: 'retry-session-1', name: 'browser_navigate' },
    { session: 'retry-session-1', name: 'browser_close' },
    { session: 'retry-session-2', name: 'browser_navigate' },
    { session: 'retry-session-2', name: 'browser_snapshot' },
  ]);
});
