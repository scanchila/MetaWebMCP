import { DurableObject } from 'cloudflare:workers';

import {
  claimExport,
  discardExport,
  MAX_EXPORT_ARCHIVE_BYTES,
  nextExportExpiry,
  persistExport,
} from './export-store-core.mjs';

function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export class ExportStore extends DurableObject {
  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => this.handleRequest(request));
  }

  async scheduleCleanup() {
    const nextExpiry = this.ctx.storage.transactionSync(() => nextExportExpiry(this.ctx.storage.kv));
    if (nextExpiry === null) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(nextExpiry);
  }

  async handleRequest(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
    const route = /^\/(store|consume)\/([0-9a-f-]+)$/.exec(pathname);
    if (!route) return json({ ok: false, error: 'Not found.' }, 404);
    const [, operation, exportId] = route;

    try {
      if (operation === 'store') {
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > MAX_EXPORT_ARCHIVE_BYTES) throw new Error('Export archive is too large.');
        const bytes = new Uint8Array(await request.arrayBuffer());
        this.ctx.storage.transactionSync(() => {
          persistExport(this.ctx.storage.kv, {
            exportId,
            bytes,
            capabilityId: request.headers.get('x-metawebmcp-capability-id'),
            sourceKey: request.headers.get('x-metawebmcp-source-key'),
            contentDisposition: request.headers.get('x-metawebmcp-content-disposition'),
            expiresAtMs: Number(request.headers.get('x-metawebmcp-expires-at')),
          });
        });
        try {
          await this.scheduleCleanup();
        } catch (error) {
          this.ctx.storage.transactionSync(() => discardExport(this.ctx.storage.kv, exportId));
          await this.scheduleCleanup().catch(() => {});
          throw error;
        }
        return json({ ok: true }, 201);
      }

      if (operation === 'consume') {
        let claimed;
        this.ctx.storage.transactionSync(() => {
          claimed = claimExport(
            this.ctx.storage.kv,
            exportId,
            request.headers.get('x-metawebmcp-capability-id'),
          );
        });
        if (claimed.status === 'not-owner' || claimed.status === 'missing') {
          return json({ ok: false, error: 'Export not found or expired.' }, 404);
        }
        if (claimed.status === 'expired') {
          return json({ ok: false, error: 'Export not found or expired.' }, 404);
        }
        // The existing earliest-expiry alarm may wake early after a claim and
        // reschedule itself. Delivery must not depend on fallible alarm I/O.
        return new Response(claimed.bytes, {
          headers: {
            'content-type': 'application/zip',
            'content-disposition': claimed.contentDisposition,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      return json({ ok: false, error: 'Not found.' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /storage is at capacity/i.test(message) ? 429 : 400;
      return json({ ok: false, error: message }, status);
    }
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        for (const [key, metadata] of this.ctx.storage.kv.list({ prefix: 'export:' })) {
          if (!key.endsWith(':metadata') || metadata?.expiresAtMs > now) continue;
          claimExport(this.ctx.storage.kv, metadata.exportId, metadata.capabilityId, now);
        }
      });
      await this.scheduleCleanup();
    });
  }
}
