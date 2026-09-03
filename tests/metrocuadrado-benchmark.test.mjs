import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractVisibleListingLinks,
  normalizeVisibleListing,
} from '../scripts/capture-metrocuadrado-benchmark.mjs';
import { scoreBenchmark } from '../scripts/score-metrocuadrado-benchmark.mjs';

test('Metrocuadrado oracle extracts canonical typed card values independently', () => {
  const snapshot = `- link "Foto de Apartamento en Arriendo en Bosa, Bogotá D.C. con 3 habitaciones, 1 baños, área 52 m2 - X Bosa | Bogotá D.C. $850.000 Apartamento" [ref=e1]:
  - /url: /inmueble/arriendo-apartamento-bogota-bosa-3-habitaciones-1-banos/X?src_url=%2Fresults`;
  const [link] = extractVisibleListingLinks(snapshot);
  assert.equal(link.url, 'https://www.metrocuadrado.com/inmueble/arriendo-apartamento-bogota-bosa-3-habitaciones-1-banos/X');
  assert.deepEqual(normalizeVisibleListing(link), {
    url: link.url,
    rentCop: 850000,
    bedrooms: 3,
    areaM2: 52,
  });
});

test('Metrocuadrado oracle prefers visible card values over stale image alt text', () => {
  const listing = normalizeVisibleListing({
    url: 'https://www.metrocuadrado.com/inmueble/arriendo-apartamento-bogota-test/X',
    label: 'Foto con 2 habitaciones, área 50 m2 - X $850.000 Apartamento 55 m² 3 hab. 1 bañ.',
  });
  assert.equal(listing.bedrooms, 3);
  assert.equal(listing.areaM2, 55);
});

test('Metrocuadrado scorer requires exact fields, ranks, and requested tie order', () => {
  const expected = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1,
    url: `https://www.metrocuadrado.com/inmueble/arriendo-apartamento-bogota-test/${index}`,
    rentCop: 800000 + index,
    bedrooms: 2,
    areaM2: 50,
  }));
  const oracle = {
    benchmark: 'metrocuadrado-cheapest-visible-v1',
    capture: { completeVisibleTop10: true },
    expected,
  };
  const candidate = {
    status: 'completed',
    results: expected.map((item) => ({
      rank: item.rank,
      url: `${item.url}?tracking=removed`,
      rent_cop: item.rentCop,
      bedrooms: item.bedrooms,
      area_m2: item.areaM2,
    })),
  };
  assert.equal(scoreBenchmark(oracle, candidate).qualityGatePassed, true);
  candidate.results[0].rent_cop += 1;
  assert.equal(scoreBenchmark(oracle, candidate).qualityGatePassed, false);
});

test('Metrocuadrado scorer rejects non-integer card fields', () => {
  const expected = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1,
    url: `https://www.metrocuadrado.com/inmueble/arriendo-apartamento-bogota-test/${index}`,
    rentCop: 800000 + index,
    bedrooms: 2,
    areaM2: 50,
  }));
  const candidate = {
    status: 'completed',
    results: expected.map((item) => ({
      rank: item.rank,
      url: item.url,
      rent_cop: item.rentCop,
      bedrooms: item.bedrooms,
      area_m2: item.areaM2,
    })),
  };
  candidate.results[0].area_m2 = 50.5;

  assert.equal(scoreBenchmark({ benchmark: 'test', capture: { completeVisibleTop10: true }, expected }, candidate).qualityGatePassed, false);
});
