#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const TARGET_COUNT = 50;
const LAUNDRY_PATTERN = /\b(?:zona|area)\s+de\s+(?:ropas|lavado|lavanderia)\b|\blavanderia\s+independiente\b/;

function usage() {
  return 'Usage: node scripts/score-fincaraiz-benchmark.mjs --oracle PATH --candidate PATH [--output PATH]\n';
}

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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
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
    administrationCop: candidate.administration_cop,
    totalMonthlyCop: candidate.total_monthly_cop,
    bedrooms: candidate.bedrooms,
    areaM2: candidate.area_m2,
    laundryEvidence: normalizeText(candidate.laundry_evidence),
  };
}

function satisfiesContract(listing) {
  return Boolean(listing.url)
    && Number.isFinite(listing.rentCop)
    && Number.isFinite(listing.administrationCop)
    && Number.isFinite(listing.totalMonthlyCop)
    && listing.rentCop >= 0
    && listing.administrationCop >= 0
    && listing.bedrooms >= 2
    && listing.areaM2 >= 45
    && listing.areaM2 <= 100
    && LAUNDRY_PATTERN.test(listing.laundryEvidence);
}

function sameFields(candidate, expected) {
  return candidate.rentCop === expected.rentCop
    && candidate.administrationCop === expected.administrationCop
    && candidate.totalMonthlyCop === expected.totalMonthlyCop
    && candidate.bedrooms === expected.bedrooms
    && candidate.areaM2 === expected.areaM2
    && candidate.laundryEvidence === normalizeText(expected.laundryEvidence);
}

function inRequestedOrder(left, right) {
  return left.totalMonthlyCop - right.totalMonthlyCop
    || left.rentCop - right.rentCop
    || left.url.localeCompare(right.url);
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : 0;
}

export function scoreBenchmark(oracle, candidate) {
  const expected = (oracle.expected || []).map((listing) => ({
    ...listing,
    url: canonicalUrl(listing.url),
  }));
  const returned = (candidate.results || []).map(mappedCandidate);
  const expectedByUrl = new Map(expected.map((listing) => [listing.url, listing]));
  const uniqueReturned = new Map();
  for (const listing of returned) {
    if (!uniqueReturned.has(listing.url)) uniqueReturned.set(listing.url, listing);
  }

  const unique = [...uniqueReturned.values()];
  const matched = unique.filter((listing) => expectedByUrl.has(listing.url));
  const exactFields = matched.filter((listing) => sameFields(listing, expectedByUrl.get(listing.url)));
  const exactRanks = matched.filter((listing) => listing.rank === expectedByUrl.get(listing.url).rank);
  const validContract = unique.filter(satisfiesContract);
  const validArithmetic = unique.filter(
    (listing) => listing.rentCop + listing.administrationCop === listing.totalMonthlyCop,
  );
  const rankSequenceValid = returned.every((listing, index) => listing.rank === index + 1);
  const requestedOrderValid = returned.every(
    (listing, index) => index === 0 || inRequestedOrder(returned[index - 1], listing) <= 0,
  );
  const missingUrls = expected.filter((listing) => !uniqueReturned.has(listing.url)).map((listing) => listing.url);
  const extraUrls = unique.filter((listing) => !expectedByUrl.has(listing.url)).map((listing) => listing.url);

  const qualityGatePassed = oracle.capture?.completeTop50 === true
    && candidate.status === 'completed'
    && expected.length === TARGET_COUNT
    && returned.length === TARGET_COUNT
    && unique.length === TARGET_COUNT
    && validContract.length === TARGET_COUNT
    && validArithmetic.length === TARGET_COUNT
    && matched.length === TARGET_COUNT
    && exactFields.length === TARGET_COUNT
    && exactRanks.length === TARGET_COUNT
    && rankSequenceValid
    && requestedOrderValid;

  return {
    schemaVersion: 1,
    benchmark: oracle.benchmark,
    oracleCompleteTop50: oracle.capture?.completeTop50 === true,
    candidateStatus: candidate.status,
    qualityGatePassed,
    counts: {
      expected: expected.length,
      returned: returned.length,
      uniqueReturned: unique.length,
      duplicates: returned.length - unique.length,
      contractValid: validContract.length,
      arithmeticValid: validArithmetic.length,
      matchedExpectedUrls: matched.length,
      exactFieldMatches: exactFields.length,
      exactRankMatches: exactRanks.length,
    },
    rates: {
      urlPrecision: ratio(matched.length, unique.length),
      urlRecall: ratio(matched.length, expected.length),
      exactFieldAccuracyOnExpected: ratio(exactFields.length, expected.length),
      exactRankAccuracyOnExpected: ratio(exactRanks.length, expected.length),
    },
    ordering: {
      sequentialRanks: rankSequenceValid,
      requestedSort: requestedOrderValid,
    },
    missingUrls,
    extraUrls,
    candidateEvidence: {
      capturedAt: candidate.captured_at,
      pagesVisited: candidate.pages_visited || [],
      limitations: candidate.limitations || [],
      results: returned,
    },
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const [oracleText, candidateText] = await Promise.all([
    readFile(options.oracle, 'utf8'),
    readFile(options.candidate, 'utf8'),
  ]);
  const oracle = JSON.parse(oracleText);
  const candidate = JSON.parse(candidateText);
  const result = scoreBenchmark(oracle, candidate);
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
