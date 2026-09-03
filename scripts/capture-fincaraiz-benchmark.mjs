#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://www.fincaraiz.com.co/arriendo/apartamentos/bogota/bogota-dc/baratos';
const TARGET_COUNT = 50;
const DEFAULT_MAX_PAGES = 24;
const REQUEST_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const USER_AGENT = 'MetaWebMCP benchmark/1.0 (+https://metawebmcp.neuryta.com/)';

const LAUNDRY_PATTERN = /\b(?:zona|area)\s+de\s+(?:ropas|lavado|lavanderia)\b|\blavanderia\s+independiente\b/;

function usage() {
  return `Usage: node scripts/capture-fincaraiz-benchmark.mjs [--output PATH] [--max-pages N]\n\n`+
    'Captures a volatile, read-only FincaRaiz result set and builds the deterministic scoring oracle.\n';
}

function parseArguments(argv) {
  const options = { output: '', maxPages: DEFAULT_MAX_PAGES };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--output') {
      options.output = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (argument === '--max-pages') {
      options.maxPages = Number.parseInt(argv[index + 1] || '', 10);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100) {
    throw new Error('--max-pages must be an integer from 1 through 100.');
  }
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

function pageUrl(page) {
  return page === 1 ? BASE_URL : `${BASE_URL}/pagina${page}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPage(page) {
  const url = pageUrl(page);
  let lastFailure = '';
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
      const html = await response.text();
      const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (response.ok && nextData) {
        const payload = JSON.parse(nextData[1]);
        const search = payload?.props?.pageProps?.fetchResult?.searchFast;
        if (!Array.isArray(search?.data)) throw new Error('The page did not contain searchFast.data.');
        return {
          url,
          status: response.status,
          htmlBytes: Buffer.byteLength(html),
          htmlSha256: createHash('sha256').update(html).digest('hex'),
          paginator: search.paginatorInfo || null,
          listings: search.data,
        };
      }
      lastFailure = `HTTP ${response.status}; Next.js payload ${nextData ? 'present' : 'missing'}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < REQUEST_RETRIES) await delay(RETRY_DELAY_MS * attempt);
  }
  throw new Error(`Unable to capture ${url}: ${lastFailure}`);
}

function technicalValue(listing, field) {
  const entry = listing.technicalSheet?.find((item) => item?.field === field);
  return entry?.value ?? null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

export function normalizeListing(listing, page) {
  const description = normalizeText(listing.description);
  const laundryMatch = description.match(LAUNDRY_PATTERN)?.[0] || '';
  const rent = Number(listing.price?.amount);
  const administration = Number(listing.commonExpenses?.amount || 0);
  const bedrooms = firstPositiveNumber(
    listing.bedrooms,
    listing.rooms,
    technicalValue(listing, 'bedrooms'),
  );
  const areaM2 = firstPositiveNumber(listing.m2, listing.m2Built);
  const path = String(listing.link || '');
  return {
    id: Number(listing.id),
    url: new URL(path, BASE_URL).href,
    title: String(listing.title || ''),
    sourcePage: page,
    rentCop: Number.isFinite(rent) ? rent : null,
    administrationCop: Number.isFinite(administration) ? administration : null,
    totalMonthlyCop: Number.isFinite(rent) && Number.isFinite(administration) ? rent + administration : null,
    bedrooms,
    areaM2,
    laundryEvidence: laundryMatch,
  };
}

export function qualifies(listing) {
  return listing.bedrooms >= 2
    && listing.areaM2 >= 45
    && listing.areaM2 <= 100
    && listing.laundryEvidence.length > 0
    && Number.isFinite(listing.totalMonthlyCop);
}

function byTotalCost(left, right) {
  return left.totalMonthlyCop - right.totalMonthlyCop
    || left.rentCop - right.rentCop
    || left.url.localeCompare(right.url);
}

async function capture(maxPages) {
  const startedAt = new Date().toISOString();
  const uniqueListings = new Map();
  const pages = [];
  let duplicates = 0;
  let previousPageMinimum = -Infinity;
  let pricesMonotonic = true;
  let terminationReason = 'maximum page limit reached';

  for (let page = 1; page <= maxPages; page += 1) {
    const captured = await fetchPage(page);
    const normalized = captured.listings.map((listing) => normalizeListing(listing, page));
    const rents = normalized.map((listing) => listing.rentCop).filter(Number.isFinite);
    const minimumRent = rents.length ? Math.min(...rents) : null;
    const maximumRent = rents.length ? Math.max(...rents) : null;
    if (minimumRent !== null && minimumRent < previousPageMinimum) pricesMonotonic = false;
    if (minimumRent !== null) previousPageMinimum = minimumRent;

    for (const listing of normalized) {
      if (uniqueListings.has(listing.url)) {
        duplicates += 1;
        continue;
      }
      uniqueListings.set(listing.url, listing);
    }

    const ranked = [...uniqueListings.values()].filter(qualifies).sort(byTotalCost);
    const threshold = ranked[TARGET_COUNT - 1]?.totalMonthlyCop ?? null;
    pages.push({
      page,
      url: captured.url,
      status: captured.status,
      htmlBytes: captured.htmlBytes,
      htmlSha256: captured.htmlSha256,
      resultCount: normalized.length,
      minimumRentCop: minimumRent,
      maximumRentCop: maximumRent,
      qualifyingUniqueSeen: ranked.length,
      currentFiftiethTotalCop: threshold,
    });

    if (pricesMonotonic && threshold !== null && minimumRent > threshold) {
      terminationReason = `page ${page} minimum rent exceeded the current 50th-ranked total monthly cost`;
      break;
    }
    if (captured.paginator?.hasMorePages === false) {
      terminationReason = 'source reported no more pages';
      break;
    }
  }

  const eligible = [...uniqueListings.values()].filter(qualifies).sort(byTotalCost);
  return {
    schemaVersion: 1,
    benchmark: 'fincaraiz-cheapest-with-laundry-v1',
    source: {
      site: 'FincaRaiz',
      baseUrl: BASE_URL,
      startedAt,
      completedAt: new Date().toISOString(),
      volatile: true,
    },
    task: {
      requestedResults: TARGET_COUNT,
      propertyType: 'apartment',
      operation: 'rent',
      location: 'Bogota',
      minimumBedrooms: 2,
      minimumAreaM2: 45,
      maximumAreaM2: 100,
      descriptionCondition: 'Explicitly mentions a laundry area using the benchmark phrase set.',
      ranking: 'Displayed rent plus separately displayed administration fee; missing administration is zero.',
      deduplicationKey: 'canonical absolute listing URL',
    },
    capture: {
      pagesVisited: pages.length,
      rawListingsSeen: pages.reduce((sum, page) => sum + page.resultCount, 0),
      uniqueListingsSeen: uniqueListings.size,
      duplicateOccurrences: duplicates,
      qualifyingUniqueListingsSeen: eligible.length,
      sourcePageMinimumPricesMonotonic: pricesMonotonic,
      terminationReason,
      completeTop50: eligible.length >= TARGET_COUNT && pricesMonotonic && !terminationReason.includes('maximum'),
      pages,
    },
    expected: eligible.slice(0, TARGET_COUNT).map((listing, index) => ({ rank: index + 1, ...listing })),
    limitations: [
      'This is a point-in-time observation of volatile third-party listings, not availability or price verification.',
      'The collector reads server-rendered Next.js data only to build a scoring oracle; it is not either benchmark arm.',
      'Laundry evidence is phrase-based and intentionally narrower than general semantic equivalence.',
    ],
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await capture(options.maxPages);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, 'utf8');
  process.stdout.write(serialized);
  if (!result.capture.completeTop50) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
