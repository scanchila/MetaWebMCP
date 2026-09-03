import test from 'node:test';
import assert from 'node:assert/strict';

import { flattenMcpText, McpHttpClient, McpSseClient } from '../lib/mcp-http-client.mjs';

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
      if (request.params.name === 'browser_fail') {
        return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'browser unavailable' }] } });
      }
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'snapshot result' }] } });
    }
    throw new Error(`Unexpected request ${request.method}`);
  };

  const client = new McpHttpClient('https://mcp.example/mcp', { fetch: mockFetch });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((item) => item.name), ['browser_snapshot']);
  const result = await client.callTool('browser_snapshot', { depth: 5 });
  assert.equal(flattenMcpText(result), 'snapshot result');
  await assert.rejects(client.callTool('browser_fail', {}), /MCP tool browser_fail failed: browser unavailable/);
  assert.equal(calls.filter((call) => call.body?.method === 'initialize').length, 1);
  assert.equal(calls.find((call) => call.body?.method === 'tools/list').headers['mcp-session-id'], 'session-1');
  assert.equal(client.sendToolCallKeepalive('browser_close', {}), true);
  await Promise.resolve();
  assert.equal(calls.at(-1).body.params.name, 'browser_close');
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

test('MCP Streamable HTTP client cancels a tool response at its byte limit', async () => {
  let canceled = false;
  const encoder = new TextEncoder();
  const mockFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } });
    }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/call') {
      return new Response(new ReadableStream({
        pull(controller) {
          controller.enqueue(encoder.encode('12345678'));
        },
        cancel() {
          canceled = true;
        },
      }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected request ${request.method}`);
  };

  const client = new McpHttpClient('https://mcp.example/mcp', { fetch: mockFetch });
  await assert.rejects(
    client.callTool('browser_snapshot', {}, { maxResponseBytes: 10 }),
    /MCP response exceeds 10 bytes/,
  );
  assert.equal(canceled, true);
});

test('MCP SSE client keeps one event stream across initialization and tool calls', async () => {
  const calls = [];
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
      value.enqueue(new TextEncoder().encode('event: endpoint\ndata: /sse/message?sessionId=page-1\n\n'));
    },
  });
  const emit = (payload) => controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
  const mockFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if ((options.method || 'GET') === 'GET') {
      options.signal?.addEventListener('abort', () => controller.close(), { once: true });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'sse-mock', version: '1' } } });
    } else if (request.method === 'tools/list') {
      emit({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] } });
    } else if (request.method === 'tools/call') {
      emit({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'SSE snapshot' }] } });
    }
    return new Response(null, { status: 202 });
  };

  const client = new McpSseClient('https://mcp.example/sse', { fetch: mockFetch });
  const tools = await client.listTools();
  const result = await client.callTool('browser_snapshot', {});
  assert.deepEqual(tools.map((tool) => tool.name), ['browser_snapshot']);
  assert.equal(flattenMcpText(result), 'SSE snapshot');
  assert.equal(calls.filter((call) => call.method === 'GET').length, 1);
  assert.equal(calls.filter((call) => call.body?.method === 'initialize').length, 1);
  assert.equal(calls.filter((call) => call.body?.method === 'notifications/initialized').length, 1);
  assert.equal(calls.filter((call) => call.url.includes('sessionId=page-1')).length, 4);
  assert.equal(client.sendToolCallKeepalive('browser_close', {}), true);
  await Promise.resolve();
  assert.equal(calls.at(-1).body.params.name, 'browser_close');
  await client.close();
});

test('flattenMcpText preserves readable text content', () => {
  assert.equal(flattenMcpText({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), 'one\ntwo');
  assert.equal(flattenMcpText('plain'), 'plain');
});
