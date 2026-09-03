import test from 'node:test';
import assert from 'node:assert/strict';

import {
  byRequestedOrder,
  extractVisibleGameLinks,
  normalizeVisibleGame,
  qualifies,
} from '../scripts/capture-steam-benchmark.mjs';
import { scoreBenchmark } from '../scripts/score-steam-benchmark.mjs';

test('Steam oracle independently extracts app identity, discount, and both displayed prices', () => {
  const snapshot = `- 'link "Example: Game Jan 2, 2024 75% off. $1.99 normally, discounted to $0.49" [ref=e1]':
  - /url: https://store.steampowered.com/app/12345/Example_Game/?snr=tracking
  - generic:
    - link "75% off. $1.99 normally, discounted to $0.49" [ref=e2]`;
  const [link] = extractVisibleGameLinks(snapshot);
  assert.deepEqual(link, {
    label: 'Example: Game Jan 2, 2024 75% off. $1.99 normally, discounted to $0.49',
    appId: 12345,
    url: 'https://store.steampowered.com/app/12345/Example_Game/',
  });
  const game = normalizeVisibleGame(link);
  assert.deepEqual(game, {
    appId: 12345,
    appUrl: link.url,
    discountPct: 75,
    originalPriceUsd: 1.99,
    salePriceUsd: 0.49,
  });
  assert.equal(qualifies(game), true);
});

test('Steam requested order applies all four tie-breaks', () => {
  const games = [
    { appUrl: 'https://store.steampowered.com/app/3/C/', salePriceUsd: 0.49, discountPct: 51, originalPriceUsd: 0.99 },
    { appUrl: 'https://store.steampowered.com/app/2/B/', salePriceUsd: 0.49, discountPct: 75, originalPriceUsd: 1.99 },
    { appUrl: 'https://store.steampowered.com/app/1/A/', salePriceUsd: 0.49, discountPct: 75, originalPriceUsd: 1.99 },
    { appUrl: 'https://store.steampowered.com/app/4/D/', salePriceUsd: 0.39, discountPct: 50, originalPriceUsd: 0.99 },
  ];
  assert.deepEqual(games.sort(byRequestedOrder).map((game) => game.appUrl.match(/app\/(\d+)/)[1]), ['4', '1', '2', '3']);
});

function fixture() {
  const expected = Array.from({ length: 50 }, (_, index) => ({
    rank: index + 1,
    appId: 1000 + index,
    appUrl: `https://store.steampowered.com/app/${1000 + index}/Game_${String(index).padStart(2, '0')}/`,
    discountPct: 75,
    originalPriceUsd: 1.99,
    salePriceUsd: 0.49,
  }));
  const results = expected.map((game) => ({
    app_id: game.appId,
    app_url: `${game.appUrl}?snr=tracking`,
    discount_pct: game.discountPct,
    original_price_usd: game.originalPriceUsd,
    sale_price_usd: game.salePriceUsd,
  }));
  return {
    oracle: { benchmark: 'test', capture: { completeScopedTop50: true }, expected },
    final: { status: 'completed', pages_scanned: 20, results },
    trace: { execution: { pagesScanned: 20, complete: false, results } },
  };
}

test('Steam scorer gates the final answer and untouched generated execution independently', () => {
  const { oracle, final, trace } = fixture();
  assert.equal(scoreBenchmark(oracle, final).qualityGatePassed, true);
  const traceScore = scoreBenchmark(oracle, trace, { candidateKind: 'trace' });
  assert.equal(traceScore.qualityGatePassed, true);
  assert.equal(traceScore.executorComplete, false);
});

test('Steam raw-tool gate fails even when a separate final answer could be correct', () => {
  const { oracle, final, trace } = fixture();
  const brokenTrace = structuredClone(trace);
  brokenTrace.execution.results[0].discount_pct = 51;
  assert.equal(scoreBenchmark(oracle, brokenTrace, { candidateKind: 'trace' }).qualityGatePassed, false);
  assert.equal(scoreBenchmark(oracle, final).qualityGatePassed, true);
});
