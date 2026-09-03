import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_CAPABILITY_COOKIE,
  browserCapabilityCookie,
  issueBrowserCapability,
  readBrowserCapabilityCookie,
  verifyBrowserCapability,
  verifyBrowserCapabilityCookie,
} from '../lib/browser-capability.mjs';

const SECRET = 'test-browser-capability-secret-value';
const OTHER_SECRET = 'different-browser-capability-secret';
const NOW = 1_800_000_000_000;

test('signed browser capabilities expire and reject tampering', async () => {
  const issued = await issueBrowserCapability(SECRET, { now: NOW, ttlSeconds: 120 });
  assert.match(issued.id, /^[a-zA-Z0-9_-]{24}$/);
  assert.deepEqual(
    await verifyBrowserCapability(issued.token, SECRET, { now: NOW + 60_000 }),
    { id: issued.id, issuedAt: 1_800_000_000, expiresAt: 1_800_000_120 },
  );
  assert.equal(await verifyBrowserCapability(issued.token, OTHER_SECRET, { now: NOW }), null);
  assert.equal(await verifyBrowserCapability(`${issued.token}x`, SECRET, { now: NOW }), null);
  assert.equal(await verifyBrowserCapability(issued.token, SECRET, { now: NOW + 120_000 }), null);
});

test('browser capability cookies are HttpOnly, scoped, and unambiguous', async () => {
  const issued = await issueBrowserCapability(SECRET, { now: NOW, ttlSeconds: 120 });
  const header = browserCapabilityCookie(issued.token, { ttlSeconds: 120 });
  assert.match(header, new RegExp(`^${BROWSER_CAPABILITY_COOKIE}=`));
  assert.match(header, /Path=\//);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=120/);
  assert.match(header, /Secure/);
  assert.equal(readBrowserCapabilityCookie(header), issued.token);
  assert.deepEqual(
    await verifyBrowserCapabilityCookie(header, SECRET, { now: NOW }),
    { id: issued.id, issuedAt: 1_800_000_000, expiresAt: 1_800_000_120 },
  );
  assert.equal(
    readBrowserCapabilityCookie(`${header}; ${BROWSER_CAPABILITY_COOKIE}=duplicate`),
    '',
  );
});
