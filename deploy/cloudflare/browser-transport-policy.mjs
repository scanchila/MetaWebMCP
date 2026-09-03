export const BROWSER_MCP_TOOL_NAMES = Object.freeze([
  'browser_navigate',
  'browser_snapshot',
  'browser_type',
  'browser_click',
  'browser_select_option',
  'browser_wait_for',
  'browser_close',
  'browser_take_screenshot',
]);

const BROWSER_MCP_TOOL_SET = new Set(BROWSER_MCP_TOOL_NAMES);

function privateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

export function isBlockedBrowserHostname(rawHostname) {
  const hostname = String(rawHostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  const privateIpv6 = hostname === '::'
    || hostname === '::1'
    || hostname.startsWith('::ffff:')
    || /^(?:fc|fd|fe[89ab]|ff)/.test(hostname)
    || hostname === '2001:db8::'
    || hostname.startsWith('2001:db8:');
  return !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'home.arpa'
    || hostname.endsWith('.home.arpa')
    || privateIpv4(hostname)
    || privateIpv6;
}

export function validatePublicTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error('Target must be a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP and HTTPS targets are supported.');
  if (parsed.username || parsed.password) throw new Error('Target URLs may not contain credentials.');
  if (isBlockedBrowserHostname(parsed.hostname)) throw new Error('Private and local targets are blocked.');
  return parsed;
}

export function validateBrowserTransportMessage(payload) {
  const messages = Array.isArray(payload) ? payload : [payload];
  for (const message of messages) {
    if (!message || message.method !== 'tools/call') continue;
    const name = message.params?.name;
    if (!BROWSER_MCP_TOOL_SET.has(name)) throw new Error(`Browser MCP tool ${name || '(missing)'} is unsupported.`);
    if (name === 'browser_navigate') validatePublicTarget(message.params?.arguments?.url);
  }
}
