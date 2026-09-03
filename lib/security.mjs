import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

function ipv4Number(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidr4(ip, base, prefix) {
  const value = ipv4Number(ip);
  const network = ipv4Number(base);
  if (value === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6Words(address) {
  let normalized = address.toLowerCase().split('%')[0];
  const dottedIndex = normalized.lastIndexOf(':');
  if (dottedIndex >= 0 && normalized.slice(dottedIndex + 1).includes('.')) {
    const value = ipv4Number(normalized.slice(dottedIndex + 1));
    if (value === null) return null;
    normalized = `${normalized.slice(0, dottedIndex)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => half
    ? half.split(':').map((word) => (/^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : Number.NaN))
    : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if ([...left, ...right].some(Number.isNaN)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array(omitted).fill(0), ...right];
}

function mappedIpv4Address(address) {
  const words = ipv6Words(address);
  if (!words || words.length !== 8) return null;
  if (words.slice(0, 5).some((word) => word !== 0) || words[5] !== 0xffff) return null;
  return [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff].join('.');
}

export function isPrivateOrReservedIp(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const blocked = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return blocked.some(([base, prefix]) => inCidr4(address, base, prefix));
  }

  if (kind === 6) {
    const normalized = address.toLowerCase().split('%')[0];
    const mapped = mappedIpv4Address(normalized);
    if (mapped) return isPrivateOrReservedIp(mapped);
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return true;
    return false;
  }

  return true;
}

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

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private and local targets are blocked.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error('Private and reserved IP targets are blocked.');
    return parsed;
  }

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
