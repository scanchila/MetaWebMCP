import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { analyzeAccessibilitySnapshot, analyzeHtml } from './lib/analyzer.mjs';
import {
  BROWSER_CAPABILITY_TTL_SECONDS,
  browserCapabilityCookie,
  issueBrowserCapability,
  verifyBrowserCapabilityCookie,
} from './lib/browser-capability.mjs';
import { generateProjectZip } from './lib/generator.mjs';
import { McpHttpClient, flattenMcpText } from './lib/mcp-http-client.mjs';
import { fetchTargetHtml, validateBrowserTarget } from './lib/security.mjs';
import { runMcpRecipe } from './public/js/mcp-recipe.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const BODY_LIMIT = 2_000_000;
const MCP_SNAPSHOT_RESPONSE_LIMIT_BYTES = 2_000_000;
const BROWSER_MCP_URL = process.env.BROWSER_MCP_URL || '';
const BROWSER_MCP_EGRESS_ISOLATED = process.env.BROWSER_MCP_EGRESS_ISOLATED === '1';
if (BROWSER_MCP_URL && !BROWSER_MCP_EGRESS_ISOLATED) {
  throw new Error(
    'BROWSER_MCP_URL requires BROWSER_MCP_EGRESS_ISOLATED=1 after the browser runtime has been placed behind enforced private-network egress controls.',
  );
}
const MCP_CAPABILITY_SECRET = process.env.MCP_CAPABILITY_SECRET || crypto.randomBytes(48).toString('base64url');
const DOWNLOAD_TTL_MS = 20 * 60 * 1000;
const MCP_SESSION_TTL_MS = Math.max(60_000, Number(process.env.MCP_SESSION_TTL_MS) || 20 * 60 * 1000);

function positiveIntegerSetting(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const MAX_PENDING_EXPORTS = positiveIntegerSetting('MAX_PENDING_EXPORTS', 8);
const MAX_PENDING_EXPORT_BYTES = positiveIntegerSetting('MAX_PENDING_EXPORT_BYTES', 16_000_000);
const MAX_EXPORT_ARCHIVE_BYTES = positiveIntegerSetting('MAX_EXPORT_ARCHIVE_BYTES', 3_000_000);
const EXPORT_RATE_LIMIT_PER_MINUTE = positiveIntegerSetting('EXPORT_RATE_LIMIT_PER_MINUTE', 12);
const ANALYSIS_RATE_LIMIT_PER_MINUTE = positiveIntegerSetting('ANALYSIS_RATE_LIMIT_PER_MINUTE', 30);
const MAX_CONCURRENT_ANALYSES = positiveIntegerSetting('MAX_CONCURRENT_ANALYSES', 4);
const MAX_MCP_CLIENTS = positiveIntegerSetting('MAX_MCP_CLIENTS', 16);
const MAX_MCP_CLIENTS_PER_CAPABILITY = positiveIntegerSetting('MAX_MCP_CLIENTS_PER_CAPABILITY', 4);
const MCP_REQUEST_RATE_LIMIT_PER_MINUTE = positiveIntegerSetting('MCP_REQUEST_RATE_LIMIT_PER_MINUTE', 120);
const MAX_CONCURRENT_MCP_REQUESTS = positiveIntegerSetting('MAX_CONCURRENT_MCP_REQUESTS', 8);
if (MAX_MCP_CLIENTS_PER_CAPABILITY > MAX_MCP_CLIENTS) {
  throw new Error('MAX_MCP_CLIENTS_PER_CAPABILITY cannot exceed MAX_MCP_CLIENTS.');
}

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
let pendingDownloadBytes = 0;
let exportRateWindowStartedAt = Date.now();
let exportsInCurrentWindow = 0;
let analysisRateWindowStartedAt = Date.now();
let analysesInCurrentWindow = 0;
let activeAnalyses = 0;
let mcpRateWindowStartedAt = Date.now();
let mcpRequestsInCurrentWindow = 0;
let activeMcpRequests = 0;

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

function requestOrigin(req) {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol || (req.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${req.headers.host || 'localhost'}`;
}

function sameOriginPageRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin';
  try {
    return new URL(origin).origin === new URL(requestOrigin(req)).origin;
  } catch {
    return false;
  }
}

function secureRequest(req) {
  return req.socket.encrypted
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

async function requireBrowserCapability(req) {
  const capability = await verifyBrowserCapabilityCookie(req.headers.cookie, MCP_CAPABILITY_SECRET);
  if (!capability) {
    const error = new Error('A valid page-issued browser capability is required.');
    error.statusCode = 401;
    throw error;
  }
  return capability;
}

function workspaceKey(value, capabilityId) {
  const key = String(value || '');
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    throw new Error('A valid workspaceId is required for Browser MCP operations.');
  }
  return `${capabilityId}:${key}`;
}

function pruneMcpClients() {
  const now = Date.now();
  const cutoff = now - MCP_SESSION_TTL_MS;
  for (const [key, entry] of mcpClients) {
    if (entry.lastUsed > cutoff && entry.capabilityExpiresAt > now) continue;
    mcpClients.delete(key);
    entry.client.close().catch(() => {});
  }
}

function getMcpClient(workspaceId, capability) {
  if (!BROWSER_MCP_URL) throw new Error('BROWSER_MCP_URL is not configured. Start the Playwright MCP service or use the built-in demo.');
  const key = workspaceKey(workspaceId, capability.id);
  pruneMcpClients();
  let entry = mcpClients.get(key);
  if (!entry) {
    if (mcpClients.size >= MAX_MCP_CLIENTS) {
      const error = new Error('Browser MCP session capacity reached. Try again after closing another workspace.');
      error.statusCode = 429;
      throw error;
    }
    const capabilityClientCount = [...mcpClients.values()]
      .filter((candidate) => candidate.capabilityId === capability.id).length;
    if (capabilityClientCount >= MAX_MCP_CLIENTS_PER_CAPABILITY) {
      const error = new Error('Browser MCP workspace limit reached for this page session.');
      error.statusCode = 429;
      throw error;
    }
    entry = {
      client: new McpHttpClient(BROWSER_MCP_URL),
      capabilityId: capability.id,
      capabilityExpiresAt: capability.expiresAt * 1000,
      lastUsed: Date.now(),
    };
    mcpClients.set(key, entry);
  }
  entry.lastUsed = Date.now();
  return entry.client;
}

async function closeMcpClient(workspaceId, capabilityId) {
  const key = workspaceKey(workspaceId, capabilityId);
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

async function analyzeWithBrowserMcp(body, capability) {
  const parsed = await validateBrowserTarget(body.url, { allowPrivate: false });
  const client = getMcpClient(body.workspaceId, capability);
  const tools = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ['browser_navigate', 'browser_snapshot']) {
    if (!names.has(required)) throw new Error(`Connected MCP server does not expose required tool ${required}.`);
  }
  const navigationResult = await client.callTool('browser_navigate', { url: parsed.href }, {
    maxResponseBytes: MCP_SNAPSHOT_RESPONSE_LIMIT_BYTES,
  });
  const navigationText = flattenMcpText(navigationResult);
  const finalUrlMatch = navigationText.match(/^- Page URL:\s*(\S+)\s*$/m);
  const finalTarget = finalUrlMatch
    ? await validateBrowserTarget(finalUrlMatch[1], { allowPrivate: false })
    : parsed;
  const statusMatch = navigationText.match(/^- HTTP status:\s*(\d{3})\b/m);
  if (statusMatch && Number(statusMatch[1]) >= 400) {
    const error = new Error(`Target browser navigation returned HTTP ${statusMatch[1]}.`);
    error.statusCode = 502;
    throw error;
  }
  const snapshotResult = await client.callTool('browser_snapshot', {}, {
    maxResponseBytes: MCP_SNAPSHOT_RESPONSE_LIMIT_BYTES,
  });
  const snapshot = flattenMcpText(snapshotResult);
  const analysis = analyzeAccessibilitySnapshot({ snapshot, url: finalTarget.href, goal: String(body.goal || '') });
  return { ...analysis, mcp: { endpointConfigured: true, availableTools: [...names].sort() } };
}

async function executeMcpRecipe(body, capability) {
  const client = getMcpClient(body.workspaceId, capability);
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
  for (const [id, item] of downloads) {
    if (item.expiresAt > now) continue;
    downloads.delete(id);
    pendingDownloadBytes -= item.buffer.length;
  }
}

function claimExportRateSlot() {
  const now = Date.now();
  if (now - exportRateWindowStartedAt >= 60_000) {
    exportRateWindowStartedAt = now;
    exportsInCurrentWindow = 0;
  }
  if (exportsInCurrentWindow >= EXPORT_RATE_LIMIT_PER_MINUTE) {
    const error = new Error('Export request limit reached. Try again in a minute.');
    error.statusCode = 429;
    throw error;
  }
  exportsInCurrentWindow += 1;
}

function claimAnalysisSlot() {
  if (activeAnalyses >= MAX_CONCURRENT_ANALYSES) {
    const error = new Error('Analysis capacity reached. Try again shortly.');
    error.statusCode = 429;
    throw error;
  }
  const now = Date.now();
  if (now - analysisRateWindowStartedAt >= 60_000) {
    analysisRateWindowStartedAt = now;
    analysesInCurrentWindow = 0;
  }
  if (analysesInCurrentWindow >= ANALYSIS_RATE_LIMIT_PER_MINUTE) {
    const error = new Error('Analysis request limit reached. Try again in a minute.');
    error.statusCode = 429;
    throw error;
  }
  analysesInCurrentWindow += 1;
  activeAnalyses += 1;
  return () => { activeAnalyses -= 1; };
}

function claimMcpRequestSlot() {
  if (activeMcpRequests >= MAX_CONCURRENT_MCP_REQUESTS) {
    const error = new Error('Browser MCP request capacity reached. Try again shortly.');
    error.statusCode = 429;
    throw error;
  }
  const now = Date.now();
  if (now - mcpRateWindowStartedAt >= 60_000) {
    mcpRateWindowStartedAt = now;
    mcpRequestsInCurrentWindow = 0;
  }
  if (mcpRequestsInCurrentWindow >= MCP_REQUEST_RATE_LIMIT_PER_MINUTE) {
    const error = new Error('Browser MCP request limit reached. Try again in a minute.');
    error.statusCode = 429;
    throw error;
  }
  mcpRequestsInCurrentWindow += 1;
  activeMcpRequests += 1;
  return () => { activeMcpRequests -= 1; };
}

async function withMcpRequestSlot(operation) {
  const release = claimMcpRequestSlot();
  try {
    return await operation();
  } finally {
    release();
  }
}

function assertDownloadCapacity(additionalBytes = 0) {
  pruneDownloads();
  if (downloads.size >= MAX_PENDING_EXPORTS
    || pendingDownloadBytes + additionalBytes > MAX_PENDING_EXPORT_BYTES) {
    const error = new Error('Export storage is at capacity. Download an existing export or try again later.');
    error.statusCode = 429;
    throw error;
  }
}

function removeDownload(id) {
  const item = downloads.get(id);
  if (!item) return null;
  downloads.delete(id);
  pendingDownloadBytes -= item.buffer.length;
  return item;
}

const downloadPruneTimer = setInterval(pruneDownloads, 60_000);
downloadPruneTimer.unref?.();

async function handleApi(req, res, pathname, searchParams) {
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'MetaWebMCP', browserMcpConfigured: Boolean(BROWSER_MCP_URL) });
  }

  if (pathname === '/api/browser-session' && req.method === 'POST') {
    if (!sameOriginPageRequest(req)) return sendError(res, 403, new Error('Same-origin page session required.'));
    const existing = await verifyBrowserCapabilityCookie(req.headers.cookie, MCP_CAPABILITY_SECRET);
    const capability = existing || await issueBrowserCapability(MCP_CAPABILITY_SECRET);
    const expiresInSeconds = existing
      ? Math.max(1, existing.expiresAt - Math.floor(Date.now() / 1000))
      : BROWSER_CAPABILITY_TTL_SECONDS;
    return sendJson(res, 201, {
      ok: true,
      expiresInSeconds,
    }, {
      'cache-control': 'no-store',
      vary: 'Origin',
      ...(!existing ? {
        'set-cookie': browserCapabilityCookie(capability.token, {
          ttlSeconds: BROWSER_CAPABILITY_TTL_SECONDS,
          secure: secureRequest(req),
        }),
      } : {}),
    });
  }

  const browserCapability = pathname.startsWith('/api/mcp/')
    || pathname === '/api/export'
    || pathname.startsWith('/api/download/')
    ? await requireBrowserCapability(req)
    : null;

  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      browserMcpConfigured: Boolean(BROWSER_MCP_URL),
      browserMcpEndpoint: '',
      allowPrivateTargets: process.env.ALLOW_PRIVATE_TARGETS === '1',
    });
  }

  if (pathname === '/api/analyze' && req.method === 'POST') {
    const releaseAnalysisSlot = claimAnalysisSlot();
    try {
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
    } finally {
      releaseAnalysisSlot();
    }
  }

  if (pathname === '/api/mcp/status' && req.method === 'GET') {
    return withMcpRequestSlot(async () => {
      if (!BROWSER_MCP_URL) return sendJson(res, 200, { ok: true, configured: false, tools: [] });
      const tools = await getMcpClient(searchParams.get('workspace_id'), browserCapability).listTools();
      return sendJson(res, 200, { ok: true, configured: true, tools: tools.map((tool) => tool.name).sort() });
    });
  }

  if (pathname === '/api/mcp/analyze' && req.method === 'POST') {
    return withMcpRequestSlot(async () => {
      const releaseAnalysisSlot = claimAnalysisSlot();
      try {
        const body = await readJson(req);
        const analysis = await analyzeWithBrowserMcp(body, browserCapability);
        return sendJson(res, 200, { ok: true, analysis });
      } finally {
        releaseAnalysisSlot();
      }
    });
  }

  if (pathname === '/api/mcp/analyze-snapshot' && req.method === 'POST') {
    return withMcpRequestSlot(async () => {
      const releaseAnalysisSlot = claimAnalysisSlot();
      try {
        const body = await readJson(req);
        const parsed = await validateBrowserTarget(body.url, { allowPrivate: false });
        const analysis = analyzeAccessibilitySnapshot({
          snapshot: String(body.snapshot || ''),
          url: parsed.href,
          goal: String(body.goal || ''),
        });
        return sendJson(res, 200, { ok: true, analysis });
      } finally {
        releaseAnalysisSlot();
      }
    });
  }

  if (pathname === '/api/mcp/execute' && req.method === 'POST') {
    return withMcpRequestSlot(async () => {
      const body = await readJson(req);
      return sendJson(res, 200, await executeMcpRecipe(body, browserCapability));
    });
  }

  if (pathname === '/api/mcp/reset' && req.method === 'POST') {
    return withMcpRequestSlot(async () => {
      const body = await readJson(req);
      await closeMcpClient(body.workspaceId, browserCapability.id);
      return sendJson(res, 200, { ok: true });
    });
  }

  if (pathname === '/api/export' && req.method === 'POST') {
    assertDownloadCapacity();
    claimExportRateSlot();
    const body = await readJson(req);
    const archive = generateProjectZip(body);
    if (archive.buffer.length > MAX_EXPORT_ARCHIVE_BYTES) {
      const error = new Error(`Generated export exceeds ${MAX_EXPORT_ARCHIVE_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    assertDownloadCapacity(archive.buffer.length);
    const id = crypto.randomUUID();
    const expiresInSeconds = Math.max(1, Math.min(
      Math.floor(DOWNLOAD_TTL_MS / 1000),
      browserCapability.expiresAt - Math.floor(Date.now() / 1000),
    ));
    downloads.set(id, {
      ...archive,
      capabilityId: browserCapability.id,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    });
    pendingDownloadBytes += archive.buffer.length;
    return sendJson(res, 201, {
      ok: true,
      fileName: archive.fileName,
      fileCount: archive.fileCount,
      bytes: archive.buffer.length,
      downloadUrl: `/api/download/${id}`,
      expiresInSeconds,
    });
  }

  if (pathname.startsWith('/api/download/') && req.method === 'GET') {
    pruneDownloads();
    const id = pathname.slice('/api/download/'.length);
    const item = downloads.get(id);
    if (!item) return sendError(res, 404, new Error('Export not found or expired.'));
    if (item.capabilityId !== browserCapability.id) {
      return sendError(res, 404, new Error('Export not found or expired.'));
    }
    removeDownload(id);
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
    const status = error?.statusCode
      || (/blocked|not allowed|not configured|valid|empty|requires|must|exceeds|invalid/i.test(error?.message || '') ? 400 : 500);
    if (!res.headersSent) sendError(res, status, error);
    else res.destroy(error);
  } finally {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});
server.maxConnections = 128;
server.headersTimeout = 10_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`MetaWebMCP listening on http://${HOST}:${PORT}`);
  if (!BROWSER_MCP_URL) console.log('Browser MCP bridge is optional and currently disabled.');
});

async function shutdown() {
  server.close();
  clearInterval(mcpPruneTimer);
  clearInterval(downloadPruneTimer);
  const clients = [...mcpClients.values()].map((entry) => entry.client);
  mcpClients.clear();
  await Promise.allSettled(clients.map((client) => client.close()));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
