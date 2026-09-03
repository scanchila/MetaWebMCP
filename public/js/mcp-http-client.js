const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

function parseEventStream(text) {
  const messages = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore comments, keep-alives, and non-JSON events.
    }
  }
  return messages;
}

function oversizedResponseError(maxBytes) {
  const error = new Error(`MCP response exceeds ${maxBytes} bytes.`);
  error.statusCode = 413;
  return error;
}

async function readResponseText(response, maxBytes) {
  if (maxBytes === undefined) return response.text();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('MCP response byte limit must be a positive integer.');
  }

  const declaredLength = response.headers.get('content-length');
  if (/^\d+$/.test(declaredLength || '') && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw oversizedResponseError(maxBytes);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw oversizedResponseError(maxBytes);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw oversizedResponseError(maxBytes);
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function parseResponse(response, { maxBytes } = {}) {
  if (response.status === 202 || response.status === 204) return null;
  const text = await readResponseText(response, maxBytes);
  if (!text.trim()) return null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const messages = parseEventStream(text);
    return messages.at(-1) ?? null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`MCP server returned non-JSON content: ${text.slice(0, 300)}`);
  }
}

export function flattenMcpText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const content = result.content ?? result.result?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.text) return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(result);
}

function checkedToolResult(name, result) {
  if (result?.isError) {
    const detail = flattenMcpText(result) || 'Unknown tool error.';
    throw new Error(`MCP tool ${name} failed: ${detail}`);
  }
  return result;
}

export class McpHttpClient {
  constructor(endpoint, options = {}) {
    const baseUrl = options.baseUrl ?? globalThis.location?.href;
    this.endpoint = new URL(endpoint, baseUrl).href;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clientInfo = options.clientInfo ?? { name: 'metawebmcp-browser-bridge', version: '1.0.0' };
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.negotiatedVersion = null;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
    this._queue = Promise.resolve();
  }

  async _post(payload, { initialization = false, maxResponseBytes } = {}) {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (!initialization && (this.negotiatedVersion || this.protocolVersion)) {
      headers['mcp-protocol-version'] = this.negotiatedVersion || this.protocolVersion;
    }

    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    const body = await parseResponse(response, { maxBytes: maxResponseBytes });
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
      throw new Error(`MCP request failed: ${detail}`);
    }
    return body;
  }

  async _request(method, params = {}, options = {}) {
    const id = this.nextId++;
    const response = await this._post({ jsonrpc: '2.0', id, method, params }, options);
    if (!response) throw new Error(`MCP server returned no response for ${method}.`);
    if (response.error) throw new Error(`MCP ${method} failed: ${response.error.message || JSON.stringify(response.error)}`);
    if (response.id !== undefined && response.id !== id) throw new Error(`MCP response ID mismatch for ${method}.`);
    return response.result;
  }

  async initialize() {
    if (this.initialized) return;
    const id = this.nextId++;
    const response = await this._post(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
      },
      { initialization: true },
    );
    if (response?.error) throw new Error(`MCP initialize failed: ${response.error.message || JSON.stringify(response.error)}`);
    if (!response?.result) throw new Error('MCP initialize returned no result.');
    this.negotiatedVersion = response.result.protocolVersion || this.protocolVersion;
    await this._post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this.initialized = true;
  }

  async run(operation) {
    const next = this._queue.then(operation, operation);
    this._queue = next.catch(() => {});
    return next;
  }

  async listTools() {
    return this.run(async () => {
      await this.initialize();
      const result = await this._request('tools/list', {});
      return result?.tools ?? [];
    });
  }

  async callTool(name, args = {}, options = {}) {
    return this.run(async () => {
      await this.initialize();
      return checkedToolResult(name, await this._request('tools/call', { name, arguments: args }, options));
    });
  }

  sendToolCallKeepalive(name, args = {}) {
    if (!this.sessionId || !this.initialized) return false;
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': this.sessionId,
      'mcp-protocol-version': this.negotiatedVersion || this.protocolVersion,
    };
    const payload = { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } };
    this.fetch(this.endpoint, { method: 'POST', headers, body: JSON.stringify(payload), keepalive: true }).catch(() => {});
    return true;
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await this.fetch(this.endpoint, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/event-stream',
          'mcp-session-id': this.sessionId,
          'mcp-protocol-version': this.negotiatedVersion || this.protocolVersion,
        },
      });
    } finally {
      this.sessionId = null;
      this.initialized = false;
    }
  }
}

function sseBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

export class McpSseClient {
  constructor(endpoint, options = {}) {
    const baseUrl = options.baseUrl ?? globalThis.location?.href;
    this.endpoint = new URL(endpoint, baseUrl).href;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clientInfo = options.clientInfo ?? { name: 'metawebmcp-browser-bridge', version: '1.0.0' };
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.connectionPromise = null;
    this.connectionAbort = null;
    this.messageEndpoint = null;
    this._queue = Promise.resolve();
    this.closed = false;
  }

  fail(error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }

  handleEvent(block, resolveEndpoint) {
    const event = sseBlock(block);
    if (event.event === 'endpoint' && event.data) {
      this.messageEndpoint = new URL(event.data, this.endpoint).href;
      resolveEndpoint(this.messageEndpoint);
      return;
    }
    if (event.event !== 'message' || !event.data) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP request failed: ${message.error.message || JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  async consume(body, resolveEndpoint, rejectEndpoint) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let endpointSeen = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = buffer.match(/\r?\n\r?\n/);
          if (!boundary || boundary.index === undefined) break;
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const parsed = sseBlock(block);
          if (parsed.event === 'endpoint') endpointSeen = true;
          this.handleEvent(block, resolveEndpoint);
        }
      }
      if (!this.closed) throw new Error('MCP SSE connection closed unexpectedly.');
    } catch (error) {
      if (!endpointSeen) rejectEndpoint(error);
      if (!this.closed) this.fail(error);
    }
  }

  async connect() {
    if (this.closed) throw new Error('MCP SSE client is closed.');
    if (this.connectionPromise) return this.connectionPromise;
    this.connectionPromise = new Promise(async (resolve, reject) => {
      this.connectionAbort = new AbortController();
      try {
        const response = await this.fetch(this.endpoint, {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
          signal: this.connectionAbort.signal,
        });
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => '');
          throw new Error(`MCP SSE connection failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`);
        }
        this.consume(response.body, resolve, reject);
      } catch (error) {
        reject(error);
      }
    }).catch((error) => {
      this.connectionPromise = null;
      throw error;
    });
    return this.connectionPromise;
  }

  async post(payload) {
    await this.connect();
    const response = await this.fetch(this.messageEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`MCP request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`);
    }
  }

  async request(method, params = {}) {
    await this.connect();
    const id = this.nextId++;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      rejectResult(new Error(`MCP request timed out: ${method}.`));
    }, this.requestTimeoutMs);
    this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
    try {
      await this.post({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      this.pending.delete(id);
      clearTimeout(timer);
      rejectResult(error);
    }
    return result;
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (!result) throw new Error('MCP initialize returned no result.');
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    this.initialized = true;
  }

  async run(operation) {
    const next = this._queue.then(operation, operation);
    this._queue = next.catch(() => {});
    return next;
  }

  async listTools() {
    return this.run(async () => {
      await this.initialize();
      const result = await this.request('tools/list', {});
      return result?.tools ?? [];
    });
  }

  async callTool(name, args = {}) {
    return this.run(async () => {
      await this.initialize();
      return checkedToolResult(name, await this.request('tools/call', { name, arguments: args }));
    });
  }

  sendToolCallKeepalive(name, args = {}) {
    if (!this.messageEndpoint || !this.initialized || this.closed) return false;
    const payload = { jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } };
    this.fetch(this.messageEndpoint, {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
    return true;
  }

  async close() {
    this.closed = true;
    this.initialized = false;
    this.connectionAbort?.abort();
    this.fail(new Error('MCP SSE client closed.'));
  }
}
