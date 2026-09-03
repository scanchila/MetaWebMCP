import { env as runtimeEnv } from 'cloudflare:workers';
import { createMcpAgent } from '@cloudflare/playwright-mcp';

import { analyzeAccessibilitySnapshot, analyzeHtml } from '../../lib/analyzer.mjs';
import {
  BROWSER_CAPABILITY_TTL_SECONDS,
  browserCapabilityCookie,
  issueBrowserCapability,
  verifyBrowserCapabilityCookie,
} from '../../lib/browser-capability.mjs';
import { generateProjectZip } from '../../lib/generator.mjs';
import {
  browserDirectNetworkInitScript,
  proxyBrowserRequest,
} from './browser-egress-proxy.mjs';
import { ExportStore } from './export-store.mjs';
import { MAX_EXPORT_ARCHIVE_BYTES } from './export-store-core.mjs';
import {
  BROWSER_MCP_TOOL_NAMES,
  validateBrowserTransportMessage,
  validatePublicTarget,
} from './browser-transport-policy.mjs';

const BODY_LIMIT = 2_000_000;
const HTML_LIMIT = 1_500_000;
const DOWNLOAD_TTL_SECONDS = 20 * 60;
const ANALYSIS_TIMEOUT_MS = 12_000;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const EXPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export { ExportStore };

export const PlaywrightMCP = createMcpAgent(runtimeEnv.BROWSER, {
  capabilities: ['core', 'wait'],
  allowedTools: BROWSER_MCP_TOOL_NAMES,
  network: {
    blockPrivate: true,
    requestHandler: proxyBrowserRequest,
    blockWebSockets: true,
    initScript: browserDirectNetworkInitScript,
  },
});

function securityHeaders(contentType = '') {
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'tools=(self), camera=(), microphone=(), geolocation=()',
  };
  if (contentType.includes('text/html')) {
    headers['cache-control'] = 'no-store';
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

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  for (const [name, content] of Object.entries(securityHeaders('application/json'))) headers.set(name, content);
  return new Response(JSON.stringify(value), { ...init, headers });
}

function errorResponse(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error?.statusCode
    || (/exceeds|too large/i.test(message)
      ? 413
      : /blocked|valid|invalid|empty|must|only|requires|unsupported|not found/i.test(message)
        ? 400
        : 500);
  return json({ ok: false, error: message }, { status });
}

async function readJson(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > BODY_LIMIT) throw new Error(`Request body exceeds ${BODY_LIMIT} bytes.`);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > BODY_LIMIT) throw new Error(`Request body exceeds ${BODY_LIMIT} bytes.`);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}

async function limitedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > HTML_LIMIT) {
      await reader.cancel();
      throw new Error(`Target response exceeds ${HTML_LIMIT} bytes.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchTargetHtml(rawUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANALYSIS_TIMEOUT_MS);
  try {
    let target = validatePublicTarget(rawUrl);
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Target returned a redirect without a Location header.');
        target = validatePublicTarget(new URL(location, target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Target returned HTTP ${response.status}.`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        await response.body?.cancel();
        throw new Error(`Target did not return HTML (${contentType || 'unknown content type'}).`);
      }
      return { html: await limitedText(response), finalUrl: target.href };
    }
    throw new Error('Target redirected more than 4 times.');
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Target request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return origin === new URL(request.url).origin
    || (!origin && request.headers.get('sec-fetch-site') === 'same-origin');
}

async function browserRequestWithinLimit(request, bindings) {
  const key = request.headers.get('cf-connecting-ip') || 'local';
  const result = await bindings.BROWSER_RATE_LIMITER.limit({ key });
  return result.success;
}

async function exportRequestWithinLimit(request, bindings) {
  const key = request.headers.get('cf-connecting-ip') || 'local';
  const result = await bindings.EXPORT_RATE_LIMITER.limit({ key });
  return result.success;
}

async function analysisRequestWithinLimit(request, bindings) {
  const key = request.headers.get('cf-connecting-ip') || 'local';
  const result = await bindings.ANALYSIS_RATE_LIMITER.limit({ key });
  return result.success;
}

function browserCapabilitySecret(bindings) {
  if (typeof bindings.MCP_CAPABILITY_SECRET !== 'string' || bindings.MCP_CAPABILITY_SECRET.length < 32) {
    const error = new Error('Browser capability secret is not configured.');
    error.statusCode = 503;
    throw error;
  }
  return bindings.MCP_CAPABILITY_SECRET;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function exportSourceKey(request, bindings) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(browserCapabilitySecret(bindings)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const source = request.headers.get('cf-connecting-ip') || 'local';
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`export-source:${source}`));
  return base64Url(new Uint8Array(signature));
}

async function requireBrowserCapability(request, bindings) {
  const capability = await verifyBrowserCapabilityCookie(
    request.headers.get('cookie'),
    browserCapabilitySecret(bindings),
  );
  if (!capability) {
    const error = new Error('A valid page-issued browser capability is required.');
    error.statusCode = 401;
    throw error;
  }
  return capability;
}

async function validateBrowserTransportRequest(request) {
  if (request.method !== 'POST') return;
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > BODY_LIMIT) throw new Error(`Request body exceeds ${BODY_LIMIT} bytes.`);
  const text = await request.clone().text();
  if (new TextEncoder().encode(text).byteLength > BODY_LIMIT) throw new Error(`Request body exceeds ${BODY_LIMIT} bytes.`);
  if (!text) return;
  try {
    validateBrowserTransportMessage(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Request body must be valid JSON.');
    throw error;
  }
}

async function handleApi(request, bindings, pathname, browserCapability) {
  if (pathname === '/health' && request.method === 'GET') {
    const deploymentVersion = String(bindings.CF_VERSION_METADATA?.id || '').trim();
    const sourceCommit = String(bindings.META_WEBMCP_SOURCE_COMMIT || '').trim().toLowerCase();
    const deployedAt = String(bindings.CF_VERSION_METADATA?.timestamp || '').trim();
    const deploymentTag = String(bindings.CF_VERSION_METADATA?.tag || '').trim() || null;
    if (!deploymentVersion || !SOURCE_COMMIT_PATTERN.test(sourceCommit) || !deployedAt) {
      return json({
        ok: false,
        service: 'MetaWebMCP',
        runtime: 'cloudflare',
        error: 'Deployment identity is not configured.',
      }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    return json({
      ok: true,
      service: 'MetaWebMCP',
      browserMcpConfigured: true,
      runtime: 'cloudflare',
      deploymentVersion,
      sourceCommit,
      deployedAt,
      deploymentTag,
    }, { headers: { 'cache-control': 'no-store' } });
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    return json({
      ok: true,
      browserMcpConfigured: true,
      browserMcpEndpoint: '/sse',
      browserMcpTransport: 'sse',
      allowPrivateTargets: false,
    });
  }

  if (pathname === '/api/analyze' && request.method === 'POST') {
    if (!await analysisRequestWithinLimit(request, bindings)) {
      return json({ ok: false, error: 'Analysis request limit reached. Try again in a minute.' }, { status: 429 });
    }
    const body = await readJson(request);
    if (body.source === 'html') {
      const analysis = analyzeHtml({ html: String(body.html || ''), url: String(body.url || ''), goal: String(body.goal || '') });
      return json({ ok: true, analysis });
    }
    if (body.source === 'url') {
      const fetched = await fetchTargetHtml(body.url);
      const analysis = analyzeHtml({ html: fetched.html, url: fetched.finalUrl, goal: String(body.goal || '') });
      analysis.source.kind = 'url';
      return json({ ok: true, analysis });
    }
    throw new Error('source must be “url” or “html”.');
  }

  if (pathname === '/api/mcp/analyze-snapshot' && request.method === 'POST') {
    if (!await analysisRequestWithinLimit(request, bindings)) {
      return json({ ok: false, error: 'Analysis request limit reached. Try again in a minute.' }, { status: 429 });
    }
    const body = await readJson(request);
    const target = validatePublicTarget(body.url);
    const analysis = analyzeAccessibilitySnapshot({
      snapshot: String(body.snapshot || ''),
      url: target.href,
      goal: String(body.goal || ''),
    });
    return json({ ok: true, analysis });
  }

  if (pathname === '/api/export' && request.method === 'POST') {
    if (!await exportRequestWithinLimit(request, bindings)) {
      return json({ ok: false, error: 'Export request limit reached. Try again in a minute.' }, { status: 429 });
    }
    const body = await readJson(request);
    const archive = generateProjectZip(body);
    if (archive.buffer.length > MAX_EXPORT_ARCHIVE_BYTES) {
      const error = new Error(`Generated export exceeds ${MAX_EXPORT_ARCHIVE_BYTES} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    const id = crypto.randomUUID();
    const downloadUrl = new URL(`/api/download/${id}`, request.url);
    const expiresInSeconds = Math.max(1, Math.min(
      DOWNLOAD_TTL_SECONDS,
      browserCapability.expiresAt - Math.floor(Date.now() / 1000),
    ));
    const store = bindings.EXPORT_STORE.get(bindings.EXPORT_STORE.idFromName('exports-v1'));
    const stored = await store.fetch(`https://export-store.internal/store/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'x-metawebmcp-capability-id': browserCapability.id,
        'x-metawebmcp-source-key': await exportSourceKey(request, bindings),
        'x-metawebmcp-content-disposition': `attachment; filename="${archive.fileName}"`,
        'x-metawebmcp-expires-at': String(browserCapability.expiresAt * 1000),
      },
      body: archive.buffer,
    });
    if (stored.status === 429) {
      return json({ ok: false, error: 'Export storage is at capacity. Try again shortly.' }, { status: 429 });
    }
    if (!stored.ok) throw new Error('Generated export could not be retained for download.');
    return json({
      ok: true,
      fileName: archive.fileName,
      fileCount: archive.fileCount,
      bytes: archive.buffer.length,
      downloadUrl: downloadUrl.pathname,
      expiresInSeconds,
    }, { status: 201 });
  }

  if (pathname.startsWith('/api/download/') && request.method === 'GET') {
    const id = pathname.slice('/api/download/'.length);
    if (!EXPORT_ID_PATTERN.test(id)) {
      return json({ ok: false, error: 'Export not found or expired.' }, { status: 404 });
    }
    const store = bindings.EXPORT_STORE.get(bindings.EXPORT_STORE.idFromName('exports-v1'));
    return store.fetch(`https://export-store.internal/consume/${id}`, {
      method: 'POST',
      headers: { 'x-metawebmcp-capability-id': browserCapability.id },
    });
  }

  return null;
}

async function serveAsset(request, bindings) {
  const response = await bindings.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(headers.get('content-type') || ''))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, bindings, context) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/browser-session') {
        if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, { status: 405 });
        if (!sameOrigin(request)) return json({ ok: false, error: 'Same-origin page session required.' }, { status: 403 });
        if (!await browserRequestWithinLimit(request, bindings)) return json({ ok: false, error: 'Browser request limit reached.' }, { status: 429 });
        const secret = browserCapabilitySecret(bindings);
        const existing = await verifyBrowserCapabilityCookie(request.headers.get('cookie'), secret);
        const capability = existing || await issueBrowserCapability(secret);
        const expiresInSeconds = existing
          ? Math.max(1, existing.expiresAt - Math.floor(Date.now() / 1000))
          : BROWSER_CAPABILITY_TTL_SECONDS;
        return json({
          ok: true,
          expiresInSeconds,
        }, {
          status: 201,
          headers: {
            'cache-control': 'no-store',
            vary: 'Origin',
            ...(!existing ? {
              'set-cookie': browserCapabilityCookie(capability.token, {
                ttlSeconds: BROWSER_CAPABILITY_TTL_SECONDS,
              }),
            } : {}),
          },
        });
      }
      const protectedPath = pathname === '/mcp'
        || pathname === '/sse'
        || pathname === '/sse/message'
        || pathname.startsWith('/api/mcp/')
        || pathname === '/api/export'
        || pathname.startsWith('/api/download/');
      const browserCapability = protectedPath
        ? await requireBrowserCapability(request, bindings)
        : null;
      if (pathname === '/mcp') {
        if (!sameOrigin(request)) return json({ ok: false, error: 'Same-origin browser session required.' }, { status: 403 });
        if (!await browserRequestWithinLimit(request, bindings)) return json({ ok: false, error: 'Browser request limit reached.' }, { status: 429 });
        await validateBrowserTransportRequest(request);
        return PlaywrightMCP.serve('/mcp').fetch(request, bindings, context);
      }
      if (pathname === '/sse' || pathname === '/sse/message') {
        if (!sameOrigin(request)) return json({ ok: false, error: 'Same-origin browser session required.' }, { status: 403 });
        if (!await browserRequestWithinLimit(request, bindings)) return json({ ok: false, error: 'Browser request limit reached.' }, { status: 429 });
        await validateBrowserTransportRequest(request);
        return PlaywrightMCP.serveSSE('/sse').fetch(request, bindings, context);
      }
      const apiResponse = await handleApi(request, bindings, pathname, browserCapability);
      if (apiResponse) return apiResponse;
      if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, error: 'Method not allowed.' }, { status: 405 });
      return serveAsset(request, bindings);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
