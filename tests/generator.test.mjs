import test from 'node:test';
import assert from 'node:assert/strict';

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

test('export validation normalizes project name and preserves tool contract', () => {
  const result = validateExportRequest({ projectName: 'Relay Sessions!', tools: [tool], goal: 'Find sessions' });
  assert.equal(result.projectName, 'relay-sessions');
  assert.equal(result.tools[0].name, 'find_sessions');
});

test('generated project directly registers WebMCP tools and includes review artifacts', () => {
  const project = generateProjectFiles({ projectName: 'relay-webmcp', tools: [tool], target: { url: 'https://events.example' }, goal: 'Find sessions' });
  assert.match(project.files['src/webmcp.generated.js'], /document\.modelContext\.registerTool\(\{/);
  assert.match(project.files['src/webmcp.generated.js'], /name: spec\.name/);
  assert.match(
    project.files['src/webmcp.generated.js'],
    /form\.querySelector\(executor\.submitSelector\) \|\| document\.querySelector\(executor\.submitSelector\)/,
  );
  assert.match(project.files['README.md'], /top-level page/);
  assert.match(project.files['integration-report.html'], /Generated WebMCP integration/);
  assert.match(project.files['integration-report.html'], /<link rel="icon" href="data:,">/);
  assert.match(project.files['AGENTS.md'], /Replace DOM clicks with stable application functions/);
  assert.match(project.files['tests/manual-evals.md'], /Expected selection: `find_sessions`/);
  assert.doesNotThrow(() => JSON.parse(project.files['src/tool-spec.json']));
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

test('invalid and duplicate tools are rejected', () => {
  assert.throws(() => validateExportRequest({ tools: [] }), /at least one tool/i);
  assert.throws(() => validateExportRequest({ tools: [{ ...tool, name: 'Bad Name' }] }), /invalid/i);
  assert.throws(() => validateExportRequest({ tools: [tool, structuredClone(tool)] }), /unique/i);
  assert.throws(
    () => validateExportRequest({ tools: [tool], ownerBundle: { html: '<main></main>', files: { '../escape.js': 'bad' } } }),
    /unsafe/i,
  );
});
