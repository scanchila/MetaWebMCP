import test from 'node:test';
import assert from 'node:assert/strict';

import { executeGeneratedSpec, ToolRegistry } from '../public/js/webmcp-runtime.js';

test('schema constraints reject values before the executor runs', async () => {
  const registry = new ToolRegistry(null);
  let effects = 0;
  await registry.register({
    name: 'set_quantity',
    description: 'Set a bounded quantity.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        quantity: { type: 'number', minimum: 1, maximum: 5 },
        note: { type: 'string', minLength: 3, maxLength: 8, pattern: '^[a-z]+$' },
      },
      required: ['quantity', 'note'],
      additionalProperties: false,
    },
  }, async () => {
    effects += 1;
    return { ok: true };
  });

  await assert.rejects(registry.execute('set_quantity', { quantity: 0, note: 'valid' }), /at least 1/);
  await assert.rejects(registry.execute('set_quantity', { quantity: 6, note: 'valid' }), /at most 5/);
  await assert.rejects(registry.execute('set_quantity', { quantity: 3, note: 'A!' }), /at least 3 characters/);
  await assert.rejects(registry.execute('set_quantity', { quantity: 3, note: 'bad-char' }), /pattern/);
  assert.equal(effects, 0);

  await registry.execute('set_quantity', { quantity: 3, note: 'valid' });
  assert.equal(effects, 1);
});

test('DOM form tools do not fall back to controls outside the resolved form', async () => {
  let outsideEffects = 0;
  const outside = {
    value: '',
    matches: () => false,
    dispatchEvent: () => { outsideEffects += 1; },
    click: () => { outsideEffects += 1; },
  };
  const form = {
    matches: (selector) => selector === 'form',
    querySelector: () => null,
    contains: () => false,
    requestSubmit: () => { outsideEffects += 1; },
  };
  const targetDocument = {
    body: { textContent: '' },
    defaultView: { Event: class {}, location: { href: 'https://example.com/' } },
    querySelector: (selector) => selector === '#review-form' ? form : outside,
    querySelectorAll: (selector) => selector === '#review-form' ? [form] : [outside],
    title: 'Example',
  };
  const spec = {
    name: 'submit_review',
    description: 'Submit the reviewed form.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
    executor: {
      type: 'dom-form',
      formSelector: '#review-form',
      fields: [{ name: 'message', selector: '#message', controlType: 'text' }],
      submitSelector: '#submit-review',
    },
  };

  await assert.rejects(
    executeGeneratedSpec(spec, { message: 'safe' }, { getTargetDocument: () => targetDocument }),
    /form control|within the resolved form/,
  );
  assert.equal(outsideEffects, 0);
});
