#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TARGET_COUNT = 50;
const SCOPED_PAGES = 20;

function parseArguments(argv) {
  const options = { oracle: '', candidate: '', output: '', candidateKind: 'final' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (['--oracle', '--candidate', '--output', '--candidate-kind'].includes(argument)) {
      const key = argument.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = argv[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.oracle || !options.candidate) throw new Error('--oracle and --candidate are required.');
  if (!['final', 'trace'].includes(options.candidateKind)) throw new Error('--candidate-kind must be final or trace.');
  return options;
}

function canonicalApp(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/app\/(\d+)(?:\/|$)/);
    if (url.origin !== 'https://store.steampowered.com' || !match) return { appId: null, url: '' };
    return { appId: Number(match[1]), url: `${url.origin}${url.pathname}` };
  } catch {
    return { appId: null, url: '' };
  }
}

function mappedCandidate(candidate, index) {
  const canonical = canonicalApp(candidate.app_url);
  return {
    rank: index + 1,
    appId: candidate.app_id,
    urlAppId: canonical.appId,
    appUrl: canonical.url,
    discountPct: candidate.discount_pct,
    originalPriceUsd: candidate.original_price_usd,
    salePriceUsd: candidate.sale_price_usd,
  };
}

function normalizedCandidate(document, kind) {
  if (kind === 'trace') {
    return {
      status: document.execution ? 'completed' : 'failed',
      pagesScanned: document.execution?.pagesScanned ?? 0,
      executorComplete: document.execution?.complete ?? null,
      results: document.execution?.results || [],
    };
  }
  return {
    status: document.status,
    pagesScanned: document.pages_scanned,
    executorComplete: null,
    results: document.results || [],
  };
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 0;
}

function byRequestedOrder(left, right) {
  return left.salePriceUsd - right.salePriceUsd
    || right.discountPct - left.discountPct
    || right.originalPriceUsd - left.originalPriceUsd
    || left.appUrl.localeCompare(right.appUrl);
}

export function scoreBenchmark(oracle, document, { candidateKind = 'final' } = {}) {
  const candidate = normalizedCandidate(document, candidateKind);
  const expected = (oracle.expected || []).map((game) => ({ ...game, appUrl: canonicalApp(game.appUrl).url }));
  const returned = candidate.results.map(mappedCandidate);
  const expectedById = new Map(expected.map((game) => [game.appId, game]));
  const uniqueIds = new Set(returned.map((game) => game.appId));
  const uniqueUrls = new Set(returned.map((game) => game.appUrl));
  const matched = returned.filter((game) => expectedById.has(game.appId));
  const exactFields = matched.filter((game) => {
    const target = expectedById.get(game.appId);
    return game.urlAppId === game.appId
      && game.appUrl === target.appUrl
      && game.discountPct === target.discountPct
      && game.originalPriceUsd === target.originalPriceUsd
      && game.salePriceUsd === target.salePriceUsd;
  });
  const exactRanks = matched.filter((game) => game.rank === expectedById.get(game.appId).rank);
  const contractValid = returned.filter((game) => Number.isInteger(game.appId)
    && game.appId > 0
    && game.urlAppId === game.appId
    && Boolean(game.appUrl)
    && Number.isFinite(game.discountPct)
    && game.discountPct >= 50
    && game.discountPct <= 80
    && Number.isFinite(game.originalPriceUsd)
    && game.originalPriceUsd >= 0.99
    && Number.isFinite(game.salePriceUsd)
    && game.salePriceUsd >= 0
    && game.salePriceUsd <= 0.49);
  const requestedSort = returned.every((game, index) => index === 0 || byRequestedOrder(returned[index - 1], game) <= 0);
  const missingAppIds = expected.filter((game) => !uniqueIds.has(game.appId)).map((game) => game.appId);
  const extraAppIds = returned.filter((game) => !expectedById.has(game.appId)).map((game) => game.appId);
  const qualityGatePassed = oracle.capture?.completeScopedTop50 === true
    && candidate.status === 'completed'
    && candidate.pagesScanned === SCOPED_PAGES
    && expected.length === TARGET_COUNT
    && returned.length === TARGET_COUNT
    && uniqueIds.size === TARGET_COUNT
    && uniqueUrls.size === TARGET_COUNT
    && contractValid.length === TARGET_COUNT
    && matched.length === TARGET_COUNT
    && exactFields.length === TARGET_COUNT
    && exactRanks.length === TARGET_COUNT
    && requestedSort;

  return {
    schemaVersion: 1,
    benchmark: oracle.benchmark,
    candidateKind,
    oracleCompleteScopedTop50: oracle.capture?.completeScopedTop50 === true,
    candidateStatus: candidate.status,
    candidatePagesScanned: candidate.pagesScanned,
    executorComplete: candidate.executorComplete,
    qualityGatePassed,
    counts: {
      expected: expected.length,
      returned: returned.length,
      uniqueAppIds: uniqueIds.size,
      uniqueUrls: uniqueUrls.size,
      duplicateAppIds: returned.length - uniqueIds.size,
      contractValid: contractValid.length,
      matchedExpectedApps: matched.length,
      exactFieldMatches: exactFields.length,
      exactRankMatches: exactRanks.length,
    },
    rates: {
      appPrecision: ratio(matched.length, returned.length),
      appRecall: ratio(matched.length, expected.length),
      exactFieldAccuracyOnExpected: ratio(exactFields.length, expected.length),
      exactRankAccuracyOnExpected: ratio(exactRanks.length, expected.length),
    },
    ordering: { requestedSort },
    missingAppIds,
    extraAppIds,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/score-steam-benchmark.mjs --oracle PATH --candidate PATH [--candidate-kind final|trace] [--output PATH]\n');
    return;
  }
  const [oracleText, candidateText] = await Promise.all([
    readFile(options.oracle, 'utf8'),
    readFile(options.candidate, 'utf8'),
  ]);
  const result = scoreBenchmark(JSON.parse(oracleText), JSON.parse(candidateText), { candidateKind: options.candidateKind });
  result.inputSha256 = {
    oracle: createHash('sha256').update(oracleText).digest('hex'),
    candidate: createHash('sha256').update(candidateText).digest('hex'),
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, 'utf8');
  process.stdout.write(serialized);
  if (!result.qualityGatePassed) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
