import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSharedWorkspaceSession,
  readSharedWorkspaceSession,
  sanitizeSharedWorkspace,
  updateSharedWorkspaceSession,
} from '../lib/shared-workspace.mjs';

const now = 1_800_000_000_000;
const id = '123e4567-e89b-42d3-a456-426614174000';
const writeTokenHash = 'a'.repeat(64);
const readTokenHash = 'b'.repeat(64);

function demoWorkspace(overrides = {}) {
  return {
    version: 1,
    savedAt: '2026-09-04T12:00:00.000Z',
    draft: {
      sourceKind: 'demo',
      targetUrl: 'https://metawebmcp.example/demo/',
      targetHtml: '<main>must not leave the author browser</main>',
      targetSnapshot: 'private accessibility snapshot',
      goal: 'Find sessions and build an itinerary.',
      reviewDrafts: [{
        capabilityId: 'demo_find_sessions',
        name: 'find_sessions',
        description: 'Find matching conference sessions.',
      }],
    },
    workspace: {
      mode: 'owner',
      sourceKind: 'demo',
      analysis: {
        source: { kind: 'demo', url: 'https://metawebmcp.example/demo/', title: 'Relay Sessions' },
        capabilities: [{ id: 'demo_find_sessions', name: 'find_sessions' }],
      },
      contracts: [{
        name: 'find_sessions',
        description: 'Find matching conference sessions.',
        risk: 'read',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        executor: { type: 'dom-read', selector: '#session-grid' },
      }],
      selectedCapabilityIds: ['demo_find_sessions'],
      activated: true,
      verificationComplete: false,
      evals: [],
      trace: [{ title: 'Tools activated', detail: 'One generated tool is live.', status: 'success', time: '12:00:00' }],
      selectedToolName: 'find_sessions',
      latestTargetState: { itinerary: [] },
      hadTemporaryExport: true,
    },
    privateTopLevelValue: 'must be discarded',
    ...overrides,
  };
}

test('shared workspace projection keeps demo state while removing browser-only source material', () => {
  const shared = sanitizeSharedWorkspace(demoWorkspace());

  assert.equal(shared.draft.targetHtml, '');
  assert.equal(shared.draft.targetSnapshot, '');
  assert.equal(shared.privateTopLevelValue, undefined);
  assert.equal(shared.workspace.contracts[0].name, 'find_sessions');
  assert.deepEqual(shared.workspace.latestTargetState, { itinerary: [] });
});

test('shared workspace projection rejects built state from non-demo targets', () => {
  const workspace = demoWorkspace();
  workspace.draft.sourceKind = 'agent_snapshot';
  workspace.workspace.sourceKind = 'agent_snapshot';
  workspace.workspace.analysis.source.kind = 'agent_snapshot';

  assert.throws(
    () => sanitizeSharedWorkspace(workspace),
    /controlled demo/i,
  );
});

test('read and write capabilities remain distinct across revisioned updates', () => {
  const created = createSharedWorkspaceSession({
    id,
    writeTokenHash,
    readTokenHash,
    nowMs: now,
    ttlMs: 60_000,
  });

  const denied = updateSharedWorkspaceSession(created, {
    tokenHash: readTokenHash,
    workspace: demoWorkspace(),
    nowMs: now + 1,
  });
  assert.equal(denied.status, 'not-authorized');

  const updated = updateSharedWorkspaceSession(created, {
    tokenHash: writeTokenHash,
    workspace: demoWorkspace(),
    nowMs: now + 2,
  });
  assert.equal(updated.status, 'ok');
  assert.equal(updated.session.revision, 1);
  assert.equal(updated.session.expiresAtMs, created.expiresAtMs);

  const visible = readSharedWorkspaceSession(updated.session, {
    tokenHash: readTokenHash,
    nowMs: now + 3,
  });
  assert.equal(visible.status, 'ok');
  assert.equal(visible.value.revision, 1);
  assert.equal(visible.value.workspace.workspace.contracts[0].name, 'find_sessions');

  assert.equal(readSharedWorkspaceSession(updated.session, {
    tokenHash: readTokenHash,
    afterRevision: 1,
    nowMs: now + 4,
  }).status, 'not-modified');
});

test('expired workspace capabilities disclose no stored state', () => {
  const created = createSharedWorkspaceSession({
    id,
    writeTokenHash,
    readTokenHash,
    nowMs: now,
    ttlMs: 10_000,
  });
  const updated = updateSharedWorkspaceSession(created, {
    tokenHash: writeTokenHash,
    workspace: demoWorkspace(),
    nowMs: now + 1,
  });

  assert.equal(readSharedWorkspaceSession(updated.session, {
    tokenHash: readTokenHash,
    nowMs: now + 10_002,
  }).status, 'expired');
});
