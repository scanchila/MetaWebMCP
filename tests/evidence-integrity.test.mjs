import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceDirectory = path.join(root, 'evidence');
const identityFields = ['deploymentVersion', 'sourceCommit', 'deployedAt', 'deploymentTag'];
const deployedAssetPaths = [
  '/',
  '/styles.css',
  '/js/app.js',
  '/js/browser-mcp-session.js',
  '/js/demo-analyzer.js',
  '/js/mcp-http-client.js',
  '/js/mcp-recipe.js',
  '/js/network-policy.js',
  '/js/webmcp-runtime.js',
  '/demo/index.html',
  '/demo/demo.css',
  '/demo/demo.js',
];
const expectedExportFiles = [
  'relay-sessions-webmcp/AGENTS.md',
  'relay-sessions-webmcp/LICENSE',
  'relay-sessions-webmcp/README.md',
  'relay-sessions-webmcp/index.html',
  'relay-sessions-webmcp/integration-report.html',
  'relay-sessions-webmcp/metawebmcp-report.json',
  'relay-sessions-webmcp/package.json',
  'relay-sessions-webmcp/serve.mjs',
  'relay-sessions-webmcp/src/tool-spec.json',
  'relay-sessions-webmcp/src/webmcp.generated.js',
  'relay-sessions-webmcp/target.css',
  'relay-sessions-webmcp/target.js',
  'relay-sessions-webmcp/tests/manual-evals.md',
];
const expectedPublicJourneys = {
  'wikipedia-search': {
    target: 'Wikipedia',
    postconditions: ['search:WebMCP'],
    stages: [{
      tool: 'search',
      steps: ['browser_type', 'browser_click', 'browser_snapshot'],
      postconditions: ['WebMCP'],
    }],
  },
  'saucedemo-cart': {
    target: 'SauceDemo',
    postconditions: [
      'login:Products',
      'add_to_cart:Sauce Labs Backpack',
      'add_to_cart:Remove',
    ],
    stages: [
      {
        tool: 'login',
        steps: ['browser_type', 'browser_type', 'browser_click', 'browser_snapshot'],
        postconditions: ['Products'],
      },
      {
        tool: 'add_to_cart',
        steps: ['browser_click', 'browser_snapshot'],
        postconditions: ['Sauce Labs Backpack', 'Remove'],
      },
    ],
  },
  'the-internet-add-element': {
    target: 'The Internet',
    postconditions: ['add_element:Delete'],
    stages: [{
      tool: 'add_element',
      steps: ['browser_click', 'browser_snapshot'],
      postconditions: ['Delete'],
    }],
  },
};

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

async function json(relative) {
  return JSON.parse(await readFile(path.join(evidenceDirectory, relative), 'utf8'));
}

async function assertArtifactHash(relative, expected) {
  const content = await readFile(path.join(evidenceDirectory, relative));
  assert.equal(sha256(content), expected, `${relative} SHA-256`);
}

function sourceFile(record, relative) {
  return execFileSync('git', ['show', `${record.sourceCommit}:${relative}`], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertDeploymentIdentity(record, label) {
  assert.match(record.deploymentVersion, /\S/, `${label} deployment version`);
  assert.match(record.sourceCommit, /^[0-9a-f]{40,64}$/, `${label} source commit`);
  assert.ok(Number.isFinite(Date.parse(record.deployedAt)), `${label} deployment timestamp`);
  assert.equal(record.deploymentTag, `source-${record.sourceCommit.slice(0, 12)}`, `${label} deployment tag`);
  assert.equal(record.identityVerifiedFromHealth, true, `${label} health identity`);
  assert.equal(
    execFileSync('git', ['cat-file', '-t', record.sourceCommit], { cwd: root, encoding: 'utf8' }).trim(),
    'commit',
    `${label} source identity is a commit`,
  );
}

function assertSameDeployment(records) {
  const expected = Object.fromEntries(identityFields.map((field) => [field, records[0][field]]));
  for (const record of records.slice(1)) {
    assert.deepEqual(
      Object.fromEntries(identityFields.map((field) => [field, record[field]])),
      expected,
    );
  }
}

function assertSameProductionOrigin(values) {
  const origins = values.map((value) => new URL(value).origin);
  assert.ok(origins.every((origin) => origin === origins[0]), 'production evidence origins must agree');
}

function assertCaptureSourceProvenance(record, captureScript, dependencies) {
  assert.equal(record.captureScript, captureScript);
  assert.ok(record.captureDependencies && !Array.isArray(record.captureDependencies), 'capture dependency map');
  assert.deepEqual(Object.keys(record.captureDependencies).sort(), [...dependencies].sort());
  assert.equal(
    sha256(sourceFile(record, `scripts/${record.captureScript}`)),
    record.captureScriptSha256,
    `${record.captureScript} source SHA-256`,
  );
  for (const [name, expected] of Object.entries(record.captureDependencies)) {
    assert.equal(sha256(sourceFile(record, `scripts/${name}`)), expected, `${name} source SHA-256`);
  }
}

function assertAssetProvenance(record) {
  assert.ok(record.assetSha256 && !Array.isArray(record.assetSha256), 'deployed asset hash map');
  assert.deepEqual(Object.keys(record.assetSha256).sort(), [...deployedAssetPaths].sort());
  for (const [urlPath, expected] of Object.entries(record.assetSha256)) {
    const relative = urlPath === '/' ? 'public/index.html' : `public${urlPath}`;
    assert.equal(sha256(sourceFile(record, relative)), expected, `${relative} deployed SHA-256`);
  }
}

const lighthouseScore = (report, category) => Math.round(Number(report.categories?.[category]?.score) * 100);
const lighthouseConsoleErrors = (report) => report.audits?.['errors-in-console']?.details?.items?.length || 0;
const lighthouseBrowser = (report) => (
  String(report.environment?.hostUserAgent || '').match(/(?:Headless)?Chrome\/[^ ]+/)?.[0] || 'unknown'
);

async function assertLighthouseSummary(summaryName, { rawReport, inputArtifact }) {
  const summary = await json(summaryName);
  assert.equal(summary.summarizer, 'summarize-lighthouse.mjs');
  assert.equal(summary.rawReport, rawReport);
  const rawBytes = await readFile(path.join(evidenceDirectory, summary.rawReport));
  const report = JSON.parse(rawBytes);
  assert.equal(sha256(rawBytes), summary.rawReportSha256);
  assert.equal(summary.url, report.finalUrl || report.requestedUrl);
  assert.equal(summary.capturedAt, report.fetchTime);
  assert.equal(summary.lighthouseVersion, report.lighthouseVersion);
  assert.equal(summary.browser, lighthouseBrowser(report));
  assert.equal(summary.formFactor, report.configSettings?.formFactor || 'unknown');
  assert.deepEqual(summary.categories, {
    performance: lighthouseScore(report, 'performance'),
    accessibility: lighthouseScore(report, 'accessibility'),
    bestPractices: lighthouseScore(report, 'best-practices'),
    seo: lighthouseScore(report, 'seo'),
    agenticBrowsing: lighthouseScore(report, 'agentic-browsing'),
  });
  assert.equal(summary.cumulativeLayoutShift, report.audits?.['cumulative-layout-shift']?.numericValue ?? null);
  assert.equal(summary.consoleErrors, lighthouseConsoleErrors(report));
  assert.equal(
    sha256(sourceFile(summary, `scripts/${summary.summarizer}`)),
    summary.summarizerSha256,
    `${summary.summarizer} source SHA-256`,
  );
  if (inputArtifact) {
    assert.deepEqual(Object.keys(summary.inputArtifact).sort(), ['file', 'sha256']);
    assert.equal(summary.inputArtifact.file, inputArtifact);
    await assertArtifactHash(inputArtifact, summary.inputArtifact.sha256);
  } else {
    assert.equal(summary.inputArtifact, null);
  }
  return summary;
}

function independentCrc32(content) {
  let checksum = 0xffffffff;
  for (const byte of content) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function assertSafeZipPath(name) {
  const segments = name.split('/');
  assert.ok(
    name
      && !name.includes('\\')
      && !name.includes('\0')
      && !path.posix.isAbsolute(name)
      && !/^[a-z]:/i.test(name)
      && !segments.includes('..'),
    `safe ZIP path: ${name}`,
  );
}

function parseStoredZip(content) {
  assert.ok(content.length >= 22, 'ZIP end record is present');
  const endOffset = content.length - 22;
  assert.equal(content.readUInt32LE(endOffset), 0x06054b50, 'ZIP end record');
  assert.equal(content.readUInt16LE(endOffset + 4), 0, 'single-disk ZIP');
  assert.equal(content.readUInt16LE(endOffset + 6), 0, 'central directory disk');
  const entriesOnDisk = content.readUInt16LE(endOffset + 8);
  const centralEntries = content.readUInt16LE(endOffset + 10);
  assert.equal(entriesOnDisk, centralEntries, 'complete central directory');
  assert.equal(content.readUInt16LE(endOffset + 20), 0, 'ZIP comment length');
  const centralSize = content.readUInt32LE(endOffset + 12);
  const centralStart = content.readUInt32LE(endOffset + 16);
  assert.equal(centralStart + centralSize, endOffset, 'central directory extent');

  const centralRecords = [];
  const centralNames = new Set();
  let centralOffset = centralStart;
  for (let index = 0; index < centralEntries; index += 1) {
    assert.ok(centralOffset + 46 <= endOffset, 'complete central entry');
    assert.equal(content.readUInt32LE(centralOffset), 0x02014b50, 'central entry signature');
    const flags = content.readUInt16LE(centralOffset + 8);
    const method = content.readUInt16LE(centralOffset + 10);
    const checksum = content.readUInt32LE(centralOffset + 16);
    const compressedSize = content.readUInt32LE(centralOffset + 20);
    const size = content.readUInt32LE(centralOffset + 24);
    const nameLength = content.readUInt16LE(centralOffset + 28);
    const extraLength = content.readUInt16LE(centralOffset + 30);
    const commentLength = content.readUInt16LE(centralOffset + 32);
    const localOffset = content.readUInt32LE(centralOffset + 42);
    const nameStart = centralOffset + 46;
    const recordEnd = nameStart + nameLength + extraLength + commentLength;
    assert.ok(recordEnd <= endOffset, 'central entry stays inside its directory');
    const nameBytes = content.subarray(nameStart, nameStart + nameLength);
    const name = nameBytes.toString('utf8');
    assert.deepEqual(Buffer.from(name, 'utf8'), nameBytes, `valid UTF-8 ZIP path: ${name}`);
    assertSafeZipPath(name);
    assert.equal(centralNames.has(name), false, `unique central ZIP path: ${name}`);
    centralNames.add(name);
    assert.equal(flags & 0x0009, 0, `${name} is unencrypted and has no data descriptor`);
    assert.equal(method, 0, `${name} is stored`);
    assert.equal(compressedSize, size, `${name} stored sizes`);
    assert.equal(content.readUInt32LE(centralOffset + 38) >>> 16, 0o100644, `${name} portable file mode`);
    centralRecords.push({ name, flags, method, checksum, compressedSize, size, localOffset });
    centralOffset = recordEnd;
  }
  assert.equal(centralOffset, centralStart + centralSize, 'complete central directory bytes');

  const entries = new Map();
  const localRegions = [];
  for (const central of centralRecords) {
    const offset = central.localOffset;
    assert.ok(offset + 30 <= centralStart, `${central.name} local header bounds`);
    assert.equal(content.readUInt32LE(offset), 0x04034b50, `${central.name} local signature`);
    assert.equal(content.readUInt16LE(offset + 6), central.flags, `${central.name} flags`);
    assert.equal(content.readUInt16LE(offset + 8), central.method, `${central.name} method`);
    assert.equal(content.readUInt32LE(offset + 14), central.checksum, `${central.name} central CRC-32`);
    assert.equal(content.readUInt32LE(offset + 18), central.compressedSize, `${central.name} compressed size`);
    assert.equal(content.readUInt32LE(offset + 22), central.size, `${central.name} uncompressed size`);
    const nameLength = content.readUInt16LE(offset + 26);
    const extraLength = content.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + central.compressedSize;
    assert.ok(dataEnd <= centralStart, `${central.name} data bounds`);
    const localName = content.subarray(nameStart, nameStart + nameLength).toString('utf8');
    assert.equal(localName, central.name, `${central.name} local path`);
    const data = content.subarray(dataStart, dataEnd);
    assert.equal(independentCrc32(data), central.checksum, `${central.name} independent CRC-32`);
    assert.equal(entries.has(central.name), false, `unique local ZIP path: ${central.name}`);
    entries.set(central.name, data);
    localRegions.push({ start: offset, end: dataEnd, name: central.name });
  }

  localRegions.sort((left, right) => left.start - right.start);
  let localOffset = 0;
  for (const region of localRegions) {
    assert.equal(region.start, localOffset, `${region.name} follows the prior local entry`);
    localOffset = region.end;
  }
  assert.equal(localOffset, centralStart, 'local entries exactly precede the central directory');
  return entries;
}

test('retained screenshots and archives match their recorded hashes', async () => {
  const native = await json('native-webmcp-result.json');
  await assertArtifactHash(native.screenshot, native.screenshotSha256);
  await assertArtifactHash(
    native.exportedNativeValidation.screenshot,
    native.exportedNativeValidation.screenshotSha256,
  );
  await assertArtifactHash(
    native.exportedNativeValidation.archive,
    native.exportedNativeValidation.archiveSha256,
  );

  const publicSites = await json('public-site-results.json');
  for (const result of publicSites.results) {
    await assertArtifactHash(result.workspaceScreenshot, result.workspaceScreenshotSha256);
    await assertArtifactHash(result.targetScreenshot, result.targetScreenshotSha256);
  }
});

test('retained capture records resolve to their exact source and deployment identities', async () => {
  const native = await json('native-webmcp-result.json');
  const publicSites = await json('public-site-results.json');
  const security = await json('deployment-security-gates.json');
  const productionSummary = await json('lighthouse-production-summary.json');
  const exportSummary = await json('lighthouse-native-export-summary.json');
  const productionSamples = await json('lighthouse-production-samples.json');

  for (const [label, record] of Object.entries({
    native,
    publicSites,
    security,
    productionSummary,
    exportSummary,
    productionSamples,
  })) assertDeploymentIdentity(record, label);
  assertSameDeployment([native, publicSites, security, productionSummary, exportSummary, productionSamples]);
  assertSameProductionOrigin([
    native.deployment,
    publicSites.deployment,
    security.deployment,
    productionSummary.url,
    productionSamples.deployment,
  ]);
  assertCaptureSourceProvenance(native, 'capture-native-evidence.py', ['evidence_provenance.py']);
  assertCaptureSourceProvenance(publicSites, 'capture-public-evidence.py', ['evidence_provenance.py']);
  assertCaptureSourceProvenance(security, 'capture-deployment-security-gates.py', ['evidence_provenance.py']);
  for (const record of [native, publicSites]) assertAssetProvenance(record);

  assert.equal(native.evaluation.ok, true);
  assert.equal(native.exportedNativeValidation.directRegisterTool, true);
  assert.deepEqual(native.consoleErrors, []);
  assert.deepEqual(security.checks, {
    healthStatus: 200,
    unauthenticatedBrowserApiStatus: 401,
    crossOriginCapabilityIssueStatus: 403,
    sameOriginCapabilityIssueStatus: 201,
    authorizedBrowserApiStatus: 200,
    tamperedCapabilityStatus: 401,
    unauthenticatedRawSseStatus: 401,
    privateTargetStatus: 400,
    unauthenticatedExportStatus: 401,
    authorizedExportStatus: 201,
    unauthenticatedDownloadStatus: 401,
    otherCapabilityDownloadStatus: 404,
    authorizedDownloadStatus: 200,
    repeatedDownloadStatus: 404,
    downloadZipSignature: true,
    cookieSecure: true,
    cookieHttpOnly: true,
    cookieSameSiteStrict: true,
    cookiePathRoot: true,
  });
  assert.equal(security.sensitiveValuesRetained, false);
  assert.deepEqual(
    publicSites.results.map((result) => result.slug).sort(),
    Object.keys(expectedPublicJourneys).sort(),
  );
  for (const result of publicSites.results) {
    const expected = expectedPublicJourneys[result.slug];
    assert.ok(expected, `known public-site journey: ${result.slug}`);
    assert.equal(result.target, expected.target);
    assert.equal(result.stages.length, expected.stages.length, `${result.slug} stage count`);
    assert.deepEqual(result.session, {
      established: true,
      reusedAcrossStages: true,
      stageCount: expected.stages.length,
    });
    assert.deepEqual(Object.keys(result.postconditions).sort(), [...expected.postconditions].sort());
    assert.ok(Object.values(result.postconditions).every((value) => value === true));
    assert.deepEqual(result.consoleErrors, []);
    result.stages.forEach((stage, index) => {
      const expectedStage = expected.stages[index];
      assert.equal(stage.selectedTool, expectedStage.tool);
      assert.equal(stage.nativeRegistered, true);
      assert.deepEqual(stage.generatedTools.map((tool) => tool.name), [expectedStage.tool]);
      assert.equal(stage.analysis.runtime.sessionEstablished, true);
      assert.equal(stage.analysis.runtime.sessionReused, true);
      assert.equal(stage.execution.ok, true);
      assert.deepEqual(stage.execution.steps.map((step) => step.tool), expectedStage.steps);
      assert.deepEqual(Object.keys(stage.postconditions).sort(), [...expectedStage.postconditions].sort());
      assert.ok(Object.values(stage.postconditions).every((value) => value === true));
    });
  }
});

test('retained Lighthouse summaries and sample aggregate match every raw report', async () => {
  const productionSummary = await assertLighthouseSummary('lighthouse-production-summary.json', {
    rawReport: 'lighthouse-production-report.json',
    inputArtifact: null,
  });
  await assertLighthouseSummary('lighthouse-native-export-summary.json', {
    rawReport: 'lighthouse-native-export-report.json',
    inputArtifact: 'relay-sessions-webmcp.zip',
  });
  const samples = await json('lighthouse-production-samples.json');
  const expectedReports = [
    'lighthouse-production-report-run1.json',
    'lighthouse-production-report-run2.json',
    'lighthouse-production-report.json',
  ];
  assert.equal(samples.samples.length, 3);
  assert.deepEqual(samples.samples.map((sample) => sample.rawReport).sort(), [...expectedReports].sort());
  assert.equal(samples.samples.filter((sample) => sample.rawReport === productionSummary.rawReport).length, 1);
  const computed = [];
  for (const sample of samples.samples) {
    const rawBytes = await readFile(path.join(evidenceDirectory, sample.rawReport));
    const report = JSON.parse(rawBytes);
    const expected = {
      rawReport: sample.rawReport,
      rawReportSha256: sha256(rawBytes),
      capturedAt: report.fetchTime,
      performance: lighthouseScore(report, 'performance'),
      firstContentfulPaintMs: report.audits?.['first-contentful-paint']?.numericValue ?? null,
      largestContentfulPaintMs: report.audits?.['largest-contentful-paint']?.numericValue ?? null,
      totalBlockingTimeMs: report.audits?.['total-blocking-time']?.numericValue ?? null,
      cumulativeLayoutShift: report.audits?.['cumulative-layout-shift']?.numericValue ?? null,
      consoleErrors: lighthouseConsoleErrors(report),
    };
    assert.deepEqual(sample, expected);
    assert.equal(samples.lighthouseVersion, report.lighthouseVersion);
    assert.equal(samples.browser, lighthouseBrowser(report));
    assert.equal(samples.formFactor, report.configSettings?.formFactor || 'unknown');
    assert.equal(
      new URL(report.finalUrl || report.requestedUrl).href,
      new URL(samples.deployment).href,
      `${sample.rawReport} production URL`,
    );
    computed.push({ report, sample: expected });
  }

  const performance = computed.map(({ sample }) => sample.performance).sort((left, right) => left - right);
  const categoryScores = (name) => computed.map(({ report }) => lighthouseScore(report, name));
  for (const [field, category] of Object.entries({
    accessibility: 'accessibility',
    bestPractices: 'best-practices',
    seo: 'seo',
    agenticBrowsing: 'agentic-browsing',
  })) {
    const values = categoryScores(category);
    assert.ok(values.every((value) => value === values[0]), `${field} scores must agree across samples`);
    assert.equal(samples.aggregate[field], values[0]);
  }
  assert.deepEqual(samples.aggregate.performanceRange, [performance[0], performance.at(-1)]);
  assert.equal(samples.aggregate.medianPerformance, performance[Math.floor(performance.length / 2)]);
  assert.equal(
    samples.aggregate.maximumCumulativeLayoutShift,
    Math.max(...computed.map(({ sample }) => sample.cumulativeLayoutShift)),
  );
  assert.equal(
    samples.aggregate.consoleErrors,
    computed.reduce((total, { sample }) => total + sample.consoleErrors, 0),
  );
});

test('retained export is a safe complete native WebMCP repository', async () => {
  const native = await json('native-webmcp-result.json');
  const archive = await readFile(path.join(evidenceDirectory, native.exportedNativeValidation.archive));
  const entries = parseStoredZip(archive);
  assert.equal(native.exported.fileName, native.exportedNativeValidation.archive);
  assert.equal(native.exported.bytes, archive.length);
  assert.equal(native.exportedNativeValidation.unixFileMode, '0644');
  assert.equal(entries.size, native.exported.fileCount);
  assert.equal(entries.size, native.exportedNativeValidation.fileCount);
  assert.deepEqual([...entries.keys()].sort(), [...expectedExportFiles].sort());

  const source = entries.get('relay-sessions-webmcp/src/webmcp.generated.js')?.toString('utf8');
  const toolSpecs = JSON.parse(entries.get('relay-sessions-webmcp/src/tool-spec.json')?.toString('utf8'));
  assert.match(source, /\S/, 'generated native source is present');
  assert.ok(Array.isArray(toolSpecs) && toolSpecs.length > 0, 'generated tool specs are present');
  assert.deepEqual(
    toolSpecs.map((tool) => tool.name).sort(),
    [...native.exportedNativeValidation.registeredTools].sort(),
  );

  const registered = [];
  const executableSource = source.replace(/^export\s+/gm, '');
  await runInNewContext(`${executableSource}\nregisterGeneratedWebMCP();`, {
    AbortController,
    console: { info() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      modelContext: {
        async registerTool(spec) {
          registered.push(spec.name);
        },
      },
    },
  }, { timeout: 1_000 });
  assert.deepEqual(registered, toolSpecs.map((tool) => tool.name));
});

test('every local evidence-document link resolves', async () => {
  const markdown = await readFile(path.join(evidenceDirectory, 'README.md'), 'utf8');
  const links = [...markdown.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
  for (const link of links.filter((value) => !/^[a-z]+:/i.test(value) && !value.startsWith('#'))) {
    const target = path.resolve(evidenceDirectory, decodeURIComponent(link.split('#', 1)[0]));
    assert.ok(target.startsWith(`${root}${path.sep}`), `evidence link stays inside the repository: ${link}`);
    await stat(target);
  }
});
