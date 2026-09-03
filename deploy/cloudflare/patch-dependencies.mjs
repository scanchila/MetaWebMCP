import { readFile, writeFile } from 'node:fs/promises';

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
    if (this.config.network?.blockPrivate) {
      await context.route("**", (route) => {
        let hostname = "";
        try {
          hostname = new URL(route.request().url()).hostname.replace(/^\\[|\\]$/g, "").toLowerCase();
        } catch {
          return route.abort("blockedbyclient");
        }
        const parts = hostname.split(".").map(Number);
        const ipv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
        const [a, b, c] = parts;
        const blockedIpv4 = ipv4 && (a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113);
        const blockedIpv6 = hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:") || /^(?:fc|fd|fe[89ab]|ff)/.test(hostname) || hostname === "2001:db8::" || hostname.startsWith("2001:db8:");
        const blockedName = !hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname === "home.arpa" || hostname.endsWith(".home.arpa");
        return blockedIpv4 || blockedIpv6 || blockedName ? route.abort("blockedbyclient") : route.continue();
      });
    }
    if (this.config.network?.allowedOrigins?.length) {`;

for (const file of contextFiles) {
  const source = await readFile(file, 'utf8');
  if (source.includes(compatibleInterception)) continue;
  if (!source.includes(originalInterception)) throw new Error(`Unexpected Playwright MCP network interception in ${file}.`);
  await writeFile(file, source.replace(originalInterception, compatibleInterception));
}
