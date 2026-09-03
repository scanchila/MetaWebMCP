import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { generateLocator } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/utils.js');
const { PageSnapshot } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/pageSnapshot.js');

let snapshotOptions;
const snapshot = await PageSnapshot.create({
  _wrapApiCall: (callback) => callback(),
  _snapshotForAI: async (options) => {
    snapshotOptions = options;
    return { full: '- searchbox "Search" [ref=e1]', incremental: '' };
  },
});
assert.deepEqual(
  snapshotOptions,
  { track: 'response' },
  'current Cloudflare Playwright snapshots should retain actionable refs for the response',
);
assert.match(snapshot.text(), /searchbox "Search" \[ref=e1\]/);

assert.equal(
  await generateLocator({ _generateLocatorString: async () => "getByRole('button', { name: 'Search' })" }),
  "getByRole('button', { name: 'Search' })",
  'legacy Playwright locators should keep using their native generator',
);

assert.equal(
  await generateLocator({ toString: () => "getByRole('searchbox', { name: 'Search Wikipedia' })" }),
  "getByRole('searchbox', { name: 'Search Wikipedia' })",
  'current Cloudflare Playwright locators should fall back to their public string representation',
);

let resolvedSelector;
assert.equal(
  await generateLocator({
    _resolveSelector: async () => ({ resolvedSelector: 'internal:role=searchbox[name="Search Wikipedia"i]' }),
    page: () => ({
      locator: (selector) => {
        resolvedSelector = selector;
        return { toString: () => "getByRole('searchbox', { name: 'Search Wikipedia' })" };
      },
    }),
    toString: () => "locator('aria-ref=e1')",
  }),
  "getByRole('searchbox', { name: 'Search Wikipedia' })",
  'current Cloudflare Playwright refs should resolve to stable selectors before actions run',
);
assert.equal(resolvedSelector, 'internal:role=searchbox[name="Search Wikipedia"i]');

await assert.rejects(
  generateLocator({}),
  /does not expose a supported string generator/,
  'unknown locator shapes should fail closed',
);

await assert.rejects(
  generateLocator({
    _generateLocatorString: async () => {
      throw new Error('locator._generateLocatorString: No element matching locator');
    },
  }),
  /Ref not found/,
  'legacy stale-reference errors should retain their actionable message',
);

const commonJsPatch = await readFile(
  './node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/utils.js',
  'utf8',
);
assert.match(
  commonJsPatch,
  /typeof locator\?\._generateLocatorString === "function"/,
  'the CommonJS build should receive the same guarded compatibility patch',
);

console.log('Cloudflare Playwright MCP compatibility checks passed.');
