import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateOrReservedIp, parseAllowedOrigins, validateBrowserTarget, validateTargetUrl } from '../lib/security.mjs';

test('private, loopback, link-local, documentation, and multicast IPs are blocked', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.2', '169.254.10.2', '203.0.113.8', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateOrReservedIp(address), true, address);
  }
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});

test('URL validation rejects credentials, unsupported protocols, and direct local targets', async () => {
  await assert.rejects(validateTargetUrl('file:///tmp/index.html'), /Only HTTP and HTTPS/);
  await assert.rejects(validateTargetUrl('https://user:secret@example.com'), /credentials/);
  await assert.rejects(validateTargetUrl('http://127.0.0.1:8000'), /Private and reserved/);
  const allowed = await validateTargetUrl('http://127.0.0.1:8000', { allowPrivate: true });
  assert.equal(allowed.hostname, '127.0.0.1');
});

test('browser origin allowlist compares origins rather than paths', async () => {
  const origins = parseAllowedOrigins('https://allowed.example/path,https://second.example');
  assert.deepEqual([...origins], ['https://allowed.example', 'https://second.example']);
  await assert.rejects(
    validateBrowserTarget('https://blocked.example', { allowPrivate: true, allowedOrigins: origins }),
    /not in BROWSER_ALLOWED_ORIGINS/,
  );
  const result = await validateBrowserTarget('https://allowed.example/target', { allowPrivate: true, allowedOrigins: origins });
  assert.equal(result.pathname, '/target');
});
