import { env as runtimeEnv } from 'cloudflare:workers';
import { createMcpAgent } from '@cloudflare/playwright-mcp';

import { analyzeAccessibilitySnapshot, analyzeHtml } from '../../lib/analyzer.mjs';
import { generateProjectZip } from '../../lib/generator.mjs';

const BODY_LIMIT = 2_000_000;
const HTML_LIMIT = 1_500_000;
const DOWNLOAD_TTL_SECONDS = 20 * 60;

export const PlaywrightMCP = createMcpAgent(runtimeEnv.BROWSER, {
  capabilities: ['core', 'wait'],
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
  const status = /exceeds|too large/i.test(message)
    ? 413
    : /blocked|valid|invalid|empty|must|only|requires|unsupported|not found/i.test(message)
      ? 400
      : 500;
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

function validatePublicTarget(rawUrl) {
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
  return parsed;
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
  let target = validatePublicTarget(rawUrl);
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const response = await fetch(target, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Target returned a redirect without a Location header.');
      target = validatePublicTarget(new URL(location, target).href);
      continue;
    }
    if (!response.ok) throw new Error(`Target returned HTTP ${response.status}.`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error(`Target did not return HTML (${contentType || 'unknown content type'}).`);
    }
    return { html: await limitedText(response), finalUrl: target.href };
  }
  throw new Error('Target redirected more than 4 times.');
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

async function handleApi(request, bindings, pathname) {
  if (pathname === '/health' && request.method === 'GET') {
    return json({ ok: true, service: 'MetaWebMCP', browserMcpConfigured: true, runtime: 'cloudflare' });
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
    const body = await readJson(request);
    const archive = generateProjectZip(body);
    const id = crypto.randomUUID();
    const downloadUrl = new URL(`/api/download/${id}`, request.url);
    const headers = new Headers({
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${archive.fileName}"`,
      'cache-control': `public, max-age=${DOWNLOAD_TTL_SECONDS}`,
      'x-content-type-options': 'nosniff',
    });
    await caches.default.put(new Request(downloadUrl), new Response(archive.buffer, { headers }));
    return json({
      ok: true,
      fileName: archive.fileName,
      fileCount: archive.fileCount,
      bytes: archive.buffer.length,
      downloadUrl: downloadUrl.pathname,
      expiresInSeconds: DOWNLOAD_TTL_SECONDS,
    }, { status: 201 });
  }

  if (pathname.startsWith('/api/download/') && request.method === 'GET') {
    const cached = await caches.default.match(new Request(request.url));
    return cached || json({ ok: false, error: 'Export not found or expired.' }, { status: 404 });
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
      if (pathname === '/mcp') {
        if (!sameOrigin(request)) return json({ ok: false, error: 'Same-origin browser session required.' }, { status: 403 });
        if (!await browserRequestWithinLimit(request, bindings)) return json({ ok: false, error: 'Browser request limit reached.' }, { status: 429 });
        return PlaywrightMCP.serve('/mcp').fetch(request, bindings, context);
      }
      if (pathname === '/sse' || pathname === '/sse/message') {
        if (!sameOrigin(request)) return json({ ok: false, error: 'Same-origin browser session required.' }, { status: 403 });
        if (!await browserRequestWithinLimit(request, bindings)) return json({ ok: false, error: 'Browser request limit reached.' }, { status: 429 });
        return PlaywrightMCP.serveSSE('/sse').fetch(request, bindings, context);
      }
      const apiResponse = await handleApi(request, bindings, pathname);
      if (apiResponse) return apiResponse;
      if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, error: 'Method not allowed.' }, { status: 405 });
      return serveAsset(request, bindings);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
