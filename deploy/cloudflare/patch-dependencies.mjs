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
