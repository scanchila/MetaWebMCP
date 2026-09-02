import { readFile, writeFile } from 'node:fs/promises';

const files = [
  'node_modules/@cloudflare/playwright-mcp/lib/esm/src/pageSnapshot.js',
  'node_modules/@cloudflare/playwright-mcp/lib/cjs/src/pageSnapshot.js',
];
const original = '      snapshot,\n      "```"';
const replacement = '      typeof snapshot === "string" ? snapshot : snapshot.full ?? snapshot.incremental ?? JSON.stringify(snapshot),\n      "```"';

for (const file of files) {
  const source = await readFile(file, 'utf8');
  if (source.includes(replacement)) continue;
  if (!source.includes(original)) throw new Error(`Unexpected Playwright MCP snapshot formatter in ${file}.`);
  await writeFile(file, source.replace(original, replacement));
}
