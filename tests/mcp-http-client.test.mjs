import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenMcpText, McpHttpClient } from '../lib/mcp-http-client.mjs';

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('MCP Streamable HTTP client initializes, reuses a session, lists and calls tools', async () => {
  const calls = [];
  const mockFetch = async (_url, options) => {
    calls.push({ method: options.method, headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }, { headers: { 'mcp-session-id': 'session-1' } });
    }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') {
      const payload = { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] } };
      return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (request.method === 'tools/call') {
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'snapshot result' }] } });
    }
    throw new Error(`Unexpected request ${request.method}`);
  };

  const client = new McpHttpClient('https://mcp.example/mcp', { fetch: mockFetch });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((item) => item.name), ['browser_snapshot']);
  const result = await client.callTool('browser_snapshot', { depth: 5 });
  assert.equal(flattenMcpText(result), 'snapshot result');
  assert.equal(calls.filter((call) => call.body?.method === 'initialize').length, 1);
  assert.equal(calls.find((call) => call.body?.method === 'tools/list').headers['mcp-session-id'], 'session-1');
  await client.close();
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('concurrent operations are serialized behind a single initialization', async () => {
  let initializes = 0;
  const mockFetch = async (_url, options) => {
    const request = options.body ? JSON.parse(options.body) : null;
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method === 'initialize') {
      initializes += 1;
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
    if (request.method === 'tools/call') return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [] } });
    throw new Error('Unexpected request');
  };
  const client = new McpHttpClient('https://mcp.example/mcp', { fetch: mockFetch });
  await Promise.all([client.listTools(), client.callTool('browser_snapshot', {})]);
  assert.equal(initializes, 1);
});

test('flattenMcpText preserves readable text content', () => {
  assert.equal(flattenMcpText({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
  assert.equal(flattenMcpText('plain'), 'plain');
});
