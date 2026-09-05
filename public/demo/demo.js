const sessions = [
  { id: 'reliability-beyond-happy-path', title: 'Reliability beyond the happy path', speaker: 'Mina Park', day: 'day-1', dayLabel: 'Day 1', time: '09:00', end: '09:45', level: 'practical', summary: 'Retries, idempotency, degraded modes, and observable recovery for agent systems.' },
  { id: 'agent-evals-that-catch-regressions', title: 'Agent evals that catch regressions', speaker: 'Noah Chen', day: 'day-1', dayLabel: 'Day 1', time: '10:00', end: '10:45', level: 'advanced', summary: 'Journey-level evaluation tied to real implementations rather than synthetic unit prompts.' },
  { id: 'secure-browser-execution', title: 'Secure browser execution without wishful thinking', speaker: 'Ari Mensah', day: 'day-1', dayLabel: 'Day 1', time: '10:30', end: '11:15', level: 'advanced', summary: 'Isolation boundaries, prompt injection, capability scoping, and auditable browser actions.' },
  { id: 'knowledge-graphs-agent-memory', title: 'Knowledge graphs as working agent memory', speaker: 'Linh Trần', day: 'day-2', dayLabel: 'Day 2', time: '09:30', end: '10:15', level: 'practical', summary: 'A provenance-first graph for decisions, evidence, contradictions, and durable organizational facts.' },
  { id: 'mcp-to-webmcp', title: 'From MCP to WebMCP: shared state returns to the page', speaker: 'Jo Silva', day: 'day-2', dayLabel: 'Day 2', time: '11:00', end: '11:45', level: 'practical', summary: 'How page-scoped tools complement backend integrations while preserving human visibility.' },
  { id: 'orchestrators-under-load', title: 'Orchestrators under load', speaker: 'Priya Raman', day: 'day-2', dayLabel: 'Day 2', time: '13:00', end: '13:45', level: 'advanced', summary: 'Concurrency, leases, queues, state machines, and the failures hidden by successful demos.' },
];

const state = { query: '', level: 'all', day: 'all', itinerary: [] };
const results = document.querySelector('#session-results');
const itineraryList = document.querySelector('#itinerary-list');
const itineraryStatus = document.querySelector('#itinerary-status');
const resultCount = document.querySelector('#result-count');
const form = document.querySelector('#session-search-form');

function minutes(value) {
  const [hours, mins] = value.split(':').map(Number);
  return hours * 60 + mins;
}

function conflicts() {
  let count = 0;
  for (let left = 0; left < state.itinerary.length; left += 1) {
    for (let right = left + 1; right < state.itinerary.length; right += 1) {
      const a = sessions.find((session) => session.id === state.itinerary[left]);
      const b = sessions.find((session) => session.id === state.itinerary[right]);
      if (a.day === b.day && minutes(a.time) < minutes(b.end) && minutes(b.time) < minutes(a.end)) count += 1;
    }
  }
  return count;
}

function visibleSessions() {
  const needle = state.query.trim().toLowerCase();
  return sessions.filter((session) => {
    const text = `${session.title} ${session.speaker} ${session.summary}`.toLowerCase();
    return (!needle || text.includes(needle)) && (state.level === 'all' || session.level === state.level) && (state.day === 'all' || session.day === state.day);
  });
}

function renderSessions() {
  const visibleIds = new Set(visibleSessions().map((session) => session.id));
  results.innerHTML = sessions.map((session) => {
    const selected = state.itinerary.includes(session.id);
    return `<article class="session-card" data-entity="session" data-entity-id="${session.id}" ${visibleIds.has(session.id) ? '' : 'hidden'}>
      <div class="session-meta"><span>${session.dayLabel} · ${session.time}</span><span>${session.level}</span></div>
      <h2>${session.title}</h2>
      <p>${session.speaker} · ${session.summary}</p>
      <button type="button" data-action="add-to-itinerary" data-entity="session" data-entity-id="${session.id}" class="${selected ? 'selected' : ''}">${selected ? 'Added to itinerary' : 'Add to itinerary'}</button>
    </article>`;
  }).join('');
  resultCount.textContent = `${visibleIds.size} session${visibleIds.size === 1 ? '' : 's'}`;
}

function renderItinerary() {
  if (!state.itinerary.length) {
    itineraryList.innerHTML = '<p class="empty">No sessions selected.</p>';
  } else {
    itineraryList.innerHTML = state.itinerary.map((id) => {
      const session = sessions.find((item) => item.id === id);
      return `<div class="itinerary-item" data-itinerary-id="${session.id}">
        <button type="button" data-action="remove-from-itinerary" data-entity-id="${session.id}" aria-label="Remove ${session.title}">Remove</button>
        <strong>${session.title}</strong><span>${session.dayLabel} · ${session.time}–${session.end}</span>
      </div>`;
    }).join('');
  }
  const conflictCount = conflicts();
  itineraryStatus.textContent = `${state.itinerary.length} session${state.itinerary.length === 1 ? '' : 's'} · ${conflictCount} conflict${conflictCount === 1 ? '' : 's'}`;
}

function render() {
  renderSessions();
  renderItinerary();
  window.parent.postMessage({ type: 'relay-state', state: getState() }, location.origin);
}

function add(id) {
  if (!sessions.some((session) => session.id === id)) throw new Error(`Unknown session: ${id}`);
  if (!state.itinerary.includes(id)) state.itinerary.push(id);
  render();
}

function remove(id) {
  state.itinerary = state.itinerary.filter((item) => item !== id);
  render();
}

function clear() {
  state.itinerary = [];
  render();
}

function reset() {
  state.query = '';
  state.level = 'all';
  state.day = 'all';
  state.itinerary = [];
  form.reset();
  render();
}

function restore(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('A valid Relay Sessions state is required.');
  }
  const filters = snapshot.filters && typeof snapshot.filters === 'object' ? snapshot.filters : {};
  state.query = String(filters.query || '').slice(0, 200);
  state.level = ['all', 'practical', 'advanced'].includes(filters.level) ? filters.level : 'all';
  state.day = ['all', 'day-1', 'day-2'].includes(filters.day) ? filters.day : 'all';
  const ids = Array.isArray(snapshot.itinerary)
    ? snapshot.itinerary.map((item) => typeof item === 'string' ? item : item?.id)
    : [];
  state.itinerary = [...new Set(ids)].filter((id) => sessions.some((session) => session.id === id));
  form.elements.query.value = state.query;
  form.elements.level.value = state.level;
  form.elements.day.value = state.day;
  render();
}

function getState() {
  return {
    filters: { query: state.query, level: state.level, day: state.day },
    visibleSessions: visibleSessions().map(({ id, title, dayLabel, time, level }) => ({ id, title, day: dayLabel, time, level })),
    itinerary: state.itinerary.map((id) => sessions.find((session) => session.id === id)),
    conflictCount: conflicts(),
  };
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  state.query = String(data.get('query') || '');
  state.level = String(data.get('level') || 'all');
  state.day = String(data.get('day') || 'all');
  render();
});

results.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="add-to-itinerary"]');
  if (button) add(button.dataset.entityId);
});

itineraryList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="remove-from-itinerary"]');
  if (button) remove(button.dataset.entityId);
});

document.querySelector('#clear-itinerary').addEventListener('click', clear);

window.demoApp = Object.freeze({ add, remove, clear, reset, restore, getState, sessions: structuredClone(sessions) });
render();
