import { isBlockedPublicHostname } from '../../public/js/network-policy.js';

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

export function hostedBrowserEnabled(bindings) {
  return bindings?.HOSTED_BROWSER_ENABLED === '1';
}

export function hostedBrowserEngine(bindings) {
  return bindings?.HOSTED_BROWSER_ENGINE === 'kitesurf' ? 'kitesurf' : 'chromium';
}

export function isBlockedBrowserHostname(rawHostname) {
  return isBlockedPublicHostname(rawHostname);
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
