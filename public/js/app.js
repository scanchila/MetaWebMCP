import { analyzeAgentSnapshot, analyzeControlledDemo, analyzeStaticSource, analyzeThroughBrowserMcp } from './demo-analyzer.js';
import { ToolRegistry, compactRegistryState, executeGeneratedSpec } from './webmcp-runtime.js';
import { browserMcpSession } from './browser-mcp-session.js';
import { COLLECTION_AUTHORING_GUIDE } from './mcp-collection.js';
import { parseSharedWorkspaceLocation, SharedWorkspaceClient } from './shared-workspace.js';
import { buildAuthoredToolSpecs } from './tool-authoring.js';
import { createWorkspaceStore } from './workspace-store.js';

const $ = (selector) => document.querySelector(selector);
const elements = {
  landingView: $('#home'),
  workspaceApp: $('#workspace-app'),
  workspace: $('#workspace'),
  nativeStatus: $('#native-status'),
  storageStatus: $('#storage-status'),
  toolCount: $('#tool-count'),
  shareButton: $('#share-button'),
  resetButton: $('#reset-button'),
  sharedWorkspaceBanner: $('#shared-workspace-banner'),
  sharedWorkspaceTitle: $('#shared-workspace-title'),
  sharedWorkspaceCopy: $('#shared-workspace-copy'),
  shareDialog: $('#share-dialog'),
  createShareButton: $('#create-share-button'),
  shareError: $('#share-error'),
  shareResult: $('#share-result'),
  shareAuthorUrl: $('#share-author-url'),
  shareViewerUrl: $('#share-viewer-url'),
  openShareViewer: $('#open-share-viewer'),
  shareExpiry: $('#share-expiry'),
  urlField: $('#url-field'),
  targetUrl: $('#target-url'),
  useDemoButton: $('#use-demo-button'),
  goal: $('#goal'),
  analyzeButton: $('#analyze-button'),
  mcpNotice: $('#mcp-notice'),
  mcpTitle: $('#mcp-title'),
  mcpCopy: $('#mcp-copy'),
  targetFrame: $('#target-frame'),
  stageViewSwitch: $('#stage-view-switch'),
  visualViewTab: $('#visual-view-tab'),
  accessibilityViewTab: $('#accessibility-view-tab'),
  stageOpenTarget: $('#stage-open-target'),
  visualView: $('#visual-view'),
  targetScreenshot: $('#target-screenshot'),
  snapshotPreview: $('#snapshot-preview'),
  stagePlaceholder: $('#stage-placeholder'),
  stagePlaceholderTitle: $('#stage-placeholder-title'),
  stagePlaceholderCopy: $('#stage-placeholder-copy'),
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
const WORKSPACE_RECORD_VERSION = 1;
const DEFAULT_GOAL = 'Find the primary actions on this website and turn the useful ones into simple tools.';
const RISK_SEVERITY = Object.freeze({ read: 0, write: 1, consequential: 2 });
const META_TOOL_NAMES = new Set();
const BROWSER_EXECUTOR_TYPES = new Set(['mcp-recipe', 'mcp-collection']);
const HOSTED_BROWSER_GUIDE_CODES = new Set([
  'HOSTED_BROWSER_RATE_LIMITED',
  'HOSTED_BROWSER_RESOURCE_LIMIT',
]);
let sharedWorkspaceLocation = null;
let sharedWorkspaceLocationError = null;
try {
  sharedWorkspaceLocation = parseSharedWorkspaceLocation();
} catch (error) {
  sharedWorkspaceLocationError = error instanceof Error ? error.message : String(error);
}
const isSharedAuthor = sharedWorkspaceLocation?.role === 'author';
const isSharedViewer = sharedWorkspaceLocation?.role === 'viewer';
const PERSISTED_META_MUTATIONS = new Set([
  'meta_analyze_site',
  'meta_create_webmcp',
  'meta_activate_webmcp',
  'meta_test_webmcp',
  'meta_export_webmcp',
]);
const registry = new ToolRegistry();
const workspaceStore = createWorkspaceStore(
  globalThis.indexedDB,
  isSharedAuthor ? `shared:${sharedWorkspaceLocation.id}` : 'current',
);
const sharedWorkspaceClient = new SharedWorkspaceClient({
  ensureCapability: () => browserMcpSession.ensureCapability(),
});
const workspaceId = (() => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `workspace_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
})();

const state = {
  mode: 'adapter',
  phase: 0,
  sourceKind: 'browser_mcp',
  sourceInput: { html: '', snapshot: '' },
  analysis: null,
  contracts: [],
  selectedCapabilityIds: new Set(),
  activated: false,
  verificationComplete: false,
  evals: [],
  export: null,
  trace: [],
  selectedToolName: null,
  browserMcp: { checked: false, checking: false, configured: false, tools: [] },
  browserImageUrl: null,
  stageView: 'visual',
  latestTargetState: null,
};

const persistence = {
  ready: false,
  available: true,
  restored: false,
  savedAt: null,
  error: null,
  paused: false,
  timer: null,
  queue: Promise.resolve(),
};

const sharing = {
  revision: -1,
  error: sharedWorkspaceLocationError,
  pollTimer: null,
  polling: false,
};

function syncPrimaryView({ focus = false } = {}) {
  const workspaceOpen = location.hash === '#workspace' || location.hash.startsWith('#workspace?');
  elements.landingView.hidden = workspaceOpen;
  elements.workspaceApp.hidden = !workspaceOpen;
  document.body.classList.toggle('workspace-open', workspaceOpen);
  document.title = workspaceOpen
    ? 'MetaWebMCP Workspace — WebMCP builds WebMCP'
    : 'MetaWebMCP — WebMCP builds WebMCP';
  if (workspaceOpen && !isSharedViewer && !state.browserMcp.checked && !state.browserMcp.checking) checkBrowserMcp();

  if (!focus) {
    if (workspaceOpen) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }));
    return;
  }
  const target = workspaceOpen ? elements.workspace : elements.landingView;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
    target.focus({ preventScroll: true });
  });
}

function revealWorkspaceForActivity() {
  if (!elements.workspaceApp.hidden) return;
  const url = new URL(location.href);
  url.hash = sharedWorkspaceLocation
    ? `workspace?shared=${sharedWorkspaceLocation.id}&role=${sharedWorkspaceLocation.role}&token=${sharedWorkspaceLocation.token}`
    : 'workspace';
  history.replaceState(null, '', url);
  syncPrimaryView({ focus: true });
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function setPersistenceStatus(label, status = 'ready', detail = '') {
  elements.storageStatus.textContent = label;
  elements.storageStatus.dataset.state = status;
  elements.storageStatus.title = detail || 'Workspace drafts and recipes are saved only in this browser.';
}

function persistenceState() {
  return {
    storage: 'indexeddb',
    available: persistence.available,
    restored: persistence.restored,
    savedAt: persistence.savedAt,
    ...(persistence.error ? { error: persistence.error } : {}),
    ...(sharedWorkspaceLocation ? {
      shared: {
        id: sharedWorkspaceLocation.id,
        role: sharedWorkspaceLocation.role,
        revision: sharing.revision,
        ...(sharing.error ? { error: sharing.error } : {}),
      },
    } : {}),
  };
}

function renderSharingBanner() {
  elements.sharedWorkspaceBanner.classList.toggle('hidden', !sharedWorkspaceLocation);
  if (!sharedWorkspaceLocation) return;
  elements.sharedWorkspaceTitle.textContent = isSharedViewer ? 'Read-only live mirror' : 'Agent author workspace';
  if (sharing.error) {
    elements.sharedWorkspaceCopy.textContent = sharing.error;
  } else if (sharing.revision < 0) {
    elements.sharedWorkspaceCopy.textContent = isSharedViewer
      ? 'Waiting for the first controlled-demo update.'
      : 'The controlled demo will be synchronized after each change.';
  } else {
    elements.sharedWorkspaceCopy.textContent = isSharedViewer
      ? `Showing shared revision ${sharing.revision}; checking for updates automatically.`
      : `Shared revision ${sharing.revision} is available to the presenter.`;
  }
}

function currentReviewDrafts() {
  return [...elements.capabilityList.querySelectorAll('.capability-card')].map((card) => ({
    capabilityId: card.dataset.capabilityId,
    name: card.querySelector('[data-review-name]')?.value || '',
    description: card.querySelector('[data-review-description]')?.value || '',
  }));
}

function workspaceRecord() {
  const savedAt = new Date().toISOString();
  return {
    version: WORKSPACE_RECORD_VERSION,
    savedAt,
    draft: {
      sourceKind: state.sourceKind,
      targetUrl: elements.targetUrl.value,
      targetHtml: state.sourceInput.html,
      targetSnapshot: state.sourceInput.snapshot,
      goal: elements.goal.value,
      reviewDrafts: currentReviewDrafts(),
    },
    workspace: {
      mode: state.mode,
      sourceKind: state.sourceKind,
      analysis: clone(state.analysis),
      contracts: clone(state.contracts),
      selectedCapabilityIds: [...state.selectedCapabilityIds],
      activated: state.activated,
      verificationComplete: state.verificationComplete,
      evals: clone(state.evals),
      trace: clone(state.trace),
      selectedToolName: state.selectedToolName,
      latestTargetState: clone(state.latestTargetState),
      hadTemporaryExport: Boolean(state.export),
    },
  };
}

function validWorkspaceRecord(record) {
  const saved = record?.workspace;
  const draft = record?.draft;
  return record?.version === WORKSPACE_RECORD_VERSION
    && typeof record.savedAt === 'string'
    && isRecord(saved)
    && ['owner', 'adapter'].includes(saved.mode)
    && ['demo', 'url', 'html', 'agent_snapshot', 'browser_mcp'].includes(saved.sourceKind)
    && (saved.analysis === null || (
      isRecord(saved.analysis)
      && Array.isArray(saved.analysis.capabilities)
      && saved.analysis.capabilities.length <= 12
    ))
    && Array.isArray(saved.contracts) && saved.contracts.length <= 25
    && saved.contracts.every((contract) => (
      isRecord(contract)
      && /^[a-z][a-z0-9_]{0,63}$/.test(contract.name || '')
      && typeof contract.description === 'string'
      && contract.description.length >= 8
      && isRecord(contract.inputSchema)
    ))
    && Array.isArray(saved.selectedCapabilityIds)
    && saved.selectedCapabilityIds.every((id) => typeof id === 'string')
    && Array.isArray(saved.evals) && saved.evals.length <= 25
    && Array.isArray(saved.trace) && saved.trace.length <= 30
    && isRecord(draft)
    && ['sourceKind', 'targetUrl', 'targetHtml', 'targetSnapshot', 'goal']
      .every((key) => typeof draft[key] === 'string')
    && Array.isArray(draft.reviewDrafts || [])
    && draft.reviewDrafts.every((review) => (
      isRecord(review)
      && typeof review.capabilityId === 'string'
      && typeof review.name === 'string'
      && typeof review.description === 'string'
    ));
}

function enqueuePersistence(operation) {
  const pending = persistence.queue.catch(() => {}).then(operation);
  persistence.queue = pending.catch(() => {});
  return pending;
}

function canPublishSharedWorkspace(record) {
  return record.workspace.sourceKind === 'demo'
    || (record.workspace.analysis === null && record.workspace.contracts.length === 0);
}

async function publishSharedWorkspace(record) {
  if (!isSharedAuthor) return false;
  if (!canPublishSharedWorkspace(record)) {
    sharing.error = 'Cloud sharing is limited to the controlled Relay Sessions demo.';
    renderSharingBanner();
    return false;
  }
  const saved = await sharedWorkspaceClient.save({
    id: sharedWorkspaceLocation.id,
    token: sharedWorkspaceLocation.token,
    workspace: record,
  });
  sharing.revision = saved.revision;
  sharing.error = null;
  renderSharingBanner();
  return true;
}

async function persistWorkspace() {
  if (persistence.timer) clearTimeout(persistence.timer);
  persistence.timer = null;
  if (!persistence.ready || persistence.paused || isSharedViewer) return false;
  const record = workspaceRecord();
  setPersistenceStatus(isSharedAuthor ? 'Saving shared…' : 'Saving locally…', 'saving');
  return enqueuePersistence(async () => {
    let localSaved = false;
    let sharedSaved = false;
    if (persistence.available) {
      try {
        await workspaceStore.save(record);
        localSaved = true;
        persistence.savedAt = record.savedAt;
        persistence.error = null;
      } catch (error) {
        persistence.available = false;
        persistence.error = error instanceof Error ? error.message : String(error);
      }
    }
    if (isSharedAuthor) {
      try {
        sharedSaved = await publishSharedWorkspace(record);
      } catch (error) {
        sharing.error = error instanceof Error ? error.message : String(error);
        renderSharingBanner();
      }
    }
    if (sharedSaved) {
      setPersistenceStatus(
        'Shared live',
        'ready',
        persistence.available
          ? 'This controlled demo is saved locally and mirrored to the expiring presentation workspace.'
          : 'The presentation workspace is live, but browser-local save is unavailable.',
      );
    } else if (localSaved) {
      setPersistenceStatus('Saved locally', 'ready', 'Workspace drafts and recipes are saved only in this browser. Reset removes them.');
    } else if (!persistence.available) {
      setPersistenceStatus('Local save unavailable', 'unavailable', persistence.error || sharing.error || 'Workspace save failed.');
    }
    return localSaved || sharedSaved;
  });
}

function scheduleWorkspaceSave() {
  persistence.paused = false;
  if (!persistence.ready || isSharedViewer || (!persistence.available && !isSharedAuthor)) return;
  if (persistence.timer) clearTimeout(persistence.timer);
  setPersistenceStatus('Saving locally…', 'saving');
  persistence.timer = setTimeout(() => { persistWorkspace(); }, 250);
}

async function clearPersistedWorkspace() {
  if (persistence.timer) clearTimeout(persistence.timer);
  persistence.timer = null;
  persistence.restored = false;
  persistence.savedAt = null;
  persistence.paused = true;
  if (isSharedViewer) return false;
  let localCleared = false;
  try {
    if (persistence.available) {
      await enqueuePersistence(() => workspaceStore.clear());
      localCleared = true;
    }
  } catch (error) {
    persistence.available = false;
    persistence.error = error instanceof Error ? error.message : String(error);
  }
  let sharedCleared = false;
  if (isSharedAuthor) {
    try {
      sharedCleared = await publishSharedWorkspace(workspaceRecord());
    } catch (error) {
      sharing.error = error instanceof Error ? error.message : String(error);
      renderSharingBanner();
    }
  }
  if (sharedCleared) setPersistenceStatus('Shared workspace reset', 'ready', 'The presenter now sees the reset workspace.');
  else if (localCleared) setPersistenceStatus('Local workspace cleared', 'ready', 'The browser-local workspace has been removed. New changes will be saved automatically.');
  else setPersistenceStatus('Workspace clear unavailable', 'unavailable', persistence.error || sharing.error || 'Workspace clear failed.');
  return localCleared || sharedCleared;
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
  revealWorkspaceForActivity();
  setBusy(true);
  try {
    return await registry.execute(name, input);
  } catch (error) {
    if (HOSTED_BROWSER_GUIDE_CODES.has(error?.code)) elements.clientGuide.open = true;
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
  const isDemo = state.sourceKind === 'demo';
  elements.useDemoButton.classList.toggle('selected', isDemo);
  elements.useDemoButton.textContent = isDemo ? 'Sample selected' : 'Use sample';
  elements.useDemoButton.setAttribute('aria-pressed', String(isDemo));
  elements.mcpNotice.classList.toggle('hidden', isDemo);
  elements.analyzeButton.querySelector('span').textContent = isDemo
    ? 'Inspect sample website'
    : 'Open and inspect website';
  renderTargetStage();
}

function targetLink(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

function selectStageView(view) {
  if (!['visual', 'accessibility'].includes(view)) return;
  state.stageView = view;
  renderTargetStage();
}

function renderTargetStage() {
  const source = state.sourceKind;
  const isDemo = source === 'demo';
  const isBrowser = ['agent_snapshot', 'browser_mcp'].includes(source);
  const snapshot = typeof state.latestTargetState === 'string'
    ? state.latestTargetState
    : state.analysis?.snapshot || '';
  const hasVisual = Boolean(state.browserImageUrl);
  const hasAccessibility = Boolean(snapshot);
  if (state.stageView === 'visual' && !hasVisual && hasAccessibility) state.stageView = 'accessibility';
  if (state.stageView === 'accessibility' && !hasAccessibility && hasVisual) state.stageView = 'visual';

  elements.targetFrame.classList.toggle('hidden', !isDemo);
  elements.stageViewSwitch.classList.toggle('hidden', !isBrowser || (!hasVisual && !hasAccessibility));
  elements.visualView.classList.toggle('hidden', isDemo || (isBrowser && state.stageView !== 'visual'));
  elements.snapshotPreview.classList.toggle('hidden', !isBrowser || state.stageView !== 'accessibility');
  elements.targetScreenshot.classList.toggle('hidden', !hasVisual);
  elements.stagePlaceholder.classList.toggle('hidden', isDemo || hasVisual || (isBrowser && state.stageView === 'accessibility'));
  elements.visualViewTab.disabled = !hasVisual;
  elements.accessibilityViewTab.disabled = !hasAccessibility;
  elements.visualViewTab.setAttribute('aria-selected', String(state.stageView === 'visual'));
  elements.accessibilityViewTab.setAttribute('aria-selected', String(state.stageView === 'accessibility'));
  if (hasVisual) elements.targetScreenshot.src = state.browserImageUrl;
  else elements.targetScreenshot.removeAttribute('src');
  elements.snapshotPreview.textContent = snapshot;

  const rawUrl = state.analysis?.source?.url || elements.targetUrl.value;
  const linkedUrl = targetLink(rawUrl);
  elements.stageOpenTarget.classList.toggle('hidden', !linkedUrl);
  if (linkedUrl) elements.stageOpenTarget.href = linkedUrl;
  else elements.stageOpenTarget.removeAttribute('href');

  if (isDemo) {
    elements.stageLabel.textContent = 'Relay Sessions · sample website';
    elements.stageState.textContent = state.activated ? `${state.contracts.length} tools via parent` : 'No WebMCP';
  } else if (isBrowser) {
    elements.stageLabel.textContent = state.analysis?.source?.title || 'Isolated website session';
    elements.stageState.textContent = hasVisual
      ? state.latestTargetState ? 'View refreshed' : 'Page captured'
      : hasAccessibility ? 'Accessibility captured' : 'Waiting for URL';
    elements.stagePlaceholderTitle.textContent = state.analysis
      ? 'The visual capture is unavailable'
      : 'Your website view will appear here';
    elements.stagePlaceholderCopy.textContent = state.analysis
      ? 'The accessibility model is still available and the generated recipes remain bounded to observed controls.'
      : 'Enter a public URL and inspect it. You will be able to see the rendered page and the accessibility model used to derive tools.';
  } else {
    elements.stageLabel.textContent = state.analysis?.source?.title || 'Supplied source analysis';
    elements.stageState.textContent = state.contracts.length ? `${state.contracts.length} contracts` : 'Export target';
    elements.stagePlaceholderTitle.textContent = 'Source analysis complete';
    elements.stagePlaceholderCopy.textContent = 'This source was supplied through the WebMCP tool API. Its evidence and generated contracts are available in the workspace.';
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
  state.browserImageUrl = null;
  state.stageView = 'visual';
  state.latestTargetState = null;
  if (!keepTrace) state.trace = [];
  elements.capabilitySection.classList.add('hidden');
  elements.capabilitySection.open = false;
  elements.capabilityList.replaceChildren();
  elements.downloadLink.classList.add('hidden');
  elements.downloadLink.removeAttribute('href');
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
    checkbox.disabled = isSharedViewer;
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
    name.readOnly = isSharedViewer;
    const reviewedDescription = document.createElement('textarea');
    reviewedDescription.value = capability.description;
    reviewedDescription.required = true;
    reviewedDescription.minLength = 8;
    reviewedDescription.maxLength = 600;
    reviewedDescription.rows = 2;
    reviewedDescription.dataset.reviewDescription = '';
    reviewedDescription.readOnly = isSharedViewer;
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

function applySavedDraft(draft) {
  elements.targetUrl.value = draft.targetUrl;
  state.sourceInput = { html: draft.targetHtml, snapshot: draft.targetSnapshot };
  elements.goal.value = draft.goal;
}

function applySavedReviewDrafts(reviewDrafts) {
  const byCapability = new Map(reviewDrafts.map((review) => [review.capabilityId, review]));
  for (const card of elements.capabilityList.querySelectorAll('.capability-card')) {
    const review = byCapability.get(card.dataset.capabilityId);
    if (!review) continue;
    card.querySelector('[data-review-name]').value = review.name;
    card.querySelector('[data-review-description]').value = review.description;
  }
}

function restoredPhase() {
  if (state.activated && state.verificationComplete) return 4;
  if (state.activated) return 3;
  if (state.contracts.length) return 2;
  if (state.analysis) return 1;
  return 0;
}

async function applyControlledDemoState() {
  if (state.sourceKind !== 'demo' || !state.latestTargetState) return;
  const restore = () => {
    const apply = elements.targetFrame.contentWindow?.demoApp?.restore;
    if (typeof apply !== 'function') return false;
    apply(state.latestTargetState);
    return true;
  };
  if (restore()) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    elements.targetFrame.addEventListener('load', () => {
      clearTimeout(timeout);
      restore();
      resolve();
    }, { once: true });
  });
}

async function applyWorkspaceRecord(record, { readOnly = false } = {}) {
  if (!validWorkspaceRecord(record)) throw new Error('Shared workspace record is incompatible or malformed.');
  const saved = record.workspace;
  registry.unregisterOrigin(GENERATED_ORIGIN);
  applySavedDraft(record.draft);
  state.mode = saved.mode;
  state.sourceKind = saved.sourceKind;
  state.analysis = clone(saved.analysis);
  state.contracts = clone(saved.contracts);
  const knownCapabilityIds = new Set(state.analysis?.capabilities?.map((capability) => capability.id) || []);
  state.selectedCapabilityIds = new Set(
    saved.selectedCapabilityIds.filter((id) => knownCapabilityIds.has(id)),
  );
  state.activated = false;
  state.verificationComplete = false;
  state.evals = clone(saved.evals);
  state.export = null;
  state.trace = clone(saved.trace);
  state.selectedToolName = saved.selectedToolName;
  state.browserImageUrl = null;
  state.stageView = ['agent_snapshot', 'browser_mcp'].includes(saved.sourceKind) ? 'accessibility' : 'visual';
  state.latestTargetState = clone(saved.latestTargetState);

  renderSourceControls();
  renderCapabilities();
  applySavedReviewDrafts(record.draft.reviewDrafts);
  renderTrace();

  const hostedSessionCannotResume = saved.activated && state.analysis?.source?.kind === 'browser_mcp';
  if (saved.activated && state.contracts.length && !hostedSessionCannotResume) {
    try {
      await registerGeneratedContracts({ readOnly });
      state.activated = true;
      state.verificationComplete = Boolean(saved.verificationComplete);
    } catch (error) {
      registry.unregisterOrigin(GENERATED_ORIGIN);
      state.selectedToolName = null;
      if (readOnly) sharing.error = error instanceof Error ? error.message : String(error);
      else addTrace('Generated tools need review', error instanceof Error ? error.message : String(error), 'warning');
    }
  }

  if (hostedSessionCannotResume) {
    state.evals = [];
    state.latestTargetState = null;
    state.selectedToolName = null;
    addTrace('Hosted session not restored', 'The contracts remain saved, but the expired browser session must be analyzed again before execution.', 'warning');
  }

  state.phase = restoredPhase();
  elements.downloadLink.classList.add('hidden');
  elements.downloadLink.removeAttribute('href');
  renderTargetStage();
  renderActions();
  renderRegistry();
  setPhase(state.phase);
  if (state.selectedToolName && registry.get(state.selectedToolName)) selectTool(state.selectedToolName);
  else {
    state.selectedToolName = null;
    elements.toolLab.classList.add('hidden');
  }

  persistence.restored = true;
  persistence.savedAt = record.savedAt;
  await applyControlledDemoState();
  return true;
}

async function restoreLocalWorkspace() {
  let record;
  try {
    record = await workspaceStore.load();
  } catch (error) {
    persistence.available = false;
    persistence.error = error instanceof Error ? error.message : String(error);
    setPersistenceStatus('Local save unavailable', 'unavailable', persistence.error);
    return false;
  }
  if (!record) return false;
  if (!validWorkspaceRecord(record)) {
    await workspaceStore.clear().catch(() => {});
    setPersistenceStatus('Local workspace reset', 'ready', 'An incompatible browser-local workspace was removed.');
    addTrace('Saved workspace ignored', 'The browser-local record was incompatible or malformed, so MetaWebMCP started clean.', 'warning');
    return false;
  }
  await applyWorkspaceRecord(record);
  setPersistenceStatus('Restored locally', 'ready', 'This workspace was restored from this browser. Reset removes the saved copy.');
  addTrace(
    'Browser-local workspace restored',
    record.workspace.hadTemporaryExport
      ? 'Analysis and recipes were restored. The expired, single-use export link was not; export again when needed.'
      : 'Analysis, review state, and generated recipes were restored from this browser.',
  );
  return true;
}

async function loadSharedWorkspace(afterRevision = -1) {
  return sharedWorkspaceClient.load({
    id: sharedWorkspaceLocation.id,
    token: sharedWorkspaceLocation.token,
    afterRevision,
  });
}

async function applySharedWorkspacePayload(payload) {
  if (!payload.changed) return false;
  sharing.revision = payload.revision;
  sharing.error = null;
  if (payload.workspace) await applyWorkspaceRecord(payload.workspace, { readOnly: isSharedViewer });
  renderSharingBanner();
  return Boolean(payload.workspace);
}

async function restoreWorkspace() {
  persistence.ready = true;
  renderSharingBanner();
  if (sharedWorkspaceLocation) {
    try {
      const payload = await loadSharedWorkspace();
      const restored = await applySharedWorkspacePayload(payload);
      if (isSharedViewer) {
        persistence.available = false;
        setPersistenceStatus(
          restored ? 'Watching shared' : 'Waiting for author',
          restored ? 'ready' : 'saving',
          'This read-only browser is loading revisions from the expiring presentation workspace.',
        );
        return restored;
      }
      if (restored) {
        setPersistenceStatus('Restored shared', 'ready', 'This author page restored the latest cloud revision and will continue sharing changes.');
        return true;
      }
    } catch (error) {
      sharing.error = error instanceof Error ? error.message : String(error);
      renderSharingBanner();
      if (isSharedViewer) {
        persistence.available = false;
        setPersistenceStatus('Shared load failed', 'unavailable', sharing.error);
        return false;
      }
    }
  }

  const restored = await restoreLocalWorkspace();
  if (!restored && persistence.available) {
    setPersistenceStatus(
      isSharedAuthor ? 'Shared author ready' : 'Local autosave',
      'ready',
      isSharedAuthor
        ? 'Select the controlled sample; changes will be saved locally and to the presentation workspace.'
        : 'Workspace drafts and recipes will be saved only in this browser.',
    );
  }
  return restored;
}

function renderActions() {
  elements.activateButton.disabled = isSharedViewer || state.contracts.length === 0;
  elements.testButton.disabled = isSharedViewer || !state.activated;
  elements.exportButton.disabled = isSharedViewer || state.contracts.length === 0;
  elements.createButton.disabled = isSharedViewer || !state.analysis?.capabilities?.length;
  elements.selectAllButton.disabled = isSharedViewer;
  elements.labRunButton.disabled = isSharedViewer || !state.selectedToolName;
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
  if (isSharedViewer && registry.nativeSupported && nativeCount === tools.length && tools.length) {
    elements.nativeStatus.className = 'status-pill native';
    elements.nativeStatus.innerHTML = '<i></i>WebMCP mirror';
    elements.clientStatusCopy.textContent = `${nativeCount} tools are registered through this browser’s native WebMCP client with read-only presentation handlers.`;
  } else if (isSharedViewer) {
    elements.nativeStatus.className = 'status-pill preview';
    elements.nativeStatus.innerHTML = '<i></i>Read-only mirror';
    elements.clientStatusCopy.textContent = 'The numbered controls expose the shared tools for inspection, while all workspace mutations remain disabled.';
  } else if (registry.nativeSupported && nativeCount === tools.length && tools.length) {
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
  scheduleWorkspaceSave();
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
    ...(analysis.snapshot ? { snapshotExcerpt: analysis.snapshot.slice(0, 5000) } : {}),
  };
}

function resolveAnalysisRequest(input) {
  const requested = input.source && input.source !== 'current' ? input.source : null;
  const source = requested || state.sourceKind;
  return {
    source,
    goal: String(input.goal ?? elements.goal.value).trim(),
    url: String(input.url ?? elements.targetUrl.value).trim(),
    html: String(input.html ?? state.sourceInput.html),
    snapshot: String(input.snapshot ?? state.sourceInput.snapshot),
  };
}

async function captureCurrentWebsiteView() {
  const view = await browserMcpSession.captureView(workspaceId);
  state.browserImageUrl = view.imageUrl;
  state.stageView = 'visual';
  return view;
}

async function analyzeTarget(input = {}) {
  const request = resolveAnalysisRequest(input);
  if (!request.goal) throw new Error('Describe what agents should be able to accomplish.');
  if (['url', 'agent_snapshot', 'browser_mcp'].includes(request.source) && !request.url) throw new Error('A target URL is required.');
  if (request.source === 'html' && !request.html.trim()) throw new Error('Paste target HTML before analysis.');
  if (request.source === 'agent_snapshot' && !request.snapshot.trim()) throw new Error('Supply an accessibility snapshot captured by the calling agent.');

  const adapterSource = ['agent_snapshot', 'browser_mcp'].includes(request.source);
  state.mode = adapterSource ? 'adapter' : 'owner';
  state.sourceKind = request.source;
  elements.goal.value = request.goal;
  if (request.source === 'demo') elements.targetUrl.value = new URL('/demo/', location.href).href;
  else if (['url', 'agent_snapshot', 'browser_mcp'].includes(request.source)) elements.targetUrl.value = request.url;
  state.sourceInput = request.source === 'html'
    ? { html: request.html, snapshot: '' }
    : request.source === 'agent_snapshot'
      ? { html: '', snapshot: request.snapshot }
      : { html: '', snapshot: '' };

  clearBuildState({ keepTrace: true });
  renderSourceControls();
  addTrace('Observing target', `Source: ${request.source}. Goal: ${request.goal}`, 'warning');
  let analysis;
  if (request.source === 'demo') {
    analysis = await analyzeControlledDemo(elements.targetFrame, request.goal);
  } else if (request.source === 'agent_snapshot') {
    analysis = await analyzeAgentSnapshot({ url: request.url, goal: request.goal, snapshot: request.snapshot });
  } else if (request.source === 'browser_mcp') {
    analysis = await analyzeThroughBrowserMcp({ url: request.url, goal: request.goal, workspaceId });
  } else {
    analysis = await analyzeStaticSource({ source: request.source, url: request.url, html: request.html, goal: request.goal });
  }

  state.analysis = analysis;
  state.sourceKind = request.source;
  if (request.source === 'browser_mcp') {
    try {
      await captureCurrentWebsiteView();
    } catch (error) {
      state.stageView = 'accessibility';
      addTrace('Page view unavailable', error instanceof Error ? error.message : String(error), 'warning');
    }
  } else if (request.source === 'agent_snapshot') {
    state.stageView = 'accessibility';
  }
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
  let tools;
  if (Object.hasOwn(input, 'authored_tools')) {
    if (Object.hasOwn(input, 'capability_ids') || Object.hasOwn(input, 'overrides')) {
      throw new Error('Use either authored_tools or selected capability overrides, not both.');
    }
    tools = buildAuthoredToolSpecs({
      definitions: input.authored_tools,
      capabilities: state.analysis.capabilities,
      targetUrl: state.analysis.source?.url,
      reservedNames: META_TOOL_NAMES,
    });
  } else {
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
    tools = ids.map((id) => {
      const capability = capabilitiesById.get(id);
      const override = byCapability.get(id) || {};
      return {
        ...clone(capability),
        ...(override.name ? { name: override.name } : {}),
        ...(override.description ? { description: override.description } : {}),
        ...(override.risk ? { risk: override.risk } : {}),
      };
    });
  }

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

async function registerGeneratedContracts({ readOnly = false } = {}) {
  registry.unregisterOrigin(GENERATED_ORIGIN);
  const names = new Set();
  try {
    for (const spec of state.contracts) {
      if (META_TOOL_NAMES.has(spec.name)) throw new Error(`Generated tool ${spec.name} collides with MetaWebMCP's control plane.`);
      if (names.has(spec.name)) throw new Error(`Generated tool name ${spec.name} is duplicated.`);
      names.add(spec.name);
      await registry.register(spec, async (input, context) => {
        revealWorkspaceForActivity();
        if (readOnly) throw new Error('This presentation viewer is read-only. Run generated tools in the author workspace.');
        const result = await executeGeneratedSpec(spec, input, {
          ...context,
          getTargetDocument,
          allowConsequential: false,
          browserExecution: state.analysis?.source?.kind === 'agent_snapshot' ? 'agent' : 'managed',
          targetUrl: state.analysis?.source?.url || '',
          workspaceId,
        });
        state.latestTargetState = clone(result.state || result.result || result);
        if (state.analysis?.source?.kind === 'browser_mcp'
          && BROWSER_EXECUTOR_TYPES.has(spec.executor.type)
          && result.completed !== false) {
          try {
            await captureCurrentWebsiteView();
          } catch (error) {
            state.stageView = 'accessibility';
            addTrace('Page view refresh failed', error instanceof Error ? error.message : String(error), 'warning');
          }
        }
        const executionIncomplete = result.completed === false || result.complete === false;
        const traceTitle = result.completed === false
          ? `Prepared ${spec.name}`
          : result.complete === false ? `Incomplete ${spec.name}` : `Executed ${spec.name}`;
        const traceDetail = result.completed === false
          ? 'Returned a bounded execution plan for the calling agent’s browser; no remote action was claimed.'
          : result.complete === false
            ? `Generated ${spec.risk} tool returned partial results through ${spec.executor.type}.`
            : `Generated ${spec.risk} tool completed through ${spec.executor.type}.`;
        addTrace(
          traceTitle,
          traceDetail,
          executionIncomplete ? 'warning' : 'success',
        );
        renderTargetStage();
        persistence.paused = false;
        await persistWorkspace();
        return result;
      }, { origin: GENERATED_ORIGIN });
    }
  } catch (error) {
    registry.unregisterOrigin(GENERATED_ORIGIN);
    throw error;
  }
}

async function activateWebMcp() {
  if (!state.contracts.length) throw new Error('Create WebMCP contracts before activation.');
  await registerGeneratedContracts();

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
    } else if (state.analysis?.source?.kind === 'agent_snapshot' && BROWSER_EXECUTOR_TYPES.has(spec.executor.type)) {
      status = 'skipped';
      reason = 'Live execution and visible-state verification belong to the calling agent’s browser in this mode.';
    } else if (!BROWSER_EXECUTOR_TYPES.has(spec.executor.type) && !getTargetDocument()) {
      status = 'skipped';
      reason = 'Static DOM exports must be executed inside the owned target application.';
    } else if (BROWSER_EXECUTOR_TYPES.has(spec.executor.type) && spec.risk !== 'read') {
      status = 'skipped';
      reason = 'Browser MCP write tools require explicit human review.';
    } else {
      try {
        result = await registry.execute(spec.name, spec.sampleArgs || {});
        if (state.analysis?.source?.kind === 'demo') checks.push(...verifyDemoPostcondition(spec, result));
        else checks.push({
          name: spec.executor.type === 'mcp-collection' ? 'collection traversal completed' : 'execution completed',
          passed: result?.ok !== false && result?.complete !== false,
        });
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
  await browserMcpSession.ensureCapability();
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
    ownerBundle = { html: state.sourceInput.html, files: {} };
  }
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectName,
      tools: state.contracts,
      target: state.analysis?.source || {},
      goal: state.analysis?.goal || elements.goal.value,
      mode: ['agent_snapshot', 'browser_mcp'].includes(state.analysis?.source?.kind) ? 'browser_mcp' : 'native',
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
    persistence: persistenceState(),
    recentTrace: clone(state.trace.slice(-10)),
  };
}

async function resetWorkspace() {
  registry.unregisterOrigin(GENERATED_ORIGIN);
  try { elements.targetFrame.contentWindow?.demoApp?.reset(); } catch { /* The demo may still be loading. */ }
  const browserReset = await browserMcpSession.reset(workspaceId).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  clearBuildState({ keepTrace: false });
  state.mode = 'adapter';
  state.sourceKind = 'browser_mcp';
  state.sourceInput = { html: '', snapshot: '' };
  elements.targetUrl.value = '';
  elements.goal.value = DEFAULT_GOAL;
  renderSourceControls();
  addTrace('Workspace reset', 'The meta-tool control plane remains registered; generated tools and project state were removed.');
  if (browserReset.ok === false) addTrace('Browser cleanup incomplete', browserReset.error, 'warning');
  return { ok: true, browserReset, remainingTools: registry.list().map((tool) => tool.name) };
}

const metaTools = [
  {
    spec: {
      name: 'meta_analyze_site',
      description: 'Open or observe a website and return evidence-backed candidate workflows. Use browser_mcp for the in-site hosted viewer; an agent may use agent_snapshot when it already controls the target browser. Call this first.',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['current', 'demo', 'url', 'html', 'agent_snapshot', 'browser_mcp'], description: 'Use current for the website entered in the workspace, browser_mcp for hosted visual inspection, or agent_snapshot for an observation already captured by the calling agent.' },
          goal: { type: 'string', description: 'What agents should be able to accomplish on the target site.' },
          url: { type: 'string', description: 'Required for URL, agent-snapshot, or Browser MCP analysis.' },
          html: { type: 'string', description: 'Required when source is html.' },
          snapshot: { type: 'string', maxLength: 250000, description: 'Accessibility snapshot captured from the target by the calling agent. Required for agent_snapshot.' },
        },
        additionalProperties: false,
      },
    },
    execute: analyzeTarget,
  },
  {
    spec: {
      name: 'meta_create_webmcp',
      description: 'Create reviewed WebMCP contracts from selected candidates, or submit agent-authored tools that cite observed capability IDs and use the constrained recipe or collection runtime.',
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
          authored_tools: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            description: 'Optional complete tool definitions authored by the managing agent. Use instead of capability_ids and overrides. Executors may be mcp-recipe or mcp-collection; arbitrary JavaScript is rejected.',
            items: {
              type: 'object',
              properties: {
                capability_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, description: 'Observed capabilities that ground this tool.' },
                name: { type: 'string', description: 'Lowercase WebMCP tool name.' },
                description: { type: 'string', minLength: 8, maxLength: 600 },
                risk: { type: 'string', enum: ['read', 'write', 'consequential'] },
                input_schema: { type: 'object', description: 'Narrow JSON object schema with additionalProperties false.' },
                sample_args: { type: 'object', description: 'Representative arguments used by deterministic evaluation.' },
                executor: { type: 'object', description: 'Constrained mcp-recipe or mcp-collection plan. Collection scaffolds returned by analysis show the supported shape.' },
              },
              required: ['capability_ids', 'name', 'description', 'risk', 'input_schema', 'executor'],
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
      description: 'Read the current MetaWebMCP build state, browser-local persistence status, generated contracts, registry contents, evaluation results, and export status.',
      risk: 'read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: getMetaState,
  },
  {
    spec: {
      name: 'meta_reset_workspace',
      description: 'Remove every dynamically generated tool and clear the current build and browser-local saved copy while preserving MetaWebMCP’s permanent seven-tool control plane.',
      risk: 'write',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    execute: resetWorkspace,
  },
];

async function registerMetaTools() {
  for (const { spec, execute } of metaTools) {
    META_TOOL_NAMES.add(spec.name);
    await registry.register(spec, async (input, context) => {
      if (spec.name !== 'meta_get_state') revealWorkspaceForActivity();
      if (isSharedViewer && spec.name !== 'meta_get_state') {
        throw new Error('This presentation viewer is read-only. Run builder tools in the author workspace.');
      }
      const result = await execute(input, context);
      if (spec.name === 'meta_reset_workspace') await clearPersistedWorkspace();
      else if (PERSISTED_META_MUTATIONS.has(spec.name)) {
        persistence.paused = false;
        await persistWorkspace();
      }
      return result;
    }, { origin: META_ORIGIN });
  }
}

async function checkBrowserMcp() {
  if (state.browserMcp.checking) return;
  state.browserMcp.checking = true;
  elements.mcpNotice.classList.remove('connected', 'error');
  elements.mcpCopy.textContent = 'Checking the isolated browser runtime.';
  try {
    const payload = await browserMcpSession.status(workspaceId);
    state.browserMcp = { checked: true, checking: false, configured: Boolean(payload.configured), tools: payload.tools || [] };
    if (payload.configured) {
      elements.mcpNotice.classList.add('connected');
      elements.mcpTitle.textContent = 'Hosted website viewer ready';
      elements.mcpCopy.textContent = 'The site will open the target in an isolated session and show both its rendered page and accessibility model here.';
    } else {
      elements.mcpNotice.classList.add('error');
      elements.mcpTitle.textContent = 'Hosted website viewer unavailable';
      elements.mcpCopy.textContent = 'Public-site inspection is not enabled in this environment. The built-in sample remains available.';
    }
  } catch (error) {
    state.browserMcp = { checked: true, checking: false, configured: false, tools: [] };
    elements.mcpNotice.classList.add('error');
    elements.mcpTitle.textContent = 'Browser MCP unavailable';
    elements.mcpCopy.textContent = error instanceof Error ? error.message : String(error);
  }
}

function configureSharedWorkspaceMode() {
  const shared = Boolean(sharedWorkspaceLocation);
  elements.shareButton.classList.toggle('hidden', shared);
  renderSharingBanner();
  if (!isSharedViewer) return;
  document.body.classList.add('shared-viewer');
  elements.resetButton.disabled = true;
  elements.useDemoButton.disabled = true;
  elements.targetUrl.readOnly = true;
  elements.goal.readOnly = true;
  elements.analyzeButton.disabled = true;
  elements.labInput.readOnly = true;
  elements.stageOpenTarget.classList.add('hidden');
  elements.targetFrame.inert = true;
  elements.targetFrame.tabIndex = -1;
  elements.targetFrame.setAttribute('aria-disabled', 'true');
  renderActions();
}

function scheduleSharedViewerPoll(delay = 800) {
  if (!isSharedViewer) return;
  if (sharing.pollTimer) clearTimeout(sharing.pollTimer);
  sharing.pollTimer = setTimeout(pollSharedWorkspace, delay);
}

async function pollSharedWorkspace() {
  if (!isSharedViewer || sharing.polling) return;
  sharing.polling = true;
  try {
    const payload = await loadSharedWorkspace(sharing.revision);
    const recovered = Boolean(sharing.error);
    sharing.error = null;
    if (payload.changed) {
      await applySharedWorkspacePayload(payload);
      setPersistenceStatus(
        payload.workspace ? 'Watching shared' : 'Waiting for author',
        payload.workspace ? 'ready' : 'saving',
        'This read-only browser is loading revisions from the expiring presentation workspace.',
      );
      configureSharedWorkspaceMode();
    } else if (recovered) {
      renderSharingBanner();
      setPersistenceStatus(
        sharing.revision > 0 ? 'Watching shared' : 'Waiting for author',
        sharing.revision > 0 ? 'ready' : 'saving',
        'The shared presentation connection recovered and is checking for updates.',
      );
    }
  } catch (error) {
    sharing.error = error instanceof Error ? error.message : String(error);
    renderSharingBanner();
    setPersistenceStatus('Shared load failed', 'unavailable', sharing.error);
  } finally {
    sharing.polling = false;
    scheduleSharedViewerPoll(sharing.error ? 2500 : 800);
  }
}

function showShareDialog() {
  elements.shareError.classList.add('hidden');
  elements.shareDialog.showModal();
}

async function createSharedPresentation() {
  elements.createShareButton.disabled = true;
  elements.shareError.classList.add('hidden');
  try {
    const created = await sharedWorkspaceClient.create();
    elements.shareAuthorUrl.value = created.links.authorUrl;
    elements.shareViewerUrl.value = created.links.viewerUrl;
    elements.openShareViewer.href = created.links.viewerUrl;
    elements.shareExpiry.textContent = `Expires ${new Date(created.expiresAt).toLocaleString()}.`;
    elements.shareResult.classList.remove('hidden');
  } catch (error) {
    elements.shareError.textContent = error instanceof Error ? error.message : String(error);
    elements.shareError.classList.remove('hidden');
  } finally {
    elements.createShareButton.disabled = false;
  }
}

async function copySharedLink(input) {
  const value = input.value;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    input.focus();
    input.select();
    document.execCommand('copy');
  }
}

function bindEvents() {
  window.addEventListener('hashchange', () => {
    const viewChanged = location.hash.startsWith('#workspace') || ['#home', ''].includes(location.hash);
    syncPrimaryView({ focus: viewChanged });
  });
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const targetHash = link.getAttribute('href');
    if (!targetHash || targetHash === '#') return;
    event.preventDefault();
    if (location.hash !== targetHash) {
      location.hash = targetHash;
      return;
    }
    const viewChanged = ['#workspace', '#home'].includes(targetHash);
    syncPrimaryView({ focus: viewChanged });
    if (!viewChanged) document.querySelector(targetHash)?.scrollIntoView();
  });
  elements.shareButton.addEventListener('click', showShareDialog);
  elements.createShareButton.addEventListener('click', createSharedPresentation);
  elements.shareDialog.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-share]');
    if (!button) return;
    const input = document.getElementById(button.dataset.copyShare);
    if (input) copySharedLink(input);
  });
  elements.useDemoButton.addEventListener('click', async () => {
    await browserMcpSession.reset(workspaceId).catch(() => {});
    state.mode = 'owner';
    state.sourceKind = 'demo';
    state.sourceInput = { html: '', snapshot: '' };
    elements.targetUrl.value = new URL('/demo/', location.href).href;
    elements.goal.value = 'Find conference sessions, add the useful ones to an itinerary, and inspect the resulting plan.';
    clearBuildState({ keepTrace: false });
    renderSourceControls();
    addTrace('Sample website selected', 'The visible Relay Sessions page has no WebMCP tools of its own. Inspect it to derive a compatible surface.');
    scheduleWorkspaceSave();
  });
  elements.targetUrl.addEventListener('input', () => {
    if (state.sourceKind !== 'browser_mcp' || state.analysis) {
      state.mode = 'adapter';
      state.sourceKind = 'browser_mcp';
      state.sourceInput = { html: '', snapshot: '' };
      clearBuildState({ keepTrace: false });
      renderSourceControls();
      addTrace('Public website selected', 'Ready to open this URL in the isolated website viewer.');
    }
    scheduleWorkspaceSave();
  });
  elements.visualViewTab.addEventListener('click', () => selectStageView('visual'));
  elements.accessibilityViewTab.addEventListener('click', () => selectStageView('accessibility'));
  elements.analyzeButton.addEventListener('click', () => invoke('meta_analyze_site', { source: 'current' }).catch(() => {}));
  elements.selectAllButton.addEventListener('click', () => {
    const boxes = [...elements.capabilityList.querySelectorAll('input[type="checkbox"]')];
    const shouldSelect = boxes.some((box) => !box.checked);
    boxes.forEach((box) => { box.checked = shouldSelect; });
    state.selectedCapabilityIds = new Set(shouldSelect ? boxes.map((box) => box.value) : []);
    elements.selectAllButton.textContent = shouldSelect ? 'Clear all' : 'Select all';
    scheduleWorkspaceSave();
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
    if (isSharedViewer || event.origin !== location.origin || event.data?.type !== 'relay-state') return;
    state.latestTargetState = clone(event.data.state);
    scheduleWorkspaceSave();
  });
  for (const field of [elements.goal, elements.labInput]) {
    field.addEventListener('input', scheduleWorkspaceSave);
  }
  elements.capabilityList.addEventListener('input', scheduleWorkspaceSave);
  elements.capabilityList.addEventListener('change', scheduleWorkspaceSave);
  window.addEventListener('pagehide', () => {
    if (sharing.pollTimer) clearTimeout(sharing.pollTimer);
    persistWorkspace();
    browserMcpSession.closeOnPageHide();
  });
  window.addEventListener('keydown', (event) => {
    if (elements.workspaceApp.hidden) return;
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
  syncPrimaryView();
  bindEvents();
  renderSourceControls();
  configureSharedWorkspaceMode();
  setPersistenceStatus(sharedWorkspaceLocation ? 'Checking shared…' : 'Checking local save…', 'saving');
  addTrace('MetaWebMCP ready', 'Enter a public URL to inspect it here, or use the visible sample. The permanent control plane is registering now.');
  if (sharedWorkspaceLocationError) addTrace('Shared workspace link ignored', sharedWorkspaceLocationError, 'warning');
  registry.addEventListener('registrychange', renderRegistry);
  await registerMetaTools();
  const restored = await restoreWorkspace();
  renderRegistry();
  renderActions();
  configureSharedWorkspaceMode();
  if (!restored) setPhase(0);
  window.MetaWebMCP = Object.freeze({
    registry,
    getState: getMetaState,
    execute: (name, input = {}) => registry.execute(name, input),
  });
  window.dispatchEvent(new CustomEvent('metawebmcp-ready'));
  if (isSharedViewer) scheduleSharedViewerPoll();
}

initialize().catch((error) => {
  addTrace('Initialization failed', error instanceof Error ? error.message : String(error), 'error');
  console.error(error);
});
