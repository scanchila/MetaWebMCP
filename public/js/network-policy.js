function ipv4Number(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function inCidr4(address, base, prefix) {
  const value = ipv4Number(address);
  const network = ipv4Number(base);
  if (value === null || network === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6Words(address) {
  let normalized = String(address).toLowerCase().split('%')[0];
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

function embeddedIpv4(words) {
  return [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff].join('.');
}

function isAllocatedGlobalIpv6(words) {
  const [first, second] = words;
  return first === 0x2001
    || (first === 0x2003 && second < 0x4000)
    || (first >= 0x2400 && first <= 0x241f)
    || (first >= 0x2600 && first <= 0x260f)
    || ((first === 0x2610 || first === 0x2620) && second < 0x0200)
    || (first >= 0x2630 && first <= 0x263f)
    || (first >= 0x2800 && first <= 0x280f)
    || (first >= 0x2a00 && first <= 0x2a1f)
    || (first >= 0x2c00 && first <= 0x2c0f);
}

export function ipVersion(address) {
  if (ipv4Number(address) !== null) return 4;
  return ipv6Words(address) ? 6 : 0;
}

export function isPrivateOrReservedIp(address) {
  const version = ipVersion(address);
  if (version === 4) {
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
      ['192.88.99.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return blocked.some(([base, prefix]) => inCidr4(address, base, prefix));
  }

  if (version === 6) {
    const words = ipv6Words(address);
    const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    if (ipv4Mapped) return isPrivateOrReservedIp(embeddedIpv4(words));

    const wellKnownNat64 = words[0] === 0x64
      && words[1] === 0xff9b
      && words.slice(2, 6).every((word) => word === 0);
    if (wellKnownNat64) return isPrivateOrReservedIp(embeddedIpv4(words));

    if (words.slice(0, 6).every((word) => word === 0)) return true;
    if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
    if (words[0] === 0x100 && words.slice(1, 4).every((word) => word === 0)) return true;
    if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return true;
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
    if (words[0] === 0x2002) return true;
    if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return true;
    if (words[0] === 0x5f00) return true;
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
    if ((words[0] & 0xff00) === 0xff00) return true;
    return !isAllocatedGlobalIpv6(words);
  }

  return true;
}

export function normalizeHostname(rawHostname) {
  return String(rawHostname || '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/g, '')
    .toLowerCase();
}

export function isBlockedPublicHostname(rawHostname) {
  const hostname = normalizeHostname(rawHostname);
  const version = ipVersion(hostname);
  return !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'home.arpa'
    || hostname.endsWith('.home.arpa')
    || hostname === 'metadata'
    || hostname === 'metadata.google.internal'
    || hostname === 'localtest.me'
    || hostname.endsWith('.localtest.me')
    || hostname === 'nip.io'
    || hostname.endsWith('.nip.io')
    || hostname === 'sslip.io'
    || hostname.endsWith('.sslip.io')
    || (version !== 0 && isPrivateOrReservedIp(hostname));
}
