#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { analyzeAccessibilitySnapshot } from '../lib/analyzer.mjs';
import { flattenMcpText, McpHttpClient, McpSseClient } from '../lib/mcp-http-client.mjs';
import { COLLECTION_AUTHORING_GUIDE, runMcpCollection } from '../public/js/mcp-collection.js';
import { runMcpRecipe } from '../public/js/mcp-recipe.js';
import { buildAuthoredToolSpecs } from '../public/js/tool-authoring.js';
import { ToolRegistry } from '../public/js/webmcp-runtime.js';

const DEFAULT_BROWSER_ENDPOINT = 'http://localhost:8932/sse';
const META_TOOL_NAMES = new Set([
  'meta_analyze_site',
  'meta_create_webmcp',
  'meta_activate_webmcp',
  'meta_invoke_webmcp',
  'meta_get_state',
]);

function parseArguments(argv) {
  const options = { browserEndpoint: DEFAULT_BROWSER_ENDPOINT, trace: '', benchmark: 'web-collection-cold-v1' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--browser-endpoint' || argument === '--trace' || argument === '--benchmark') {
      const key = argument === '--trace' ? 'trace' : argument === '--benchmark' ? 'benchmark' : 'browserEndpoint';
      options[key] = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') return { help: true };
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return 'Usage: node scripts/serve-metawebmcp-cold-benchmark.mjs [--browser-endpoint URL] [--trace PATH] [--benchmark NAME]\n';
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function compactAnalysis(analysis) {
  return {
    source: clone(analysis.source),
    goal: analysis.goal,
    summary: clone(analysis.summary),
    warnings: clone(analysis.warnings || []),
    capabilities: clone(analysis.capabilities || []),
    authoring: {
      createField: 'authored_tools',
      executorTypes: ['mcp-recipe', 'mcp-collection'],
      recipeTools: ['browser_snapshot', 'browser_type', 'browser_click', 'browser_select_option', 'browser_wait_for'],
      collection: clone(COLLECTION_AUTHORING_GUIDE),
      guidance: 'Cite observed capability IDs, provide a closed input schema, and compose an allowlisted recipe or collection plan. Omit collection scope and startUrl because the runtime fixes them to the analyzed target.',
    },
    ...(analysis.snapshot ? { snapshotExcerpt: analysis.snapshot.slice(0, 5_000) } : {}),
  };
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }) }] };
}

const META_TOOLS = [
  {
    name: 'meta_analyze_site',
    description: 'Open a public website in the managed browser and return observed capabilities, evidence, collection scaffolds, and the complete constrained authoring grammar. Call this first.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute public HTTP(S) target URL.' },
        goal: { type: 'string', minLength: 1, maxLength: 2_000, description: 'The domain task the generated tools must support.' },
      },
      required: ['url', 'goal'],
      additionalProperties: false,
    },
  },
  {
    name: 'meta_create_webmcp',
    description: 'Validate and create complete agent-authored WebMCP contracts grounded in capability IDs returned by meta_analyze_site. Arbitrary JavaScript is rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        authored_tools: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              capability_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
              name: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
              description: { type: 'string', minLength: 8, maxLength: 600 },
              risk: { type: 'string', enum: ['read', 'write', 'consequential'] },
              input_schema: { type: 'object', description: 'Closed JSON object schema with additionalProperties false.' },
              sample_args: { type: 'object' },
              executor: { type: 'object', description: 'A constrained mcp-recipe or mcp-collection plan using the grammar returned by analysis.' },
            },
            required: ['capability_ids', 'name', 'description', 'risk', 'input_schema', 'executor'],
            additionalProperties: false,
          },
        },
      },
      required: ['authored_tools'],
      additionalProperties: false,
    },
  },
  {
    name: 'meta_activate_webmcp',
    description: 'Register the created domain tools into the live benchmark registry. Call after meta_create_webmcp.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'meta_invoke_webmcp',
    description: 'Transport fallback for invoking an activated generated tool when this MCP client has not refreshed its dynamic tool list.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['tool_name', 'input'],
      additionalProperties: false,
    },
  },
  {
    name: 'meta_get_state',
    description: 'Return the current analyzed, authored, and activated state without changing it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export class ColdBenchmarkSession {
  constructor({
    browserEndpoint = DEFAULT_BROWSER_ENDPOINT,
    tracePath = '',
    benchmark = 'web-collection-cold-v1',
    emitNotification = () => {},
  } = {}) {
    this.browserEndpoint = browserEndpoint;
    this.tracePath = tracePath;
    this.emitNotification = emitNotification;
    this.client = null;
    this.availableTools = null;
    this.analysis = null;
    this.contracts = [];
    this.registry = new ToolRegistry(null);
    this.active = false;
    this.trace = {
      schemaVersion: 1,
      benchmark,
      arm: 'metawebmcp-cold-agent',
      serverStartedAt: new Date().toISOString(),
      browserEndpoint,
      metaCalls: [],
      browserCalls: [],
      analysis: null,
      authoredDefinitions: null,
      authoredTools: null,
      execution: null,
    };
  }

  async flushTrace() {
    if (!this.tracePath) return;
    await writeFile(this.tracePath, `${JSON.stringify(this.trace, null, 2)}\n`, 'utf8');
  }

  async browser() {
    if (!this.client) {
      const Client = new URL(this.browserEndpoint).pathname.endsWith('/sse') ? McpSseClient : McpHttpClient;
      this.client = new Client(this.browserEndpoint, {
        clientInfo: { name: 'metawebmcp-cold-benchmark', version: '1.0.0' },
      });
      this.availableTools = await this.client.listTools();
      const names = new Set(this.availableTools.map((tool) => tool.name));
      for (const required of ['browser_navigate', 'browser_snapshot']) {
        if (!names.has(required)) throw new Error(`Connected browser MCP does not expose ${required}.`);
      }
    }
    return this.client;
  }

  async callBrowser(name, args) {
    const client = await this.browser();
    const started = performance.now();
    try {
      const result = await client.callTool(name, args);
      const text = flattenMcpText(result);
      this.trace.browserCalls.push({
        name,
        args: clone(args),
        durationMs: Math.round(performance.now() - started),
        responseCharacters: text.length,
        ok: true,
      });
      await this.flushTrace();
      return result;
    } catch (error) {
      this.trace.browserCalls.push({
        name,
        args: clone(args),
        durationMs: Math.round(performance.now() - started),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.flushTrace();
      throw error;
    }
  }

  async analyze({ url, goal }) {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Target must be an absolute HTTP(S) URL without credentials.');
    }
    await this.callBrowser('browser_navigate', { url: parsed.href });
    const snapshot = flattenMcpText(await this.callBrowser('browser_snapshot', {}));
    const started = performance.now();
    this.analysis = analyzeAccessibilitySnapshot({ snapshot, url: parsed.href, goal: String(goal) });
    const analysisMs = performance.now() - started;
    this.contracts = [];
    this.registry.unregisterOrigin('generated');
    this.active = false;
    this.trace.analysis = {
      targetUrl: parsed.href,
      goal: String(goal),
      snapshotCharacters: snapshot.length,
      snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
      durationMs: Number(analysisMs.toFixed(3)),
      summary: clone(this.analysis.summary),
      warnings: clone(this.analysis.warnings || []),
    };
    await this.flushTrace();
    return compactAnalysis(this.analysis);
  }

  async create({ authored_tools: definitions }) {
    if (!this.analysis) throw new Error('Call meta_analyze_site before authoring tools.');
    const started = performance.now();
    const contracts = buildAuthoredToolSpecs({
      definitions,
      capabilities: this.analysis.capabilities,
      targetUrl: this.analysis.source?.url,
      reservedNames: META_TOOL_NAMES,
    });
    this.registry.unregisterOrigin('generated');
    this.contracts = contracts;
    this.active = false;
    this.trace.authoredDefinitions = clone(definitions);
    this.trace.authoredTools = clone(contracts);
    this.trace.authoringValidationMs = Number((performance.now() - started).toFixed(3));
    await this.flushTrace();
    return {
      ok: true,
      toolCount: contracts.length,
      tools: clone(contracts),
      next: 'Call meta_activate_webmcp, then invoke the generated tool.',
    };
  }

  async executeContract(spec, input) {
    const execute = spec.executor?.type === 'mcp-collection' ? runMcpCollection : runMcpRecipe;
    const started = performance.now();
    const result = await execute({
      executor: spec.executor,
      inputSchema: spec.inputSchema,
      input,
      availableTools: this.availableTools,
      callTool: (name, args) => this.callBrowser(name, args),
      resultText: flattenMcpText,
    });
    this.trace.execution = {
      tool: spec.name,
      input: clone(input),
      durationMs: Math.round(performance.now() - started),
      complete: result.complete ?? true,
      terminationReason: result.terminationReason || 'recipe completed',
      pagesScanned: result.pagesScanned ?? null,
      recordsScanned: result.recordsScanned ?? null,
      matchedRecords: result.matchedRecords ?? null,
      resultCount: Array.isArray(result.results) ? result.results.length : null,
      results: clone(result.results || null),
    };
    await this.flushTrace();
    return result;
  }

  async activate() {
    if (!this.contracts.length) throw new Error('Call meta_create_webmcp before activation.');
    await this.browser();
    this.registry.unregisterOrigin('generated');
    for (const spec of this.contracts) {
      await this.registry.register(spec, (input) => this.executeContract(spec, input), { origin: 'generated' });
    }
    this.active = true;
    await this.flushTrace();
    this.emitNotification({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    return {
      ok: true,
      generatedTools: this.contracts.map((tool) => ({ name: tool.name, inputSchema: clone(tool.inputSchema) })),
      registrySize: META_TOOLS.length + this.contracts.length,
    };
  }

  async invoke({ tool_name: name, input }) {
    if (!this.active) throw new Error('Call meta_activate_webmcp before invoking generated tools.');
    return this.registry.execute(name, input);
  }

  state() {
    return {
      analyzed: Boolean(this.analysis),
      goal: this.analysis?.goal || '',
      targetUrl: this.analysis?.source?.url || '',
      authoredTools: this.contracts.map(({ name, description, risk, inputSchema, sampleArgs }) => ({
        name, description, risk, inputSchema: clone(inputSchema), sampleArgs: clone(sampleArgs),
      })),
      active: this.active,
    };
  }

  listTools() {
    const generated = this.active ? this.contracts.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: clone(tool.inputSchema),
      annotations: { readOnlyHint: tool.risk === 'read', untrustedContentHint: true },
    })) : [];
    return [...META_TOOLS, ...generated];
  }

  async callTool(name, args = {}) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let ok = true;
    let error = '';
    try {
      if (name === 'meta_analyze_site') return await this.analyze(args);
      if (name === 'meta_create_webmcp') return await this.create(args);
      if (name === 'meta_activate_webmcp') return await this.activate();
      if (name === 'meta_invoke_webmcp') return await this.invoke(args);
      if (name === 'meta_get_state') return this.state();
      if (this.active && this.contracts.some((tool) => tool.name === name)) return await this.registry.execute(name, args);
      throw new Error(`Unknown MetaWebMCP tool: ${name}.`);
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      this.trace.metaCalls.push({
        name,
        startedAt,
        durationMs: Math.round(performance.now() - started),
        ok,
        ...(error ? { error } : {}),
      });
      await this.flushTrace();
    }
  }

  async close() {
    this.trace.serverCompletedAt = new Date().toISOString();
    await this.flushTrace();
    await this.client?.close().catch(() => {});
  }
}

async function serve(options) {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const session = new ColdBenchmarkSession({
    browserEndpoint: options.browserEndpoint,
    tracePath: options.trace,
    benchmark: options.benchmark,
    emitNotification: send,
  });
  await session.flushTrace();

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.method === 'notifications/initialized' || request.method?.startsWith('notifications/')) continue;
    if (request.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'metawebmcp-cold-benchmark', version: '1.0.0' },
        },
      });
      continue;
    }
    if (request.method === 'ping') {
      send({ jsonrpc: '2.0', id: request.id, result: {} });
      continue;
    }
    if (request.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: request.id, result: { tools: session.listTools() } });
      continue;
    }
    if (request.method === 'tools/call') {
      try {
        const value = await session.callTool(request.params?.name, request.params?.arguments || {});
        send({ jsonrpc: '2.0', id: request.id, result: toolResult(value) });
      } catch (error) {
        send({ jsonrpc: '2.0', id: request.id, result: errorResult(error) });
      }
      continue;
    }
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } });
  }
  await session.close();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await serve(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
