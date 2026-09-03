const encoder = new TextEncoder();

export const BROWSER_CAPABILITY_COOKIE = 'metawebmcp_browser_capability';
export const BROWSER_CAPABILITY_TTL_SECONDS = 20 * 60;

function requireCrypto(cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new Error('Web Crypto is required for browser capabilities.');
  }
  return cryptoImpl;
}

function requireSecret(secret) {
  const value = String(secret || '');
  if (encoder.encode(value).byteLength < 32) {
    throw new Error('Browser capability secret must contain at least 32 bytes.');
  }
  return value;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function signingKey(secret, cryptoImpl) {
  return cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(requireSecret(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function issueBrowserCapability(secret, options = {}) {
  const cryptoImpl = requireCrypto(options.cryptoImpl || globalThis.crypto);
  const ttlSeconds = Number(options.ttlSeconds ?? BROWSER_CAPABILITY_TTL_SECONDS);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 60 * 60) {
    throw new Error('Browser capability lifetime must be between 60 and 3600 seconds.');
  }
  const issuedAt = Math.floor(Number(options.now ?? Date.now()) / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const random = new Uint8Array(18);
  cryptoImpl.getRandomValues(random);
  const id = base64Url(random);
  const payload = `v1.${issuedAt}.${expiresAt}.${id}`;
  const signature = await cryptoImpl.subtle.sign(
    'HMAC',
    await signingKey(secret, cryptoImpl),
    encoder.encode(payload),
  );
  return {
    id,
    issuedAt,
    expiresAt,
    token: `${payload}.${base64Url(new Uint8Array(signature))}`,
  };
}

export async function verifyBrowserCapability(token, secret, options = {}) {
  try {
    const cryptoImpl = requireCrypto(options.cryptoImpl || globalThis.crypto);
    const parts = String(token || '').split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const [, issuedText, expiresText, id, signatureText] = parts;
    if (!/^\d{10}$/.test(issuedText) || !/^\d{10}$/.test(expiresText) || !/^[a-zA-Z0-9_-]{24}$/.test(id)) return null;
    const issuedAt = Number(issuedText);
    const expiresAt = Number(expiresText);
    const now = Math.floor(Number(options.now ?? Date.now()) / 1000);
    if (issuedAt > now + 60 || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 60 * 60) return null;
    const payload = parts.slice(0, 4).join('.');
    const valid = await cryptoImpl.subtle.verify(
      'HMAC',
      await signingKey(secret, cryptoImpl),
      decodeBase64Url(signatureText),
      encoder.encode(payload),
    );
    return valid ? { id, issuedAt, expiresAt } : null;
  } catch {
    return null;
  }
}

export function readBrowserCapabilityCookie(cookieHeader) {
  const values = String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${BROWSER_CAPABILITY_COOKIE}=`))
    .map((part) => part.slice(BROWSER_CAPABILITY_COOKIE.length + 1));
  return values.length === 1 ? values[0] : '';
}

export async function verifyBrowserCapabilityCookie(cookieHeader, secret, options = {}) {
  return verifyBrowserCapability(readBrowserCapabilityCookie(cookieHeader), secret, options);
}

export function browserCapabilityCookie(token, options = {}) {
  const ttlSeconds = Number(options.ttlSeconds ?? BROWSER_CAPABILITY_TTL_SECONDS);
  const attributes = [
    `${BROWSER_CAPABILITY_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${ttlSeconds}`,
  ];
  if (options.secure !== false) attributes.push('Secure');
  return attributes.join('; ');
}
