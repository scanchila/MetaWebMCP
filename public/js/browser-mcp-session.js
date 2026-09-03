import { McpHttpClient, McpSseClient, flattenMcpText } from './mcp-http-client.js';
import { runMcpRecipe } from './mcp-recipe.js';

const REQUIRED_TOOLS = ['browser_navigate', 'browser_snapshot'];

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function normalizedTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error('Target must be a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS targets are supported.');
  if (parsed.username || parsed.password) throw new Error('Target URLs may not contain credentials.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateIpv6 = hostname === '::'
    || hostname === '::1'
    || hostname.startsWith('::ffff:')
    || /^(?:fc|fd|fe[89ab]|ff)/.test(hostname);
  if (!hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || privateIpv4(hostname)
    || privateIpv6) {
    throw new Error('Private and local targets are blocked.');
  }
  return parsed.href;
}

export class BrowserMcpSession {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? globalThis.location?.href ?? 'http://localhost/';
    this.configPath = options.configPath ?? '/api/config';
    this.capabilityPath = options.capabilityPath ?? '/api/browser-session';
    this.capabilityPromise = null;
    this.configurationPromise = null;
    this.client = null;
  }

  url(path) {
    return new URL(path, this.baseUrl).href;
  }

  async json(path, options = {}) {
    const response = await this.fetch(this.url(path), { credentials: 'same-origin', ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
    return payload;
  }

  async ensureCapability() {
    if (!this.capabilityPromise) {
      this.capabilityPromise = this.json(this.capabilityPath, { method: 'POST' }).catch((error) => {
        this.capabilityPromise = null;
        throw error;
      });
    }
    return this.capabilityPromise;
  }

  async configuration() {
    if (!this.configurationPromise) {
      this.configurationPromise = this.ensureCapability().then(() => this.json(this.configPath)).catch((error) => {
        this.configurationPromise = null;
        throw error;
      });
    }
    return this.configurationPromise;
  }

  async directClient() {
    const configuration = await this.configuration();
    if (!configuration.browserMcpEndpoint) return null;
    if (!this.client) {
      const Client = configuration.browserMcpTransport === 'sse' ? McpSseClient : McpHttpClient;
      this.client = new Client(configuration.browserMcpEndpoint, {
        baseUrl: this.baseUrl,
        fetch: (input, options = {}) => this.fetch(input, { credentials: 'same-origin', ...options }),
      });
    }
    return this.client;
  }

  async status(workspaceId) {
    const configuration = await this.configuration();
    const client = await this.directClient();
    if (client) {
      const tools = await client.listTools();
      return { configured: true, transport: 'page', tools: tools.map((tool) => tool.name).sort() };
    }
    if (!configuration.browserMcpConfigured) return { configured: false, transport: 'none', tools: [] };
    const payload = await this.json(`/api/mcp/status?workspace_id=${encodeURIComponent(workspaceId)}`);
    return { ...payload, transport: 'server' };
  }

  async analyze({ url, goal, workspaceId }) {
    const client = await this.directClient();
    if (!client) {
      const payload = await this.json('/api/mcp/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, goal, workspaceId }),
      });
      return payload.analysis;
    }

    const targetUrl = normalizedTargetUrl(url);
    const tools = await client.listTools();
    const available = new Set(tools.map((tool) => tool.name));
    for (const required of REQUIRED_TOOLS) {
      if (!available.has(required)) throw new Error(`Connected MCP server does not expose required tool ${required}.`);
    }
    await client.callTool('browser_navigate', { url: targetUrl });
    const snapshot = flattenMcpText(await client.callTool('browser_snapshot', {}));
    const payload = await this.json('/api/mcp/analyze-snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot, url: targetUrl, goal }),
    });
    return {
      ...payload.analysis,
      mcp: { endpointConfigured: true, transport: 'page', availableTools: [...available].sort() },
    };
  }

  async execute({ executor, input, workspaceId }) {
    const client = await this.directClient();
    if (!client) {
      return this.json('/api/mcp/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor, input, workspaceId }),
      });
    }
    const tools = await client.listTools();
    return runMcpRecipe({
      executor,
      input,
      availableTools: tools,
      callTool: (name, args) => client.callTool(name, args),
      resultText: flattenMcpText,
    });
  }

  async reset(workspaceId) {
    const configuration = await this.configuration();
    if (this.client) {
      const client = this.client;
      this.client = null;
      try {
        const available = new Set((await client.listTools()).map((tool) => tool.name));
        if (available.has('browser_close')) await client.callTool('browser_close', {});
      } catch {
        // A browser session may already have expired.
      } finally {
        await client.close().catch(() => {});
      }
      return { ok: true };
    }
    if (!configuration.browserMcpConfigured) return { ok: true };
    return this.json('/api/mcp/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
  }

  closeOnPageHide() {
    const client = this.client;
    this.client = null;
    return client?.sendToolCallKeepalive?.('browser_close', {}) ?? false;
  }
}

export const browserMcpSession = new BrowserMcpSession();
