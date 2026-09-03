#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TARGET_COUNT = 10;

function parseArguments(argv) {
  const options = { oracle: '', candidate: '', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--oracle' || argument === '--candidate' || argument === '--output') {
      options[argument.slice(2)] = argv[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.oracle || !options.candidate) throw new Error('--oracle and --candidate are required.');
  return options;
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function mappedCandidate(candidate) {
  return {
    rank: candidate.rank,
    url: canonicalUrl(candidate.url),
    rentCop: candidate.rent_cop,
    bedrooms: candidate.bedrooms,
    areaM2: candidate.area_m2,
  };
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 0;
}

function byRequestedOrder(left, right) {
  return left.rentCop - right.rentCop
    || right.areaM2 - left.areaM2
    || left.url.localeCompare(right.url);
}

export function scoreBenchmark(oracle, candidate) {
  const expected = (oracle.expected || []).map((listing) => ({ ...listing, url: canonicalUrl(listing.url) }));
  const returned = (candidate.results || []).map(mappedCandidate);
  const expectedByUrl = new Map(expected.map((listing) => [listing.url, listing]));
  const unique = new Map();
  for (const listing of returned) if (!unique.has(listing.url)) unique.set(listing.url, listing);
  const uniqueReturned = [...unique.values()];
  const matched = uniqueReturned.filter((listing) => expectedByUrl.has(listing.url));
  const exactFields = matched.filter((listing) => {
    const target = expectedByUrl.get(listing.url);
    return listing.rentCop === target.rentCop
      && listing.bedrooms === target.bedrooms
      && listing.areaM2 === target.areaM2;
  });
  const exactRanks = matched.filter((listing) => listing.rank === expectedByUrl.get(listing.url).rank);
  const contractValid = uniqueReturned.filter((listing) => Boolean(listing.url)
    && Number.isInteger(listing.rentCop)
    && listing.rentCop >= 0
    && Number.isInteger(listing.bedrooms)
    && listing.bedrooms >= 2
    && Number.isInteger(listing.areaM2)
    && listing.areaM2 >= 45
    && listing.areaM2 <= 100);
  const sequentialRanks = returned.every((listing, index) => listing.rank === index + 1);
  const requestedSort = returned.every((listing, index) => index === 0 || byRequestedOrder(returned[index - 1], listing) <= 0);
  const missingUrls = expected.filter((listing) => !unique.has(listing.url)).map((listing) => listing.url);
  const extraUrls = uniqueReturned.filter((listing) => !expectedByUrl.has(listing.url)).map((listing) => listing.url);
  const qualityGatePassed = oracle.capture?.completeVisibleTop10 === true
    && candidate.status === 'completed'
    && expected.length === TARGET_COUNT
    && returned.length === TARGET_COUNT
    && uniqueReturned.length === TARGET_COUNT
    && contractValid.length === TARGET_COUNT
    && matched.length === TARGET_COUNT
    && exactFields.length === TARGET_COUNT
    && exactRanks.length === TARGET_COUNT
    && sequentialRanks
    && requestedSort;

  return {
    schemaVersion: 1,
    benchmark: oracle.benchmark,
    oracleCompleteVisibleTop10: oracle.capture?.completeVisibleTop10 === true,
    candidateStatus: candidate.status,
    qualityGatePassed,
    counts: {
      expected: expected.length,
      returned: returned.length,
      uniqueReturned: uniqueReturned.length,
      duplicates: returned.length - uniqueReturned.length,
      contractValid: contractValid.length,
      matchedExpectedUrls: matched.length,
      exactFieldMatches: exactFields.length,
      exactRankMatches: exactRanks.length,
    },
    rates: {
      urlPrecision: ratio(matched.length, uniqueReturned.length),
      urlRecall: ratio(matched.length, expected.length),
      exactFieldAccuracyOnExpected: ratio(exactFields.length, expected.length),
      exactRankAccuracyOnExpected: ratio(exactRanks.length, expected.length),
    },
    ordering: { sequentialRanks, requestedSort },
    missingUrls,
    extraUrls,
    candidateEvidence: {
      capturedAt: candidate.captured_at,
      sourceUrl: candidate.source_url,
      limitations: candidate.limitations || [],
      results: returned,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node scripts/score-metrocuadrado-benchmark.mjs --oracle PATH --candidate PATH [--output PATH]\n');
    return;
  }
  const [oracleText, candidateText] = await Promise.all([
    readFile(options.oracle, 'utf8'),
    readFile(options.candidate, 'utf8'),
  ]);
  const result = scoreBenchmark(JSON.parse(oracleText), JSON.parse(candidateText));
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
