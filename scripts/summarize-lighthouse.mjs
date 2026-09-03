import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const [rawName, summaryName] = process.argv.slice(2);
if (!rawName || !summaryName) {
  throw new Error('Usage: node scripts/summarize-lighthouse.mjs <raw-report.json> <summary.json>');
}

const expectedDeploymentVersion = String(process.env.META_WEBMCP_DEPLOYMENT_VERSION || '').trim();
const expectedSourceCommit = String(process.env.META_WEBMCP_SOURCE_COMMIT || '').trim().toLowerCase();
if (!/^[0-9a-f]{40,64}$/.test(expectedSourceCommit)) {
  throw new Error('Set META_WEBMCP_SOURCE_COMMIT to the exact full deployed commit.');
}
const appUrl = String(process.env.META_WEBMCP_APP_URL || 'https://metawebmcp.neuryta.com');
const healthResponse = await fetch(new URL('/health', appUrl), {
  headers: { accept: 'application/json', 'user-agent': 'MetaWebMCP-Evidence/1.0' },
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
});
if (!healthResponse.ok) throw new Error(`Deployment health returned HTTP ${healthResponse.status}.`);
const health = await healthResponse.json();
const deploymentVersion = String(health.deploymentVersion || '').trim();
const sourceCommit = String(health.sourceCommit || '').trim().toLowerCase();
if (health.ok !== true || health.runtime !== 'cloudflare' || !deploymentVersion || !health.deployedAt) {
  throw new Error('Deployment health is missing immutable deployment identity fields.');
}
if (sourceCommit !== expectedSourceCommit) {
  throw new Error('Live deployment source commit does not match META_WEBMCP_SOURCE_COMMIT.');
}
if (expectedDeploymentVersion && deploymentVersion !== expectedDeploymentVersion) {
  throw new Error('Live Worker version does not match META_WEBMCP_DEPLOYMENT_VERSION.');
}

const raw = await readFile(path.resolve(rawName));
const script = await readFile(scriptPath);
const report = JSON.parse(raw);
const reportUrl = report.finalUrl || report.requestedUrl;
const inputArtifactName = String(process.env.META_WEBMCP_INPUT_ARTIFACT || '').trim();
let inputArtifact = null;
if (inputArtifactName) {
  const inputBytes = await readFile(path.resolve(inputArtifactName));
  inputArtifact = {
    file: path.basename(inputArtifactName),
    sha256: createHash('sha256').update(inputBytes).digest('hex'),
  };
}
const reportHostname = new URL(reportUrl).hostname;
if (['127.0.0.1', 'localhost', '::1'].includes(reportHostname) && !inputArtifact) {
  throw new Error('Set META_WEBMCP_INPUT_ARTIFACT to the exact archive used for a local Lighthouse target.');
}
const score = (name) => Math.round(Number(report.categories?.[name]?.score) * 100);
const consoleItems = report.audits?.['errors-in-console']?.details?.items || [];
const summary = {
  url: reportUrl,
  capturedAt: report.fetchTime,
  deploymentVersion,
  sourceCommit,
  deployedAt: health.deployedAt,
  deploymentTag: health.deploymentTag || null,
  identityVerifiedFromHealth: true,
  summarizer: path.basename(scriptPath),
  summarizerSha256: createHash('sha256').update(script).digest('hex'),
  rawReport: path.basename(rawName),
  rawReportSha256: createHash('sha256').update(raw).digest('hex'),
  inputArtifact,
  lighthouseVersion: report.lighthouseVersion,
  browser: String(report.environment?.hostUserAgent || '').match(/(?:Headless)?Chrome\/[^ ]+/)?.[0] || 'unknown',
  formFactor: report.configSettings?.formFactor || 'unknown',
  categories: {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
    agenticBrowsing: score('agentic-browsing'),
  },
  cumulativeLayoutShift: report.audits?.['cumulative-layout-shift']?.numericValue ?? null,
  consoleErrors: consoleItems.length,
};

await writeFile(path.resolve(summaryName), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
