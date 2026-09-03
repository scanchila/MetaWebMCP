import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { Readable } from 'node:stream';

import {
  fetchTargetHtml,
  isPrivateOrReservedIp,
  parseAllowedOrigins,
  validateBrowserTarget,
  validateTargetUrl,
} from '../lib/security.mjs';

test('private, loopback, link-local, documentation, and multicast IPs are blocked', () => {
  for (const address of [
    '127.0.0.1',
    '10.2.3.4',
    '172.16.0.1',
    '192.168.1.2',
    '169.254.10.2',
    '192.88.99.1',
    '203.0.113.8',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '100::1',
    '2002:7f00:1::',
    '3000::1',
    '3fff::1',
    '4000::1',
  ]) {
    assert.equal(isPrivateOrReservedIp(address), true, address);
  }
  assert.equal(isPrivateOrReservedIp('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIp('::ffff:808:808'), false);
  assert.equal(isPrivateOrReservedIp('64:ff9b::808:808'), false);
  assert.equal(isPrivateOrReservedIp('2001:4860:4860::8888'), false);
  assert.equal(isPrivateOrReservedIp('2606:4700:4700::1111'), false);
});

test('URL validation rejects credentials, unsupported protocols, and direct local targets', async () => {
  await assert.rejects(validateTargetUrl('file:///tmp/index.html'), /Only HTTP and HTTPS/);
  await assert.rejects(validateTargetUrl('https://user:secret@example.com'), /credentials/);
  await assert.rejects(validateTargetUrl('http://127.0.0.1:8000'), /Private and reserved/);
  await assert.rejects(validateTargetUrl('http://[::ffff:127.0.0.1]/'), /Private and reserved/);
  await assert.rejects(validateTargetUrl('http://[::ffff:a9fe:a9fe]/latest/meta-data/'), /Private and reserved/);
  await assert.rejects(validateTargetUrl('http://[64:ff9b::a9fe:a9fe]/latest/meta-data/'), /Private and reserved/);
  await assert.rejects(validateTargetUrl('http://metadata.google.internal./'), /Private and local/);
  await assert.rejects(validateTargetUrl('http://169.254.169.254.nip.io/'), /Private and local/);
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

test('URL fetch connects to the public address that passed DNS validation', async (t) => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers.host, 'public.example');
    assert.equal(request.url, '/catalog?view=compact');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<main>Pinned response</main>');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const seenConnections = [];
  const result = await fetchTargetHtml('http://public.example/catalog?view=compact', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpRequest: (options, callback) => {
      seenConnections.push({
        hostname: options.hostname,
        family: options.family,
        hostHeader: options.headers.host,
      });
      return http.request({
        ...options,
        hostname: '127.0.0.1',
        family: 4,
        port: upstream.address().port,
      }, callback);
    },
  });

  assert.equal(result.html, '<main>Pinned response</main>');
  assert.deepEqual(seenConnections, [{
    hostname: '93.184.216.34',
    family: 4,
    hostHeader: 'public.example',
  }]);
});

test('URL fetch deadline includes DNS resolution', async () => {
  await assert.rejects(
    fetchTargetHtml('https://slow.example/', {
      lookup: () => new Promise(() => {}),
      timeoutMs: 20,
    }),
    /Target request timed out/,
  );
});

test('HTTPS address pinning preserves the validated hostname for TLS and HTTP', async () => {
  let requestOptions;
  const result = await fetchTargetHtml('https://secure.example/account', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    httpsRequest: (options, callback) => {
      requestOptions = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = Readable.from(['<main>Secure response</main>']);
        response.statusCode = 200;
        response.headers = { 'content-type': 'text/html' };
        callback(response);
      };
      return request;
    },
  });

  assert.equal(result.html, '<main>Secure response</main>');
  assert.equal(requestOptions.hostname, '93.184.216.34');
  assert.equal(requestOptions.servername, 'secure.example');
  assert.equal(requestOptions.headers.host, 'secure.example');
});
