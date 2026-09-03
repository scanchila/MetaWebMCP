#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { flattenMcpText, McpSseClient } from '../lib/mcp-http-client.mjs';

const BASE_URL = 'https://www.metrocuadrado.com/apartamentos/arriendo/bogota/economicos/';
const DEFAULT_ENDPOINT = 'http://localhost:8936/sse';
const TARGET_COUNT = 10;

function usage() {
  return 'Usage: node scripts/capture-metrocuadrado-benchmark.mjs [--endpoint URL] [--output PATH]\n';
}

function parseArguments(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT, output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--endpoint' || argument === '--output') {
      options[argument.slice(2)] = argv[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function lineIndent(line) {
  return (String(line).match(/^\s*/)?.[0] || '').replace(/\t/g, '  ').length;
}

function decoded(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

export function extractVisibleListingLinks(snapshot, baseUrl = BASE_URL) {
  const lines = String(snapshot || '').split(/\r?\n/);
  const links = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-\s*link\s+"((?:\\.|[^"])*)"[^\n]*\[ref=/i);
    if (!match) continue;
    const indent = lineIndent(lines[index]);
    let href = '';
    for (let child = index + 1; child < lines.length; child += 1) {
      if (!lines[child].trim()) continue;
      if (lineIndent(lines[child]) <= indent) break;
      const urlMatch = lines[child].match(/^\s*-\s*\/url:\s*(.+?)\s*$/i);
      if (urlMatch) {
        href = urlMatch[1].replace(/^"|"$/g, '');
        break;
      }
    }
    if (!href) continue;
    const url = new URL(href, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/inmueble/arriendo-apartamento-bogota')) continue;
    url.search = '';
    url.hash = '';
    links.push({ label: decoded(match[1]), url: url.href });
  }
  return links;
}

function normalizedText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function localizedInteger(value) {
  const parsed = Number(String(value || '').replace(/[.\s]/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeVisibleListing(link) {
  const text = normalizedText(link.label);
  const rent = localizedInteger(text.match(/\$\s*([0-9][0-9.]*)/)?.[1]);
  const bedrooms = localizedInteger(
    text.match(/\b(\d+)\s+hab\./)?.[1]
      ?? text.match(/\bcon\s+(\d+)\s+habitacion(?:es)?\b/)?.[1],
  );
  const areaM2 = localizedInteger(
    text.match(/\b(\d+(?:[.,]\d+)?)\s*m²(?:\s|$)/)?.[1]
      ?? text.match(/\barea\s+(\d+(?:[.,]\d+)?)\s*m2\b/)?.[1],
  );
  return { url: link.url, rentCop: rent, bedrooms, areaM2 };
}

export function qualifies(listing) {
  return Number.isFinite(listing.rentCop)
    && listing.bedrooms >= 2
    && listing.areaM2 >= 45
    && listing.areaM2 <= 100;
}

export function byRequestedOrder(left, right) {
  return left.rentCop - right.rentCop
    || right.areaM2 - left.areaM2
    || left.url.localeCompare(right.url);
}

async function capture(endpoint) {
  const startedAt = new Date().toISOString();
  const client = new McpSseClient(endpoint, {
    clientInfo: { name: 'metawebmcp-metrocuadrado-oracle', version: '1.0.0' },
  });
  try {
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const required of ['browser_navigate', 'browser_wait_for', 'browser_snapshot']) {
      if (!names.has(required)) throw new Error(`Connected browser MCP does not expose ${required}.`);
    }
    await client.callTool('browser_navigate', { url: BASE_URL });
    await client.callTool('browser_wait_for', { time: 2 });
    const snapshot = flattenMcpText(await client.callTool('browser_snapshot', {}));
    const rawLinks = extractVisibleListingLinks(snapshot);
    const unique = new Map();
    for (const link of rawLinks) {
      const listing = normalizeVisibleListing(link);
      if (!unique.has(listing.url)) unique.set(listing.url, listing);
    }
    const eligible = [...unique.values()].filter(qualifies).sort(byRequestedOrder);
    return {
      schemaVersion: 1,
      benchmark: 'metrocuadrado-cheapest-visible-v1',
      source: {
        site: 'Metrocuadrado',
        url: BASE_URL,
        startedAt,
        completedAt: new Date().toISOString(),
        volatile: true,
      },
      task: {
        requestedResults: TARGET_COUNT,
        scope: 'All promoted and ordinary linked apartment cards visible on the first Menor precio page.',
        minimumBedrooms: 2,
        minimumAreaM2: 45,
        maximumAreaM2: 100,
        ranking: 'Displayed monthly rent ascending, then area descending, then canonical URL ascending.',
      },
      capture: {
        snapshotCharacters: snapshot.length,
        snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
        rawListingLinks: rawLinks.length,
        uniqueListingLinks: unique.size,
        duplicateOccurrences: rawLinks.length - unique.size,
        qualifyingUniqueListings: eligible.length,
        completeVisibleTop10: eligible.length >= TARGET_COUNT,
      },
      expected: eligible.slice(0, TARGET_COUNT).map((listing, index) => ({ rank: index + 1, ...listing })),
      limitations: [
        'This is a point-in-time observation of volatile third-party listings, not availability or price verification.',
        'Completeness is scoped to cards rendered on the first public results page, including promoted cards; it is not a claim about every Metrocuadrado listing.',
        'A fixed tall viewport is required because the site lazy-renders result cards below the fold.',
      ],
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await capture(options.endpoint);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, 'utf8');
  process.stdout.write(serialized);
  if (!result.capture.completeVisibleTop10) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
