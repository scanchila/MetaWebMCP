import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimExport,
  discardExport,
  EXPORT_CHUNK_BYTES,
  MAX_EXPORT_ARCHIVE_BYTES,
  MAX_PENDING_EXPORT_BYTES,
  MAX_PENDING_EXPORTS,
  MAX_PENDING_EXPORTS_PER_SOURCE,
  nextExportExpiry,
  persistExport,
} from '../deploy/cloudflare/export-store-core.mjs';

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  get(key) {
    return this.values.get(key);
  }

  put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  delete(key) {
    return this.values.delete(key);
  }

  list({ prefix = '' } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort());
  }
}

const owner = 'abcdefghijklmnopqrstuvwx';
const other = 'zyxwvutsrqponmlkjihgfedc';
const now = 1_800_000_000_000;
const firstId = '00000000-0000-4000-8000-000000000001';

function exportId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sourceKey(index) {
  return String.fromCharCode(96 + index).repeat(43);
}

function archive(size = EXPORT_CHUNK_BYTES + 19) {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x50;
  bytes[1] = 0x4b;
  bytes.fill(0x5a, 2);
  return bytes;
}

function store(
  kv,
  bytes = archive(),
  id = firstId,
  expiresAtMs = now + 60_000,
  quotaKey = sourceKey(1),
) {
  return persistExport(kv, {
    exportId: id,
    bytes,
    capabilityId: owner,
    sourceKey: quotaKey,
    contentDisposition: 'attachment; filename="evidence.zip"',
    expiresAtMs,
    nowMs: now,
  });
}

test('archives are chunked, owner-bound, and atomically single-use', () => {
  const kv = new MemoryKv();
  const expected = archive();
  assert.deepEqual(store(kv, expected), { chunkCount: 2, expiresAtMs: now + 60_000 });
  assert.equal(kv.values.size, 3);

  assert.deepEqual(claimExport(kv, firstId, other, now), { status: 'not-owner' });
  assert.equal(kv.values.size, 3);

  const claimed = claimExport(kv, firstId, owner, now);
  assert.equal(claimed.status, 'ok');
  assert.equal(claimed.contentDisposition, 'attachment; filename="evidence.zip"');
  assert.deepEqual(claimed.bytes, expected);
  assert.equal(kv.values.size, 0);
  assert.deepEqual(claimExport(kv, firstId, owner, now), { status: 'missing' });
});

test('expired archives are removed without disclosure', () => {
  const kv = new MemoryKv();
  store(kv);
  assert.deepEqual(claimExport(kv, firstId, owner, now + 60_001), { status: 'expired' });
  assert.equal(kv.values.size, 0);
});

test('archive storage enforces format, size, expiration, and immutable ownership', () => {
  const invalidZip = new Uint8Array([1, 2, 3]);
  assert.throws(() => store(new MemoryKv(), invalidZip), /not a ZIP/);
  assert.throws(() => store(new MemoryKv(), archive(MAX_EXPORT_ARCHIVE_BYTES + 1)), /between 1 and/);

  const kv = new MemoryKv();
  store(kv, archive(4));
  assert.throws(() => store(kv, archive(4)), /already exists/);
  assert.throws(() => claimExport(kv, firstId, 'invalid', now), /Invalid export capability/);
});

test('the shared store bounds pending archives and tracks the earliest cleanup', () => {
  const kv = new MemoryKv();
  for (let index = 1; index <= MAX_PENDING_EXPORTS; index += 1) {
    store(
      kv,
      archive(4),
      exportId(index),
      now + 60_000 + index,
      sourceKey(Math.ceil(index / MAX_PENDING_EXPORTS_PER_SOURCE)),
    );
  }
  assert.equal(nextExportExpiry(kv), now + 60_001);
  assert.throws(
    () => store(
      kv,
      archive(4),
      exportId(MAX_PENDING_EXPORTS + 1),
      now + 60_000,
      sourceKey(5),
    ),
    /storage is at capacity/,
  );

  assert.equal(claimExport(kv, exportId(1), owner, now).status, 'ok');
  store(kv, archive(4), exportId(MAX_PENDING_EXPORTS + 1), now + 30_000, sourceKey(5));
  assert.equal(nextExportExpiry(kv), now + 30_000);
  assert.equal(discardExport(kv, exportId(2)), true);
  assert.equal(discardExport(kv, exportId(2)), false);
});

test('the shared store bounds aggregate retained bytes', () => {
  const kv = new MemoryKv();
  for (let index = 1; index <= 5; index += 1) {
    store(kv, archive(MAX_EXPORT_ARCHIVE_BYTES), exportId(index), now + 60_000, sourceKey(index));
  }
  assert.equal(5 * MAX_EXPORT_ARCHIVE_BYTES, 15_000_000);
  assert.throws(
    () => store(
      kv,
      archive(MAX_PENDING_EXPORT_BYTES - (5 * MAX_EXPORT_ARCHIVE_BYTES) + 1),
      exportId(6),
      now + 60_000,
      sourceKey(6),
    ),
    /storage is at capacity/,
  );
});

test('one source cannot occupy the global pool', () => {
  const kv = new MemoryKv();
  store(kv, archive(4), exportId(1), now + 60_000, sourceKey(1));
  store(kv, archive(4), exportId(2), now + 60_000, sourceKey(1));
  assert.throws(
    () => store(kv, archive(4), exportId(3), now + 60_000, sourceKey(1)),
    /storage is at capacity/,
  );
  assert.doesNotThrow(
    () => store(kv, archive(4), exportId(3), now + 60_000, sourceKey(2)),
  );
});

test('missing chunks fail closed and delete the partial record', () => {
  const kv = new MemoryKv();
  store(kv);
  kv.delete(`export:${firstId}:chunk:001`);
  assert.throws(() => claimExport(kv, firstId, owner, now), /chunk is invalid/);
  assert.equal(kv.values.size, 0);
});
