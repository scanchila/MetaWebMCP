export const SHARED_WORKSPACE_RECORD_VERSION = 1;
export const DEFAULT_SHARED_WORKSPACE_TTL_MS = 60 * 60 * 1000;
export const MAX_SHARED_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SHARED_WORKSPACE_BYTES = 512_000;

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error('Shared workspace must be JSON serializable.');
  }
}

function requireWorkspaceId(value) {
  const id = String(value || '').toLowerCase();
  if (!WORKSPACE_ID_PATTERN.test(id)) throw new Error('Invalid shared workspace identifier.');
  return id;
}

function requireTokenHash(value) {
  const hash = String(value || '').toLowerCase();
  if (!TOKEN_HASH_PATTERN.test(hash)) throw new Error('Invalid shared workspace capability.');
  return hash;
}

function requireNow(value) {
  const now = Number(value);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid shared workspace timestamp.');
  return now;
}

function requireTtl(value) {
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_SHARED_WORKSPACE_TTL_MS) {
    throw new Error('Invalid shared workspace expiration.');
  }
  return ttl;
}

function validWorkspaceRecord(record) {
  const saved = record?.workspace;
  const draft = record?.draft;
  return record?.version === SHARED_WORKSPACE_RECORD_VERSION
    && typeof record.savedAt === 'string'
    && Number.isFinite(Date.parse(record.savedAt))
    && isRecord(saved)
    && ['owner', 'adapter'].includes(saved.mode)
    && ['demo', 'url', 'html', 'agent_snapshot', 'browser_mcp'].includes(saved.sourceKind)
    && (saved.analysis === null || (
      isRecord(saved.analysis)
      && Array.isArray(saved.analysis.capabilities)
      && saved.analysis.capabilities.length <= 12
    ))
    && Array.isArray(saved.contracts)
    && saved.contracts.length <= 25
    && saved.contracts.every((contract) => (
      isRecord(contract)
      && /^[a-z][a-z0-9_]{0,63}$/.test(contract.name || '')
      && typeof contract.description === 'string'
      && contract.description.length >= 8
      && isRecord(contract.inputSchema)
      && isRecord(contract.executor)
    ))
    && Array.isArray(saved.selectedCapabilityIds)
    && saved.selectedCapabilityIds.every((id) => typeof id === 'string')
    && typeof saved.activated === 'boolean'
    && typeof saved.verificationComplete === 'boolean'
    && Array.isArray(saved.evals) && saved.evals.length <= 25
    && Array.isArray(saved.trace) && saved.trace.length <= 30
    && (saved.selectedToolName === null || typeof saved.selectedToolName === 'string')
    && (saved.latestTargetState === null
      || typeof saved.latestTargetState === 'string'
      || isRecord(saved.latestTargetState))
    && typeof saved.hadTemporaryExport === 'boolean'
    && isRecord(draft)
    && draft.sourceKind === saved.sourceKind
    && ['sourceKind', 'targetUrl', 'targetHtml', 'targetSnapshot', 'goal']
      .every((key) => typeof draft[key] === 'string')
    && Array.isArray(draft.reviewDrafts || [])
    && draft.reviewDrafts.every((review) => (
      isRecord(review)
      && typeof review.capabilityId === 'string'
      && typeof review.name === 'string'
      && typeof review.description === 'string'
    ));
}

function pristineWorkspace(record) {
  const saved = record.workspace;
  return saved.analysis === null
    && saved.contracts.length === 0
    && saved.selectedCapabilityIds.length === 0
    && saved.activated === false
    && saved.verificationComplete === false
    && saved.evals.length === 0;
}

export function sanitizeSharedWorkspace(rawRecord) {
  const record = jsonClone(rawRecord);
  if (!validWorkspaceRecord(record)) throw new Error('Shared workspace record is invalid.');
  if (record.workspace.sourceKind !== 'demo' && !pristineWorkspace(record)) {
    throw new Error('Cloud sharing must use the controlled demo workspace.');
  }
  if (record.workspace.analysis?.source?.kind !== undefined
      && record.workspace.analysis.source.kind !== 'demo') {
    throw new Error('Cloud sharing must use the controlled demo workspace.');
  }

  const sanitized = {
    version: SHARED_WORKSPACE_RECORD_VERSION,
    savedAt: record.savedAt,
    draft: {
      sourceKind: record.draft.sourceKind,
      targetUrl: record.workspace.sourceKind === 'demo' ? record.draft.targetUrl : '',
      targetHtml: '',
      targetSnapshot: '',
      goal: record.draft.goal,
      reviewDrafts: record.draft.reviewDrafts.map((review) => ({
        capabilityId: review.capabilityId,
        name: review.name,
        description: review.description,
      })),
    },
    workspace: {
      mode: record.workspace.mode,
      sourceKind: record.workspace.sourceKind,
      analysis: record.workspace.analysis,
      contracts: record.workspace.contracts,
      selectedCapabilityIds: record.workspace.selectedCapabilityIds,
      activated: record.workspace.activated,
      verificationComplete: record.workspace.verificationComplete,
      evals: record.workspace.evals,
      trace: record.workspace.trace,
      selectedToolName: record.workspace.selectedToolName,
      latestTargetState: record.workspace.latestTargetState,
      hadTemporaryExport: record.workspace.hadTemporaryExport,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(sanitized)).byteLength;
  if (bytes > MAX_SHARED_WORKSPACE_BYTES) {
    throw new Error(`Shared workspace exceeds ${MAX_SHARED_WORKSPACE_BYTES} bytes.`);
  }
  return sanitized;
}

export function createSharedWorkspaceSession({
  id,
  writeTokenHash,
  readTokenHash,
  nowMs = Date.now(),
  ttlMs = DEFAULT_SHARED_WORKSPACE_TTL_MS,
}) {
  const now = requireNow(nowMs);
  const ttl = requireTtl(ttlMs);
  const writeHash = requireTokenHash(writeTokenHash);
  const readHash = requireTokenHash(readTokenHash);
  if (writeHash === readHash) throw new Error('Shared workspace read and write capabilities must differ.');
  return {
    version: 1,
    id: requireWorkspaceId(id),
    writeTokenHash: writeHash,
    readTokenHash: readHash,
    revision: 0,
    workspace: null,
    createdAtMs: now,
    updatedAtMs: now,
    expiresAtMs: now + ttl,
  };
}

function validSession(session) {
  return isRecord(session)
    && session.version === 1
    && WORKSPACE_ID_PATTERN.test(session.id || '')
    && TOKEN_HASH_PATTERN.test(session.writeTokenHash || '')
    && TOKEN_HASH_PATTERN.test(session.readTokenHash || '')
    && Number.isSafeInteger(session.revision)
    && session.revision >= 0
    && Number.isSafeInteger(session.createdAtMs)
    && Number.isSafeInteger(session.updatedAtMs)
    && Number.isSafeInteger(session.expiresAtMs)
    && (session.workspace === null || validWorkspaceRecord(session.workspace));
}

function requireSession(session) {
  if (!validSession(session)) throw new Error('Stored shared workspace is invalid.');
  return session;
}

function equalTokenHashes(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function publicSession(session) {
  return {
    id: session.id,
    revision: session.revision,
    workspace: jsonClone(session.workspace),
    updatedAt: new Date(session.updatedAtMs).toISOString(),
    expiresAt: new Date(session.expiresAtMs).toISOString(),
  };
}

export function readSharedWorkspaceSession(rawSession, {
  tokenHash,
  afterRevision = -1,
  nowMs = Date.now(),
}) {
  const session = requireSession(rawSession);
  const now = requireNow(nowMs);
  const hash = requireTokenHash(tokenHash);
  if (session.expiresAtMs <= now) return { status: 'expired' };
  if (!equalTokenHashes(hash, session.readTokenHash) && !equalTokenHashes(hash, session.writeTokenHash)) {
    return { status: 'not-authorized' };
  }
  const after = Number(afterRevision);
  if (!Number.isSafeInteger(after) || after < -1) throw new Error('Invalid shared workspace revision.');
  if (after >= session.revision) return { status: 'not-modified' };
  return { status: 'ok', value: publicSession(session) };
}

export function updateSharedWorkspaceSession(rawSession, {
  tokenHash,
  workspace,
  nowMs = Date.now(),
}) {
  const session = requireSession(rawSession);
  const now = requireNow(nowMs);
  const hash = requireTokenHash(tokenHash);
  if (session.expiresAtMs <= now) return { status: 'expired' };
  if (!equalTokenHashes(hash, session.writeTokenHash)) return { status: 'not-authorized' };
  const updated = {
    ...session,
    revision: session.revision + 1,
    workspace: sanitizeSharedWorkspace(workspace),
    updatedAtMs: now,
  };
  return { status: 'ok', session: updated, value: publicSession(updated) };
}
