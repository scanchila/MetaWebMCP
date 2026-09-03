import { DurableObject } from 'cloudflare:workers';

import {
  createSharedWorkspaceSession,
  readSharedWorkspaceSession,
  updateSharedWorkspaceSession,
} from '../../lib/shared-workspace.mjs';

const SESSION_KEY = 'session';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFound() {
  return json({ ok: false, error: 'Shared workspace not found or expired.' }, 404);
}

export class SharedWorkspaceStore extends DurableObject {
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => this.handleRequest(request));
  }

  async handleRequest(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/create' && request.method === 'POST') {
        if (await this.ctx.storage.get(SESSION_KEY)) {
          return json({ ok: false, error: 'Shared workspace already exists.' }, 409);
        }
        const session = createSharedWorkspaceSession({
          id: request.headers.get('x-metawebmcp-workspace-id'),
          writeTokenHash: request.headers.get('x-metawebmcp-write-token-hash'),
          readTokenHash: request.headers.get('x-metawebmcp-read-token-hash'),
          ttlMs: Number(request.headers.get('x-metawebmcp-ttl-ms')),
        });
        await this.ctx.storage.put(SESSION_KEY, session);
        await this.ctx.storage.setAlarm(session.expiresAtMs);
        return json({
          ok: true,
          revision: session.revision,
          expiresAt: new Date(session.expiresAtMs).toISOString(),
        }, 201);
      }

      if (url.pathname !== '/workspace') return notFound();
      const session = await this.ctx.storage.get(SESSION_KEY);
      if (!session) return notFound();
      const tokenHash = request.headers.get('x-metawebmcp-token-hash');

      if (request.method === 'GET') {
        const afterValue = url.searchParams.get('after');
        const result = readSharedWorkspaceSession(session, {
          tokenHash,
          afterRevision: afterValue === null ? -1 : Number(afterValue),
        });
        if (result.status === 'expired') await this.ctx.storage.deleteAll();
        if (result.status === 'not-authorized' || result.status === 'expired') return notFound();
        if (result.status === 'not-modified') {
          return new Response(null, {
            status: 204,
            headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
          });
        }
        return json({ ok: true, ...result.value });
      }

      if (request.method === 'PUT') {
        const body = await request.json();
        const result = updateSharedWorkspaceSession(session, {
          tokenHash,
          workspace: body.workspace,
        });
        if (result.status === 'expired') await this.ctx.storage.deleteAll();
        if (result.status === 'not-authorized' || result.status === 'expired') return notFound();
        await this.ctx.storage.put(SESSION_KEY, result.session);
        return json({ ok: true, ...result.value });
      }

      return json({ ok: false, error: 'Method not allowed.' }, 405);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /invalid|must|exceeds|controlled demo/i.test(message) ? 400 : 500;
      return json({ ok: false, error: message }, status);
    }
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
