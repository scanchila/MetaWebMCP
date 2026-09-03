export const MAX_EXPORT_ARCHIVE_BYTES = 3_000_000;
export const EXPORT_CHUNK_BYTES = 1_500_000;
export const MAX_EXPORT_TTL_MS = 20 * 60 * 1000;
export const MAX_PENDING_EXPORTS = 8;
export const MAX_PENDING_EXPORT_BYTES = 16_000_000;
export const MAX_PENDING_EXPORTS_PER_SOURCE = 2;
export const MAX_PENDING_EXPORT_BYTES_PER_SOURCE = 6_000_000;

const CAPABILITY_ID_PATTERN = /^[a-zA-Z0-9_-]{24}$/;
const EXPORT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_KEY_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

function metadataKey(exportId) {
  return `export:${exportId}:metadata`;
}

function chunkKey(exportId, index) {
  return `export:${exportId}:chunk:${String(index).padStart(3, '0')}`;
}

function clearRecord(kv, exportId, chunkCount = 0) {
  kv.delete(metadataKey(exportId));
  for (let index = 0; index < chunkCount; index += 1) kv.delete(chunkKey(exportId, index));
}

function requireCapabilityId(value) {
  const capabilityId = String(value || '');
  if (!CAPABILITY_ID_PATTERN.test(capabilityId)) throw new Error('Invalid export capability identifier.');
  return capabilityId;
}

function requireExportId(value) {
  const exportId = String(value || '');
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new Error('Invalid export identifier.');
  return exportId;
}

function requireSourceKey(value) {
  const sourceKey = String(value || '');
  if (!SOURCE_KEY_PATTERN.test(sourceKey)) throw new Error('Invalid export source key.');
  return sourceKey;
}

function requireDisposition(value) {
  const disposition = String(value || '');
  if (!/^attachment; filename="[a-zA-Z0-9._-]{1,160}"$/.test(disposition)) {
    throw new Error('Invalid export content disposition.');
  }
  return disposition;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('Stored export chunk is invalid.');
}

function storedMetadata(kv) {
  return [...kv.list({ prefix: 'export:' })]
    .filter(([key]) => key.endsWith(':metadata'))
    .map(([, metadata]) => metadata)
    .filter((metadata) => metadata?.version === 1);
}

function pruneExpired(kv, nowMs) {
  for (const metadata of storedMetadata(kv)) {
    if (metadata.expiresAtMs <= nowMs) clearRecord(kv, metadata.exportId, metadata.chunkCount);
  }
}

export function nextExportExpiry(kv) {
  const expiries = storedMetadata(kv).map((metadata) => metadata.expiresAtMs);
  return expiries.length ? Math.min(...expiries) : null;
}

export function discardExport(kv, rawExportId) {
  const exportId = requireExportId(rawExportId);
  const metadata = kv.get(metadataKey(exportId));
  if (!metadata || metadata.version !== 1) return false;
  clearRecord(kv, exportId, metadata.chunkCount);
  return true;
}

export function persistExport(kv, {
  exportId: rawExportId,
  bytes,
  capabilityId: rawCapabilityId,
  sourceKey: rawSourceKey,
  contentDisposition,
  expiresAtMs,
  nowMs = Date.now(),
}) {
  const exportId = requireExportId(rawExportId);
  const capabilityId = requireCapabilityId(rawCapabilityId);
  const sourceKey = requireSourceKey(rawSourceKey);
  const archive = asBytes(bytes);
  const expiry = Number(expiresAtMs);
  const now = Number(nowMs);
  if (!archive.byteLength || archive.byteLength > MAX_EXPORT_ARCHIVE_BYTES) {
    throw new Error(`Export archive must contain between 1 and ${MAX_EXPORT_ARCHIVE_BYTES} bytes.`);
  }
  if (archive[0] !== 0x50 || archive[1] !== 0x4b) throw new Error('Export archive is not a ZIP file.');
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + MAX_EXPORT_TTL_MS) {
    throw new Error('Invalid export expiration.');
  }
  pruneExpired(kv, now);
  if (kv.get(metadataKey(exportId)) !== undefined) throw new Error('Export archive already exists.');

  const pending = storedMetadata(kv);
  const pendingBytes = pending.reduce((total, metadata) => total + metadata.byteLength, 0);
  const sourcePending = pending.filter((metadata) => metadata.sourceKey === sourceKey);
  const sourcePendingBytes = sourcePending.reduce((total, metadata) => total + metadata.byteLength, 0);
  if (pending.length >= MAX_PENDING_EXPORTS
      || pendingBytes + archive.byteLength > MAX_PENDING_EXPORT_BYTES
      || sourcePending.length >= MAX_PENDING_EXPORTS_PER_SOURCE
      || sourcePendingBytes + archive.byteLength > MAX_PENDING_EXPORT_BYTES_PER_SOURCE) {
    throw new Error('Export storage is at capacity. Try again shortly.');
  }

  const chunkCount = Math.ceil(archive.byteLength / EXPORT_CHUNK_BYTES);
  kv.put(metadataKey(exportId), {
    version: 1,
    exportId,
    capabilityId,
    sourceKey,
    contentDisposition: requireDisposition(contentDisposition),
    byteLength: archive.byteLength,
    chunkCount,
    expiresAtMs: expiry,
  });
  for (let index = 0; index < chunkCount; index += 1) {
    const offset = index * EXPORT_CHUNK_BYTES;
    kv.put(chunkKey(exportId, index), archive.slice(offset, offset + EXPORT_CHUNK_BYTES));
  }
  return { chunkCount, expiresAtMs: expiry };
}

export function claimExport(kv, rawExportId, rawCapabilityId, nowMs = Date.now()) {
  const exportId = requireExportId(rawExportId);
  const capabilityId = requireCapabilityId(rawCapabilityId);
  const metadata = kv.get(metadataKey(exportId));
  if (!metadata || metadata.version !== 1) return { status: 'missing' };
  if (metadata.expiresAtMs <= Number(nowMs)) {
    clearRecord(kv, exportId, metadata.chunkCount);
    return { status: 'expired' };
  }
  if (metadata.capabilityId !== capabilityId) return { status: 'not-owner' };

  try {
    const chunks = [];
    let total = 0;
    for (let index = 0; index < metadata.chunkCount; index += 1) {
      const chunk = asBytes(kv.get(chunkKey(exportId, index)));
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    if (total !== metadata.byteLength || total > MAX_EXPORT_ARCHIVE_BYTES) {
      throw new Error('Stored export archive is incomplete.');
    }
    const archive = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    clearRecord(kv, exportId, metadata.chunkCount);
    return {
      status: 'ok',
      bytes: archive,
      contentDisposition: metadata.contentDisposition,
    };
  } catch (error) {
    clearRecord(kv, exportId, metadata.chunkCount);
    throw error;
  }
}
