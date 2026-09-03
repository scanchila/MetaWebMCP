import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
  browserDirectNetworkInitScript,
  proxyBrowserRequest,
} from '../deploy/cloudflare/browser-egress-proxy.mjs';
import {
  BROWSER_MCP_TOOL_NAMES,
  hostedBrowserEnabled,
  isBlockedBrowserHostname,
  validateBrowserTransportMessage,
  validatePublicTarget,
} from '../deploy/cloudflare/browser-transport-policy.mjs';

test('hosted Browser Run is disabled unless the deployment explicitly opts in', () => {
  assert.equal(hostedBrowserEnabled({}), false);
  assert.equal(hostedBrowserEnabled({ HOSTED_BROWSER_ENABLED: '0' }), false);
  assert.equal(hostedBrowserEnabled({ HOSTED_BROWSER_ENABLED: '1' }), true);
});

function routedRequest({
  url = 'https://public.example/page',
  method = 'GET',
  headers = {},
  postData = null,
  resourceType = 'document',
} = {}) {
  const actions = [];
  return {
    actions,
    route: {
      request: () => ({
        url: () => url,
        method: () => method,
        allHeaders: async () => headers,
        postDataBuffer: () => postData,
        resourceType: () => resourceType,
      }),
      fulfill: async (options) => { actions.push({ type: 'fulfill', options }); },
      abort: async (reason) => { actions.push({ type: 'abort', reason }); },
    },
  };
}

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
    'http://metadata.google.internal./computeMetadata/v1/',
    'http://169.254.169.254.nip.io/latest/meta-data/',
    'http://192.168.1.1.sslip.io/',
    'http://router.home.arpa/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[64:ff9b::a9fe:a9fe]/latest/meta-data/',
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

test('Browser Rendering requests cross the Worker public-fetch boundary', async () => {
  const { route, actions } = routedRequest({
    method: 'POST',
    headers: {
      host: 'forged.internal',
      connection: 'x-remove-me',
      'x-remove-me': 'remove me',
      authorization: 'Bearer public-target-session',
      'content-type': 'application/json',
    },
    postData: Buffer.from('{"query":"safe"}'),
  });
  let fetched;
  await proxyBrowserRequest(route, {
    fetchImpl: async (url, init) => {
      fetched = { url: url.href, init };
      return new Response('<main>Public response</main>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
          connection: 'x-upstream-only',
          'x-upstream-only': 'remove me',
        },
      });
    },
  });

  assert.equal(fetched.url, 'https://public.example/page');
  assert.equal(fetched.init.redirect, 'manual');
  assert.equal(fetched.init.cache, 'no-store');
  assert.equal(fetched.init.headers.get('host'), null);
  assert.equal(fetched.init.headers.get('x-remove-me'), null);
  assert.equal(fetched.init.headers.get('authorization'), 'Bearer public-target-session');
  assert.equal(fetched.init.headers.get('accept-encoding'), 'identity');
  assert.equal(Buffer.from(fetched.init.body).toString(), '{"query":"safe"}');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'fulfill');
  assert.equal(actions[0].options.status, 200);
  assert.equal(actions[0].options.headers.connection, undefined);
  assert.equal(actions[0].options.headers['content-encoding'], undefined);
  assert.equal(actions[0].options.headers['x-upstream-only'], undefined);
  assert.equal(actions[0].options.body.toString(), '<main>Public response</main>');
});

test('Browser Rendering preserves multiple response cookies', async () => {
  const responseHeaders = new Headers({ 'content-type': 'text/html' });
  responseHeaders.append('set-cookie', 'session=abc; Path=/; HttpOnly');
  responseHeaders.append('set-cookie', 'csrf=def; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/');
  const { route, actions } = routedRequest();

  await proxyBrowserRequest(route, {
    fetchImpl: async () => new Response('<main>Signed in</main>', { headers: responseHeaders }),
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'fulfill');
  assert.equal(
    actions[0].options.headers['set-cookie'],
    'session=abc; Path=/; HttpOnly\ncsrf=def; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/',
  );
});

test('Browser Rendering proxy blocks private redirects, service workers, and oversized bodies', async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    });
  };
  const first = routedRequest();
  await proxyBrowserRequest(first.route, { fetchImpl });
  assert.equal(first.actions[0].type, 'fulfill');
  assert.equal(first.actions[0].options.status, 302);
  assert.equal(first.actions[0].options.headers.location, 'http://127.0.0.1/private');

  const redirected = routedRequest({ url: first.actions[0].options.headers.location });
  await proxyBrowserRequest(redirected.route, { fetchImpl });
  assert.deepEqual(redirected.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);
  assert.equal(fetches, 1);

  const serviceWorker = routedRequest({ resourceType: 'serviceworker' });
  await proxyBrowserRequest(serviceWorker.route, { fetchImpl });
  assert.deepEqual(serviceWorker.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);
  assert.equal(fetches, 1);

  const oversizedRequest = routedRequest({ method: 'POST', postData: Buffer.alloc(4) });
  await proxyBrowserRequest(oversizedRequest.route, { fetchImpl, maxRequestBytes: 3 });
  assert.deepEqual(oversizedRequest.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);
  assert.equal(fetches, 1);

  const oversizedResponse = routedRequest();
  await proxyBrowserRequest(oversizedResponse.route, {
    fetchImpl: async () => new Response('large', { headers: { 'content-length': '5' } }),
    maxResponseBytes: 4,
  });
  assert.deepEqual(oversizedResponse.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);

  const streamedResponse = routedRequest();
  await proxyBrowserRequest(streamedResponse.route, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('456'));
        controller.close();
      },
    })),
    maxResponseBytes: 4,
  });
  assert.deepEqual(streamedResponse.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);

  const unsupportedMethod = routedRequest({ method: 'DELETE' });
  await proxyBrowserRequest(unsupportedMethod.route, { fetchImpl });
  assert.deepEqual(unsupportedMethod.actions, [{ type: 'abort', reason: 'blockedbyclient' }]);
});

test('Browser Rendering proxy aborts requests after its deadline', async () => {
  const { route, actions } = routedRequest();
  await proxyBrowserRequest(route, {
    timeoutMs: 5,
    fetchImpl: async (_target, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  assert.deepEqual(actions, [{ type: 'abort', reason: 'blockedbyclient' }]);
});

test('Browser Rendering startup disables direct socket APIs', async () => {
  class ServiceWorkerContainer {
    register() { return Promise.resolve('registered'); }
  }
  const context = {
    DOMException,
    ServiceWorkerContainer,
    Worker: class {},
    SharedWorker: class {},
    WebSocket: class {},
    RTCPeerConnection: class {},
    webkitRTCPeerConnection: class {},
    WebTransport: class {},
  };
  vm.runInNewContext(browserDirectNetworkInitScript, context);
  assert.equal(context.Worker, undefined);
  assert.equal(context.SharedWorker, undefined);
  assert.equal(context.WebSocket, undefined);
  assert.equal(context.RTCPeerConnection, undefined);
  assert.equal(context.webkitRTCPeerConnection, undefined);
  assert.equal(context.WebTransport, undefined);
  await assert.rejects(
    new ServiceWorkerContainer().register('/worker.js'),
    /Service workers are disabled/,
  );
});
