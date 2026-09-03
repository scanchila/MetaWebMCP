import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ipVersion,
  isBlockedPublicHostname,
  isPrivateOrReservedIp,
  normalizeHostname,
} from './public/js/network-policy.js';

const ALLOWED_PORTS = new Set([80, 443]);
const DNS_TIMEOUT_MS = 5_000;
const SOCKET_IDLE_TIMEOUT_MS = 60_000;
const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function destinationError(message, code = 'DESTINATION_BLOCKED') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(destinationError('Destination lookup timed out.', 'DNS_FAILURE')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function resolvePublicDestination(rawHostname, rawPort, options = {}) {
  const hostname = normalizeHostname(rawHostname);
  const port = Number(rawPort);
  if (!hostname || !Number.isInteger(port) || !ALLOWED_PORTS.has(port)) {
    throw destinationError('Only public destinations on ports 80 and 443 are allowed.');
  }
  if (isBlockedPublicHostname(hostname)) throw destinationError('Private and local destinations are blocked.');

  let records;
  if (ipVersion(hostname)) {
    records = [{ address: hostname, family: ipVersion(hostname) }];
  } else {
    const lookup = options.lookup ?? dns.lookup;
    try {
      records = await withTimeout(
        Promise.resolve(lookup(hostname, { all: true, verbatim: true })),
        options.timeoutMs ?? DNS_TIMEOUT_MS,
      );
    } catch (error) {
      if (error?.code === 'DESTINATION_BLOCKED' || error?.code === 'DNS_FAILURE') throw error;
      throw destinationError('Destination hostname could not be resolved.', 'DNS_FAILURE');
    }
  }

  if (!Array.isArray(records) || !records.length) {
    throw destinationError('Destination hostname could not be resolved.', 'DNS_FAILURE');
  }
  if (records.some(({ address }) => isPrivateOrReservedIp(address))) {
    throw destinationError('Destination resolves to a private or reserved address.');
  }
  const selected = records[0];
  return {
    hostname,
    port,
    address: selected.address,
    family: selected.family || ipVersion(selected.address),
  };
}

function parseConnectAuthority(authority) {
  const value = String(authority || '');
  const portMatch = value.startsWith('[')
    ? value.match(/^\[[^\]]+\]:(\d{1,5})$/)
    : value.match(/^[^:]+:(\d{1,5})$/);
  if (!portMatch) throw destinationError('CONNECT requires an explicit host and port.');
  let parsed;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    throw destinationError('CONNECT destination is invalid.');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw destinationError('CONNECT destination is invalid.');
  }
  return { hostname: parsed.hostname, port: Number(portMatch[1]) };
}

function targetForHttpRequest(requestUrl) {
  let parsed;
  try {
    parsed = new URL(String(requestUrl));
  } catch {
    throw destinationError('Proxy requests require an absolute URL.');
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) {
    throw destinationError('Only credential-free HTTP proxy requests are supported.');
  }
  return parsed;
}

function hostHeader(hostname, port, defaultPort) {
  const host = ipVersion(hostname) === 6 ? `[${hostname}]` : hostname;
  return port === defaultPort ? host : `${host}:${port}`;
}

function sanitizedHeaders(source, destination) {
  const headers = { ...source };
  const connectionHeaders = String(source.connection || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP_HEADERS, ...connectionHeaders]);
  for (const name of Object.keys(headers)) {
    if (blocked.has(name.toLowerCase())) delete headers[name];
  }
  if (destination) headers.host = hostHeader(destination.hostname, destination.port, 80);
  headers.connection = 'close';
  return headers;
}

function failureStatus(error) {
  return error?.code === 'DESTINATION_BLOCKED' ? 403 : 502;
}

function sendFailure(response, error) {
  if (response.headersSent) return response.destroy(error);
  const status = failureStatus(error);
  const body = status === 403 ? 'Destination blocked.\n' : 'Destination unavailable.\n';
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function rejectTunnel(socket, error) {
  if (socket.destroyed) return;
  const status = failureStatus(error);
  const reason = status === 403 ? 'Forbidden' : 'Bad Gateway';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createEgressProxy(options = {}) {
  const resolver = options.resolveDestination ?? resolvePublicDestination;
  const requestUpstream = options.requestUpstream ?? http.request;
  const connectUpstream = options.connectUpstream ?? net.connect;
  const openSockets = new Set();

  const server = http.createServer(async (request, response) => {
    let upstream;
    try {
      if (request.headers.upgrade) throw destinationError('Protocol upgrades are not supported.');
      const target = targetForHttpRequest(request.url);
      const port = Number(target.port || 80);
      const destination = await resolver(target.hostname, port);
      upstream = requestUpstream({
        hostname: destination.address,
        family: destination.family,
        port: destination.port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: sanitizedHeaders(request.headers, destination),
      }, (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          sanitizedHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
      });
      upstream.setTimeout?.(SOCKET_IDLE_TIMEOUT_MS, () => upstream.destroy(destinationError('Upstream request timed out.', 'DNS_FAILURE')));
      upstream.on('error', (error) => sendFailure(response, error));
      request.on('aborted', () => upstream.destroy());
      request.pipe(upstream);
    } catch (error) {
      upstream?.destroy();
      sendFailure(response, error);
    }
  });

  server.on('connect', async (request, clientSocket, head) => {
    clientSocket.on('error', () => {});
    let upstreamSocket;
    try {
      const target = parseConnectAuthority(request.url);
      const destination = await resolver(target.hostname, target.port);
      if (clientSocket.destroyed) return;
      upstreamSocket = connectUpstream({
        host: destination.address,
        family: destination.family,
        port: destination.port,
      });
      openSockets.add(upstreamSocket);
      upstreamSocket.on('close', () => openSockets.delete(upstreamSocket));
      upstreamSocket.setTimeout?.(SOCKET_IDLE_TIMEOUT_MS, () => upstreamSocket.destroy());
      const beforeConnectError = (error) => rejectTunnel(clientSocket, error);
      upstreamSocket.once('error', beforeConnectError);
      upstreamSocket.once('connect', () => {
        upstreamSocket.off('error', beforeConnectError);
        upstreamSocket.on('error', () => clientSocket.destroy());
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
    } catch (error) {
      upstreamSocket?.destroy();
      rejectTunnel(clientSocket, error);
    }
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  server.on('clientError', (error, socket) => rejectTunnel(socket, error));
  server.maxConnections = 256;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.destroyOpenSockets = () => {
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
  };
  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const host = process.env.EGRESS_PROXY_HOST || '127.0.0.1';
  const port = Number(process.env.EGRESS_PROXY_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EGRESS_PROXY_PORT must be a valid TCP port.');
  const server = createEgressProxy();
  server.listen(port, host, () => console.log(`MetaWebMCP egress proxy listening on http://${host}:${port}`));
  const shutdown = () => {
    server.close();
    server.destroyOpenSockets();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
