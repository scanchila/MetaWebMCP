import test from 'node:test';
import assert from 'node:assert/strict';

import { executeGeneratedSpec, ToolRegistry } from '../public/js/webmcp-runtime.js';

const PROTOTYPE_PROPERTY_NAMES = ['constructor', 'toString', '__proto__'];

function inputWithOwnProperty(name, value = 'safe') {
  const input = JSON.parse(`{${JSON.stringify(name)}:${JSON.stringify(value)}}`);
  assert.equal(Object.hasOwn(input, name), true);
  return input;
}

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

test('schema validation treats prototype-colliding input names as own properties', async () => {
  const registry = new ToolRegistry(null);
  let effects = 0;

  for (const [index, propertyName] of PROTOTYPE_PROPERTY_NAMES.entries()) {
    const toolName = `set_prototype_value_${index + 1}`;
    await registry.register({
      name: toolName,
      description: 'Set a value whose field name overlaps the object prototype.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries([[propertyName, { type: 'string' }]]),
        required: [propertyName],
        additionalProperties: false,
      },
    }, async (input) => {
      effects += 1;
      return input[propertyName];
    });

    await assert.rejects(registry.execute(toolName, {}), new RegExp(`input\\.${propertyName} is required`));
    assert.equal(await registry.execute(toolName, inputWithOwnProperty(propertyName)), 'safe');
  }

  assert.equal(effects, PROTOTYPE_PROPERTY_NAMES.length);

  let unexpectedEffects = 0;
  await registry.register({
    name: 'reject_prototype_extras',
    description: 'Reject properties that are not declared by the schema.',
    risk: 'write',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, async () => {
    unexpectedEffects += 1;
  });

  for (const propertyName of PROTOTYPE_PROPERTY_NAMES) {
    await assert.rejects(
      registry.execute('reject_prototype_extras', inputWithOwnProperty(propertyName)),
      new RegExp(`input\\.${propertyName} is not accepted`),
    );
  }
  assert.equal(unexpectedEffects, 0);
});

test('DOM form execution ignores omitted optional prototype-colliding fields', async () => {
  let submissions = 0;
  const controls = new Map(PROTOTYPE_PROPERTY_NAMES.map((propertyName) => [propertyName, {
    value: '',
    events: [],
    matches: () => false,
    dispatchEvent(event) { this.events.push(event.type); },
  }]));
  const form = {
    matches: (selector) => selector === 'form',
    contains: (element) => [...controls.values()].includes(element),
    requestSubmit: () => { submissions += 1; },
  };
  const targetDocument = {
    body: { textContent: '' },
    defaultView: { Event: class { constructor(type) { this.type = type; } }, location: { href: 'https://example.com/' } },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '#prototype-form') return [form];
      const control = controls.get(selector.slice(1));
      return control ? [control] : [];
    },
    title: 'Example',
  };
  const spec = {
    name: 'submit_optional_fields',
    description: 'Submit a form with optional prototype-colliding fields.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(PROTOTYPE_PROPERTY_NAMES.map((name) => [name, { type: 'string' }])),
      additionalProperties: false,
    },
    executor: {
      type: 'dom-form',
      formSelector: '#prototype-form',
      fields: PROTOTYPE_PROPERTY_NAMES.map((name) => ({ name, selector: `#${name}`, controlType: 'text' })),
      submitSelector: null,
    },
  };

  await executeGeneratedSpec(spec, {}, { getTargetDocument: () => targetDocument });

  assert.equal(submissions, 1);
  for (const control of controls.values()) {
    assert.equal(control.value, '');
    assert.deepEqual(control.events, []);
  }
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
