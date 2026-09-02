import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { analyzeAccessibilitySnapshot, analyzeHtml } from './lib/analyzer.mjs';
import { generateProjectZip } from './lib/generator.mjs';
import { McpHttpClient, flattenMcpText } from './lib/mcp-http-client.mjs';
import { fetchTargetHtml, validateBrowserTarget } from './lib/security.mjs';
import { runMcpRecipe } from './public/js/mcp-recipe.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = 2_000_000;
const BROWSER_MCP_URL = process.env.BROWSER_MCP_URL || '';
const DOWNLOAD_TTL_MS = 20 * 60 * 1000;
const MCP_SESSION_TTL_MS = Math.max(60_000, Number(process.env.MCP_SESSION_TTL_MS) || 20 * 60 * 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const downloads = new Map();
const mcpClients = new Map();

function securityHeaders(contentType = '') {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'tools=(self), camera=(), microphone=(), geolocation=()',
    'cache-control': contentType.includes('text/html') ? 'no-store' : 'public, max-age=300',
  };
  if (contentType.includes('text/html')) {
    headers['content-security-policy'] = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
  }
  return headers;
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...securityHeaders('application/json'),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, status, error) {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { ok: false, error: message });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error(`Request body exceeds ${BODY_LIMIT} bytes.`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

function workspaceKey(value) {
  const key = String(value || '');
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    throw new Error('A valid workspaceId is required for Browser MCP operations.');
  }
  return key;
}

function pruneMcpClients() {
  const cutoff = Date.now() - MCP_SESSION_TTL_MS;
  for (const [key, entry] of mcpClients) {
    if (entry.lastUsed > cutoff) continue;
    mcpClients.delete(key);
    entry.client.close().catch(() => {});
  }
}

function getMcpClient(workspaceId) {
  if (!BROWSER_MCP_URL) throw new Error('BROWSER_MCP_URL is not configured. Start the Playwright MCP service or use the built-in demo.');
  const key = workspaceKey(workspaceId);
  pruneMcpClients();
  let entry = mcpClients.get(key);
  if (!entry) {
    entry = { client: new McpHttpClient(BROWSER_MCP_URL), lastUsed: Date.now() };
    mcpClients.set(key, entry);
  }
  entry.lastUsed = Date.now();
  return entry.client;
}

async function closeMcpClient(workspaceId) {
  const key = workspaceKey(workspaceId);
  const entry = mcpClients.get(key);
  if (!entry) return;
  mcpClients.delete(key);
  try {
    await entry.client.callTool('browser_close', {});
  } catch {
    // Closing an already closed browser is harmless.
  }
  await entry.client.close().catch(() => {});
}

const mcpPruneTimer = setInterval(pruneMcpClients, Math.min(MCP_SESSION_TTL_MS, 60_000));
mcpPruneTimer.unref?.();

async function analyzeWithBrowserMcp(body) {
  const parsed = await validateBrowserTarget(body.url);
  const client = getMcpClient(body.workspaceId);
  const tools = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ['browser_navigate', 'browser_snapshot']) {
    if (!names.has(required)) throw new Error(`Connected MCP server does not expose required tool ${required}.`);
  }
  await client.callTool('browser_navigate', { url: parsed.href });
  const snapshotResult = await client.callTool('browser_snapshot', {});
  const snapshot = flattenMcpText(snapshotResult);
  const analysis = analyzeAccessibilitySnapshot({ snapshot, url: parsed.href, goal: String(body.goal || '') });
  return { ...analysis, mcp: { endpointConfigured: true, availableTools: [...names].sort() } };
}

async function executeMcpRecipe(body) {
  const client = getMcpClient(body.workspaceId);
  const tools = await client.listTools();
  return runMcpRecipe({
    executor: body.executor,
    input: body.input ?? {},
    availableTools: tools,
    callTool: (name, args) => client.callTool(name, args),
    resultText: flattenMcpText,
  });
}

function pruneDownloads() {
  const now = Date.now();
  for (const [id, item] of downloads) if (item.expiresAt <= now) downloads.delete(id);
}

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'MetaWebMCP', browserMcpConfigured: Boolean(BROWSER_MCP_URL) });
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      browserMcpConfigured: Boolean(BROWSER_MCP_URL),
      browserMcpEndpoint: '',
      allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1',
    });
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.source === 'html') {
      const result = analyzeHtml({ html: String(body.html || ''), url: String(body.url || ''), goal: String(body.goal || '') });
      return sendJson(res, 200, { ok: true, analysis: result });
    }
    if (body.source === 'url') {
      const fetched = await fetchTargetHtml(body.url);
      const result = analyzeHtml({ html: fetched.html, url: fetched.finalUrl, goal: String(body.goal || '') });
      result.source.kind = 'url';
      result.source.url = fetched.finalUrl;
      return sendJson(res, 200, { ok: true, analysis: result });
    }
    throw new Error('source must be “url” or “html”.');
  }

  if (pathname === '/api/mcp/status' && req.method === 'GET') {
    if (!BROWSER_MCP_URL) return sendJson(res, 200, { ok: true, configured: false, tools: [] });
    const tools = await getMcpClient(searchParams.get('workspace_id')).listTools();
    return sendJson(res, 200, { ok: true, configured: true, tools: tools.map((tool) => tool.name).sort() });
  }

  if (pathname === '/api/mcp/analyze' && req.method === 'POST') {
    const body = await readJson(req);
    const analysis = await analyzeWithBrowserMcp(body);
    return sendJson(res, 200, { ok: true, analysis });
  }

  if (pathname === '/api/mcp/analyze-snapshot' && req.method === 'POST') {
    const body = await readJson(req);
    const parsed = await validateBrowserTarget(body.url);
    const analysis = analyzeAccessibilitySnapshot({
      snapshot: String(body.snapshot || ''),
      url: parsed.href,
      goal: String(body.goal || ''),
    });
    return sendJson(res, 200, { ok: true, analysis });
  }

  if (pathname === '/api/mcp/execute' && req.method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await executeMcpRecipe(body));
  }

  if (pathname === '/api/mcp/reset' && req.method === 'POST') {
    const body = await readJson(req);
    await closeMcpClient(body.workspaceId);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    const body = await readJson(req);
    const archive = generateProjectZip(body);
    const id = crypto.randomUUID();
    downloads.set(id, { ...archive, expiresAt: Date.now() + DOWNLOAD_TTL_MS });
    pruneDownloads();
    return sendJson(res, 201, {
      ok: true,
      fileName: archive.fileName,
      fileCount: archive.fileCount,
      bytes: archive.buffer.length,
      downloadUrl: `/api/download/${id}`,
      expiresInSeconds: Math.floor(DOWNLOAD_TTL_MS / 1000),
    });
  }

  if (pathname.startsWith('/api/download/') && req.method === 'GET') {
    pruneDownloads();
    const id = pathname.slice('/api/download/'.length);
    const item = downloads.get(id);
    if (!item) return sendError(res, 404, new Error('Export not found or expired.'));
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': item.buffer.length,
      'content-disposition': `attachment; filename="${item.fileName}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(item.buffer);
  }

  return false;
}

async function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative === '') relative = '/index.html';
  relative = relative.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_ROOT, relative);
  if (!resolved.startsWith(`${PUBLIC_ROOT}${path.sep}`) && resolved !== PUBLIC_ROOT) {
    return sendError(res, 403, new Error('Forbidden.'));
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('Not a file');
    const contentType = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    const body = await readFile(resolved);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      ...securityHeaders(contentType),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    if (!path.extname(relative)) {
      try {
        const fallback = await readFile(path.join(PUBLIC_ROOT, 'index.html'));
        res.writeHead(200, {
          'content-type': MIME['.html'],
          'content-length': fallback.length,
          ...securityHeaders(MIME['.html']),
        });
        return res.end(fallback);
      } catch {
        // Fall through.
      }
    }
    sendError(res, 404, new Error('Not found.'));
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const { pathname, searchParams } = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    const handled = await handleApi(req, res, pathname, searchParams);
    if (handled !== false) return;
    if (!['GET', 'HEAD'].includes(req.method || '')) return sendError(res, 405, new Error('Method not allowed.'));
    await serveStatic(req, res, pathname);
  } catch (error) {
    const status = /blocked|not allowed|not configured|valid|empty|requires|must|exceeds|invalid/i.test(error?.message || '') ? 400 : 500;
    if (!res.headersSent) sendError(res, status, error);
    else res.destroy(error);
  } finally {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MetaWebMCP listening on http://${HOST}:${PORT}`);
  if (!BROWSER_MCP_URL) console.log('Browser MCP bridge is optional and currently disabled.');
});

async function shutdown() {
  server.close();
  clearInterval(mcpPruneTimer);
  const clients = [...mcpClients.values()].map((entry) => entry.client);
  mcpClients.clear();
  await Promise.allSettled(clients.map((client) => client.close()));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
