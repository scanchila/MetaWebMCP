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
