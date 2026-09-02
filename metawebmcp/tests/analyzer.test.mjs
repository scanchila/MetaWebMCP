import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeAccessibilitySnapshot, analyzeHtml, parseAttributes, slugifyToolName } from '../lib/analyzer.mjs';

const FIXTURE = `<!doctype html>
<html><head><title>Tool Shop</title></head><body>
  <form id="catalog-search" aria-label="Search catalog" method="get">
    <label for="query">Keywords</label>
    <input id="query" name="query" required placeholder="agent tools">
    <label for="category">Category</label>
    <select id="category" name="category">
      <option value="all">All</option>
      <option value="mcp">MCP</option>
    </select>
    <button id="search-submit" type="submit">Search products</button>
  </form>
  <button data-action="add-to-cart" data-entity="product" data-entity-id="p1">Add to cart</button>
  <button data-action="add-to-cart" data-entity="product" data-entity-id="p2">Add to cart</button>
  <button id="view-cart">View cart</button>
</body></html>`;

test('parseAttributes handles quoted, unquoted, and boolean values', () => {
  assert.deepEqual(parseAttributes('id="alpha" required data-id=p1 aria-label=\'Use item\''), {
    id: 'alpha',
    required: '',
    'data-id': 'p1',
    'aria-label': 'Use item',
  });
});

test('slugifyToolName emits valid stable tool identifiers', () => {
  assert.equal(slugifyToolName('Ádd “Thing” / Now!'), 'add_thing_now');
  assert.equal(slugifyToolName('42 options'), 'tool_42_options');
});

test('HTML analysis discovers complete forms and grouped actions', () => {
  const result = analyzeHtml({ html: FIXTURE, url: 'https://shop.example/', goal: 'Search and build a cart.' });
  assert.equal(result.source.title, 'Tool Shop');
  assert.equal(result.summary.forms, 1);
  assert.equal(result.summary.inputs, 2);

  const form = result.capabilities.find((capability) => capability.kind === 'form');
  assert.ok(form);
  assert.equal(form.name, 'search_catalog');
  assert.deepEqual(Object.keys(form.inputSchema.properties).sort(), ['category', 'query']);
  assert.deepEqual(form.inputSchema.properties.category.enum, ['all', 'mcp']);
  assert.deepEqual(form.inputSchema.required, ['query']);
  assert.equal(form.executor.type, 'dom-form');

  const add = result.capabilities.find((capability) => capability.executor.selector?.includes('add-to-cart'));
  assert.ok(add);
  assert.equal(add.name, 'add_to_cart_product');
  assert.deepEqual(add.inputSchema.properties.item_id.enum, ['p1', 'p2']);
  assert.equal(add.risk, 'write');

  const view = result.capabilities.find((capability) => capability.title === 'View cart');
  assert.ok(view);
  assert.equal(view.risk, 'read');
});

test('accessibility snapshot analysis produces browser MCP recipes', () => {
  const snapshot = `- main "Conference"
  - textbox "Topic" [ref=e1]
  - combobox "Level" [ref=e2]
  - button "Find sessions" [ref=e3]
  - button "Add to itinerary" [ref=e4]`;
  const result = analyzeAccessibilitySnapshot({ snapshot, url: 'https://events.example', goal: 'Build an itinerary.' });
  assert.equal(result.summary.controls, 4);
  const search = result.capabilities.find((capability) => capability.name === 'find_sessions');
  assert.ok(search);
  assert.equal(search.executor.type, 'mcp-recipe');
  assert.equal(search.executor.steps.at(-1).tool, 'browser_snapshot');
  assert.deepEqual(Object.keys(search.inputSchema.properties), ['topic', 'level']);
  const add = result.capabilities.find((capability) => capability.name === 'add_to_itinerary');
  assert.ok(add);
  assert.equal(add.risk, 'write');
});
