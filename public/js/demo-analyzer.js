import { browserMcpSession } from './browser-mcp-session.js';

function waitForFrame(frame) {
  if (frame.contentDocument?.readyState === 'complete' && frame.contentWindow?.demoApp) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The controlled demo did not finish loading.')), 6000);
    frame.addEventListener('load', () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
  return payload;
}

function normalizeDemoCapability(capability) {
  const copy = structuredClone(capability);
  if (copy.kind === 'form') {
    copy.name = 'find_sessions';
    copy.title = 'Find sessions';
    copy.description = 'Search and filter conference sessions by topic, level, and day, then return the visible matching sessions.';
    copy.risk = 'read';
    copy.sampleArgs = { query: 'agent', level: 'all', day: 'all' };
    copy.executor.resultSelector = '#session-grid';
  } else if (copy.executor?.type === 'dom-action-group' && copy.executor.selector.includes('add-to-itinerary')) {
    copy.name = 'add_session_to_itinerary';
    copy.title = 'Add a session to the itinerary';
    copy.description = 'Add one identified conference session to the itinerary and return the updated schedule and conflict count.';
    copy.risk = 'write';
    copy.sampleArgs = { item_id: 'agent-evals-that-catch-regressions' };
    copy.executor.statusSelector = '#itinerary-panel';
  } else if (copy.executor?.type === 'dom-button' && (copy.executor.selector.includes('clear-itinerary') || /clear itinerary/i.test(copy.title))) {
    copy.name = 'clear_itinerary';
    copy.title = 'Clear the itinerary';
    copy.description = 'Remove every selected conference session from the itinerary and return the empty schedule state.';
    copy.risk = 'write';
    copy.sampleArgs = {};
    copy.executor.statusSelector = '#itinerary-panel';
  }
  copy.id = `demo_${copy.name}`;
  return copy;
}

export async function analyzeControlledDemo(frame, goal) {
  await waitForFrame(frame);
  const targetDocument = frame.contentDocument;
  if (!targetDocument?.documentElement) throw new Error('The controlled demo is not available as a same-origin document.');

  const payload = await postJson('/api/analyze', {
    source: 'html',
    html: targetDocument.documentElement.outerHTML,
    url: new URL('/demo/', location.href).href,
    goal,
  });

  const normalized = payload.analysis.capabilities
    .map(normalizeDemoCapability)
    .filter((capability, index, all) => all.findIndex((item) => item.name === capability.name) === index);

  const inspectTool = {
    id: 'demo_inspect_itinerary',
    kind: 'read',
    name: 'inspect_itinerary',
    title: 'Inspect the itinerary',
    description: 'Return the currently selected sessions and the schedule conflict count without changing the itinerary.',
    risk: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    sampleArgs: {},
    evidence: [
      { type: 'region', selector: '#itinerary-panel', label: 'Your itinerary' },
      { type: 'status', selector: '#itinerary-status', label: 'Selection and conflict count' },
    ],
    executor: { type: 'dom-read', selector: '#itinerary-panel' },
  };

  const desiredOrder = ['find_sessions', 'add_session_to_itinerary', 'inspect_itinerary', 'clear_itinerary'];
  const capabilities = [...normalized, inspectTool]
    .filter((capability) => desiredOrder.includes(capability.name))
    .sort((left, right) => desiredOrder.indexOf(left.name) - desiredOrder.indexOf(right.name));

  return {
    ...payload.analysis,
    source: {
      kind: 'demo',
      url: new URL('/demo/', location.href).href,
      title: 'Relay Sessions · controlled legacy target',
    },
    summary: {
      ...payload.analysis.summary,
      candidates: capabilities.length,
      generatedFromLiveDom: true,
    },
    capabilities,
    warnings: [],
  };
}

export async function analyzeStaticSource({ source, url, html, goal }) {
  const payload = await postJson('/api/analyze', { source, url, html, goal });
  return payload.analysis;
}

export async function analyzeThroughBrowserMcp({ url, goal, workspaceId }) {
  return browserMcpSession.analyze({ url, goal, workspaceId });
}
