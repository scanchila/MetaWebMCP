import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSnapshotLinks,
  runMcpCollection,
  validateCollectionExecutor,
} from '../public/js/mcp-collection.js';

const PAGE_ONE = `- main "Apartments"
  - link "Apartment image" [ref=e1]:
    - /url: /listing/a
  - link [ref=e2]:
    - /url: /listing/a
    - paragraph [ref=e2a]: $ 800.000 + $ 100.000 admin Apartment A 2 Habs. 48 m² Zona de lavado
  - link "$ 650.000 + $ 300.000 admin Apartment B 2 Habs. 55 m² Área de ropas" [ref=e3]:
    - /url: /listing/b
  - link "$ 500.000 + $ 50.000 admin Apartment C 1 Habs. 40 m² Zona de lavado" [ref=e4]:
    - /url: /listing/c
  - link "Page 2" [ref=e5]:
    - /url: /rentals/page2`;

const PAGE_TWO = `- main "Apartments, page 2"
  - link "$ 700.000 + $ 150.000 admin Apartment D 3 Habs. 60 m² Zona de lavado" [ref=e6]:
    - /url: /listing/d
  - link "$ 900.000 Apartment E 2 Habs. 75 m² Sin lavandería" [ref=e7]:
    - /url: /listing/e`;

const EXECUTOR = {
  type: 'mcp-collection',
  scope: {
    origin: 'https://homes.example',
    pathPrefix: '/rentals',
  },
  startUrl: 'https://homes.example/rentals',
  item: {
    urlContains: '/listing/',
    minTextLength: 20,
  },
  fields: [
    { name: 'url', source: 'url', parser: { type: 'identity' }, required: true },
    { name: 'rent', source: 'text', parser: { type: 'currency', occurrence: 0 }, required: true },
    { name: 'administration', source: 'text', parser: { type: 'currency-before', marker: 'admin', default: 0 } },
    { name: 'bedrooms', source: 'text', parser: { type: 'number-before', marker: 'Habs.' }, required: true },
    { name: 'area_m2', source: 'text', parser: { type: 'number-before', marker: 'm²' }, required: true },
    { name: 'matched_phrase', source: 'text', parser: { type: 'matched-input', input: 'features' }, required: true },
  ],
  filters: [
    { field: 'bedrooms', operator: 'gte', value: { input: 'min_bedrooms' } },
    { field: 'area_m2', operator: 'gte', value: { input: 'min_area_m2' } },
    { field: 'area_m2', operator: 'lte', value: { input: 'max_area_m2' } },
    { field: '$text', operator: 'contains-any', value: { input: 'features' } },
  ],
  computed: [
    { name: 'total_monthly', operator: 'sum', fields: ['rent', 'administration'] },
  ],
  sort: [{ field: 'total_monthly', direction: 'asc' }],
  limit: { input: 'limit', default: 50, maximum: 100 },
  maxItems: 500,
  pagination: {
    type: 'page-template',
    urlTemplate: 'https://homes.example/rentals/page{{page}}',
    startPage: 2,
    maxPages: 3,
  },
};

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    min_bedrooms: { type: 'number' },
    min_area_m2: { type: 'number' },
    max_area_m2: { type: 'number' },
    features: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['min_bedrooms', 'min_area_m2', 'max_area_m2', 'features'],
  additionalProperties: false,
};

test('snapshot links retain the richest accessible name for each absolute URL', () => {
  assert.deepEqual(extractSnapshotLinks(PAGE_ONE, 'https://homes.example/rentals'), [
    {
      name: '$ 800.000 + $ 100.000 admin Apartment A 2 Habs. 48 m² Zona de lavado',
      url: 'https://homes.example/listing/a',
      ref: 'e2',
    },
    {
      name: '$ 650.000 + $ 300.000 admin Apartment B 2 Habs. 55 m² Área de ropas',
      url: 'https://homes.example/listing/b',
      ref: 'e3',
    },
    {
      name: '$ 500.000 + $ 50.000 admin Apartment C 1 Habs. 40 m² Zona de lavado',
      url: 'https://homes.example/listing/c',
      ref: 'e4',
    },
    { name: 'Page 2', url: 'https://homes.example/rentals/page2', ref: 'e5' },
  ]);
});

test('collection tools paginate internally and return filtered typed records in requested order', async () => {
  const calls = [];
  const result = await runMcpCollection({
    executor: EXECUTOR,
    inputSchema: INPUT_SCHEMA,
    input: {
      min_bedrooms: 2,
      min_area_m2: 45,
      max_area_m2: 100,
      features: ['zona de lavado', 'área de ropas'],
      limit: 2,
    },
    availableTools: new Set(['browser_snapshot', 'browser_navigate']),
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      if (args.url === 'https://homes.example/rentals') return PAGE_ONE;
      if (args.url.endsWith('page2')) return PAGE_TWO;
      return '- main "No more apartments"';
    },
    resultText: String,
  });

  assert.deepEqual(calls, [
    { tool: 'browser_navigate', args: { url: 'https://homes.example/rentals' } },
    { tool: 'browser_navigate', args: { url: 'https://homes.example/rentals/page2' } },
    { tool: 'browser_navigate', args: { url: 'https://homes.example/rentals/page3' } },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.pagesScanned, 3);
  assert.equal(result.recordsScanned, 5);
  assert.equal(result.complete, true);
  assert.deepEqual(result.results, [
    {
      url: 'https://homes.example/listing/d',
      rent: 700000,
      administration: 150000,
      bedrooms: 3,
      area_m2: 60,
      matched_phrase: 'zona de lavado',
      total_monthly: 850000,
    },
    {
      url: 'https://homes.example/listing/a',
      rent: 800000,
      administration: 100000,
      bedrooms: 2,
      area_m2: 48,
      matched_phrase: 'zona de lavado',
      total_monthly: 900000,
    },
  ]);
});

test('collection pagination is bounded to the analyzed origin and path', () => {
  assert.throws(
    () => validateCollectionExecutor({
      ...structuredClone(EXECUTOR),
      pagination: {
        ...EXECUTOR.pagination,
        urlTemplate: 'https://attacker.example/rentals/page{{page}}',
      },
    }, { inputSchema: INPUT_SCHEMA }),
    /same analyzed origin/,
  );

  assert.throws(
    () => validateCollectionExecutor({
      ...structuredClone(EXECUTOR),
      pagination: {
        ...EXECUTOR.pagination,
        urlTemplate: 'https://homes.example/account/export?page={{page}}',
      },
    }, { inputSchema: INPUT_SCHEMA }),
    /analyzed path/,
  );

  assert.throws(
    () => validateCollectionExecutor({
      ...structuredClone(EXECUTOR),
      pagination: {
        ...EXECUTOR.pagination,
        urlTemplate: 'https://homes.example/rentals-private/page{{page}}',
      },
    }, { inputSchema: INPUT_SCHEMA }),
    /analyzed path/,
  );

  assert.throws(
    () => validateCollectionExecutor({
      ...structuredClone(EXECUTOR),
      scope: { origin: 'https://homes.example/admin', pathPrefix: '/rentals' },
    }, { inputSchema: INPUT_SCHEMA }),
    /canonical HTTP or HTTPS origin/,
  );

  assert.throws(
    () => validateCollectionExecutor({
      ...structuredClone(EXECUTOR),
      scope: { origin: 'https://homes.example', pathPrefix: '//attacker.example' },
    }, { inputSchema: INPUT_SCHEMA }),
    /canonical absolute path/,
  );
});

test('a missing optional currency uses its configured zero default', async () => {
  const executor = structuredClone(EXECUTOR);
  delete executor.pagination;
  delete executor.startUrl;
  executor.filters = [];
  executor.limit = { default: 10, maximum: 10 };
  const result = await runMcpCollection({
    executor,
    inputSchema: INPUT_SCHEMA,
    input: { features: ['zona de lavado'] },
    availableTools: new Set(['browser_snapshot']),
    callTool: async () => `- link "$ 900.000 Apartment E 2 Habs. 75 m² Zona de lavado Canon: $ 800.000 Administración: $ 100.000" [ref=e7]:
  - /url: /listing/e`,
    resultText: String,
  });

  assert.equal(result.results[0].administration, 0);
  assert.equal(result.results[0].total_monthly, 900000);
});

test('collection pagination stops once an ordered page cannot improve the requested rank', async () => {
  const pageTwo = `- main "Apartments, page 2"
  - link "$ 1.100.000 Apartment F 2 Habs. 50 m² Zona de lavado" [ref=e8]:
    - /url: /listing/f`;
  const calls = [];
  const executor = structuredClone(EXECUTOR);
  executor.limit = { input: 'limit', default: 2, maximum: 2 };
  executor.pagination.stopWhen = {
    type: 'page-minimum-exceeds-ranked',
    sourceField: 'rent',
    resultField: 'total_monthly',
    rank: 2,
  };

  const result = await runMcpCollection({
    executor,
    inputSchema: INPUT_SCHEMA,
    input: {
      min_bedrooms: 2,
      min_area_m2: 45,
      max_area_m2: 100,
      features: ['zona de lavado', 'área de ropas'],
      limit: 2,
    },
    availableTools: new Set(['browser_snapshot', 'browser_navigate']),
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      return args.url === 'https://homes.example/rentals' ? PAGE_ONE : pageTwo;
    },
    resultText: String,
  });

  assert.equal(result.complete, true);
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.terminationReason, 'page minimum rent exceeded ranked total_monthly at rank 2');
  assert.deepEqual(calls.map((call) => call.tool), ['browser_navigate', 'browser_navigate']);
});

test('ordered stopping must prove every permitted result rank and a safe lower bound', () => {
  const rankTooSmall = structuredClone(EXECUTOR);
  rankTooSmall.pagination.stopWhen = {
    type: 'page-minimum-exceeds-ranked',
    sourceField: 'rent',
    resultField: 'total_monthly',
    rank: 50,
  };
  assert.throws(
    () => validateCollectionExecutor(rankTooSmall, { inputSchema: INPUT_SCHEMA }),
    /cover the maximum result limit/,
  );

  const unrelatedSource = structuredClone(EXECUTOR);
  unrelatedSource.limit = { input: 'limit', default: 50, maximum: 50 };
  unrelatedSource.pagination.stopWhen = {
    type: 'page-minimum-exceeds-ranked',
    sourceField: 'area_m2',
    resultField: 'total_monthly',
    rank: 50,
  };
  assert.throws(
    () => validateCollectionExecutor(unrelatedSource, { inputSchema: INPUT_SCHEMA }),
    /lower-bounds the ranked result/,
  );
});

test('collection input references ignore inherited prototype properties', async () => {
  const executor = {
    type: 'mcp-collection',
    scope: { origin: 'https://homes.example', pathPrefix: '/' },
    item: { urlContains: '/listing/' },
    fields: [
      { name: 'url', source: 'url', parser: { type: 'identity' }, required: true },
      { name: 'match', source: 'text', parser: { type: 'matched-input', input: 'constructor' }, required: true },
    ],
    limit: { default: 10, maximum: 10 },
  };
  const result = await runMcpCollection({
    executor,
    inputSchema: {
      type: 'object',
      properties: { constructor: { type: 'string' } },
      additionalProperties: false,
    },
    input: {},
    availableTools: new Set(['browser_snapshot']),
    callTool: async () => '- link "function Object() { [native code] }" [ref=e1]:\n  - /url: /listing/a',
    resultText: String,
  });

  assert.deepEqual(result.results, []);
});
