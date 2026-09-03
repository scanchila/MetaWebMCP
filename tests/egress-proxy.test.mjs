import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';

import { createEgressProxy, resolvePublicDestination } from '../egress-proxy.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  server.destroyOpenSockets?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

test('egress resolution rejects private aliases, mixed answers, translation ranges, and non-web ports', async () => {
  const calls = [];
  const lookup = async (hostname, options) => {
    calls.push({ hostname, options });
    return [{ address: '93.184.216.34', family: 4 }];
  };
  assert.deepEqual(
    await resolvePublicDestination('PUBLIC.EXAMPLE.', 443, { lookup }),
    { hostname: 'public.example', port: 443, address: '93.184.216.34', family: 4 },
  );
  assert.deepEqual(calls, [{ hostname: 'public.example', options: { all: true, verbatim: true } }]);

  await assert.rejects(
    resolvePublicDestination('mixed.example', 443, {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    /private or reserved/,
  );
  for (const [hostname, port] of [
    ['127.0.0.1', 80],
    ['metadata.google.internal.', 80],
    ['169.254.169.254.nip.io', 80],
    ['64:ff9b::a9fe:a9fe', 443],
    ['public.example', 8080],
  ]) {
    await assert.rejects(resolvePublicDestination(hostname, port, { lookup }), /blocked|ports 80 and 443/);
  }
});

test('HTTP proxy traffic connects to the resolver-selected address', async (t) => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    seen.push({
      path: request.url,
      host: request.headers.host,
      connection: request.headers.connection,
      removedHeader: request.headers['x-remove-me'],
    });
    response.writeHead(200, {
      'content-type': 'text/plain',
      connection: 'x-upstream-only',
      'x-upstream-only': 'remove me',
    });
    response.end('pinned response');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createEgressProxy({
    resolveDestination: async (hostname, port) => {
      assert.equal(hostname, 'public.example');
      assert.equal(port, upstreamPort);
      return { hostname, port, address: '127.0.0.1', family: 4 };
    },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await new Promise((resolve) => upstream.close(resolve));
  });

  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: `http://public.example:${upstreamPort}/catalog?view=compact`,
      headers: {
        host: `public.example:${upstreamPort}`,
        connection: 'x-remove-me',
        'x-remove-me': 'remove me',
      },
    }, async (response) => {
      const chunks = [];
      for await (const chunk of response) chunks.push(chunk);
      resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString(),
        removedHeader: response.headers['x-upstream-only'],
      });
    });
    request.on('error', reject);
    request.end();
  });
  assert.deepEqual(result, { status: 200, body: 'pinned response', removedHeader: undefined });
  assert.deepEqual(seen, [{
    path: '/catalog?view=compact',
    host: `public.example:${upstreamPort}`,
    connection: 'close',
    removedHeader: undefined,
  }]);
});

test('CONNECT tunnels use the resolver-selected address and reject loopback literals', async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const proxy = createEgressProxy({
    resolveDestination: async (hostname, port) => {
      assert.equal(hostname, 'public.example');
      assert.equal(port, echoPort);
      return { hostname, port, address: '127.0.0.1', family: 4 };
    },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await new Promise((resolve) => echo.close(resolve));
  });

  const client = net.connect(proxyPort, '127.0.0.1');
  await once(client, 'connect');
  client.write(`CONNECT public.example:${echoPort} HTTP/1.1\r\nHost: public.example:${echoPort}\r\n\r\n`);
  let response = '';
  while (!response.includes('\r\n\r\n')) response += (await once(client, 'data'))[0].toString();
  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
  client.write('tunnel payload');
  assert.equal((await once(client, 'data'))[0].toString(), 'tunnel payload');
  client.end();

  const blockingProxy = createEgressProxy();
  const blockingPort = await listen(blockingProxy);
  t.after(() => close(blockingProxy));
  const blockedClient = net.connect(blockingPort, '127.0.0.1');
  await once(blockedClient, 'connect');
  blockedClient.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
  const blockedResponse = (await once(blockedClient, 'data'))[0].toString();
  assert.match(blockedResponse, /^HTTP\/1\.1 403 Forbidden/);
  blockedClient.destroy();
});

test('Node Browser MCP configuration fails closed without an isolated-egress declaration', () => {
  const result = spawnSync(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      BROWSER_MCP_URL: 'http://127.0.0.1:8931/mcp',
      BROWSER_MCP_EGRESS_ISOLATED: '',
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires BROWSER_MCP_EGRESS_ISOLATED=1/);
});
