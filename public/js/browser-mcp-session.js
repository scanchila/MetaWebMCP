import { McpHttpClient, McpSseClient, flattenMcpText } from './mcp-http-client.js';
import { runMcpRecipe } from './mcp-recipe.js';
import { isBlockedPublicHostname } from './network-policy.js';

const REQUIRED_TOOLS = ['browser_navigate', 'browser_snapshot'];
const SCREENSHOT_TOOL = 'browser_take_screenshot';
const MAX_INLINE_IMAGE_CHARACTERS = 8_000_000;
const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

function inlineImageFromResult(result) {
  const content = result?.content ?? result?.result?.content;
  const image = Array.isArray(content) ? content.find((part) => part?.type === 'image') : null;
  const mimeType = String(image?.mimeType || '');
  const data = String(image?.data || '');
  if (!image || !INLINE_IMAGE_TYPES.has(mimeType) || !data) {
    throw new Error('Connected Browser MCP did not return a supported page image.');
  }
  if (data.length > MAX_INLINE_IMAGE_CHARACTERS || !/^[a-zA-Z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('Connected Browser MCP returned an invalid or oversized page image.');
  }
  return { imageUrl: `data:${mimeType};base64,${data}`, mimeType };
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
  if (isBlockedPublicHostname(parsed.hostname)) {
    throw new Error('Private and local targets are blocked.');
  }
  return parsed.href;
}

export class BrowserMcpSession {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? globalThis.document?.baseURI ?? globalThis.location?.href ?? 'http://localhost/';
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
    try {
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
    } catch (error) {
      await this.reset(workspaceId).catch(() => {});
      const detail = error instanceof Error ? error.message : String(error);
      if (/\b429\b|rate limit|request limit/i.test(detail)) {
        throw new Error('Hosted browser capacity is unavailable. Retry after the service limit resets, or use source "agent_snapshot" with a snapshot from the calling agent’s browser.');
      }
      throw error;
    }
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

  async captureView(workspaceId) {
    const client = await this.directClient();
    if (!client) {
      const payload = await this.json('/api/mcp/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      return { imageUrl: payload.imageUrl, mimeType: payload.mimeType };
    }
    const tools = await client.listTools();
    if (!tools.some((tool) => tool.name === SCREENSHOT_TOOL)) {
      throw new Error(`Connected MCP server does not expose ${SCREENSHOT_TOOL}.`);
    }
    return inlineImageFromResult(await client.callTool(SCREENSHOT_TOOL, {}));
  }

  async reset(workspaceId) {
    if (!this.client && !this.configurationPromise) return { ok: true, closed: false };
    const configuration = await this.configuration();
    if (this.client) {
      const client = this.client;
      this.client = null;
      try {
        client.sendToolCallKeepalive?.('browser_close', {});
      } finally {
        await client.close().catch(() => {});
      }
      return { ok: true, closed: true };
    }
    if (configuration.browserMcpEndpoint) return { ok: true, closed: false };
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
