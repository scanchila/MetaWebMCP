import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32 } from '../lib/zip.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const evidenceDirectory = path.join(root, 'evidence');
const identityFields = ['deploymentVersion', 'sourceCommit', 'deployedAt', 'deploymentTag'];

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

function assertCaptureSourceProvenance(record) {
  assert.equal(
    sha256(sourceFile(record, `scripts/${record.captureScript}`)),
    record.captureScriptSha256,
    `${record.captureScript} source SHA-256`,
  );
  for (const [name, expected] of Object.entries(record.captureDependencies || {})) {
    assert.equal(sha256(sourceFile(record, `scripts/${name}`)), expected, `${name} source SHA-256`);
  }
}

function assertAssetProvenance(record) {
  for (const [urlPath, expected] of Object.entries(record.assetSha256 || {})) {
    const relative = urlPath === '/' ? 'public/index.html' : `public${urlPath}`;
    assert.equal(sha256(sourceFile(record, relative)), expected, `${relative} deployed SHA-256`);
  }
}

const lighthouseScore = (report, category) => Math.round(Number(report.categories?.[category]?.score) * 100);
const lighthouseConsoleErrors = (report) => report.audits?.['errors-in-console']?.details?.items?.length || 0;
const lighthouseBrowser = (report) => (
  String(report.environment?.hostUserAgent || '').match(/(?:Headless)?Chrome\/[^ ]+/)?.[0] || 'unknown'
);

async function assertLighthouseSummary(summaryName) {
  const summary = await json(summaryName);
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
  if (summary.inputArtifact) {
    await assertArtifactHash(summary.inputArtifact.file, summary.inputArtifact.sha256);
  }
  return summary;
}

function parseStoredZip(content) {
  const entries = new Map();
  let offset = 0;
  while (content.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(content.readUInt16LE(offset + 8), 0, 'retained ZIP entries must be stored');
    const checksum = content.readUInt32LE(offset + 14);
    const size = content.readUInt32LE(offset + 18);
    assert.equal(size, content.readUInt32LE(offset + 22), 'stored ZIP sizes');
    const nameLength = content.readUInt16LE(offset + 26);
    const extraLength = content.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = content.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const data = content.subarray(dataStart, dataStart + size);
    assert.ok(name && !path.posix.isAbsolute(name) && !name.split('/').includes('..'), `safe ZIP path: ${name}`);
    assert.equal(crc32(data), checksum, `${name} CRC-32`);
    assert.equal(entries.has(name), false, `unique ZIP path: ${name}`);
    entries.set(name, data);
    offset = dataStart + size;
  }
  assert.equal(content.readUInt32LE(offset), 0x02014b50, 'ZIP central directory');

  const endOffset = content.length - 22;
  assert.equal(content.readUInt32LE(endOffset), 0x06054b50, 'ZIP end record');
  const centralEntries = content.readUInt16LE(endOffset + 10);
  let centralOffset = content.readUInt32LE(endOffset + 16);
  for (let index = 0; index < centralEntries; index += 1) {
    assert.equal(content.readUInt32LE(centralOffset), 0x02014b50);
    assert.equal(content.readUInt32LE(centralOffset + 38) >>> 16, 0o100644, 'portable ZIP file mode');
    centralOffset += 46
      + content.readUInt16LE(centralOffset + 28)
      + content.readUInt16LE(centralOffset + 30)
      + content.readUInt16LE(centralOffset + 32);
  }
  assert.equal(centralEntries, entries.size);
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
  assertSameDeployment([native, security, productionSummary, exportSummary, productionSamples]);
  for (const record of [native, publicSites, security]) assertCaptureSourceProvenance(record);
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
  assert.equal(publicSites.results.length, 3);
  for (const result of publicSites.results) {
    assert.deepEqual(result.consoleErrors, []);
    assert.ok(result.stages.every((stage) => stage.execution.ok === true));
    assert.ok(Object.values(result.postconditions).every((value) => value === true));
  }
});

test('retained Lighthouse summaries and sample aggregate match every raw report', async () => {
  await assertLighthouseSummary('lighthouse-production-summary.json');
  await assertLighthouseSummary('lighthouse-native-export-summary.json');
  const samples = await json('lighthouse-production-samples.json');
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
  assert.equal(entries.size, native.exported.fileCount);
  assert.equal(entries.size, native.exportedNativeValidation.fileCount);
  const source = [...entries.entries()].find(([name]) => name.endsWith('/src/webmcp.generated.js'))?.[1];
  assert.ok(source, 'generated native source is present');
  assert.match(source.toString('utf8'), /document\.modelContext\.registerTool\(\{/);
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
