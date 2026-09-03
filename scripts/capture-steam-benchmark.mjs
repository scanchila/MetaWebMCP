#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { flattenMcpText, McpSseClient } from '../lib/mcp-http-client.mjs';

const BASE_URL = 'https://store.steampowered.com/search/?sort_by=Price_ASC&os=win&specials=1&ndl=1&cc=us&l=english&page=1';
const DEFAULT_ENDPOINT = 'http://localhost:8942/sse';
const FIRST_PAGE = 1;
const LAST_PAGE = 20;
const TARGET_COUNT = 50;

function usage() {
  return 'Usage: node scripts/capture-steam-benchmark.mjs [--endpoint URL] [--output PATH]\n';
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

function canonicalAppUrl(value) {
  try {
    const url = new URL(value, BASE_URL);
    const match = url.pathname.match(/^\/app\/(\d+)(?:\/|$)/);
    if (url.origin !== 'https://store.steampowered.com' || !match) return null;
    return { appId: Number(match[1]), url: `${url.origin}${url.pathname}` };
  } catch {
    return null;
  }
}

export function extractVisibleGameLinks(snapshot, baseUrl = BASE_URL) {
  const lines = String(snapshot || '').split(/\r?\n/);
  const links = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-\s*'?link\s+"((?:\\.|[^"])*)"[^\n]*\[ref=/i);
    if (!match) continue;
    const indent = lineIndent(lines[index]);
    let href = '';
    for (let child = index + 1; child < lines.length; child += 1) {
      if (!lines[child].trim()) continue;
      if (lineIndent(lines[child]) <= indent) break;
      const urlMatch = lines[child].match(/^\s*-\s*\/url:\s*(.+?)\s*$/i);
      if (urlMatch && !href) href = urlMatch[1].replace(/^"|"$/g, '');
    }
    if (!href) continue;
    const canonical = canonicalAppUrl(href);
    if (!canonical) continue;
    links.push({ label: decoded(match[1]), ...canonical });
  }
  return links;
}

function moneyOccurrences(value) {
  return [...String(value).matchAll(/\$\s*([0-9][0-9.,]*)/g)]
    .map((match) => Number(match[1].replace(/,/g, '')))
    .filter(Number.isFinite);
}

export function normalizeVisibleGame(link) {
  const prices = moneyOccurrences(link.label);
  const discountPct = Number(link.label.match(/\b(\d+)%\s+off\b/i)?.[1]);
  return {
    appId: link.appId,
    appUrl: link.url,
    discountPct: Number.isFinite(discountPct) ? discountPct : null,
    originalPriceUsd: prices[0] ?? null,
    salePriceUsd: prices[1] ?? null,
  };
}

export function qualifies(game) {
  return game.discountPct >= 50
    && game.discountPct <= 80
    && game.originalPriceUsd >= 0.99
    && game.salePriceUsd >= 0
    && game.salePriceUsd <= 0.49;
}

export function byRequestedOrder(left, right) {
  return left.salePriceUsd - right.salePriceUsd
    || right.discountPct - left.discountPct
    || right.originalPriceUsd - left.originalPriceUsd
    || left.appUrl.localeCompare(right.appUrl);
}

function pageUrl(page) {
  const url = new URL(BASE_URL);
  url.searchParams.set('page', String(page));
  return url.href;
}

async function capture(endpoint) {
  const startedAt = new Date().toISOString();
  const client = new McpSseClient(endpoint, {
    clientInfo: { name: 'metawebmcp-steam-oracle', version: '1.0.0' },
  });
  try {
    const tools = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    for (const required of ['browser_navigate']) {
      if (!names.has(required)) throw new Error(`Connected browser MCP does not expose ${required}.`);
    }

    const unique = new Map();
    const pages = [];
    let rawGameLinks = 0;
    for (let page = FIRST_PAGE; page <= LAST_PAGE; page += 1) {
      const snapshot = flattenMcpText(await client.callTool('browser_navigate', { url: pageUrl(page) }));
      const links = extractVisibleGameLinks(snapshot, pageUrl(page));
      rawGameLinks += links.length;
      for (const link of links) {
        const game = normalizeVisibleGame(link);
        const previous = unique.get(game.appId);
        if (!previous || link.label.length > previous.labelLength) {
          unique.set(game.appId, { ...game, labelLength: link.label.length });
        }
      }
      pages.push({
        page,
        snapshotCharacters: snapshot.length,
        snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
        gameLinks: links.length,
      });
    }

    const games = [...unique.values()].map(({ labelLength, ...game }) => game);
    const eligible = games.filter(qualifies).sort(byRequestedOrder);
    return {
      schemaVersion: 1,
      benchmark: 'steam-discounted-games-first-20-pages-v1',
      source: {
        site: 'Steam Store',
        url: BASE_URL,
        startedAt,
        completedAt: new Date().toISOString(),
        volatile: true,
      },
      task: {
        requestedResults: TARGET_COUNT,
        firstPage: FIRST_PAGE,
        lastPage: LAST_PAGE,
        minimumDiscountPct: 50,
        maximumDiscountPct: 80,
        minimumOriginalPriceUsd: 0.99,
        maximumSalePriceUsd: 0.49,
        ranking: 'Sale price ascending, discount descending, original price descending, canonical app URL ascending.',
      },
      capture: {
        pages,
        pagesScanned: pages.length,
        rawGameLinks,
        uniqueGames: unique.size,
        duplicateOccurrences: rawGameLinks - unique.size,
        qualifyingUniqueGames: eligible.length,
        completeScopedTop50: pages.length === LAST_PAGE - FIRST_PAGE + 1
          && pages.every((page) => page.gameLinks > 0)
          && eligible.length >= TARGET_COUNT,
      },
      expected: eligible.slice(0, TARGET_COUNT).map((game, index) => ({ rank: index + 1, ...game })),
      limitations: [
        'This is a point-in-time observation of volatile Steam search results and sale prices.',
        'Completeness is intentionally limited to the first 20 pages of the exact public query.',
        'URL matching ignores tracking query parameters and fragments but requires the same Steam app ID.',
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
  if (!result.capture.completeScopedTop50) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
