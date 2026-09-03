#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { analyzeAccessibilitySnapshot } from '../lib/analyzer.mjs';
import { flattenMcpText, McpHttpClient, McpSseClient } from '../lib/mcp-http-client.mjs';
import { runMcpCollection } from '../public/js/mcp-collection.js';
import { buildAuthoredToolSpecs } from '../public/js/tool-authoring.js';

const TARGET_URL = 'https://www.fincaraiz.com.co/arriendo/apartamentos/bogota/bogota-dc/baratos';
const DEFAULT_ENDPOINT = 'http://localhost:8932/sse';
const GOAL = 'Find the 50 cheapest unique apartments with at least 2 bedrooms, 45–100 m², and an explicit laundry-area phrase; rank by rent plus administration.';
const LAUNDRY_PHRASES = [
  'zona de ropas',
  'zona de lavado',
  'zona de lavandería',
  'área de ropas',
  'área de lavado',
  'área de lavandería',
  'lavandería independiente',
];

function usage() {
  return 'Usage: node scripts/capture-fincaraiz-metawebmcp.mjs [--endpoint URL] [--output PATH]\n';
}

function parseArguments(argv) {
  const options = { endpoint: DEFAULT_ENDPOINT, output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--endpoint' || argument === '--output') {
      options[argument.slice(2)] = argv[index + 1] || '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function compactCapability(capability) {
  return {
    id: capability.id,
    kind: capability.kind,
    name: capability.name,
    title: capability.title,
    risk: capability.risk,
    inputProperties: Object.keys(capability.inputSchema?.properties || {}),
    executorType: capability.executor?.type,
    outputFields: (capability.executor?.fields || []).map((field) => field.name),
    paginated: Boolean(capability.executor?.pagination),
    recipeSteps: (capability.executor?.steps || []).map((step) => step.tool),
  };
}

function taskCoverage(capabilities) {
  const compact = capabilities.map(compactCapability);
  const listingExtractionContract = capabilities.some((capability) => {
    if (capability.executor?.type === 'mcp-collection' && capability.executor.fields?.length) return true;
    const output = capability.outputSchema;
    return output?.type === 'array'
      || Object.values(output?.properties || {}).some((property) => property?.type === 'array');
  });
  const allInputNames = compact.flatMap((capability) => capability.inputProperties).join(' ');
  const benchmarkFilterInputs = /bed|room|habit/i.test(allInputNames)
    && /area|m2|square/i.test(allInputNames)
    && /laundry|lavander|lavado|ropas|description/i.test(allInputNames);
  const paginationContract = compact.some((capability) =>
    /\b(next|page|pagina|siguiente)\b/i.test(`${capability.name} ${capability.title}`)
      || capability.paginated
      || capability.recipeSteps.includes('browser_navigate'));
  const canCompleteTask = listingExtractionContract && benchmarkFilterInputs && paginationContract;
  return {
    listingExtractionContract,
    benchmarkFilterInputs,
    paginationContract,
    canCompleteTask,
    reason: canCompleteTask
      ? 'The generated surface contains the structural contracts required to attempt the task; result quality still needs scoring.'
      : `The generated candidates (${compact.map((capability) => capability.name).join(', ') || 'none'}) do not provide all three required contracts: structured listing output, benchmark filter inputs, and pagination.`,
  };
}

function authoredDefinition(collection) {
  if (!collection?.executor?.pagination) {
    throw new Error('The analyzed listing collection did not expose an observed pagination template.');
  }
  return {
    capability_ids: [collection.id],
    name: 'find_matching_apartments',
    description: 'Return the cheapest matching rental apartments as normalized records after bounded pagination.',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        minimum_bedrooms: { type: 'number', minimum: 0 },
        minimum_area_m2: { type: 'number', minimum: 0 },
        maximum_area_m2: { type: 'number', minimum: 0 },
        laundry_phrases: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['minimum_bedrooms', 'minimum_area_m2', 'maximum_area_m2', 'laundry_phrases', 'limit'],
      additionalProperties: false,
    },
    sample_args: {
      minimum_bedrooms: 2,
      minimum_area_m2: 45,
      maximum_area_m2: 100,
      laundry_phrases: LAUNDRY_PHRASES,
      limit: 50,
    },
    executor: {
      type: 'mcp-collection',
      item: collection.executor.item,
      fields: [
        { name: 'url', source: 'url', parser: { type: 'identity' }, required: true },
        { name: 'rent_cop', source: 'text', parser: { type: 'currency', occurrence: 0 }, required: true },
        { name: 'administration_cop', source: 'text', parser: { type: 'currency-before', marker: 'admin', default: 0 } },
        { name: 'bedrooms', source: 'text', parser: { type: 'number-before', marker: 'Habs.' }, required: true },
        { name: 'area_m2', source: 'text', parser: { type: 'number-before', marker: 'm²' }, required: true },
        { name: 'laundry_evidence', source: 'text', parser: { type: 'matched-input', input: 'laundry_phrases' }, required: true },
      ],
      filters: [
        { field: 'bedrooms', operator: 'gte', value: { input: 'minimum_bedrooms' } },
        { field: 'area_m2', operator: 'gte', value: { input: 'minimum_area_m2' } },
        { field: 'area_m2', operator: 'lte', value: { input: 'maximum_area_m2' } },
        { field: '$text', operator: 'contains-any', value: { input: 'laundry_phrases' } },
      ],
      computed: [{ name: 'total_monthly_cop', operator: 'sum', fields: ['rent_cop', 'administration_cop'] }],
      sort: [
        { field: 'total_monthly_cop', direction: 'asc' },
        { field: 'rent_cop', direction: 'asc' },
        { field: 'url', direction: 'asc' },
      ],
      limit: { input: 'limit', default: 50, maximum: 50 },
      maxItems: 500,
      pagination: {
        ...collection.executor.pagination,
        maxPages: 20,
        stopWhen: {
          type: 'page-minimum-exceeds-ranked',
          sourceField: 'rent_cop',
          resultField: 'total_monthly_cop',
          rank: 50,
        },
      },
    },
  };
}

async function capture(endpoint) {
  const Client = new URL(endpoint).pathname.endsWith('/sse') ? McpSseClient : McpHttpClient;
  const client = new Client(endpoint, {
    clientInfo: { name: 'metawebmcp-fincaraiz-benchmark', version: '1.0.0' },
  });
  const startedAt = new Date().toISOString();
  try {
    const calls = [];
    const callTool = async (name, args) => {
      calls.push({ name, args });
      try {
        return await client.callTool(name, args);
      } catch (error) {
        throw new Error(`Browser call ${name}${args?.url ? ` (${args.url})` : ''} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const totalStart = performance.now();
    const navigationStart = performance.now();
    const navigation = await callTool('browser_navigate', { url: TARGET_URL });
    const navigationMs = performance.now() - navigationStart;
    const snapshot = flattenMcpText(navigation);

    const analysisStart = performance.now();
    const analysis = analyzeAccessibilitySnapshot({ snapshot, url: TARGET_URL, goal: GOAL });
    const analysisMs = performance.now() - analysisStart;
    const collection = analysis.capabilities.find((capability) => capability.kind === 'collection'
      && capability.evidence?.filter((item) => item.type === 'collection-item')
        .some((item) => item.url?.includes('/apartamento-en-arriendo')));
    if (!collection) throw new Error('No repeated listing collection was detected.');

    const authoringStart = performance.now();
    const [tool] = buildAuthoredToolSpecs({
      definitions: [authoredDefinition(collection)],
      capabilities: analysis.capabilities,
      targetUrl: TARGET_URL,
    });
    const authoringMs = performance.now() - authoringStart;
    const availableTools = await client.listTools();
    const executionStart = performance.now();
    const execution = await runMcpCollection({
      executor: tool.executor,
      inputSchema: tool.inputSchema,
      input: tool.sampleArgs,
      availableTools,
      callTool,
      resultText: flattenMcpText,
    });
    const executionMs = performance.now() - executionStart;
    const completedAt = new Date().toISOString();
    const completed = execution.complete && execution.results.length === 50;
    const pagesVisited = Array.from({ length: execution.pagesScanned }, (_, index) => index + 1);
    const results = execution.results.map((item, index) => ({ rank: index + 1, ...item }));

    return {
      schemaVersion: 2,
      benchmark: 'fincaraiz-cheapest-with-laundry-v1',
      arm: 'metawebmcp-authored-collection',
      startedAt,
      completedAt,
      status: completed ? 'completed' : 'partial',
      captured_at: completedAt.slice(0, 10),
      pages_visited: pagesVisited,
      results,
      limitations: [
        'This is a warm-tool execution measurement. The deterministic harness supplies the reviewed agent-authored ToolSpec, so no model authoring tokens are fabricated.',
        'Native Site Tools discovery was unavailable in the non-interactive CLI; this invokes the same validated executor used by the registered generated tool.',
        ...(!execution.complete ? [`Collection traversal was incomplete: ${execution.terminationReason}.`] : []),
      ],
      input: {
        url: TARGET_URL,
        goal: GOAL,
        snapshotCharacters: snapshot.length,
        snapshotBytes: Buffer.byteLength(snapshot),
        snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
      },
      timing: {
        browserNavigationMs: Math.round(navigationMs),
        localAnalysisMs: Number(analysisMs.toFixed(3)),
        localAuthoringValidationMs: Number(authoringMs.toFixed(3)),
        collectionExecutionMs: Math.round(executionMs),
        totalMs: Math.round(performance.now() - totalStart),
      },
      browserCalls: {
        total: calls.length,
        navigate: calls.filter((call) => call.name === 'browser_navigate').length,
        snapshot: calls.filter((call) => call.name === 'browser_snapshot').length,
      },
      analysis: {
        summary: analysis.summary,
        warnings: analysis.warnings,
        capabilities: analysis.capabilities.map(compactCapability),
      },
      authoredTool: compactCapability(tool),
      taskCoverage: taskCoverage([tool]),
      execution: {
        pagesScanned: execution.pagesScanned,
        recordsScanned: execution.recordsScanned,
        matchedRecords: execution.matchedRecords,
        complete: execution.complete,
        terminationReason: execution.terminationReason,
      },
    };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const result = await capture(options.endpoint);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output) await writeFile(options.output, serialized, 'utf8');
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
