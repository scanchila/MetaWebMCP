import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeListing, qualifies } from '../scripts/capture-fincaraiz-benchmark.mjs';
import { scoreBenchmark } from '../scripts/score-fincaraiz-benchmark.mjs';

function listing(overrides = {}) {
  return {
    id: 123,
    link: '/apartamento-en-arriendo-en-example-bogota/123',
    title: 'Example apartment',
    description: 'Dos habitaciones y zona de lavandería independiente.',
    rooms: 0,
    bedrooms: 2,
    m2: 48,
    m2Built: 48,
    price: { amount: 900_000 },
    commonExpenses: { amount: 100_000 },
    technicalSheet: [],
    ...overrides,
  };
}

test('FincaRaiz benchmark ignores a zero rooms sentinel when bedrooms is populated', () => {
  const normalized = normalizeListing(listing(), 3);

  assert.equal(normalized.bedrooms, 2);
  assert.equal(normalized.totalMonthlyCop, 1_000_000);
  assert.equal(normalized.laundryEvidence, 'zona de lavanderia');
  assert.equal(qualifies(normalized), true);
});

test('FincaRaiz benchmark falls back to the technical sheet for bedroom count', () => {
  const normalized = normalizeListing(listing({
    bedrooms: undefined,
    technicalSheet: [{ field: 'bedrooms', value: '3' }],
  }), 1);

  assert.equal(normalized.bedrooms, 3);
  assert.equal(qualifies(normalized), true);
});

test('FincaRaiz benchmark requires the explicit laundry phrase and area bounds', () => {
  const noLaundry = normalizeListing(listing({ description: 'Dos habitaciones y patio.' }), 1);
  const tooLarge = normalizeListing(listing({ m2: 101, m2Built: 101 }), 1);

  assert.equal(qualifies(noLaundry), false);
  assert.equal(qualifies(tooLarge), false);
});

test('FincaRaiz benchmark scorer requires the exact top 50', () => {
  const expected = Array.from({ length: 50 }, (_, index) => ({
    rank: index + 1,
    url: `https://example.com/listing/${index + 1}`,
    rentCop: 600_000 + index,
    administrationCop: 100_000,
    totalMonthlyCop: 700_000 + index,
    bedrooms: 2,
    areaM2: 50,
    laundryEvidence: 'zona de lavado',
  }));
  const oracle = {
    benchmark: 'test',
    capture: { completeTop50: true },
    expected,
  };
  const candidate = {
    status: 'completed',
    captured_at: '2026-09-04T00:00:00Z',
    pages_visited: [1],
    limitations: [],
    results: expected.map((item) => ({
      rank: item.rank,
      url: item.url,
      rent_cop: item.rentCop,
      administration_cop: item.administrationCop,
      total_monthly_cop: item.totalMonthlyCop,
      bedrooms: item.bedrooms,
      area_m2: item.areaM2,
      laundry_evidence: item.laundryEvidence,
    })),
  };

  assert.equal(scoreBenchmark(oracle, candidate).qualityGatePassed, true);
  candidate.results[49].url = 'https://example.com/listing/not-expected';
  const failed = scoreBenchmark(oracle, candidate);
  assert.equal(failed.qualityGatePassed, false);
  assert.equal(failed.counts.matchedExpectedUrls, 49);
});
