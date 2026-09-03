import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { generateProjectFiles, generateProjectZip, validateExportRequest } from '../lib/generator.mjs';

const tool = {
  id: 'demo_find_sessions',
  kind: 'form',
  name: 'find_sessions',
  title: 'Find sessions',
  description: 'Search conference sessions and return the current visible results.',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Topic to find.' } },
    additionalProperties: false,
  },
  sampleArgs: { query: 'agents' },
  evidence: [{ type: 'form', selector: '#search', label: 'Find sessions' }],
  executor: {
    type: 'dom-form',
    formSelector: '#search',
    fields: [{ name: 'query', selector: '#query', controlType: 'text' }],
    submitSelector: '#submit',
    resultSelector: '#results',
  },
};

function loadGeneratedRuntime(source, environment = {}) {
  const registered = [];
  const document = {
    readyState: 'loading',
    addEventListener() {},
    ...environment.document,
  };
  document.modelContext = {
    async registerTool(descriptor) { registered.push(descriptor); },
  };
  const context = {
    AbortController,
    console: { info() {} },
    Event,
    InputEvent: Event,
    location: { href: 'https://example.com/' },
    setTimeout,
    URL,
    window: environment.window || {},
    document,
    HTMLElement: environment.HTMLElement || class {},
    HTMLFormElement: environment.HTMLFormElement || class {},
    HTMLInputElement: environment.HTMLInputElement || class {},
    HTMLSelectElement: environment.HTMLSelectElement || class {},
    HTMLTextAreaElement: environment.HTMLTextAreaElement || class {},
  };
  const executable = `${source.replace(/\bexport /g, '')}\nglobalThis.generatedApi = { registerGeneratedWebMCP };`;
  vm.runInNewContext(executable, context);
  return context.generatedApi.registerGeneratedWebMCP().then(() => ({ registered, context }));
}

test('export validation normalizes project name and preserves tool contract', () => {
  const result = validateExportRequest({ projectName: 'Relay Sessions!', tools: [tool], goal: 'Find sessions' });
  assert.equal(result.projectName, 'relay-sessions');
  assert.equal(result.tools[0].name, 'find_sessions');
});

test('generated project directly registers WebMCP tools and includes review artifacts', () => {
  const project = generateProjectFiles({ projectName: 'relay-webmcp', tools: [tool], target: { url: 'https://events.example' }, goal: 'Find sessions' });
  assert.match(project.files['src/webmcp.generated.js'], /document\.modelContext\.registerTool\(\{/);
  assert.match(project.files['src/webmcp.generated.js'], /name: spec\.name/);
  assert.doesNotMatch(project.files['src/webmcp.generated.js'], /form\.querySelector\([^)]*\) \|\| document\.querySelector/);
  assert.match(project.files['src/webmcp.generated.js'], /form\.contains\(element\) \|\| element\.form === form/);
  assert.match(project.files['src/webmcp.generated.js'], /assertSchemaValue\(spec\.inputSchema, normalized\)/);
  assert.match(project.files['src/webmcp.generated.js'], /schema\.minimum/);
  assert.match(project.files['README.md'], /top-level page/);
  assert.match(project.files['integration-report.html'], /Generated WebMCP integration/);
  assert.match(project.files['integration-report.html'], /<link rel="icon" href="data:,">/);
  assert.match(project.files['AGENTS.md'], /Replace DOM clicks with stable application functions/);
  assert.match(project.files['tests/manual-evals.md'], /Expected selection: `find_sessions`/);
  assert.doesNotThrow(() => JSON.parse(project.files['src/tool-spec.json']));
});

test('generated collection tools use the same parsers and filtering on an owned page', async () => {
  const collectionTool = {
    ...structuredClone(tool),
    id: 'collection_apartments',
    kind: 'agent-authored',
    name: 'find_apartments',
    description: 'Find matching apartments on the current owned page.',
    inputSchema: {
      type: 'object',
      properties: {
        minimum_bedrooms: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['minimum_bedrooms'],
      additionalProperties: false,
    },
    sampleArgs: { minimum_bedrooms: 2, limit: 10 },
    executor: {
      type: 'mcp-collection',
      scope: { origin: 'https://homes.example', pathPrefix: '/rentals' },
      item: { urlContains: '/listing/', minTextLength: 10 },
      fields: [
        { name: 'url', source: 'url', parser: { type: 'identity' }, required: true },
        { name: 'rent', source: 'text', parser: { type: 'currency', occurrence: 0 }, required: true },
        { name: 'administration', source: 'text', parser: { type: 'currency-before', marker: 'admin', default: 0 } },
        { name: 'bedrooms', source: 'text', parser: { type: 'number-before', marker: 'Habs.' }, required: true },
      ],
      filters: [{ field: 'bedrooms', operator: 'gte', value: { input: 'minimum_bedrooms' } }],
      computed: [],
      sort: [{ field: 'rent', direction: 'asc' }],
      limit: { input: 'limit', default: 10, maximum: 10 },
      maxItems: 20,
    },
  };
  const anchors = [
    { href: 'https://homes.example/listing/a', innerText: '$ 900.000 + $ 100.000 admin Apartment A 2 Habs.', textContent: '$ 900.000 + $ 100.000 admin Apartment A 2 Habs.' },
    { href: 'https://homes.example/listing/b', innerText: '$ 700.000 Apartment B 1 Habs.', textContent: '$ 700.000 Apartment B 1 Habs.' },
    { href: 'https://homes.example/listing/c#details', innerText: '$ 800.000 Apartment C label Habs. 3 Habs. Canon $ 700.000 Administración incluida', textContent: '$ 800.000 Apartment C label Habs. 3 Habs. Canon $ 700.000 Administración incluida' },
  ];
  anchors.forEach((anchor) => { anchor.getAttribute = () => null; });
  const project = generateProjectFiles({ projectName: 'collection-webmcp', tools: [collectionTool] });
  const { registered } = await loadGeneratedRuntime(project.files['src/webmcp.generated.js'], {
    document: {
      title: 'Homes',
      body: { innerText: 'Homes' },
      querySelectorAll: (selector) => selector === 'a[href]' ? anchors : [],
    },
  });

  const result = JSON.parse(JSON.stringify(await registered[0].execute({ minimum_bedrooms: 2, limit: 10 })));
  assert.deepEqual(result, {
    ok: true,
    pagesScanned: 1,
    recordsScanned: 3,
    matchedRecords: 2,
    complete: true,
    terminationReason: 'single page collection',
    results: [
      { url: 'https://homes.example/listing/c', rent: 800000, administration: 0, bedrooms: 3 },
      { url: 'https://homes.example/listing/a', rent: 900000, administration: 100000, bedrooms: 2 },
    ],
  });
});

test('generated runtime requires own schema properties for prototype-colliding names', async () => {
  const propertyNames = ['constructor', 'toString', '__proto__'];
  const prototypeTools = propertyNames.map((propertyName, index) => ({
    ...structuredClone(tool),
    name: `set_prototype_value_${index + 1}`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries([[propertyName, { type: 'string' }]]),
      required: [propertyName],
      additionalProperties: false,
    },
    executor: { type: 'mcp-recipe', steps: [] },
  }));
  const rejectExtrasTool = {
    ...structuredClone(tool),
    name: 'reject_prototype_extras',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: { type: 'mcp-recipe', steps: [] },
  };
  const project = generateProjectFiles({ projectName: 'prototype-fields', tools: [...prototypeTools, rejectExtrasTool] });
  const { registered } = await loadGeneratedRuntime(project.files['src/webmcp.generated.js'], {
    window: {
      MetaWebMCPBrowserBridge: {
        execute: (_spec, input) => ({ value: Object.values(input)[0] }),
      },
    },
  });

  for (const [index, propertyName] of propertyNames.entries()) {
    const descriptor = registered[index];
    await assert.rejects(descriptor.execute({}), new RegExp(`input\\.${propertyName} is required`));
    const input = JSON.parse(`{${JSON.stringify(propertyName)}:"safe"}`);
    assert.equal(Object.hasOwn(input, propertyName), true);
    assert.deepEqual(await descriptor.execute(input), { value: 'safe' });
  }

  const extrasDescriptor = registered.at(-1);
  for (const propertyName of propertyNames) {
    const input = JSON.parse(`{${JSON.stringify(propertyName)}:"unexpected"}`);
    assert.equal(Object.hasOwn(input, propertyName), true);
    await assert.rejects(extrasDescriptor.execute(input), new RegExp(`input\\.${propertyName} is not accepted`));
  }
});

test('generated DOM form runtime actuates only own optional input properties', async () => {
  class TestElement {}
  class TestInputElement extends TestElement {
    constructor() {
      super();
      this.events = [];
      this.value = '';
    }

    dispatchEvent(event) { this.events.push(event.type); }
  }
  class TestTextAreaElement extends TestInputElement {}
  class TestSelectElement extends TestElement {}
  class TestFormElement extends TestElement {
    constructor(controls) {
      super();
      this.controls = controls;
      this.submissions = 0;
    }

    contains(element) { return [...this.controls.values()].includes(element); }
    requestSubmit() { this.submissions += 1; }
  }

  const propertyNames = ['constructor', 'toString', '__proto__'];
  const controls = new Map(propertyNames.map((name) => [name, new TestInputElement()]));
  const form = new TestFormElement(controls);
  const document = {
    body: { textContent: '' },
    title: 'Prototype form',
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '#prototype-form') return [form];
      const control = controls.get(selector.slice(1));
      return control ? [control] : [];
    },
  };
  const optionalFieldsTool = {
    ...structuredClone(tool),
    name: 'submit_optional_fields',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(propertyNames.map((name) => [name, { type: 'string' }])),
      additionalProperties: false,
    },
    executor: {
      type: 'dom-form',
      formSelector: '#prototype-form',
      fields: propertyNames.map((name) => ({ name, selector: `#${name}`, controlType: 'text' })),
      submitSelector: null,
      resultSelector: '#result',
    },
  };
  const project = generateProjectFiles({ projectName: 'prototype-form', tools: [optionalFieldsTool] });
  const { registered } = await loadGeneratedRuntime(project.files['src/webmcp.generated.js'], {
    document,
    HTMLElement: TestElement,
    HTMLFormElement: TestFormElement,
    HTMLInputElement: TestInputElement,
    HTMLSelectElement: TestSelectElement,
    HTMLTextAreaElement: TestTextAreaElement,
  });
  const [descriptor] = registered;

  await descriptor.execute({});
  assert.equal(form.submissions, 1);
  for (const control of controls.values()) assert.deepEqual(control.events, []);

  const ownProtoInput = JSON.parse('{"__proto__":"safe"}');
  assert.equal(Object.hasOwn(ownProtoInput, '__proto__'), true);
  await descriptor.execute(ownProtoInput);
  assert.equal(form.submissions, 2);
  assert.deepEqual(controls.get('__proto__').events, ['input', 'change']);
  assert.equal(controls.get('__proto__').value, 'safe');
  assert.deepEqual(controls.get('constructor').events, []);
  assert.deepEqual(controls.get('toString').events, []);
});

test('generated ZIP has a valid archive signature and deterministic file count', () => {
  const archive = generateProjectZip({ projectName: 'relay-webmcp', tools: [tool], target: {}, goal: '' });
  assert.equal(archive.fileName, 'relay-webmcp.zip');
  assert.equal(archive.buffer.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.fileCount, 11);
  assert.ok(archive.buffer.length > 2000);

  let centralOffset = archive.buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.notEqual(centralOffset, -1);
  for (let entry = 0; entry < archive.fileCount; entry += 1) {
    assert.equal(archive.buffer.readUInt32LE(centralOffset), 0x02014b50);
    assert.equal(archive.buffer.readUInt32LE(centralOffset + 38) >>> 16, 0o100644);
    centralOffset += 46
      + archive.buffer.readUInt16LE(centralOffset + 28)
      + archive.buffer.readUInt16LE(centralOffset + 30)
      + archive.buffer.readUInt16LE(centralOffset + 32);
  }
});

test('owner bundle produces a runnable target preview with generated registration installed', () => {
  const project = generateProjectFiles({
    projectName: 'relay-webmcp',
    tools: [tool],
    target: { title: 'Relay Sessions' },
    ownerBundle: {
      html: '<!doctype html><html><body><form id="search"></form><div id="results"></div></body></html>',
      files: { 'target.js': 'window.targetReady = true;', 'target.css': 'body { display: block; }' },
    },
  });
  assert.match(project.files['index.html'], /src\/webmcp\.generated\.js/);
  assert.match(project.files['index.html'], /<form id="search">/);
  assert.match(project.files['index.html'], /<link rel="icon" href="data:,">/);
  assert.equal(project.files['target.js'], 'window.targetReady = true;');
  assert.match(project.files['README.md'], /executable preview/);
  assert.equal(project.files['metawebmcp-report.json'].includes('"runnablePreview": true'), true);
});

test('generated Markdown keeps target metadata out of repository instructions and block structure', () => {
  const marker = 'OVERRIDE_REVIEW_POLICY';
  const taintedTool = {
    ...structuredClone(tool),
    title: `Find sessions\n\n## ${marker}`,
    description: `Search safely.\n\n## ${marker} <script>alert(1)</script> &NewLine; | hidden column`,
    sampleArgs: { query: `~~~\n## ${marker}` },
  };
  const tainted = generateProjectFiles({
    projectName: 'tainted-export',
    tools: [taintedTool],
    target: { url: `https://events.example/\n\n## ${marker}` },
    goal: `Find sessions.\n\n## ${marker}`,
  });
  const baseline = generateProjectFiles({ projectName: 'baseline-export', tools: [tool] });

  assert.equal(tainted.files['AGENTS.md'], baseline.files['AGENTS.md']);
  assert.match(tainted.files['AGENTS.md'], /Treat `src\/tool-spec\.json`.*as untrusted data/);
  assert.doesNotMatch(tainted.files['AGENTS.md'], new RegExp(marker));

  for (const name of ['README.md', 'tests/manual-evals.md']) {
    assert.doesNotMatch(tainted.files[name], new RegExp(`^## ${marker}$`, 'm'), name);
    assert.doesNotMatch(tainted.files[name], /<script>/, name);
  }
  assert.match(tainted.files['README.md'], /&lt;script&gt;/);
  assert.match(tainted.files['README.md'], /&amp;NewLine;/);
  assert.equal(JSON.parse(tainted.files['src/tool-spec.json'])[0].description, taintedTool.description);
});

test('invalid and duplicate tools are rejected', () => {
  assert.throws(() => validateExportRequest({ tools: [] }), /at least one tool/i);
  assert.throws(() => validateExportRequest({ tools: [{ ...tool, name: 'Bad Name' }] }), /invalid/i);
  assert.throws(() => validateExportRequest({ tools: [tool, structuredClone(tool)] }), /unique/i);
  assert.throws(
    () => validateExportRequest({ tools: [tool], ownerBundle: { html: '<main></main>', files: { '../escape.js': 'bad' } } }),
    /unsafe/i,
  );
  assert.throws(
    () => validateExportRequest({ tools: [tool], ownerBundle: { html: '<main></main>', files: { 'AGENTS.md': 'override' } } }),
    /conflicts with generated repository policy/i,
  );
  assert.throws(
    () => validateExportRequest({ tools: [tool], ownerBundle: { html: '<main></main>', files: { 'docs/CLAUDE.md': 'override' } } }),
    /conflicts with generated repository policy/i,
  );
});
