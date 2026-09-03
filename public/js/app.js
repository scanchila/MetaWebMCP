import { analyzeControlledDemo, analyzeStaticSource, analyzeThroughBrowserMcp } from './demo-analyzer.js';
import { ToolRegistry, compactRegistryState, executeGeneratedSpec } from './webmcp-runtime.js';
import { browserMcpSession } from './browser-mcp-session.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  nativeStatus: $('#native-status'),
  toolCount: $('#tool-count'),
  resetButton: $('#reset-button'),
  ownerMode: $('#owner-mode'),
  adapterMode: $('#adapter-mode'),
  ownerSourceControls: $('#owner-source-controls'),
  sourceKind: $('#source-kind'),
  urlField: $('#url-field'),
  targetUrl: $('#target-url'),
  htmlField: $('#html-field'),
  targetHtml: $('#target-html'),
  goal: $('#goal'),
  analyzeButton: $('#analyze-button'),
  mcpNotice: $('#mcp-notice'),
  mcpTitle: $('#mcp-title'),
  mcpCopy: $('#mcp-copy'),
  targetFrame: $('#target-frame'),
  snapshotPreview: $('#snapshot-preview'),
  stagePlaceholder: $('#stage-placeholder'),
  stageLabel: $('#stage-label'),
  stageState: $('#stage-state'),
  clientGuide: $('#client-guide'),
  clientStatusCopy: $('#client-status-copy'),
  progressSummary: $('#progress-summary'),
  trace: $('#trace'),
  capabilitySection: $('#capability-section'),
  capabilityList: $('#capability-list'),
  selectAllButton: $('#select-all-button'),
  createButton: $('#create-button'),
  activateButton: $('#activate-button'),
  testButton: $('#test-button'),
  exportButton: $('#export-button'),
  downloadLink: $('#download-link'),
  downloadName: $('#download-name'),
  downloadMeta: $('#download-meta'),
  metaToolCount: $('#meta-tool-count'),
  generatedToolCount: $('#generated-tool-count'),
  toolList: $('#tool-list'),
  toolLab: $('#tool-lab'),
  labToolName: $('#lab-tool-name'),
  labRisk: $('#lab-risk'),
  labDescription: $('#lab-description'),
  labInput: $('#lab-input'),
  labRunButton: $('#lab-run-button'),
  labOutput: $('#lab-output'),
  pipeline: [...document.querySelectorAll('.pipeline-step')],
};

const META_ORIGIN = 'meta';
const GENERATED_ORIGIN = 'generated';
const RISK_SEVERITY = Object.freeze({ read: 0, write: 1, consequential: 2 });
const META_TOOL_NAMES = new Set();
const registry = new ToolRegistry();
const workspaceId = (() => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `workspace_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
})();

const state = {
  mode: 'owner',
  phase: 0,
  sourceKind: 'demo',
  analysis: null,
  contracts: [],
  selectedCapabilityIds: new Set(),
  activated: false,
  verificationComplete: false,
  evals: [],
  export: null,
  trace: [],
  selectedToolName: null,
  browserMcp: { checked: false, configured: false, tools: [] },
  latestTargetState: null,
};

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addTrace(title, detail, status = 'success') {
  state.trace.push({ title, detail, status, time: nowLabel() });
  if (state.trace.length > 30) state.trace.splice(0, state.trace.length - 30);
  renderTrace();
}

function renderTrace() {
  elements.trace.replaceChildren();
  for (const entry of state.trace) {
    const row = document.createElement('div');
    row.className = `trace-entry ${entry.status}`;
    const dot = document.createElement('span');
    dot.className = 'trace-dot';
    const copy = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = entry.title;
    const paragraph = document.createElement('p');
    paragraph.textContent = entry.detail;
    copy.append(strong, paragraph);
    const time = document.createElement('time');
    time.textContent = entry.time;
    row.append(dot, copy, time);
    elements.trace.append(row);
  }
  elements.trace.scrollTop = elements.trace.scrollHeight;
}

function setPhase(phase) {
  state.phase = Math.max(0, Math.min(5, phase));
  elements.pipeline.forEach((step, index) => {
    step.classList.toggle('complete', index < state.phase || state.phase === 5);
    step.classList.toggle('current', index === state.phase && state.phase < 5);
  });
  const summaries = [
    'Ready to inspect the target',
    `${state.analysis?.capabilities?.length || 0} capability candidates found`,
    `${state.contracts.length} WebMCP contracts ready`,
    `${state.contracts.length} generated tools active`,
    `${state.evals.filter((item) => item.status === 'passed').length} runtime evals passed`,
    state.export ? `${state.export.fileName} is ready` : 'Integration pack complete',
  ];
  elements.progressSummary.textContent = summaries[state.phase] || summaries[0];
}

function setBusy(active) {
  document.body.classList.toggle('busy', active);
  document.body.setAttribute('aria-busy', String(active));
}

async function invoke(name, input = {}) {
  setBusy(true);
  try {
    return await registry.execute(name, input);
  } catch (error) {
    addTrace('Operation failed', error instanceof Error ? error.message : String(error), 'error');
    throw error;
  } finally {
    setBusy(false);
    renderActions();
  }
}

function selectedCardsFromUi() {
  return [...elements.capabilityList.querySelectorAll('.capability-card')]
    .filter((card) => card.querySelector('input[type="checkbox"]')?.checked);
}

function selectedIdsFromUi() {
  return selectedCardsFromUi().map((card) => card.dataset.capabilityId);
}

function reviewedOverridesFromUi() {
  return selectedCardsFromUi().map((card) => ({
    capability_id: card.dataset.capabilityId,
    name: card.querySelector('[data-review-name]').value.trim(),
    description: card.querySelector('[data-review-description]').value.trim(),
  }));
}

function defaultProjectName() {
  const title = state.analysis?.source?.title || 'generated-webmcp';
  return `${title}-webmcp`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'generated-webmcp';
}

function renderSourceControls() {
  const adapter = state.mode === 'adapter';
  elements.ownerMode.setAttribute('aria-pressed', String(!adapter));
  elements.adapterMode.setAttribute('aria-pressed', String(adapter));
  elements.ownerSourceControls.classList.toggle('hidden', adapter);
  elements.mcpNotice.classList.toggle('hidden', !adapter);

  const source = adapter ? 'browser_mcp' : elements.sourceKind.value;
  state.sourceKind = source;
  elements.urlField.classList.toggle('hidden', !(adapter || source === 'url'));
  elements.htmlField.classList.toggle('hidden', source !== 'html');
  renderTargetStage();
}

function renderTargetStage() {
  const source = state.mode === 'adapter' ? 'browser_mcp' : state.sourceKind;
  const isDemo = source === 'demo';
  const isBrowser = source === 'browser_mcp';
  elements.targetFrame.classList.toggle('hidden', !isDemo);
  elements.snapshotPreview.classList.toggle('hidden', !isBrowser);
  elements.stagePlaceholder.classList.toggle('hidden', isDemo || isBrowser);

  if (isDemo) {
    elements.stageLabel.textContent = 'Uninstrumented target';
    elements.stageState.textContent = state.activated ? `${state.contracts.length} tools via parent` : 'No WebMCP';
  } else if (isBrowser) {
    const latestSnapshot = typeof state.latestTargetState === 'string' ? state.latestTargetState : '';
    elements.stageLabel.textContent = 'Isolated Browser MCP session';
    elements.stageState.textContent = latestSnapshot
      ? 'Latest tool result'
      : state.activated ? `${state.contracts.length} virtual tools` : 'External target unchanged';
    elements.snapshotPreview.textContent = latestSnapshot
      || state.analysis?.snapshot
      || 'Analyze a target to populate the accessibility snapshot.';
  } else {
    elements.stageLabel.textContent = 'Native integration analysis';
    elements.stageState.textContent = state.contracts.length ? `${state.contracts.length} contracts` : 'Export target';
  }
}

function clearBuildState({ keepTrace = true } = {}) {
  registry.unregisterOrigin(GENERATED_ORIGIN);
  state.phase = 0;
  state.analysis = null;
  state.contracts = [];
  state.selectedCapabilityIds = new Set();
  state.activated = false;
  state.verificationComplete = false;
  state.evals = [];
  state.export = null;
  state.selectedToolName = null;
  state.latestTargetState = null;
  if (!keepTrace) state.trace = [];
  elements.capabilitySection.classList.add('hidden');
  elements.capabilitySection.open = false;
  elements.capabilityList.replaceChildren();
  elements.downloadLink.classList.add('hidden');
  elements.downloadLink.removeAttribute('href');
  elements.snapshotPreview.textContent = '';
  renderTargetStage();
  renderActions();
  renderRegistry();
  setPhase(0);
}

function capabilitySummary(capability) {
  const evidence = capability.evidence?.length || 0;
  return `${capability.description} ${evidence} untrusted page reference${evidence === 1 ? '' : 's'} available for review.`;
}

function evidenceSummary(item) {
  return [
    item.type,
    item.label ? `label: ${item.label}` : '',
    item.selector ? `selector: ${item.selector}` : '',
    item.ref ? `reference: ${item.ref}` : '',
    item.item ? `item: ${item.item}` : '',
    item.itemId ? `item ID: ${item.itemId}` : '',
  ].filter(Boolean).join(' · ');
}

function reviewField(labelText, control) {
  const label = document.createElement('label');
  label.className = 'review-field';
  const title = document.createElement('span');
  title.textContent = labelText;
  label.append(title, control);
  return label;
}

function reviewCode(labelText, value) {
  const section = document.createElement('section');
  section.className = 'review-code';
  const title = document.createElement('strong');
  title.textContent = labelText;
  const code = document.createElement('pre');
  code.textContent = JSON.stringify(value, null, 2);
  section.append(title, code);
  return section;
}

function renderCapabilities() {
  elements.capabilityList.replaceChildren();
  for (const capability of state.analysis?.capabilities || []) {
    const card = document.createElement('article');
    card.className = 'capability-card';
    card.dataset.capabilityId = capability.id;
    const heading = document.createElement('div');
    heading.className = 'capability-card-head';
    const selection = document.createElement('label');
    selection.className = 'capability-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = capability.id;
    checkbox.checked = state.selectedCapabilityIds.has(capability.id);
    checkbox.setAttribute('aria-label', `Include ${capability.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedCapabilityIds.add(capability.id);
      else state.selectedCapabilityIds.delete(capability.id);
    });
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = capability.name;
    const observed = document.createElement('span');
    observed.className = 'observed-label';
    observed.textContent = `Observed label: ${capability.title}`;
    const description = document.createElement('p');
    description.textContent = capabilitySummary(capability);
    copy.append(title, observed, description);
    const risk = document.createElement('span');
    risk.className = `kind-chip ${capability.risk}`;
    risk.textContent = capability.risk;
    selection.append(checkbox, copy);
    heading.append(selection, risk);

    const details = document.createElement('details');
    details.className = 'capability-detail';
    const summary = document.createElement('summary');
    summary.textContent = 'Inspect evidence and edit tool metadata';
    const body = document.createElement('div');
    body.className = 'capability-detail-body';
    const trust = document.createElement('p');
    trust.className = 'trust-note';
    trust.textContent = 'Page labels, locators, and observed values are untrusted evidence. The tool name and description below are the reviewed metadata that will be registered.';
    const evidenceTitle = document.createElement('strong');
    evidenceTitle.textContent = 'Observed interface evidence';
    const evidenceList = document.createElement('ul');
    evidenceList.className = 'evidence-list';
    for (const item of capability.evidence || []) {
      const row = document.createElement('li');
      row.textContent = evidenceSummary(item);
      evidenceList.append(row);
    }
    const name = document.createElement('input');
    name.type = 'text';
    name.value = capability.name;
    name.required = true;
    name.maxLength = 64;
    name.dataset.reviewName = '';
    name.autocomplete = 'off';
    const reviewedDescription = document.createElement('textarea');
    reviewedDescription.value = capability.description;
    reviewedDescription.required = true;
    reviewedDescription.minLength = 8;
    reviewedDescription.maxLength = 600;
    reviewedDescription.rows = 2;
    reviewedDescription.dataset.reviewDescription = '';
    const metadata = document.createElement('div');
    metadata.className = 'metadata-review';
    metadata.append(reviewField('Reviewed tool name', name), reviewField('Reviewed description', reviewedDescription));
    const contract = document.createElement('div');
    contract.className = 'contract-review-grid';
    contract.append(
      reviewCode('Input schema and sample', { inputSchema: capability.inputSchema, sampleArgs: capability.sampleArgs }),
      reviewCode('Executor and expected state source', capability.executor),
    );
    body.append(trust, evidenceTitle, evidenceList, metadata, contract);
    details.append(summary, body);
    card.append(heading, details);
    elements.capabilityList.append(card);
  }
  elements.capabilitySection.open = true;
  elements.capabilitySection.classList.toggle('hidden', !state.analysis?.capabilities?.length);
}

function renderActions() {
  elements.activateButton.disabled = state.contracts.length === 0;
  elements.testButton.disabled = !state.activated;
  elements.exportButton.disabled = state.contracts.length === 0;
  elements.createButton.disabled = !state.analysis?.capabilities?.length;
}

function renderRegistry() {
  const tools = registry.list();
  const meta = tools.filter((tool) => tool.origin === META_ORIGIN);
  const generated = tools.filter((tool) => tool.origin === GENERATED_ORIGIN);
  elements.metaToolCount.textContent = String(meta.length);
  elements.generatedToolCount.textContent = String(generated.length);
  elements.toolCount.textContent = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
  elements.toolList.replaceChildren();

  for (const tool of [...generated, ...meta]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tool-card ${tool.origin === GENERATED_ORIGIN ? 'generated' : ''}`;
    button.classList.toggle('selected', state.selectedToolName === tool.name);
    button.dataset.toolName = tool.name;
    const name = document.createElement('strong');
    name.textContent = tool.name;
    const origin = document.createElement('span');
    origin.className = 'tool-origin';
    origin.textContent = tool.origin === GENERATED_ORIGIN ? 'generated' : 'meta';
    const description = document.createElement('p');
    description.textContent = tool.description;
    button.append(name, origin, description);
    button.addEventListener('click', () => selectTool(tool.name));
    elements.toolList.append(button);
  }

  const nativeCount = tools.filter((tool) => tool.nativeRegistered).length;
  if (registry.nativeSupported && nativeCount === tools.length && tools.length) {
    elements.nativeStatus.className = 'status-pill native';
    elements.nativeStatus.innerHTML = '<i></i>WebMCP active';
    elements.clientStatusCopy.textContent = `${nativeCount} tools are registered through this browser’s native WebMCP client.`;
  } else if (registry.nativeSupported) {
    elements.nativeStatus.className = 'status-pill preview';
    elements.nativeStatus.innerHTML = '<i></i>WebMCP partial';
    elements.clientStatusCopy.textContent = 'Native WebMCP is present, but not every tool registered. Use the numbered fallback if tools are missing.';
  } else {
    elements.nativeStatus.className = 'status-pill preview';
    elements.nativeStatus.innerHTML = '<i></i>Preview registry';
    elements.clientStatusCopy.textContent = 'This browser has no native WebMCP client. The numbered controls run the same complete workflow.';
    if (!elements.clientGuide.dataset.autoOpened) {
      elements.clientGuide.open = true;
      elements.clientGuide.dataset.autoOpened = 'true';
    }
  }
}

function selectTool(name) {
  const tool = registry.get(name);
  if (!tool) return;
  state.selectedToolName = name;
  renderRegistry();
  elements.toolLab.classList.remove('hidden');
  elements.labToolName.textContent = tool.name;
  elements.labDescription.textContent = tool.description;
  elements.labRisk.textContent = tool.risk || (tool.origin === META_ORIGIN ? 'meta' : 'read');
  elements.labRisk.className = `risk-badge ${tool.risk || 'read'}`;
  const contract = state.contracts.find((candidate) => candidate.name === name);
  elements.labInput.value = JSON.stringify(contract?.sampleArgs || {}, null, 2);
  elements.labOutput.textContent = JSON.stringify({ inputSchema: tool.inputSchema, nativeRegistered: tool.nativeRegistered }, null, 2);
}

function compactAnalysis(analysis) {
  return {
    source: clone(analysis.source),
    goal: analysis.goal,
    summary: clone(analysis.summary),
    warnings: clone(analysis.warnings || []),
    capabilities: clone(analysis.capabilities || []),
    ...(analysis.snapshot ? { snapshotExcerpt: analysis.snapshot.slice(0, 5000) } : {}),
  };
}

function resolveAnalysisRequest(input) {
  const requested = input.source && input.source !== 'current' ? input.source : null;
  const source = requested || (state.mode === 'adapter' ? 'browser_mcp' : elements.sourceKind.value);
  return {
    source,
    goal: String(input.goal ?? elements.goal.value).trim(),
    url: String(input.url ?? elements.targetUrl.value).trim(),
    html: String(input.html ?? elements.targetHtml.value),
  };
}

async function analyzeTarget(input = {}) {
  const request = resolveAnalysisRequest(input);
  if (!request.goal) throw new Error('Describe what agents should be able to accomplish.');
  if (['url', 'browser_mcp'].includes(request.source) && !request.url) throw new Error('A target URL is required.');
  if (request.source === 'html' && !request.html.trim()) throw new Error('Paste target HTML before analysis.');

  elements.goal.value = request.goal;
  if (['url', 'browser_mcp'].includes(request.source)) elements.targetUrl.value = request.url;
  if (request.source === 'html') elements.targetHtml.value = request.html;

  clearBuildState({ keepTrace: true });
  addTrace('Observing target', `Source: ${request.source}. Goal: ${request.goal}`, 'warning');
  let analysis;
  if (request.source === 'demo') {
    analysis = await analyzeControlledDemo(elements.targetFrame, request.goal);
  } else if (request.source === 'browser_mcp') {
    analysis = await analyzeThroughBrowserMcp({ url: request.url, goal: request.goal, workspaceId });
  } else {
    analysis = await analyzeStaticSource({ source: request.source, url: request.url, html: request.html, goal: request.goal });
  }

  state.analysis = analysis;
  state.sourceKind = request.source;
  state.selectedCapabilityIds = new Set(analysis.capabilities.map((capability) => capability.id));
  renderCapabilities();
  renderTargetStage();
  setPhase(1);
  renderActions();
  addTrace(
    'Capability graph created',
    `${analysis.capabilities.length} candidate workflow${analysis.capabilities.length === 1 ? '' : 's'} from ${Object.values(analysis.summary || {}).filter((value) => typeof value === 'number').reduce((sum, value) => sum + value, 0)} observed signals.`,
  );
  for (const warning of analysis.warnings || []) addTrace('Analysis warning', warning, 'warning');
  return compactAnalysis(analysis);
}

function validateOverride(override, capabilitiesById) {
  if (!override || typeof override !== 'object') throw new Error('Each tool override must be an object.');
  const capability = capabilitiesById.get(override.capability_id);
  if (!capability) throw new Error(`Unknown capability override: ${override.capability_id}.`);
  if (override.name && !/^[a-z][a-z0-9_]{0,63}$/.test(override.name)) throw new Error(`Invalid tool override name: ${override.name}.`);
  if (override.description && (override.description.length < 8 || override.description.length > 600)) throw new Error('Override descriptions must contain 8–600 characters.');
  if (override.risk && !['read', 'write', 'consequential'].includes(override.risk)) throw new Error(`Invalid override risk: ${override.risk}.`);
  if (override.risk && RISK_SEVERITY[override.risk] < RISK_SEVERITY[capability.risk]) {
    throw new Error(`Risk override for ${override.capability_id} cannot downgrade inferred ${capability.risk} risk to ${override.risk}.`);
  }
}

async function createWebMcp(input = {}) {
  if (!state.analysis) throw new Error('Analyze a target before creating WebMCP contracts.');
  const capabilitiesById = new Map(state.analysis.capabilities.map((capability) => [capability.id, capability]));
  const knownIds = new Set(capabilitiesById.keys());
  const requestedIds = input.capability_ids?.length ? input.capability_ids : selectedIdsFromUi();
  const ids = requestedIds.length ? requestedIds : [...state.selectedCapabilityIds];
  if (!ids.length) throw new Error('Select at least one capability.');
  const unknown = ids.find((id) => !knownIds.has(id));
  if (unknown) throw new Error(`Unknown capability: ${unknown}.`);

  const overrides = input.overrides || [];
  overrides.forEach((override) => validateOverride(override, capabilitiesById));
  const byCapability = new Map(overrides.map((override) => [override.capability_id, override]));
  if (state.analysis.source?.kind !== 'demo') {
    const missingReview = ids.find((id) => {
      const override = byCapability.get(id);
      return !override?.name?.trim() || !override?.description?.trim();
    });
    if (missingReview) throw new Error(`Review the tool name and description before creating external-target contract ${missingReview}.`);
  }
  const tools = ids.map((id) => {
    const capability = capabilitiesById.get(id);
    const override = byCapability.get(id) || {};
    return {
      ...clone(capability),
      ...(override.name ? { name: override.name } : {}),
      ...(override.description ? { description: override.description } : {}),
      ...(override.risk ? { risk: override.risk } : {}),
    };
  });

  const seen = new Set();
  for (const tool of tools) {
    if (META_TOOL_NAMES.has(tool.name)) throw new Error(`Generated tool ${tool.name} collides with MetaWebMCP's control plane.`);
    if (seen.has(tool.name)) throw new Error(`Generated tool name ${tool.name} is duplicated.`);
    seen.add(tool.name);
  }

  registry.unregisterOrigin(GENERATED_ORIGIN);
  state.contracts = tools;
  state.activated = false;
  state.verificationComplete = false;
  state.evals = [];
  state.export = null;
  elements.downloadLink.classList.add('hidden');
  elements.capabilitySection.open = false;
  setPhase(2);
  renderActions();
  renderTargetStage();
  addTrace('WebMCP contracts created', `${tools.length} narrow semantic tool${tools.length === 1 ? '' : 's'} retain schemas, risk, execution recipes, and interface evidence.`);
  return {
    ok: true,
    toolCount: tools.length,
    tools: clone(tools),
    next: 'Call meta_activate_webmcp to register these tools on the current top-level page.',
  };
}

function getTargetDocument() {
  return state.analysis?.source?.kind === 'demo' ? elements.targetFrame.contentDocument : null;
}

async function activateWebMcp() {
  if (!state.contracts.length) throw new Error('Create WebMCP contracts before activation.');
  registry.unregisterOrigin(GENERATED_ORIGIN);

  for (const spec of state.contracts) {
    await registry.register(spec, async (input, context) => {
      const result = await executeGeneratedSpec(spec, input, {
        ...context,
        getTargetDocument,
        allowConsequential: false,
        workspaceId,
      });
      state.latestTargetState = clone(result.state || result.result || result);
      addTrace(`Executed ${spec.name}`, `Generated ${spec.risk} tool completed through ${spec.executor.type}.`);
      renderTargetStage();
      return result;
    }, { origin: GENERATED_ORIGIN });
  }

  state.activated = true;
  state.verificationComplete = false;
  state.evals = [];
  setPhase(3);
  renderActions();
  renderRegistry();
  renderTargetStage();
  addTrace('Generated WebMCP activated', `${state.contracts.length} domain tools were added to the same top-level registry as the seven builder tools.`);
  return {
    ok: true,
    generatedTools: registry.list().filter((tool) => tool.origin === GENERATED_ORIGIN).map((tool) => ({ name: tool.name, nativeRegistered: tool.nativeRegistered })),
    registrySize: registry.list().length,
  };
}

function verifyDemoPostcondition(spec, result) {
  const checks = [{ name: 'execution returned ok', passed: result?.ok === true }];
  const targetState = result?.state;
  if (spec.name === 'find_sessions') {
    checks.push({ name: 'matching sessions are visible', passed: Array.isArray(targetState?.visibleSessions) && targetState.visibleSessions.length > 0 });
  } else if (spec.name === 'add_session_to_itinerary') {
    checks.push({
      name: 'requested session is in itinerary',
      passed: Array.isArray(targetState?.itinerary) && targetState.itinerary.some((session) => session.id === spec.sampleArgs.item_id),
    });
  } else if (spec.name === 'inspect_itinerary') {
    checks.push({ name: 'read result contains itinerary state', passed: Array.isArray(targetState?.itinerary) });
  } else if (spec.name === 'clear_itinerary') {
    checks.push({ name: 'itinerary is empty', passed: Array.isArray(targetState?.itinerary) && targetState.itinerary.length === 0 });
  }
  return checks;
}

async function testWebMcp(input = {}) {
  if (!state.activated) throw new Error('Activate the generated tools before testing.');
  const requested = input.tool_names?.length ? new Set(input.tool_names) : null;
  if (requested) {
    const unknown = [...requested].find((name) => !state.contracts.some((tool) => tool.name === name));
    if (unknown) throw new Error(`Unknown generated tool: ${unknown}.`);
  }

  const tools = state.contracts.filter((tool) => !requested || requested.has(tool.name));
  if (state.analysis?.source?.kind === 'demo') elements.targetFrame.contentWindow?.demoApp?.reset();
  const evals = [];

  for (const spec of tools) {
    const started = performance.now();
    const discovery = registry.get(spec.name);
    const checks = [{ name: 'registered in generated tool registry', passed: Boolean(discovery) }];
    let result = null;
    let status = 'passed';
    let reason = '';

    if (!discovery) {
      status = 'failed';
      reason = 'Tool was not present in the registry.';
    } else if (spec.risk === 'consequential') {
      status = 'skipped';
      reason = 'Consequential actions are deliberately not auto-executed.';
    } else if (spec.executor.type !== 'mcp-recipe' && !getTargetDocument()) {
      status = 'skipped';
      reason = 'Static DOM exports must be executed inside the owned target application.';
    } else if (spec.executor.type === 'mcp-recipe' && spec.risk !== 'read') {
      status = 'skipped';
      reason = 'Browser MCP write recipes require explicit human review.';
    } else {
      try {
        result = await registry.execute(spec.name, spec.sampleArgs || {});
        if (state.analysis?.source?.kind === 'demo') checks.push(...verifyDemoPostcondition(spec, result));
        else checks.push({ name: 'execution completed', passed: result?.ok !== false });
        if (checks.some((check) => !check.passed)) status = 'failed';
      } catch (error) {
        status = 'failed';
        reason = error instanceof Error ? error.message : String(error);
      }
    }

    const item = {
      tool: spec.name,
      status,
      durationMs: Math.round(performance.now() - started),
      checks,
      ...(reason ? { reason } : {}),
      ...(result ? { result: clone(result) } : {}),
    };
    evals.push(item);
    addTrace(
      `${spec.name}: ${status}`,
      reason || `${checks.filter((check) => check.passed).length}/${checks.length} deterministic checks passed.`,
      status === 'failed' ? 'error' : status === 'skipped' ? 'warning' : 'success',
    );
  }

  state.evals = evals;
  const failures = evals.filter((item) => item.status === 'failed');
  const skipped = evals.filter((item) => item.status === 'skipped');
  const evaluatedAll = tools.length === state.contracts.length;
  const complete = evaluatedAll && failures.length === 0 && skipped.length === 0;
  state.verificationComplete = complete;
  setPhase(complete ? (state.export ? 5 : 4) : 3);
  renderActions();
  const traceTitle = failures.length
    ? 'Runtime evaluation found failures'
    : complete ? 'Runtime evaluation complete' : 'Runtime evaluation incomplete';
  const traceStatus = failures.length ? 'error' : complete ? 'success' : 'warning';
  addTrace(
    traceTitle,
    `${evals.filter((item) => item.status === 'passed').length} passed, ${skipped.length} skipped, ${failures.length} failed, ${state.contracts.length - tools.length} not run.`,
    traceStatus,
  );
  return {
    ok: complete,
    complete,
    scope: 'Deterministic registration, schema, execution, and visible-state checks. Agent intent-selection prompts are included in the exported manual eval plan.',
    coverage: {
      contracts: state.contracts.length,
      evaluated: tools.length,
      notRun: state.contracts.length - tools.length,
      passed: evals.filter((item) => item.status === 'passed').length,
      skipped: skipped.length,
      failed: failures.length,
    },
    results: clone(evals),
  };
}

async function exportWebMcp(input = {}) {
  if (!state.contracts.length) throw new Error('Create WebMCP contracts before export.');
  const projectName = String(input.project_name || defaultProjectName());
  let ownerBundle = null;
  if (state.analysis?.source?.kind === 'demo') {
    const [html, css, javascript] = await Promise.all([
      fetch('/demo/index.html').then((response) => response.text()),
      fetch('/demo/demo.css').then((response) => response.text()),
      fetch('/demo/demo.js').then((response) => response.text()),
    ]);
    ownerBundle = {
      html: html
        .replace('/demo/demo.css', './target.css')
        .replace('/demo/demo.js', './target.js')
        .replace('Legacy UI · no WebMCP', 'Generated native WebMCP'),
      files: {
        'target.css': css,
        'target.js': javascript,
      },
    };
  } else if (state.analysis?.source?.kind === 'html') {
    ownerBundle = { html: elements.targetHtml.value, files: {} };
  }
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName,
      tools: state.contracts,
      target: state.analysis?.source || {},
      goal: state.analysis?.goal || elements.goal.value,
      mode: state.analysis?.source?.kind === 'browser_mcp' ? 'browser_mcp' : 'native',
      ownerBundle,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Export failed with HTTP ${response.status}.`);
  state.export = payload;
  elements.downloadLink.href = payload.downloadUrl;
  elements.downloadLink.download = payload.fileName;
  elements.downloadName.textContent = payload.fileName;
  elements.downloadMeta.textContent = `${payload.fileCount} files · ${Math.max(1, Math.round(payload.bytes / 1024))} KB · expires in ${Math.round(payload.expiresInSeconds / 60)} min`;
  elements.downloadLink.classList.remove('hidden');
  setPhase(state.verificationComplete ? 5 : Math.min(state.phase, 3));
  addTrace(
    state.verificationComplete ? 'Verified integration exported' : 'Integration exported with verification pending',
    `${payload.fileName} contains directly registered WebMCP code, the tool manifest, evidence report, and manual agent evals.`,
    state.verificationComplete ? 'success' : 'warning',
  );
  return clone(payload);
}

function getMetaState() {
  return {
    mode: state.mode,
    phase: state.phase,
    source: clone(state.analysis?.source || null),
    goal: state.analysis?.goal || elements.goal.value,
    capabilityCount: state.analysis?.capabilities?.length || 0,
    contracts: state.contracts.map(({ name, description, risk, inputSchema, evidence, executor }) => ({ name, description, risk, inputSchema, evidence, executor })),
    registry: compactRegistryState(registry),
    verificationComplete: state.verificationComplete,
    evals: clone(state.evals),
    export: clone(state.export),
    recentTrace: clone(state.trace.slice(-10)),
  };
}

async function resetWorkspace() {
  registry.unregisterOrigin(GENERATED_ORIGIN);
  try { elements.targetFrame.contentWindow?.demoApp?.reset(); } catch { /* The demo may still be loading. */ }
  if (state.analysis?.source?.kind === 'browser_mcp') {
    browserMcpSession.reset(workspaceId).catch(() => {});
  }
  clearBuildState({ keepTrace: false });
  addTrace('Workspace reset', 'The meta-tool control plane remains registered; generated tools and project state were removed.');
  return { ok: true, remainingTools: registry.list().map((tool) => tool.name) };
}

const metaTools = [
  {
    spec: {
      name: 'meta_analyze_site',
      description: 'Observe the selected website source and return evidence-backed candidate workflows that can become WebMCP tools. Call this first.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['current', 'demo', 'url', 'html', 'browser_mcp'], description: 'Use current to read the mode selected in the MetaWebMCP interface.' },
          goal: { type: 'string', description: 'What agents should be able to accomplish on the target site.' },
          url: { type: 'string', description: 'Required for URL or Browser MCP analysis.' },
          html: { type: 'string', description: 'Required when source is html.' },
        },
        additionalProperties: false,
      },
    },
    execute: analyzeTarget,
  },
  {
    spec: {
      name: 'meta_create_webmcp',
      description: 'Turn selected capability candidates into narrow WebMCP tool contracts after reviewing their untrusted page evidence. External targets require an explicit reviewed name and description for every selected capability.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          capability_ids: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Capability IDs to expose. Omit to use the checked candidates.' },
          overrides: {
            type: 'array',
            maxItems: 12,
            description: 'Reviewed tool metadata. A name and description are required for every selected capability from an external or supplied target.',
            items: {
              type: 'object',
              properties: {
                capability_id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                risk: { type: 'string', enum: ['read', 'write', 'consequential'] },
              },
              required: ['capability_id'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    execute: createWebMcp,
  },
  {
    spec: {
      name: 'meta_activate_webmcp',
      description: 'Dynamically register the generated domain tools on this same top-level page so an agent can use the new WebMCP immediately.',
      risk: 'write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: activateWebMcp,
  },
  {
    spec: {
      name: 'meta_test_webmcp',
      description: 'Run deterministic discovery, schema, execution, and visible-state checks against the activated generated tools without auto-running consequential actions.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: {
          tool_names: { type: 'array', items: { type: 'string' }, maxItems: 25, description: 'Optional generated tool subset to test.' },
        },
        additionalProperties: false,
      },
    },
    execute: testWebMcp,
  },
  {
    spec: {
      name: 'meta_export_webmcp',
      description: 'Export the reviewed tool contracts as a standalone repository ZIP containing direct document.modelContext.registerTool calls, manifests, evidence, and eval guidance.',
      risk: 'write',
      inputSchema: {
        type: 'object',
        properties: { project_name: { type: 'string', description: 'Optional lowercase repository name.' } },
        additionalProperties: false,
      },
    },
    execute: exportWebMcp,
  },
  {
    spec: {
      name: 'meta_get_state',
      description: 'Read the current MetaWebMCP build state, generated contracts, registry contents, evaluation results, and export status.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: getMetaState,
  },
  {
    spec: {
      name: 'meta_reset_workspace',
      description: 'Remove every dynamically generated tool and clear the current build while preserving MetaWebMCP’s permanent seven-tool control plane.',
      risk: 'write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: resetWorkspace,
  },
];

async function registerMetaTools() {
  for (const { spec, execute } of metaTools) {
    META_TOOL_NAMES.add(spec.name);
    await registry.register(spec, execute, { origin: META_ORIGIN });
  }
}

async function checkBrowserMcp() {
  elements.mcpNotice.classList.remove('connected', 'error');
  elements.mcpCopy.textContent = 'Checking the configured Streamable HTTP endpoint.';
  try {
    const payload = await browserMcpSession.status(workspaceId);
    state.browserMcp = { checked: true, configured: Boolean(payload.configured), tools: payload.tools || [] };
    if (payload.configured) {
      elements.mcpNotice.classList.add('connected');
      elements.mcpTitle.textContent = 'Browser MCP connected';
      elements.mcpCopy.textContent = `${payload.tools.length} low-level browser tools available behind the semantic adapter.`;
    } else {
      elements.mcpNotice.classList.add('error');
      elements.mcpTitle.textContent = 'Browser MCP optional';
      elements.mcpCopy.textContent = 'This deployment has no browser runtime configured. The controlled demo and native exports remain available.';
    }
  } catch (error) {
    state.browserMcp = { checked: true, configured: false, tools: [] };
    elements.mcpNotice.classList.add('error');
    elements.mcpTitle.textContent = 'Browser MCP unavailable';
    elements.mcpCopy.textContent = error instanceof Error ? error.message : String(error);
  }
}

function switchMode(mode) {
  if (!['owner', 'adapter'].includes(mode) || state.mode === mode) return;
  state.mode = mode;
  clearBuildState({ keepTrace: false });
  renderSourceControls();
  addTrace(mode === 'owner' ? 'Owner mode selected' : 'Any-site adapter mode selected', mode === 'owner'
    ? 'Analyze a controlled demo, public HTML, or pasted HTML and export native WebMCP code.'
    : 'Use a standard browser MCP server as the low-level runtime behind generated semantic tools.');
  if (mode === 'adapter') checkBrowserMcp();
}

function bindEvents() {
  elements.ownerMode.addEventListener('click', () => switchMode('owner'));
  elements.adapterMode.addEventListener('click', () => switchMode('adapter'));
  elements.sourceKind.addEventListener('change', () => {
    state.sourceKind = elements.sourceKind.value;
    clearBuildState({ keepTrace: false });
    renderSourceControls();
    addTrace('Source changed', `Ready to analyze ${state.sourceKind}.`);
  });
  elements.analyzeButton.addEventListener('click', () => invoke('meta_analyze_site', { source: 'current' }).catch(() => {}));
  elements.selectAllButton.addEventListener('click', () => {
    const boxes = [...elements.capabilityList.querySelectorAll('input[type="checkbox"]')];
    const shouldSelect = boxes.some((box) => !box.checked);
    boxes.forEach((box) => { box.checked = shouldSelect; });
    state.selectedCapabilityIds = new Set(shouldSelect ? boxes.map((box) => box.value) : []);
    elements.selectAllButton.textContent = shouldSelect ? 'Clear all' : 'Select all';
  });
  elements.createButton.addEventListener('click', () => invoke('meta_create_webmcp', {
    capability_ids: selectedIdsFromUi(),
    overrides: reviewedOverridesFromUi(),
  }).catch(() => {}));
  elements.activateButton.addEventListener('click', () => invoke('meta_activate_webmcp', {}).catch(() => {}));
  elements.testButton.addEventListener('click', () => invoke('meta_test_webmcp', {}).catch(() => {}));
  elements.exportButton.addEventListener('click', () => invoke('meta_export_webmcp', {}).catch(() => {}));
  elements.resetButton.addEventListener('click', () => invoke('meta_reset_workspace', {}).catch(() => {}));
  elements.labRunButton.addEventListener('click', async () => {
    if (!state.selectedToolName) return;
    try {
      const input = JSON.parse(elements.labInput.value || '{}');
      const result = await invoke(state.selectedToolName, input);
      elements.labOutput.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      elements.labOutput.textContent = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2);
    }
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'relay-state') return;
    state.latestTargetState = clone(event.data.state);
  });
  window.addEventListener('pagehide', () => browserMcpSession.closeOnPageHide());
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)) return;
    const actions = {
      1: () => elements.analyzeButton.click(),
      2: () => elements.createButton.click(),
      3: () => elements.activateButton.click(),
      4: () => elements.testButton.click(),
      5: () => elements.exportButton.click(),
    };
    if (actions[event.key]) actions[event.key]();
  });
}

async function initialize() {
  bindEvents();
  renderSourceControls();
  addTrace('MetaWebMCP ready', 'The permanent control plane is registering. The embedded target still exposes no WebMCP of its own.');
  registry.addEventListener('registrychange', renderRegistry);
  await registerMetaTools();
  renderRegistry();
  renderActions();
  setPhase(0);
  window.MetaWebMCP = Object.freeze({
    registry,
    getState: getMetaState,
    execute: (name, input = {}) => registry.execute(name, input),
  });
  window.dispatchEvent(new CustomEvent('metawebmcp-ready'));
}

initialize().catch((error) => {
  addTrace('Initialization failed', error instanceof Error ? error.message : String(error), 'error');
  console.error(error);
});
