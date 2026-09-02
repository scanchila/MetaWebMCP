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

async function parseResponse(response) {
  if (response.status === 202 || response.status === 204) return null;
  const text = await response.text();
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

export class McpHttpClient {
  constructor(endpoint, options = {}) {
    this.endpoint = new URL(endpoint).href;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clientInfo = options.clientInfo ?? { name: 'metawebmcp-browser-bridge', version: '1.0.0' };
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.negotiatedVersion = null;
    this.sessionId = null;
    this.nextId = 1;
    this.initialized = false;
    this._queue = Promise.resolve();
  }

  async _post(payload, { initialization = false } = {}) {
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
    const body = await parseResponse(response);
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
      throw new Error(`MCP request failed: ${detail}`);
    }
    return body;
  }

  async _request(method, params = {}) {
    const id = this.nextId++;
    const response = await this._post({ jsonrpc: '2.0', id, method, params });
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

  async callTool(name, args = {}) {
    return this.run(async () => {
      await this.initialize();
      return this._request('tools/call', { name, arguments: args });
    });
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
