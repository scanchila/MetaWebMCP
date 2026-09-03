import dns from 'node:dns/promises';

import {
  ipVersion,
  isBlockedPublicHostname,
  isPrivateOrReservedIp,
  normalizeHostname,
} from '../public/js/network-policy.js';

export { isPrivateOrReservedIp } from '../public/js/network-policy.js';

const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

export async function validateTargetUrl(rawUrl, options = {}) {
  const { allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === '1' } = options;
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error('Target must be a valid absolute URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS targets are supported.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Target URLs may not contain credentials.');
  }
  if (!parsed.hostname) throw new Error('Target URL has no hostname.');

  if (allowPrivate) return parsed;

  const hostname = normalizeHostname(parsed.hostname);
  if (ipVersion(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error('Private and reserved IP targets are blocked.');
    return parsed;
  }
  if (isBlockedPublicHostname(hostname)) throw new Error('Private and local targets are blocked.');

  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Target hostname could not be resolved.');
  }
  if (!records.length || records.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error('Target resolves to a private or reserved network address.');
  }
  return parsed;
}

export function parseAllowedOrigins(raw = process.env.BROWSER_ALLOWED_ORIGINS ?? '') {
  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => new URL(value).origin),
  );
}

export async function validateBrowserTarget(rawUrl, options = {}) {
  const parsed = await validateTargetUrl(rawUrl, options);
  const allowedOrigins = options.allowedOrigins ?? parseAllowedOrigins();
  if (allowedOrigins.size > 0 && !allowedOrigins.has(parsed.origin)) {
    throw new Error(`Target origin ${parsed.origin} is not in BROWSER_ALLOWED_ORIGINS.`);
  }
  return parsed;
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`Target response exceeds ${maxBytes} bytes.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchTargetHtml(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_TARGETS === '1';
  let current = await validateTargetUrl(rawUrl, { allowPrivate });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
  timeout.unref?.();

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'MetaWebMCP/1.0',
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Target returned a redirect without a Location header.');
        current = await validateTargetUrl(new URL(location, current).href, { allowPrivate });
        continue;
      }

      if (!response.ok) throw new Error(`Target returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        throw new Error(`Target did not return HTML (${contentType || 'unknown content type'}).`);
      }

      const html = await readLimitedBody(response, options.maxBytes ?? MAX_HTML_BYTES);
      return { html, finalUrl: current.href, status: response.status, contentType };
    }
    throw new Error(`Target redirected more than ${MAX_REDIRECTS} times.`);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Target request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
