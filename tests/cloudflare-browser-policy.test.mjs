import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_MCP_TOOL_NAMES,
  isBlockedBrowserHostname,
  validateBrowserTransportMessage,
  validatePublicTarget,
} from '../deploy/cloudflare/browser-transport-policy.mjs';

test('Cloudflare Browser MCP exposes only the product transport tools', () => {
  assert.deepEqual(BROWSER_MCP_TOOL_NAMES, [
    'browser_navigate',
    'browser_snapshot',
    'browser_type',
    'browser_click',
    'browser_select_option',
    'browser_wait_for',
    'browser_close',
    'browser_take_screenshot',
  ]);
  assert.doesNotThrow(() => validateBrowserTransportMessage({
    method: 'tools/call',
    params: { name: 'browser_click', arguments: { ref: 'e1', element: 'Search' } },
  }));
  assert.throws(
    () => validateBrowserTransportMessage({ method: 'tools/call', params: { name: 'browser_drag', arguments: {} } }),
    /browser_drag is unsupported/,
  );
});

test('Browser MCP navigation rejects local, private, reserved, and metadata targets', () => {
  assert.equal(validatePublicTarget('https://example.com/catalog').href, 'https://example.com/catalog');
  for (const url of [
    'file:///etc/passwd',
    'http://localhost:8787/',
    'http://127.0.0.1/',
    'http://0x7f000001/',
    'http://10.0.0.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.0.2.8/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://router.home.arpa/',
    'http://[::1]/',
    'http://[fd00::1]/',
  ]) {
    assert.throws(
      () => validateBrowserTransportMessage({
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url } },
      }),
      /Only HTTP and HTTPS|Private and local targets/,
      url,
    );
  }
  assert.equal(isBlockedBrowserHostname('example.com'), false);
});

test('Browser MCP validates every navigation in a JSON-RPC batch', () => {
  assert.throws(
    () => validateBrowserTransportMessage([
      { method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } },
      { method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://127.0.0.1/' } } },
    ]),
    /Private and local targets/,
  );
});
