import { readFile, writeFile } from 'node:fs/promises';

const agentEntryFiles = [
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/esm/index.js',
    originalConnection: `  const connection = createConnection({
    capabilities: ["core", "tabs", "pdf", "history", "wait", "files", "testing"],
    browser: {
      cdpEndpoint
    },
    ...options
  });`,
    isolatedConnection: `  const connectionOptions = {
    capabilities: ["core", "tabs", "pdf", "history", "wait", "files", "testing"],
    browser: {
      cdpEndpoint
    },
    ...options
  };`,
    originalServer: '      this.server = connection.then((server) => server.server);',
    isolatedServer: '      this.server = createConnection(connectionOptions).then((server) => server.server);',
  },
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/cjs/index.js',
    originalConnection: `  const connection = index.createConnection({
    capabilities: ["core", "tabs", "pdf", "history", "wait", "files", "testing"],
    browser: {
      cdpEndpoint
    },
    ...options
  });`,
    isolatedConnection: `  const connectionOptions = {
    capabilities: ["core", "tabs", "pdf", "history", "wait", "files", "testing"],
    browser: {
      cdpEndpoint
    },
    ...options
  };`,
    originalServer: '      this.server = connection.then((server) => server.server);',
    isolatedServer: '      this.server = index.createConnection(connectionOptions).then((server) => server.server);',
  },
];

for (const { file, originalConnection, isolatedConnection, originalServer, isolatedServer } of agentEntryFiles) {
  const installedSource = await readFile(file, 'utf8');
  let source = installedSource;
  if (!source.includes(isolatedConnection)) {
    if (!source.includes(originalConnection)) throw new Error(`Unexpected Playwright MCP agent factory in ${file}.`);
    source = source.replace(originalConnection, isolatedConnection);
  }
  if (!source.includes(isolatedServer)) {
    if (!source.includes(originalServer)) throw new Error(`Unexpected Playwright MCP server assignment in ${file}.`);
    source = source.replace(originalServer, isolatedServer);
  }
  if (source !== installedSource) await writeFile(file, source);
}

const snapshotFiles = [
  'node_modules/@cloudflare/playwright-mcp/lib/esm/src/pageSnapshot.js',
  'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/pageSnapshot.js',
];
const originalSnapshotFormatter = '      snapshot,\n      "```"';
const compatibleSnapshotFormatter = '      typeof snapshot === "string" ? snapshot : snapshot.full ?? snapshot.incremental ?? JSON.stringify(snapshot),\n      "```"';
const originalSnapshotCall = 'page._snapshotForAI()';
const compatibleSnapshotCall = 'page._snapshotForAI({ track: "response" })';

for (const file of snapshotFiles) {
  const installedSource = await readFile(file, 'utf8');
  let source = installedSource;
  if (!source.includes(compatibleSnapshotCall)) {
    if (!source.includes(originalSnapshotCall)) throw new Error(`Unexpected Playwright MCP snapshot call in ${file}.`);
    source = source.replace(originalSnapshotCall, compatibleSnapshotCall);
  }
  if (!source.includes(compatibleSnapshotFormatter)) {
    if (!source.includes(originalSnapshotFormatter)) throw new Error(`Unexpected Playwright MCP snapshot formatter in ${file}.`);
    source = source.replace(originalSnapshotFormatter, compatibleSnapshotFormatter);
  }
  if (source !== installedSource) await writeFile(file, source);
}

const locatorFiles = [
  'node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/utils.js',
  'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/utils.js',
];
const originalLocatorGenerator = '    return await locator._generateLocatorString();';
const compatibleLocatorGenerator = `    if (typeof locator?._generateLocatorString === "function")
      return await locator._generateLocatorString();
    if (typeof locator?._resolveSelector === "function") {
      const { resolvedSelector } = await locator._resolveSelector();
      const resolvedLocator = locator.page?.().locator?.(resolvedSelector);
      const resolvedDescription = resolvedLocator?.toString?.();
      if (typeof resolvedDescription === "string" && resolvedDescription && resolvedDescription !== "[object Object]")
        return resolvedDescription;
    }
    const description = locator?.toString?.();
    if (typeof description === "string" && description && description !== "[object Object]")
      return description;
    throw new Error("Locator does not expose a supported string generator.");`;

for (const file of locatorFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes(compatibleLocatorGenerator)) continue;
  if (!source.includes(originalLocatorGenerator)) throw new Error(`Unexpected Playwright MCP locator generator in ${file}.`);
  await writeFile(file, source.replace(originalLocatorGenerator, compatibleLocatorGenerator));
}

const screenshotFiles = [
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/esm/src/tools/screenshot.js',
    configImport: "import { outputFile } from '../config.js';\n",
    originalSetup: '    const fileName = await outputFile(context.config, params.filename ?? `page-${(/* @__PURE__ */ new Date()).toISOString()}.${fileType}`);\n    const options = { type: fileType, quality: fileType === "png" ? void 0 : 50, scale: "css", path: fileName };',
  },
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/tools/screenshot.js',
    configImport: "const config = require('../config.js');\n",
    originalSetup: '    const fileName = await config.outputFile(context.config, params.filename ?? `page-${(/* @__PURE__ */ new Date()).toISOString()}.${fileType}`);\n    const options = { type: fileType, quality: fileType === "png" ? void 0 : 50, scale: "css", path: fileName };',
  },
];
const compatibleScreenshotSetup = '    const options = { type: fileType, quality: fileType === "png" ? void 0 : 50, scale: "css" };';
const originalScreenshotCode = '    const code = [\n      `// Screenshot ${isElementScreenshot ? params.element : "viewport"} and save it as ${fileName}`\n    ];';
const compatibleScreenshotCode = '    const code = [\n      `// Capture ${isElementScreenshot ? params.element : "viewport"} screenshot and return it inline`\n    ];';
const originalFilenameDescription = 'File name to save the screenshot to. Defaults to `page-{timestamp}.{png|jpeg}` if not specified.';
const compatibleFilenameDescription = 'Suggested screenshot name for compatible clients. Cloudflare returns the image inline.';

for (const { file, configImport, originalSetup } of screenshotFiles) {
  const installedSource = await readFile(file, 'utf8');
  let source = installedSource;
  if (source.includes(configImport)) source = source.replace(configImport, '');
  if (!source.includes(compatibleScreenshotSetup)) {
    if (!source.includes(originalSetup)) throw new Error(`Unexpected Playwright MCP screenshot setup in ${file}.`);
    source = source.replace(originalSetup, compatibleScreenshotSetup);
  }
  if (!source.includes(compatibleScreenshotCode)) {
    if (!source.includes(originalScreenshotCode)) throw new Error(`Unexpected Playwright MCP screenshot trace in ${file}.`);
    source = source.replace(originalScreenshotCode, compatibleScreenshotCode);
  }
  if (!source.includes(compatibleFilenameDescription)) {
    if (!source.includes(originalFilenameDescription)) throw new Error(`Unexpected Playwright MCP screenshot schema in ${file}.`);
    source = source.replace(originalFilenameDescription, compatibleFilenameDescription);
  }
  if (source !== installedSource) await writeFile(file, source);
}

const chromiumPageFile = 'node_modules/@cloudflare/playwright/lib/playwright-core/src/server/chromium/crPage.js';
const originalViewportMetrics = '    const { visualViewport } = await progress.race(this._mainFrameSession._client.send("Page.getLayoutMetrics"));';
const compatibleViewportMetrics = `    const layoutMetrics = await progress.race(this._mainFrameSession._client.send("Page.getLayoutMetrics"));
    const visualViewport = layoutMetrics.cssVisualViewport ?? layoutMetrics.visualViewport;
    if (!visualViewport)
      throw new Error("Browser did not return viewport metrics for screenshot.");`;

{
  const source = await readFile(chromiumPageFile, 'utf8');
  if (!source.includes(compatibleViewportMetrics)) {
    if (!source.includes(originalViewportMetrics)) throw new Error(`Unexpected Playwright viewport metrics in ${chromiumPageFile}.`);
    await writeFile(chromiumPageFile, source.replace(originalViewportMetrics, compatibleViewportMetrics));
  }
}

const connectionFiles = [
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/esm/src/connection.js',
    original: '  const tools = allTools.filter((tool) => !config.capabilities || tool.capability === "core" || config.capabilities.includes(tool.capability));',
    compatible: '  const tools = allTools.filter((tool) => (!config.capabilities || tool.capability === "core" || config.capabilities.includes(tool.capability)) && (!config.allowedTools || config.allowedTools.includes(tool.schema.name)));',
  },
  {
    file: 'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/connection.js',
    original: '  const tools$1 = allTools.filter((tool) => !config.capabilities || tool.capability === "core" || config.capabilities.includes(tool.capability));',
    compatible: '  const tools$1 = allTools.filter((tool) => (!config.capabilities || tool.capability === "core" || config.capabilities.includes(tool.capability)) && (!config.allowedTools || config.allowedTools.includes(tool.schema.name)));',
  },
];

for (const { file, original, compatible } of connectionFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes(compatible)) continue;
  if (!source.includes(original)) throw new Error(`Unexpected Playwright MCP tool filtering in ${file}.`);
  await writeFile(file, source.replace(original, compatible));
}

const contextFiles = [
  'node_modules/@cloudflare/playwright-mcp/lib/esm/src/context.js',
  'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/context.js',
];
const originalInterception = `  async _setupRequestInterception(context) {
    if (this.config.network?.allowedOrigins?.length) {`;
const compatibleInterception = `  async _setupRequestInterception(context) {
    if (this.config.network?.blockPrivate && !this.config.network?.requestHandler)
      throw new Error("blockPrivate requires a connection-level request handler.");
    if (this.config.network?.requestHandler)
      await context.route("**", (route) => this.config.network.requestHandler(route));
    if (this.config.network?.blockWebSockets)
      await context.routeWebSocket("**", (route) => route.close({ code: 1008, reason: "Direct network access is disabled." }));
    if (this.config.network?.initScript)
      await context.addInitScript(this.config.network.initScript);
    if (this.config.network?.allowedOrigins?.length) {`;

for (const file of contextFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes(compatibleInterception)) continue;
  if (!source.includes(originalInterception)) throw new Error(`Unexpected Playwright MCP network interception in ${file}.`);
  await writeFile(file, source.replace(originalInterception, compatibleInterception));
}
