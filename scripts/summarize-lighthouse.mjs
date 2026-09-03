import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [rawName, summaryName] = process.argv.slice(2);
if (!rawName || !summaryName) {
  throw new Error('Usage: node scripts/summarize-lighthouse.mjs <raw-report.json> <summary.json>');
}

const deploymentVersion = String(process.env.META_WEBMCP_DEPLOYMENT_VERSION || '').trim();
if (!deploymentVersion) throw new Error('Set META_WEBMCP_DEPLOYMENT_VERSION to the deployed Worker version.');
const sourceCommit = String(process.env.META_WEBMCP_SOURCE_COMMIT || '').trim()
  || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

const raw = await readFile(path.resolve(rawName));
const report = JSON.parse(raw);
const score = (name) => Math.round(Number(report.categories?.[name]?.score) * 100);
const consoleItems = report.audits?.['errors-in-console']?.details?.items || [];
const summary = {
  url: report.finalUrl || report.requestedUrl,
  capturedAt: report.fetchTime,
  deploymentVersion,
  sourceCommit,
  rawReport: path.basename(rawName),
  rawReportSha256: createHash('sha256').update(raw).digest('hex'),
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
