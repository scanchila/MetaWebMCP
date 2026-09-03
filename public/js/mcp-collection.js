const FIELD_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const PARSER_TYPES = new Set(['identity', 'currency', 'currency-before', 'number-before', 'number-after', 'matched-input']);
const FILTER_OPERATORS = new Set(['eq', 'gte', 'lte', 'contains', 'contains-any', 'exists']);
const MAX_EXECUTOR_CHARACTERS = 30_000;
const MAX_RESULT_CHARACTERS = 500_000;

export const COLLECTION_PARSER_TYPES = Object.freeze([...PARSER_TYPES]);
export const COLLECTION_AUTHORING_GUIDE = Object.freeze({
  runtimeSupplied: ['scope', 'startUrl'],
  parsers: [
    { type: 'identity', purpose: 'Return normalized source text or URL.' },
    { type: 'currency', options: { occurrence: 'zero-based integer 0–20', default: 'optional scalar' }, purpose: 'Parse a dollar-prefixed localized number.' },
    { type: 'currency-before', options: { marker: 'required string', default: 'optional scalar' }, purpose: 'Parse a dollar amount immediately followed by a marker such as admin.' },
    { type: 'number-before', options: { marker: 'required string', default: 'optional scalar' }, purpose: 'Parse the number immediately before a marker such as m².' },
    { type: 'number-after', options: { marker: 'required string', default: 'optional scalar' }, purpose: 'Parse the number immediately after a marker.' },
    { type: 'matched-input', options: { input: 'declared scalar or array input name' }, purpose: 'Return the first supplied value found in normalized source text.' },
  ],
  filters: {
    operators: [...FILTER_OPERATORS],
    value: 'Use { input: "declared_name" } or { value: <literal> }; exists takes no value.',
    rawFields: ['$text', '$url'],
  },
  computed: [{ operator: 'sum', shape: { name: 'total', fields: ['field_a', 'field_b'] } }],
  pagination: {
    type: 'page-template',
    placeholder: 'urlTemplate must contain exactly one {{page}}.',
    stopWhen: 'Optional page-minimum-exceeds-ranked requires a monotonic numeric lower bound and must cover the maximum result limit.',
  },
  limits: { fields: 24, computed: 10, filters: 20, sort: 4, pages: 20, items: 500, results: 100 },
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function decodeSnapshotString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return String(value).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function stripSnapshotScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeSnapshotString(trimmed.slice(1, -1));
  }
  return trimmed;
}

function lineIndent(line) {
  return (String(line).match(/^\s*/)?.[0] || '').replace(/\t/g, '  ').length;
}

export function extractSnapshotLinks(snapshot, baseUrl) {
  const lines = String(snapshot || '').split(/\r?\n/);
  const found = [];
  const linkPattern = /^\s*-\s*'?link(?:\s+"((?:\\.|[^"])*)")?[^\n]*?\[ref=([^\]]+)\]/i;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(linkPattern);
    if (!match) continue;
    const indent = lineIndent(lines[index]);
    let href = '';
    const descendantText = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      if (!lines[childIndex].trim()) continue;
      if (lineIndent(lines[childIndex]) <= indent) break;
      const urlMatch = lines[childIndex].match(/^\s*-\s*\/url:\s*(.+?)\s*$/i);
      if (urlMatch) {
        href = stripSnapshotScalar(urlMatch[1]);
        continue;
      }
      const quotedText = lines[childIndex].match(/^\s*-\s*(?:heading|paragraph|strong|generic|text)\s+"((?:\\.|[^"])*)"/i);
      const inlineText = lines[childIndex].match(/^\s*-\s*(?:heading|paragraph|strong|generic|text)\b[^:]*:\s*(\S.*)$/i);
      const text = quotedText ? decodeSnapshotString(quotedText[1]) : inlineText ? stripSnapshotScalar(inlineText[1]) : '';
      if (text && !descendantText.includes(text)) descendantText.push(text);
    }
    if (!href) continue;
    try {
      const parsed = new URL(href, baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      parsed.hash = '';
      const ownName = decodeSnapshotString(match[1] || '').replace(/\s+/g, ' ').trim();
      const nestedName = descendantText.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4_000);
      found.push({ name: nestedName.length > ownName.length ? nestedName : ownName, url: parsed.href, ref: match[2] });
    } catch {
      // Invalid and non-URL link targets are not collection records.
    }
  }

  const byUrl = new Map();
  for (const link of found) {
    const previous = byUrl.get(link.url);
    if (!previous || link.name.length > previous.name.length) byUrl.set(link.url, link);
  }
  return [...byUrl.values()];
}

function inputNames(inputSchema) {
  return new Set(Object.keys(isRecord(inputSchema?.properties) ? inputSchema.properties : {}));
}

function assertKnownInput(name, names, label) {
  if (typeof name !== 'string' || !names.has(name)) throw new Error(`${label} references undeclared input ${name || '(missing)'}.`);
}

function validateParser(parser, names, label) {
  if (!isRecord(parser) || !PARSER_TYPES.has(parser.type)) throw new Error(`${label} has an unsupported parser.`);
  if (parser.type === 'currency') assertInteger(parser.occurrence ?? 0, 0, 20, `${label}.occurrence`);
  if (parser.type === 'currency-before' || parser.type === 'number-before' || parser.type === 'number-after') {
    if (typeof parser.marker !== 'string' || !parser.marker.trim() || parser.marker.length > 80) {
      throw new Error(`${label}.marker must contain 1–80 characters.`);
    }
  }
  if (parser.type === 'matched-input') assertKnownInput(parser.input, names, `${label}.input`);
  if (Object.hasOwn(parser, 'default') && !['string', 'number', 'boolean'].includes(typeof parser.default)) {
    throw new Error(`${label}.default must be a string, number, or boolean.`);
  }
}

function validateOperand(operand, names, label) {
  if (!isRecord(operand)) throw new Error(`${label} must be an input or literal value reference.`);
  const hasInput = Object.hasOwn(operand, 'input');
  const hasValue = Object.hasOwn(operand, 'value');
  if (hasInput === hasValue) throw new Error(`${label} must contain exactly one of input or value.`);
  if (hasInput) assertKnownInput(operand.input, names, label);
}

function normalizedScope(scope) {
  if (!isRecord(scope)) throw new Error('Collection scope is required.');
  let parsed;
  try {
    parsed = new URL(String(scope.origin || ''));
  } catch {
    throw new Error('Collection scope origin must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || String(scope.origin) !== parsed.origin) {
    throw new Error('Collection scope origin must be a canonical HTTP or HTTPS origin without credentials.');
  }
  if (typeof scope.pathPrefix !== 'string'
    || !scope.pathPrefix.startsWith('/')
    || scope.pathPrefix.startsWith('//')
    || scope.pathPrefix.includes('\\')
    || /[?#]/.test(scope.pathPrefix)
    || (scope.pathPrefix.length > 1 && scope.pathPrefix.endsWith('/'))
    || scope.pathPrefix.length > 500) {
    throw new Error('Collection scope pathPrefix must be a canonical absolute path of at most 500 characters.');
  }
  return { origin: parsed.origin, pathPrefix: scope.pathPrefix };
}

function pathIsWithinScope(pathname, pathPrefix) {
  return pathPrefix === '/' || pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

function urlWithinScope(rawUrl, scope, label) {
  let url;
  try {
    url = new URL(String(rawUrl), scope.origin);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== scope.origin) {
    throw new Error(`${label} must stay on the same analyzed origin.`);
  }
  if (!pathIsWithinScope(url.pathname, scope.pathPrefix)) {
    throw new Error(`${label} must stay within the analyzed path.`);
  }
  url.hash = '';
  return url;
}

export function collectionScopeForTarget(rawUrl) {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('An analyzed target URL is required for collection tools.');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('The analyzed target must use HTTP or HTTPS without credentials.');
  }
  const pathPrefix = target.pathname
    .replace(/\/(?:pagina|page|p)[-_]?\d+\/?$/i, '')
    .replace(/\/$/, '') || '/';
  return { origin: target.origin, pathPrefix };
}

export function validateCollectionExecutor(executor, { inputSchema } = {}) {
  if (!isRecord(executor) || executor.type !== 'mcp-collection') throw new Error('A valid mcp-collection executor is required.');
  if (JSON.stringify(executor).length > MAX_EXECUTOR_CHARACTERS) {
    throw new Error(`Collection executor exceeds ${MAX_EXECUTOR_CHARACTERS} characters.`);
  }
  const names = inputNames(inputSchema);
  const scope = normalizedScope(executor.scope);
  if (executor.startUrl != null) {
    if (typeof executor.startUrl !== 'string' || executor.startUrl.length > 1_000) {
      throw new Error('Collection startUrl must be a URL of at most 1,000 characters.');
    }
    urlWithinScope(executor.startUrl, scope, 'Collection startUrl');
  }
  if (!isRecord(executor.item)
    || typeof executor.item.urlContains !== 'string'
    || !executor.item.urlContains.trim()
    || executor.item.urlContains.length > 300) {
    throw new Error('Collection item.urlContains must contain 1–300 characters.');
  }
  assertInteger(executor.item.minTextLength ?? 1, 0, 2_000, 'Collection item.minTextLength');

  if (!Array.isArray(executor.fields) || executor.fields.length < 1 || executor.fields.length > 24) {
    throw new Error('Collection fields must contain 1–24 definitions.');
  }
  const fields = new Set();
  executor.fields.forEach((field, index) => {
    if (!isRecord(field) || !FIELD_NAME.test(field.name || '') || fields.has(field.name)) {
      throw new Error(`Collection field ${index + 1} needs a unique lowercase name.`);
    }
    if (!['text', 'url'].includes(field.source)) throw new Error(`Collection field ${field.name} has an unsupported source.`);
    validateParser(field.parser, names, `Collection field ${field.name}`);
    fields.add(field.name);
  });
  const parsedFields = new Set(fields);

  if (!Array.isArray(executor.computed || []) || (executor.computed || []).length > 10) {
    throw new Error('Collection computed fields may contain at most 10 definitions.');
  }
  for (const computed of executor.computed || []) {
    if (!isRecord(computed) || !FIELD_NAME.test(computed.name || '') || fields.has(computed.name)) {
      throw new Error('Each computed field needs a unique lowercase name.');
    }
    if (computed.operator !== 'sum' || !Array.isArray(computed.fields) || computed.fields.length < 1 || computed.fields.length > 10) {
      throw new Error(`Computed field ${computed.name} must sum 1–10 fields.`);
    }
    for (const field of computed.fields) {
      if (!fields.has(field)) throw new Error(`Computed field ${computed.name} references unknown field ${field}.`);
    }
    fields.add(computed.name);
  }

  if (!Array.isArray(executor.filters || []) || (executor.filters || []).length > 20) {
    throw new Error('Collection filters may contain at most 20 definitions.');
  }
  for (const filter of executor.filters || []) {
    if (!isRecord(filter) || (!fields.has(filter.field) && !['$text', '$url'].includes(filter.field))) {
      throw new Error(`Collection filter references unknown field ${filter?.field || '(missing)'}.`);
    }
    if (!FILTER_OPERATORS.has(filter.operator)) throw new Error(`Collection filter ${filter.field} has an unsupported operator.`);
    if (filter.operator !== 'exists') validateOperand(filter.value, names, `Collection filter ${filter.field}`);
  }

  if (!Array.isArray(executor.sort || []) || (executor.sort || []).length > 4) {
    throw new Error('Collection sort may contain at most four definitions.');
  }
  for (const item of executor.sort || []) {
    if (!isRecord(item) || !fields.has(item.field) || !['asc', 'desc'].includes(item.direction)) {
      throw new Error('Collection sort references an unknown field or direction.');
    }
  }

  if (!isRecord(executor.limit)) throw new Error('Collection limit is required.');
  if (executor.limit.input != null) assertKnownInput(executor.limit.input, names, 'Collection limit');
  assertInteger(executor.limit.default ?? 50, 1, 100, 'Collection limit.default');
  assertInteger(executor.limit.maximum ?? 100, 1, 100, 'Collection limit.maximum');
  if ((executor.limit.default ?? 50) > (executor.limit.maximum ?? 100)) {
    throw new Error('Collection limit.default cannot exceed limit.maximum.');
  }
  assertInteger(executor.maxItems ?? 500, 1, 500, 'Collection maxItems');

  if (executor.pagination != null) {
    const pagination = executor.pagination;
    if (!isRecord(pagination) || pagination.type !== 'page-template') {
      throw new Error('Collection pagination must use page-template.');
    }
    const template = String(pagination.urlTemplate || '');
    if ((template.match(/\{\{page\}\}/g) || []).length !== 1 || template.length > 1_000) {
      throw new Error('Collection pagination urlTemplate must contain exactly one {{page}} placeholder.');
    }
    assertInteger(pagination.startPage, 1, 10_000, 'Collection pagination.startPage');
    assertInteger(pagination.maxPages, 1, 20, 'Collection pagination.maxPages');
    urlWithinScope(
      template.replace('{{page}}', String(pagination.startPage)),
      scope,
      'Collection pagination',
    );
    if (pagination.stopWhen != null) {
      const stop = pagination.stopWhen;
      if (!isRecord(stop)
        || stop.type !== 'page-minimum-exceeds-ranked'
        || !parsedFields.has(stop.sourceField)
        || !fields.has(stop.resultField)) {
        throw new Error('Collection pagination stopWhen must compare a parsed source field with a ranked result field.');
      }
      assertInteger(stop.rank, 1, 100, 'Collection pagination stopWhen.rank');
      if (stop.rank < (executor.limit.maximum ?? 100)) {
        throw new Error('Collection pagination stopWhen.rank must cover the maximum result limit.');
      }
      const primarySort = executor.sort?.[0];
      if (primarySort?.field !== stop.resultField || primarySort.direction !== 'asc') {
        throw new Error('Collection pagination stopWhen requires its result field to be the primary ascending sort.');
      }
      const source = executor.fields.find((field) => field.name === stop.sourceField);
      const numericParsers = new Set(['currency', 'currency-before', 'number-before', 'number-after']);
      const computedResult = (executor.computed || []).find((field) => field.name === stop.resultField);
      const nonNegativeAddition = (fieldName) => {
        const field = executor.fields.find((candidate) => candidate.name === fieldName);
        return field
          && ['currency', 'currency-before'].includes(field.parser.type)
          && (!Object.hasOwn(field.parser, 'default')
            || typeof field.parser.default !== 'number'
            || field.parser.default >= 0);
      };
      const safeLowerBound = numericParsers.has(source.parser.type)
        && (stop.resultField === stop.sourceField
          || (computedResult?.operator === 'sum'
            && computedResult.fields.includes(stop.sourceField)
            && computedResult.fields.every((field) => field === stop.sourceField || nonNegativeAddition(field))));
      if (!safeLowerBound) {
        throw new Error('Collection pagination stopWhen must use a numeric source that lower-bounds the ranked result.');
      }
    }
  }
  return executor;
}

function normalizedText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localizedNumber(value) {
  const compact = String(value).replace(/\s+/g, '');
  if (!compact) return null;
  const separators = [...compact.matchAll(/[.,]/g)].map((match) => match.index);
  if (!separators.length) {
    const parsed = Number(compact);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const last = separators.at(-1);
  const decimalDigits = compact.length - last - 1;
  const isThousands = decimalDigits === 3 && separators.every((position, index) => (
    index === separators.length - 1 || separators[index + 1] - position === 4
  ));
  const normalized = isThousands
    ? compact.replace(/[.,]/g, '')
    : `${compact.slice(0, last).replace(/[.,]/g, '')}.${compact.slice(last + 1)}`;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsedField(field, raw, input) {
  const parser = field.parser;
  let value = null;
  if (parser.type === 'identity') value = String(raw).replace(/\s+/g, ' ').trim().slice(0, 2_000);
  if (parser.type === 'currency') {
    const matches = [...String(raw).matchAll(/\$\s*([0-9](?:[0-9.,]|\s(?=\d))*)/g)];
    value = localizedNumber(matches[parser.occurrence ?? 0]?.[1]);
  }
  if (parser.type === 'currency-before') {
    const marker = String(parser.marker).toLowerCase();
    const match = [...String(raw).matchAll(/\$\s*([0-9](?:[0-9.,]|\s(?=\d))*)/g)].find((candidate) => {
      const suffix = String(raw).slice(candidate.index + candidate[0].length).trimStart().toLowerCase();
      return suffix.startsWith(marker) && !/[a-z0-9_]/i.test(suffix.charAt(marker.length));
    });
    value = localizedNumber(match?.[1]);
  }
  if (parser.type === 'number-before') {
    const match = String(raw).match(new RegExp(`(-?\\d[\\d.,]*)\\s*${escapedRegExp(parser.marker)}`, 'i'));
    value = localizedNumber(match?.[1]);
  }
  if (parser.type === 'number-after') {
    const match = String(raw).match(new RegExp(`${escapedRegExp(parser.marker)}\\s*(-?\\d[\\d.,]*)`, 'i'));
    value = localizedNumber(match?.[1]);
  }
  if (parser.type === 'matched-input') {
    const supplied = Object.hasOwn(input, parser.input) ? input[parser.input] : undefined;
    const candidates = Array.isArray(supplied) ? supplied : [supplied];
    const haystack = normalizedText(raw);
    value = candidates.find((candidate) => candidate != null && haystack.includes(normalizedText(candidate))) ?? null;
  }
  if ((value == null || value === '') && Object.hasOwn(parser, 'default')) return parser.default;
  return value;
}

function operandValue(operand, input) {
  return Object.hasOwn(operand, 'input')
    ? (Object.hasOwn(input, operand.input) ? input[operand.input] : undefined)
    : operand.value;
}

function comparable(value) {
  return typeof value === 'string' ? normalizedText(value) : value;
}

function passesFilter(record, filter, input) {
  const actual = record[filter.field];
  if (filter.operator === 'exists') return actual !== null && actual !== undefined && actual !== '';
  const expected = operandValue(filter.value, input);
  if (filter.operator === 'eq') return comparable(actual) === comparable(expected);
  if (filter.operator === 'gte') return Number.isFinite(actual) && actual >= expected;
  if (filter.operator === 'lte') return Number.isFinite(actual) && actual <= expected;
  if (filter.operator === 'contains') return normalizedText(actual).includes(normalizedText(expected));
  if (filter.operator === 'contains-any') {
    const candidates = Array.isArray(expected) ? expected : [expected];
    const text = normalizedText(actual);
    return candidates.some((candidate) => candidate != null && text.includes(normalizedText(candidate)));
  }
  return false;
}

function compareValues(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

function recordFromLink(link, executor, input) {
  const record = { $text: link.name, $url: link.url };
  for (const field of executor.fields) {
    const raw = field.source === 'url' ? link.url : link.name;
    const value = parsedField(field, raw, input);
    if (field.required && (value == null || value === '')) return null;
    record[field.name] = value;
  }
  for (const computed of executor.computed || []) {
    const values = computed.fields.map((field) => record[field]);
    record[computed.name] = values.every(Number.isFinite)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }
  return record;
}

function rankedRecords(links, executor, input) {
  const records = [];
  for (const link of links) {
    const record = recordFromLink(link, executor, input);
    if (record && (executor.filters || []).every((filter) => passesFilter(record, filter, input))) records.push(record);
  }
  records.sort((left, right) => {
    for (const order of executor.sort || []) {
      const compared = compareValues(left[order.field], right[order.field]);
      if (compared) return order.direction === 'asc' ? compared : -compared;
    }
    return String(left.$url).localeCompare(String(right.$url));
  });
  return records;
}

function minimumSourceValue(links, executor, input, fieldName) {
  const field = executor.fields.find((candidate) => candidate.name === fieldName);
  const values = links.map((link) => parsedField(field, field.source === 'url' ? link.url : link.name, input))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function pageUrl(executor, page) {
  const scope = normalizedScope(executor.scope);
  return urlWithinScope(
    executor.pagination.urlTemplate.replace('{{page}}', String(page)),
    scope,
    'Collection pagination',
  ).href;
}

export async function runMcpCollection({ executor, inputSchema, input = {}, availableTools, callTool, resultText }) {
  validateCollectionExecutor(executor, { inputSchema });
  if (typeof callTool !== 'function' || typeof resultText !== 'function') {
    throw new Error('Collection execution requires a tool client and result formatter.');
  }
  const available = availableTools instanceof Set
    ? availableTools
    : new Set((availableTools || []).map((tool) => typeof tool === 'string' ? tool : tool?.name).filter(Boolean));
  if (!executor.startUrl && !available.has('browser_snapshot')) {
    throw new Error('Connected MCP server does not expose browser_snapshot.');
  }
  if ((executor.startUrl || executor.pagination) && !available.has('browser_navigate')) {
    throw new Error('Connected MCP server does not expose browser_navigate.');
  }

  const candidates = new Map();
  const itemLinks = (snapshot) => extractSnapshotLinks(snapshot, executor.scope.origin)
    .filter((link) => link.url.includes(executor.item.urlContains)
      && link.name.length >= (executor.item.minTextLength ?? 1));
  const addLinks = (links) => {
    for (const link of links) {
      const previous = candidates.get(link.url);
      if (!previous || link.name.length > previous.name.length) candidates.set(link.url, link);
      if (candidates.size >= (executor.maxItems ?? 500)) return true;
    }
    return false;
  };
  const initialSnapshot = String(resultText(executor.startUrl
    ? await callTool('browser_navigate', { url: urlWithinScope(executor.startUrl, normalizedScope(executor.scope), 'Collection startUrl').href })
    : await callTool('browser_snapshot', {})));
  const initialLinks = itemLinks(initialSnapshot);
  let reachedItemLimit = addLinks(initialLinks);
  let pagesScanned = 1;
  let complete = !executor.pagination;
  let terminationReason = executor.pagination ? 'maximum page limit reached' : 'single page collection';
  let sourceMonotonic = true;
  let previousPageMinimum = executor.pagination?.stopWhen
    ? minimumSourceValue(initialLinks, executor, input, executor.pagination.stopWhen.sourceField)
    : null;
  if (executor.pagination) {
    for (let offset = 0; offset < executor.pagination.maxPages - 1; offset += 1) {
      if (reachedItemLimit) break;
      const page = executor.pagination.startPage + offset;
      const navigation = await callTool('browser_navigate', { url: pageUrl(executor, page) });
      const snapshot = String(resultText(navigation));
      pagesScanned += 1;
      const links = itemLinks(snapshot);
      if (!links.length) {
        complete = true;
        terminationReason = 'page contained no new collection items';
        break;
      }
      reachedItemLimit = addLinks(links);
      const stop = executor.pagination.stopWhen;
      if (stop) {
        const pageMinimum = minimumSourceValue(links, executor, input, stop.sourceField);
        if (Number.isFinite(pageMinimum) && Number.isFinite(previousPageMinimum) && pageMinimum < previousPageMinimum) {
          sourceMonotonic = false;
        }
        if (Number.isFinite(pageMinimum)) previousPageMinimum = pageMinimum;
        const ranked = rankedRecords(candidates.values(), executor, input);
        const threshold = ranked[stop.rank - 1]?.[stop.resultField];
        if (sourceMonotonic && Number.isFinite(pageMinimum) && Number.isFinite(threshold) && pageMinimum > threshold) {
          complete = true;
          terminationReason = `page minimum ${stop.sourceField} exceeded ranked ${stop.resultField} at rank ${stop.rank}`;
          break;
        }
      }
    }
  }
  if (reachedItemLimit) {
    complete = false;
    terminationReason = 'maximum item limit reached';
  }

  const records = rankedRecords(candidates.values(), executor, input);
  const requestedLimit = executor.limit.input == null || !Object.hasOwn(input, executor.limit.input)
    ? undefined
    : input[executor.limit.input];
  const limit = Math.min(
    Number.isInteger(requestedLimit) ? requestedLimit : (executor.limit.default ?? 50),
    executor.limit.maximum ?? 100,
  );
  const results = records.slice(0, limit).map((record) => Object.fromEntries(
    Object.entries(record).filter(([name]) => !name.startsWith('$')),
  ));
  if (JSON.stringify(results).length > MAX_RESULT_CHARACTERS) {
    throw new Error(`Collection result exceeds ${MAX_RESULT_CHARACTERS} characters.`);
  }
  return {
    ok: true,
    pagesScanned,
    recordsScanned: candidates.size,
    matchedRecords: records.length,
    complete,
    terminationReason,
    results,
  };
}
