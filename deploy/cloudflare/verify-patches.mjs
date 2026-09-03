import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { generateLocator } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/utils.js');
const { PageSnapshot } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/pageSnapshot.js');
const { default: screenshotTools } = await import(
  './node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/screenshot.js'
);

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

const screenshotTool = screenshotTools.find((tool) => tool.schema.name === 'browser_take_screenshot');
assert.ok(screenshotTool, 'the screenshot tool should remain available');
let screenshotOptions;
const screenshotAction = await screenshotTool.handle(
  {
    currentTabOrDie: () => ({
      snapshotOrDie: () => ({}),
      page: {
        screenshot: async (options) => {
          screenshotOptions = options;
          return Buffer.from('inline screenshot');
        },
      },
    }),
    clientSupportsImages: () => true,
  },
  { raw: true, filename: 'evidence.png' },
);
const screenshotResult = await screenshotAction.action();
assert.equal(
  Object.hasOwn(screenshotOptions, 'path'),
  false,
  'Cloudflare screenshots should stay in memory instead of requesting persistent filesystem output',
);
assert.deepEqual(screenshotResult.content, [
  {
    type: 'image',
    data: Buffer.from('inline screenshot').toString('base64'),
    mimeType: 'image/png',
  },
]);

const commonJsPatch = await readFile(
  './node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/utils.js',
  'utf8',
);
assert.match(
  commonJsPatch,
  /typeof locator\?\._generateLocatorString === "function"/,
  'the CommonJS build should receive the same guarded compatibility patch',
);
assert.doesNotMatch(
  await readFile('./node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/screenshot.js', 'utf8'),
  /config\.outputFile|path: fileName/,
  'the CommonJS screenshot tool should also avoid persistent filesystem output',
);

console.log('Cloudflare Playwright MCP compatibility checks passed.');
