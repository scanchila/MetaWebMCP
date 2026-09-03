import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { generateLocator } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/utils.js');
const { PageSnapshot } = await import('./node_modules/@cloudflare/playwright-mcp/lib/esm/src/pageSnapshot.js');
const { default: screenshotTools } = await import(
  './node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/screenshot.js'
);
const { default: snapshotTools } = await import(
  './node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/snapshot.js'
);

const agentsPackage = JSON.parse(await readFile(
 './node_modules/@cloudflare/playwright-mcp/node_modules/agents/package.json',
  'utf8',
));
assert.equal(
  agentsPackage.version,
  '0.22.0',
  'the Cloudflare agent runtime should stay on the reviewed compatibility pin',
);

const mcpSdkPackage = JSON.parse(await readFile(
 './node_modules/@modelcontextprotocol/sdk/package.json',
  'utf8',
));
assert.equal(
  mcpSdkPackage.version,
  '1.30.0',
  'the MCP SDK should stay on the reviewed compatibility pin',
);

const agentEntrySource = await readFile(
  './node_modules/@cloudflare/playwright-mcp/lib/esm/index.js',
  'utf8',
);
const evaluateAgentFactory = new Function(
  'McpAgent',
  'endpointURLString',
  'createConnection',
  agentEntrySource
    .replace(/^import .*;\n/gm, '')
    .replace(/\nexport \{ createMcpAgent \};\s*$/, '\nreturn createMcpAgent;'),
);
let connectionCount = 0;
const createMcpAgent = evaluateAgentFactory(
  class {},
  String,
  async () => ({ server: { id: ++connectionCount } }),
);
const IsolatedAgent = createMcpAgent('https://browser.example');
const firstAgent = new IsolatedAgent();
const secondAgent = new IsolatedAgent();
const [firstServer, secondServer] = await Promise.all([firstAgent.server, secondAgent.server]);
assert.equal(connectionCount, 2, 'each Durable Object instance should create its own MCP protocol server');
assert.notStrictEqual(firstServer, secondServer, 'MCP protocol servers must not be shared across transports');
assert.match(
  await readFile('./node_modules/@cloudflare/playwright-mcp/lib/cjs/index.js', 'utf8'),
  /this\.server = index\.createConnection\(connectionOptions\)/,
  'the CommonJS agent factory should also isolate protocol servers by instance',
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

const clickTool = snapshotTools.find((tool) => tool.schema.name === 'browser_click');
assert.ok(clickTool, 'the click tool should remain available');
let pressedKey;
const geometryFailure = new Error(`locator.click: Timeout 5000ms exceeded.
Call log:
  - scrolling into view if needed
  - done scrolling
  - element is not visible`);
const clickAction = await clickTool.handle(
  {
    currentTabOrDie: () => ({
      snapshotOrDie: () => ({
        refLocator: () => ({
          _generateLocatorString: async () => "getByRole('button', { name: 'Search' })",
          click: async () => { throw geometryFailure; },
          isVisible: async () => true,
          isEnabled: async () => true,
          press: async (key) => { pressedKey = key; },
        }),
      }),
    }),
  },
  { element: 'Search', ref: 'e1' },
);
await clickAction.action();
assert.equal(
  pressedKey,
  'Enter',
  'a pointer action without Kitesurf geometry should keyboard-activate the same referenced control',
);
let hiddenControlActivated = false;
const hiddenClickAction = await clickTool.handle(
  {
    currentTabOrDie: () => ({
      snapshotOrDie: () => ({
        refLocator: () => ({
          _generateLocatorString: async () => "getByRole('button', { name: 'Hidden action' })",
          click: async () => { throw geometryFailure; },
          isVisible: async () => false,
          isEnabled: async () => true,
          press: async () => { hiddenControlActivated = true; },
        }),
      }),
    }),
  },
  { element: 'Hidden action', ref: 'e2' },
);
await assert.rejects(hiddenClickAction.action(), (error) => error === geometryFailure);
assert.equal(hiddenControlActivated, false, 'hidden controls should fail closed instead of using keyboard activation');

const chromiumPageSource = await readFile(
  './node_modules/@cloudflare/playwright/lib/playwright-core/src/server/chromium/crPage.js',
  'utf8',
);
assert.match(
  chromiumPageSource,
  /layoutMetrics\.cssVisualViewport \?\? layoutMetrics\.visualViewport/,
  'Kitesurf screenshots should accept the current CSS visual viewport response shape',
);
assert.match(
  chromiumPageSource,
  /if \(!visualViewport\) \{[\s\S]*Page\.captureScreenshot[\s\S]*return Buffer\.from\(result\.data, "base64"\)/,
  'Kitesurf viewport screenshots should fall back to its protocol-level capture response',
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
assert.doesNotMatch(
  await readFile('./node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/screenshot.js', 'utf8'),
  /config\.outputFile|path: fileName/,
  'the CommonJS screenshot tool should also avoid persistent filesystem output',
);

for (const build of ['esm', 'cjs']) {
  const connectionSource = await readFile(
    `./node_modules/@cloudflare/playwright-mcp/lib/${build}/src/connection.js`,
    'utf8',
  );
  assert.match(
    connectionSource,
    /config\.allowedTools\.includes\(tool\.schema\.name\)/,
    `${build} tool discovery should honor the deployment allowlist`,
  );
  const contextSource = await readFile(
    `./node_modules/@cloudflare/playwright-mcp/lib/${build}/src/context.js`,
    'utf8',
  );
  assert.match(contextSource, /blockPrivate requires a connection-level request handler/);
  assert.match(contextSource, /this\.config\.network\.requestHandler\(route\)/);
  assert.match(contextSource, /context\.routeWebSocket/);
  assert.match(contextSource, /context\.addInitScript/);
  assert.doesNotMatch(contextSource, /const blockedIpv4/);
}

console.log('Cloudflare Playwright MCP compatibility checks passed.');
