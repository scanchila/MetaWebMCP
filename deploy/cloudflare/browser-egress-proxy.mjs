import { Buffer } from 'node:buffer';

import { validatePublicTarget } from './browser-transport-policy.mjs';

const MAX_BROWSER_REQUEST_BYTES = 2_000_000;
const MAX_BROWSER_RESPONSE_BYTES = 8_000_000;
const BROWSER_REQUEST_TIMEOUT_MS = 20_000;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', ...BODY_METHODS]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function filteredHeaders(source, { request = false } = {}) {
  const headers = new Headers(source);
  const connectionHeaders = String(headers.get('connection') || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders]);
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower.startsWith('proxy-')) headers.delete(name);
  }
  if (request) headers.set('accept-encoding', 'identity');
  else headers.delete('content-encoding');
  return headers;
}

async function limitedResponseBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('Browser response exceeds the proxy limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Browser response exceeds the proxy limit.');
    }
    chunks.push(value);
  }
  const body = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function requestHeaders(request) {
  if (typeof request.allHeaders === 'function') return request.allHeaders();
  return request.headers();
}

async function safelyAbort(route) {
  await route.abort('blockedbyclient').catch(() => {});
}

export async function proxyBrowserRequest(route, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxRequestBytes = options.maxRequestBytes ?? MAX_BROWSER_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_BROWSER_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? BROWSER_REQUEST_TIMEOUT_MS;
  try {
    const browserRequest = route.request();
    if (browserRequest.resourceType?.() === 'serviceworker') {
      await safelyAbort(route);
      return;
    }
    const target = validatePublicTarget(browserRequest.url());
    const method = String(browserRequest.method()).toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new Error('Browser request method is blocked.');

    const postData = BODY_METHODS.has(method) ? browserRequest.postDataBuffer?.() : null;
    if (postData && postData.byteLength > maxRequestBytes) {
      throw new Error('Browser request exceeds the proxy limit.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target, {
        method,
        headers: filteredHeaders(await requestHeaders(browserRequest), { request: true }),
        body: postData ? new Uint8Array(postData) : undefined,
        redirect: 'manual',
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = method === 'HEAD'
        ? Buffer.alloc(0)
        : await limitedResponseBody(response, maxResponseBytes);
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(filteredHeaders(response.headers)),
        body,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    await safelyAbort(route);
  }
}

export const browserDirectNetworkInitScript = `(() => {
  for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
    try {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        writable: false,
        value: undefined,
      });
    } catch {}
  }
  try {
    Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
      configurable: false,
      writable: false,
      value: () => Promise.reject(new DOMException('Service workers are disabled.', 'NotAllowedError')),
    });
  } catch {}
})();`;
