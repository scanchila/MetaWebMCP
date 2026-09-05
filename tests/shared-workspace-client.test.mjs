import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSharedWorkspaceLocation,
  sharedWorkspaceLinks,
  SharedWorkspaceClient,
} from '../public/js/shared-workspace.js';

const id = '123e4567-e89b-42d3-a456-426614174000';
const writeToken = 'w'.repeat(43);
const readToken = 'r'.repeat(43);

test('shared workspace links keep bearer capabilities in the URL fragment', () => {
  const links = sharedWorkspaceLinks({
    baseUrl: 'https://metawebmcp.example/path?old=value#home',
    id,
    writeToken,
    readToken,
  });

  assert.equal(links.authorUrl, `https://metawebmcp.example/#workspace?shared=${id}&role=author&token=${writeToken}`);
  assert.equal(links.viewerUrl, `https://metawebmcp.example/#workspace?shared=${id}&role=viewer&token=${readToken}`);
  assert.deepEqual(parseSharedWorkspaceLocation(new URL(links.authorUrl)), {
    id,
    role: 'author',
    token: writeToken,
  });
  assert.deepEqual(parseSharedWorkspaceLocation(new URL(links.viewerUrl)), {
    id,
    role: 'viewer',
    token: readToken,
  });
});

test('shared workspace client authenticates API requests without placing tokens in request URLs', async () => {
  const requests = [];
  let capabilityChecks = 0;
  const responses = [
    new Response(JSON.stringify({ ok: true, id, writeToken, readToken }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ ok: true, id, revision: 1, workspace: { version: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(null, { status: 204 }),
  ];
  const client = new SharedWorkspaceClient({
    baseUrl: 'https://metawebmcp.example/',
    ensureCapability: async () => { capabilityChecks += 1; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
  });

  const created = await client.create();
  assert.equal(capabilityChecks, 1);
  assert.equal(created.links.viewerUrl.includes(readToken), true);

  const saved = await client.save({ id, token: writeToken, workspace: { version: 1 } });
  assert.equal(saved.revision, 1);
  const unchanged = await client.load({ id, token: readToken, afterRevision: 1 });
  assert.deepEqual(unchanged, { changed: false });

  assert.equal(requests[0].url, 'https://metawebmcp.example/api/shared-workspaces');
  assert.equal(requests[1].url, `https://metawebmcp.example/api/shared-workspaces/${id}`);
  assert.equal(requests[2].url, `https://metawebmcp.example/api/shared-workspaces/${id}?after=1`);
  assert.equal(requests[1].options.headers.authorization, `Bearer ${writeToken}`);
  assert.equal(requests[2].options.headers.authorization, `Bearer ${readToken}`);
  assert.equal(requests.every((request) => !request.url.includes(writeToken) && !request.url.includes(readToken)), true);
});
