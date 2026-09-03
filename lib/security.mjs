import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

import {
  ipVersion,
  isBlockedPublicHostname,
  isPrivateOrReservedIp,
  normalizeHostname,
} from '../public/js/network-policy.js';

export { isPrivateOrReservedIp } from '../public/js/network-policy.js';

const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 12_000;

function targetTimeoutError() {
  const error = new Error('Target request timed out.');
  error.code = 'TARGET_TIMEOUT';
  return error;
}

async function waitForLookup(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw targetTimeoutError();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(targetTimeoutError());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}

function parseTargetUrl(rawUrl) {
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
  return parsed;
}

async function resolveTargetConnection(rawUrl, options = {}) {
  const parsed = parseTargetUrl(rawUrl);
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_TARGETS === '1';
  const hostname = normalizeHostname(parsed.hostname);
  if (!allowPrivate) {
    if (ipVersion(hostname) && isPrivateOrReservedIp(hostname)) {
      throw new Error('Private and reserved IP targets are blocked.');
    }
    if (!ipVersion(hostname) && isBlockedPublicHostname(hostname)) {
      throw new Error('Private and local targets are blocked.');
    }
  }

  let records;
  if (ipVersion(hostname)) {
    records = [{ address: hostname, family: ipVersion(hostname) }];
  } else {
    const lookup = options.lookup ?? dns.lookup;
    try {
      records = await waitForLookup(
        lookup(hostname, { all: true, verbatim: true }),
        options.signal,
      );
    } catch (error) {
      if (error?.code === 'TARGET_TIMEOUT') throw error;
      throw new Error('Target hostname could not be resolved.');
    }
  }

  if (!Array.isArray(records) || !records.length) {
    throw new Error('Target hostname could not be resolved.');
  }
  if (!allowPrivate && records.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw new Error('Target resolves to a private or reserved network address.');
  }
  const selected = records[0];
  return {
    url: parsed,
    address: selected.address,
    family: selected.family || ipVersion(selected.address),
  };
}

export async function validateTargetUrl(rawUrl, options = {}) {
  const { allowPrivate = process.env.ALLOW_PRIVATE_TARGETS === '1' } = options;
  const parsed = parseTargetUrl(rawUrl);

  if (allowPrivate) return parsed;
  return (await resolveTargetConnection(parsed, options)).url;
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
  const body = response.body ?? response;
  if (!body?.[Symbol.asyncIterator]) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy?.();
      throw new Error(`Target response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function responseHeader(response, name) {
  const value = response.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function discardResponse(response) {
  response.resume?.();
}

function requestPinnedTarget(target, destination, options = {}) {
  const request = target.protocol === 'https:'
    ? options.httpsRequest ?? https.request
    : options.httpRequest ?? http.request;
  return new Promise((resolve, reject) => {
    const originalHostname = normalizeHostname(target.hostname);
    const outgoing = request({
      protocol: target.protocol,
      hostname: destination.address,
      family: destination.family,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        host: target.host,
        'user-agent': 'MetaWebMCP/1.0',
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'accept-encoding': 'identity',
        connection: 'close',
      },
      agent: false,
      signal: options.signal,
      ...(target.protocol === 'https:' && !ipVersion(originalHostname)
        ? { servername: originalHostname }
        : {}),
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
}

export async function fetchTargetHtml(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_TARGETS === '1';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let current = parseTargetUrl(rawUrl);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const destination = await resolveTargetConnection(current, {
        allowPrivate,
        lookup: options.lookup,
        signal: controller.signal,
      });
      const response = await requestPinnedTarget(current, destination, {
        httpRequest: options.httpRequest,
        httpsRequest: options.httpsRequest,
        signal: controller.signal,
      });
      const status = response.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = responseHeader(response, 'location');
        discardResponse(response);
        if (!location) throw new Error('Target returned a redirect without a Location header.');
        current = parseTargetUrl(new URL(location, current).href);
        continue;
      }

      if (status < 200 || status >= 300) {
        discardResponse(response);
        throw new Error(`Target returned HTTP ${status}.`);
      }
      const contentType = responseHeader(response, 'content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        discardResponse(response);
        throw new Error(`Target did not return HTML (${contentType || 'unknown content type'}).`);
      }

      const html = await readLimitedBody(response, options.maxBytes ?? MAX_HTML_BYTES);
      return { html, finalUrl: current.href, status, contentType };
    }
    throw new Error(`Target redirected more than ${MAX_REDIRECTS} times.`);
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'TARGET_TIMEOUT') {
      throw new Error('Target request timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
