const MAX_CAPABILITIES = 12;
const MAX_ACCESSIBILITY_SNAPSHOT_CHARACTERS = 250_000;
const MAX_ACCESSIBILITY_SNAPSHOT_CONTROLS = 2_000;
const GOAL_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'page', 'site', 'that', 'the', 'this', 'to', 'use', 'using', 'website', 'with',
]);

const ENTITY_MAP = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&#39;', "'"],
  ['&nbsp;', ' '],
]);

export function decodeEntities(value = '') {
  return String(value)
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (match) => ENTITY_MAP.get(match.toLowerCase()) ?? match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function stripTags(value = '') {
  return decodeEntities(
    String(value)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAttributes(source = '') {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source))) {
    const key = match[1].toLowerCase();
    if (key.startsWith('<') || key === '/') continue;
    attributes[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

export function slugifyToolName(value, fallback = 'use_site_action') {
  const normalized = String(value || fallback)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  const startsWithLetter = /^[a-z]/.test(normalized) ? normalized : `tool_${normalized}`;
  return (startsWithLetter || fallback).slice(0, 64);
}

function singularize(value) {
  if (value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.endsWith('ses')) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function relevanceToken(value) {
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function relevanceTokens(value) {
  const normalized = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return new Set(
    (normalized.match(/[a-z0-9]+/g) || [])
      .filter((token) => token.length >= 2 && !/^\d+$/.test(token))
      .map(relevanceToken)
      .filter((token) => !GOAL_STOP_WORDS.has(token)),
  );
}

function capabilityRelevanceTokens(capability) {
  const evidence = (capability.evidence || []).flatMap((item) => [item.label, item.item, item.itemId]);
  const fields = Object.entries(capability.inputSchema?.properties || {}).flatMap(
    ([name, property]) => [name, property?.description],
  );
  return relevanceTokens([capability.name, capability.title, ...evidence, ...fields].filter(Boolean).join(' '));
}

function cappedCapabilities(discovered, goal) {
  const goalTokens = relevanceTokens(goal);
  const ranked = discovered.map((capability, index) => ({
    index,
    score: [...capabilityRelevanceTokens(capability)].filter((token) => goalTokens.has(token)).length,
  }));
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selectedIndexes = new Set(ranked.slice(0, MAX_CAPABILITIES).map((item) => item.index));
  const capabilities = discovered.filter((_, index) => selectedIndexes.has(index));
  const omitted = discovered.length - capabilities.length;
  const warning = omitted < 1
    ? ''
    : goalTokens.size
      ? `Found ${discovered.length} candidate workflows. Returned ${MAX_CAPABILITIES} using goal-token relevance and omitted ${omitted}; ties preserve document order.`
      : `Found ${discovered.length} candidate workflows. Returned the first ${MAX_CAPABILITIES} in document order and omitted ${omitted} because no meaningful goal terms were provided.`;
  return { capabilities, discoveredCount: discovered.length, omittedCount: omitted, warning };
}

function createNameRegistry() {
  return { used: new Set(), nextSuffix: new Map() };
}

function uniqueName(base, registry) {
  const normalized = slugifyToolName(base);
  if (!registry.used.has(normalized)) {
    registry.used.add(normalized);
    return normalized;
  }

  const root = normalized.slice(0, 60);
  let index = registry.nextSuffix.get(root) ?? 2;
  let candidate = `${root}_${index}`;
  while (registry.used.has(candidate)) candidate = `${root}_${++index}`;
  registry.nextSuffix.set(root, index + 1);
  registry.used.add(candidate);
  return candidate;
}

function cssEscapeAttribute(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function selectorFor(attrs, tag, index) {
  if (attrs.id) return `#${attrs.id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')}`;
  if (attrs['data-action']) return `[data-action="${cssEscapeAttribute(attrs['data-action'])}"]`;
  if (attrs.name) return `${tag}[name="${cssEscapeAttribute(attrs.name)}"]`;
  if (attrs['aria-label']) return `${tag}[aria-label="${cssEscapeAttribute(attrs['aria-label'])}"]`;
  return `${tag}:nth-of-type(${index + 1})`;
}

function labelMapFromHtml(html) {
  const labels = new Map();
  const pattern = /<label\b([^>]*)>([\s\S]*?)<\/label>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (attrs.for) labels.set(attrs.for, stripTags(match[2]));
  }
  return labels;
}

function schemaForControl(tag, attrs, inner, labels, index) {
  const type = (attrs.type || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
  if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) return null;
  if (attrs.disabled !== undefined) return null;

  const rawName = attrs.name || attrs.id || attrs['aria-label'] || attrs.placeholder || `field_${index + 1}`;
  const name = slugifyToolName(rawName, `field_${index + 1}`);
  const label = labels.get(attrs.id) || attrs['aria-label'] || attrs.placeholder || rawName.replace(/[_-]+/g, ' ');
  const property = { description: 'Value for this form field.' };

  if (type === 'number' || type === 'range') {
    property.type = 'number';
    if (attrs.min !== undefined && attrs.min !== '') property.minimum = Number(attrs.min);
    if (attrs.max !== undefined && attrs.max !== '') property.maximum = Number(attrs.max);
  } else if (type === 'checkbox') {
    property.type = 'boolean';
  } else {
    property.type = 'string';
    if (type === 'date') property.format = 'date';
    if (type === 'email') property.format = 'email';
    if (tag === 'select') {
      const values = [...inner.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
        .map((option) => parseAttributes(option[1]).value || stripTags(option[2]))
        .filter(Boolean)
        .slice(0, 30);
      if (values.length) property.enum = values;
    }
  }

  return {
    name,
    sourceName: attrs.name || attrs.id || name,
    label,
    selector: selectorFor(attrs, tag, index),
    required: attrs.required !== undefined,
    controlType: tag === 'select' ? 'select' : type,
    property,
  };
}

function extractFormControls(body) {
  const labels = labelMapFromHtml(body);
  const controls = [];
  let index = 0;

  // Inputs are void elements. Parsing them separately prevents the first input
  // from consuming the rest of a form while looking for an optional closing tag.
  for (const match of body.matchAll(/<input\b([^>]*)>/gi)) {
    const control = schemaForControl('input', parseAttributes(match[1]), '', labels, index++);
    if (control && !controls.some((existing) => existing.name === control.name)) controls.push(control);
  }

  for (const match of body.matchAll(/<(textarea|select)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const control = schemaForControl(match[1].toLowerCase(), parseAttributes(match[2]), match[3] || '', labels, index++);
    if (control && !controls.some((existing) => existing.name === control.name)) controls.push(control);
  }

  return controls;
}

function textFromButtonHtml(body) {
  const button = body.match(/<button\b[^>]*>([\s\S]*?)<\/button>/i);
  if (button) return stripTags(button[1]);
  const submit = body.match(/<input\b[^>]*type\s*=\s*["']?submit["']?[^>]*>/i);
  return submit ? parseAttributes(submit[0]).value || 'Submit' : '';
}

function inferRisk(label, method = '') {
  const consequential = /\b(pay(?: now)?|purchase|buy(?: now)?|delete|remove account|send|publish|book|reserve|check ?out|(?:place|submit|complete|confirm)(?: (?:the|your))? (?:order|purchase)|transfer)\b/i;
  if (consequential.test(label)) return 'consequential';
  const readPattern = /\b(search|find|filter|show|view|preview|inspect|lookup|check|calculate|compare|list|get)\b/i;
  if (readPattern.test(label) || String(method).toLowerCase() === 'get') return 'read';
  return 'write';
}

function sampleForProperty(property) {
  if (property.enum?.length) return property.enum[0];
  if (property.type === 'boolean') return true;
  if (property.type === 'number') return property.minimum ?? 1;
  if (property.format === 'date') return '2026-09-03';
  if (property.format === 'email') return 'agent@example.com';
  return 'example';
}

function sampleArgsFromSchema(schema) {
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([name, property]) => [name, sampleForProperty(property)]));
}

function formCapability({ attrs, body, index, usedNames }) {
  const controls = extractFormControls(body);
  if (!controls.length) return null;
  const submitLabel = textFromButtonHtml(body);
  const title = attrs['aria-label'] || submitLabel || attrs.name || attrs.id || `Submit form ${index + 1}`;
  const baseName = slugifyToolName(title);
  const name = uniqueName(baseName.startsWith('search_') || baseName.startsWith('find_') ? baseName : baseName, usedNames);
  const risk = inferRisk(title, attrs.method);
  const properties = Object.fromEntries(controls.map((control) => [control.name, control.property]));
  const required = controls.filter((control) => control.required).map((control) => control.name);
  const formSelector = selectorFor(attrs, 'form', index);
  const submitButton = body.match(/<button\b([^>]*)>([\s\S]*?)<\/button>/i);
  const submitInputs = [...body.matchAll(/<input\b([^>]*)>/gi)]
    .map((match, inputIndex) => ({ attrs: parseAttributes(match[1]), inputIndex }));
  const submitInput = submitInputs.find(({ attrs: inputAttrs }) => ['submit', 'image'].includes(String(inputAttrs.type || '').toLowerCase()));
  const submitSelector = submitButton
    ? selectorFor(parseAttributes(submitButton[1]), 'button', 0)
    : submitInput ? selectorFor(submitInput.attrs, 'input', submitInput.inputIndex) : null;
  const inputSchema = {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };

  return {
    id: `form_${index + 1}_${name}`,
    kind: 'form',
    name,
    title,
    description: risk === 'read'
      ? 'Use this form workflow on the current page and return the resulting visible state.'
      : 'Submit this reviewed form workflow on the current page and return the resulting visible state.',
    risk,
    inputSchema,
    sampleArgs: sampleArgsFromSchema(inputSchema),
    evidence: [
      { type: 'form', selector: formSelector, label: title },
      ...controls.map((control) => ({ type: 'field', selector: `${formSelector} ${control.selector}`, label: control.label })),
    ],
    executor: {
      type: 'dom-form',
      formSelector,
      fields: controls.map(({ name: fieldName, selector, controlType }) => ({ name: fieldName, selector, controlType })),
      submitSelector,
      resultSelector: '[aria-live], [role="status"], main',
    },
  };
}

function buttonCapabilities(html, formRanges, usedNames) {
  const groups = new Map();
  const pattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let match;
  let index = 0;
  let formRangeIndex = 0;
  while ((match = pattern.exec(html))) {
    while (formRanges[formRangeIndex]?.[1] <= match.index) formRangeIndex += 1;
    const formRange = formRanges[formRangeIndex];
    const insideForm = Boolean(formRange && match.index >= formRange[0] && match.index < formRange[1]);
    if (insideForm) continue;
    const attrs = parseAttributes(match[1]);
    const label = attrs['aria-label'] || stripTags(match[2]);
    if (!label || attrs.disabled !== undefined) continue;
    const groupKey = attrs['data-action'] || label.toLowerCase();
    const item = {
      attrs,
      label,
      selector: selectorFor(attrs, 'button', index++),
      itemId: attrs['data-entity-id'] || attrs['data-id'] || attrs.value || null,
    };
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }

  const capabilities = [];
  for (const items of groups.values()) {
    const first = items[0];
    const risk = inferRisk(first.label);
    let base = slugifyToolName(first.label);
    const properties = {};
    const required = [];
    let executor;

    if (items.length > 1 && items.some((item) => item.itemId)) {
      const entity = first.attrs['data-entity'] || first.attrs['data-action']?.split('-')[0] || 'item';
      if (!base.includes(singularize(entity))) base = `${base}_${singularize(slugifyToolName(entity))}`;
      const ids = items.map((item) => item.itemId).filter(Boolean);
      properties.item_id = {
        type: 'string',
        description: 'Identifier of the visible item to act on.',
        ...(ids.length <= 30 ? { enum: ids } : {}),
      };
      required.push('item_id');
      executor = {
        type: 'dom-action-group',
        selector: first.attrs['data-action']
          ? `[data-action="${cssEscapeAttribute(first.attrs['data-action'])}"]`
          : first.selector,
        itemAttribute: first.attrs['data-entity-id'] !== undefined ? 'data-entity-id' : first.attrs['data-id'] !== undefined ? 'data-id' : 'value',
        statusSelector: '[aria-live], [role="status"]',
      };
    } else {
      executor = { type: 'dom-button', selector: first.selector, statusSelector: '[aria-live], [role="status"]' };
    }

    const name = uniqueName(base, usedNames);
    const inputSchema = {
      type: 'object',
      properties,
      additionalProperties: false,
      ...(required.length ? { required } : {}),
    };
    capabilities.push({
      id: `button_${capabilities.length + 1}_${name}`,
      kind: 'action',
      name,
      title: first.label,
      description: risk === 'read'
        ? 'Run this page action and return the resulting visible state.'
        : 'Run this reviewed page action and return the resulting visible state.',
      risk,
      inputSchema,
      sampleArgs: sampleArgsFromSchema(inputSchema),
      evidence: items.slice(0, 5).map((item) => ({ type: 'button', selector: item.selector, label: item.label, itemId: item.itemId })),
      executor,
    });
  }
  return capabilities;
}

function titleFromHtml(html, url) {
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return stripTags(title[1]);
  try {
    return new URL(url).hostname;
  } catch {
    return 'Untitled site';
  }
}

export function analyzeHtml({ html, url = '', goal = '' }) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('HTML input is empty.');
  // Script and template source frequently contains HTML-looking strings. They
  // are implementation text, not live controls, so exclude them from the scan.
  const scannedHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  const usedNames = createNameRegistry();
  const capabilities = [];
  const formRanges = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch;
  let formIndex = 0;
  while ((formMatch = formPattern.exec(scannedHtml))) {
    formRanges.push([formMatch.index, formPattern.lastIndex]);
    const capability = formCapability({
      attrs: parseAttributes(formMatch[1]),
      body: formMatch[2],
      index: formIndex++,
      usedNames,
    });
    if (capability) capabilities.push(capability);
  }
  capabilities.push(...buttonCapabilities(scannedHtml, formRanges, usedNames));
  const selected = cappedCapabilities(capabilities, goal);

  const linkCount = (scannedHtml.match(/<a\b/gi) || []).length;
  const buttonCount = (scannedHtml.match(/<button\b/gi) || []).length;
  const inputCount = (scannedHtml.match(/<(input|select|textarea)\b/gi) || []).length;

  return {
    source: { kind: 'html', url, title: titleFromHtml(html, url) },
    goal,
    summary: {
      forms: formRanges.length,
      buttons: buttonCount,
      inputs: inputCount,
      links: linkCount,
      candidates: selected.capabilities.length,
      discoveredCandidates: selected.discoveredCount,
      omittedCandidates: selected.omittedCount,
    },
    capabilities: selected.capabilities,
    warnings: selected.capabilities.length
      ? [selected.warning].filter(Boolean)
      : ['No stable form or button workflows were found in the server-rendered HTML. Use Browser MCP mode for client-rendered sites.'],
  };
}

function extractSnapshotControls(snapshot) {
  const controls = [];
  const contextNodes = [];
  const lines = String(snapshot).split(/\r?\n/);
  const rolePattern = /^\s*-\s+'?(button|textbox|searchbox|combobox|checkbox|radio|link|spinbutton|slider)\s+(?:"([^"]*)")?[^\n]*?\[ref=([^\]]+)\]/i;
  lines.forEach((line, index) => {
    const match = line.match(rolePattern);
    const contextMatch = line.match(/^\s*-\s+'?(heading|img)\s+"([^"]+)"[^\n]*?(?:\[ref=([^\]]+)\])?/i);
    const indent = line.match(/^\s*/)?.[0].replace(/\t/g, '  ').length || 0;
    if (match) {
      if (controls.length >= MAX_ACCESSIBILITY_SNAPSHOT_CONTROLS) {
        throw new Error(`Accessibility snapshot exceeds ${MAX_ACCESSIBILITY_SNAPSHOT_CONTROLS} controls.`);
      }
      const control = {
        role: match[1].toLowerCase(),
        name: match[2] || match[1],
        ref: match[3],
        line: index,
        indent,
        raw: line.trim(),
      };
      controls.push(control);
      if (control.role === 'link' && match[2]) contextNodes.push(control);
    }
    if (!contextMatch) return;
    contextNodes.push({
      role: contextMatch[1].toLowerCase(),
      name: contextMatch[2],
      ref: contextMatch[3] || '',
      line: index,
      indent,
      raw: line.trim(),
    });
  });
  for (const control of controls.filter((item) => item.role === 'combobox')) {
    const options = [];
    let selected = '';
    for (let index = control.line + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      const indent = line.match(/^\s*/)?.[0].replace(/\t/g, '  ').length || 0;
      if (indent <= control.indent) break;
      const match = line.match(/^\s*-\s+'?option\s+"([^"]+)"([^\n]*)/i);
      if (!match) continue;
      options.push(match[1]);
      if (/\[selected\]/i.test(match[2])) selected = match[1];
    }
    control.options = [...new Set(options)];
    control.selectedOption = selected;
  }
  return { controls, contextNodes, lines };
}

function inputPropertyFromRole(control) {
  if (control.role === 'checkbox' || control.role === 'radio') return { type: 'boolean', description: 'Whether to select this control.' };
  if (control.role === 'spinbutton' || control.role === 'slider') return { type: 'number', description: 'Numeric value for this control.' };
  const property = { type: 'string', description: 'Text value for this control.' };
  if (control.role === 'combobox' && control.options?.length) {
    const ordered = control.selectedOption
      ? [control.selectedOption, ...control.options.filter((option) => option !== control.selectedOption)]
      : control.options;
    property.enum = ordered.slice(0, 60);
  }
  return property;
}

export function analyzeAccessibilitySnapshot({ snapshot, url = '', goal = '' }) {
  const snapshotText = String(snapshot);
  if (snapshotText.length > MAX_ACCESSIBILITY_SNAPSHOT_CHARACTERS) {
    throw new Error(`Accessibility snapshot exceeds ${MAX_ACCESSIBILITY_SNAPSHOT_CHARACTERS} characters.`);
  }
  const { controls, contextNodes } = extractSnapshotControls(snapshotText);
  const usedNames = createNameRegistry();
  const capabilities = [];
  const consumed = new Set();
  const inputRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
  const formButtonPattern = /\b(search|find|filter|apply|submit|go|continue|check|compare|log\s*in|sign\s*in|subscribe)\b/i;

  let precedingButton = null;
  let inputsSinceButton = [];
  for (const control of controls) {
    if (control.role !== 'button') {
      if (inputRoles.has(control.role)) inputsSinceButton.push(control);
      continue;
    }
    const button = control;
    if (!formButtonPattern.test(button.name)) {
      precedingButton = button;
      inputsSinceButton = [];
      continue;
    }
    let inputs = inputsSinceButton.filter((input) => !consumed.has(input.ref));
    const sameLevelInputs = inputs.filter((control) => control.indent === button.indent);
    if (precedingButton && sameLevelInputs.length) inputs = sameLevelInputs;
    inputs = inputs.slice(-8);
    precedingButton = button;
    inputsSinceButton = [];
    if (!inputs.length) continue;
    inputs.forEach((input) => consumed.add(input.ref));
    consumed.add(button.ref);
    const name = uniqueName(button.name, usedNames);
    const properties = {};
    const fields = [];
    const fieldNames = createNameRegistry();
    for (const input of inputs) {
      const rawFieldName = input.role === 'combobox' && (/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(input.name) || input.name === 'combobox')
        ? 'selection'
        : input.name;
      const fieldName = uniqueName(slugifyToolName(rawFieldName, `field_${fields.length + 1}`), fieldNames);
      properties[fieldName] = inputPropertyFromRole(input);
      fields.push({ name: fieldName, role: input.role, target: input.ref, label: input.name });
    }
    const inputSchema = { type: 'object', properties, required: fields.map((field) => field.name), additionalProperties: false };
    const steps = fields.map((field) =>
      field.role === 'combobox'
        ? { tool: 'browser_select_option', arguments: { element: field.label, ref: field.target, values: [`{{${field.name}}}`] } }
        : { tool: 'browser_type', arguments: { element: field.label, ref: field.target, text: `{{${field.name}}}` } },
    );
    steps.push(
      { tool: 'browser_click', arguments: { element: button.name, ref: button.ref } },
      { tool: 'browser_snapshot', arguments: {} },
    );
    capabilities.push({
      id: `mcp_form_${capabilities.length + 1}_${name}`,
      kind: 'form',
      name,
      title: button.name,
      description: 'Use this reviewed form workflow through the connected browser MCP session and return the resulting page snapshot.',
      risk: inferRisk(button.name),
      inputSchema,
      sampleArgs: sampleArgsFromSchema(inputSchema),
      evidence: [...fields.map((field) => ({ type: field.role, ref: field.target, label: field.label })), { type: 'button', ref: button.ref, label: button.name }],
      executor: { type: 'mcp-recipe', steps },
    });
  }

  const remainingButtons = controls.filter((control) => control.role === 'button' && !consumed.has(control.ref));
  const repeatedButtons = new Map();
  for (const button of remainingButtons) {
    const key = button.name.trim().toLowerCase();
    if (!repeatedButtons.has(key)) repeatedButtons.set(key, []);
    repeatedButtons.get(key).push(button);
  }

  for (const buttons of repeatedButtons.values()) {
    if (buttons.length < 2) continue;
    const caseEntries = new Map();
    const evidence = [];
    buttons.forEach((button, index) => {
      const lowerBound = index ? buttons[index - 1].line : button.line - 40;
      const labels = contextNodes.filter(
        (node) => node.line > lowerBound
          && node.line < button.line
          && node.indent >= button.indent - 2
          && node.name.trim()
          && node.name.toLowerCase() !== button.name.toLowerCase(),
      );
      const label = labels.sort((left, right) => right.name.length - left.name.length || right.line - left.line)[0]?.name;
      if (!label || caseEntries.has(label)) return;
      caseEntries.set(label, button.ref);
      evidence.push({ type: 'button', ref: button.ref, label: button.name, item: label });
    });
    const cases = Object.fromEntries(caseEntries);
    const items = [...caseEntries.keys()];
    if (items.length < 2) continue;

    buttons.forEach((button) => consumed.add(button.ref));
    const first = buttons[0];
    const name = uniqueName(first.name, usedNames);
    const risk = inferRisk(first.name);
    const inputSchema = {
      type: 'object',
      properties: {
        item: {
          type: 'string',
          description: 'Visible item associated with this action.',
          enum: items,
        },
      },
      required: ['item'],
      additionalProperties: false,
    };
    capabilities.push({
      id: `mcp_group_${capabilities.length + 1}_${name}`,
      kind: 'action-group',
      name,
      title: first.name,
      description: risk === 'read'
        ? 'Run this item-scoped action through the connected browser MCP session and return the resulting page snapshot.'
        : 'Run this reviewed item-scoped action through the connected browser MCP session and return the resulting page snapshot.',
      risk,
      inputSchema,
      sampleArgs: sampleArgsFromSchema(inputSchema),
      evidence,
      executor: {
        type: 'mcp-recipe',
        steps: [
          {
            tool: 'browser_click',
            arguments: {
              element: `${first.name} for {{item}}`,
              ref: { $pick: 'item', cases },
            },
          },
          { tool: 'browser_snapshot', arguments: {} },
        ],
      },
    });
  }

  for (const button of controls.filter((control) => control.role === 'button' && !consumed.has(control.ref))) {
    const name = uniqueName(button.name, usedNames);
    const risk = inferRisk(button.name);
    capabilities.push({
      id: `mcp_button_${capabilities.length + 1}_${name}`,
      kind: 'action',
      name,
      title: button.name,
      description: risk === 'read'
        ? 'Run this page action through the connected browser MCP session and return the resulting page snapshot.'
        : 'Run this reviewed page action through the connected browser MCP session and return the resulting page snapshot.',
      risk,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      sampleArgs: {},
      evidence: [{ type: 'button', ref: button.ref, label: button.name }],
      executor: {
        type: 'mcp-recipe',
        steps: [
          { tool: 'browser_click', arguments: { element: button.name, ref: button.ref } },
          { tool: 'browser_snapshot', arguments: {} },
        ],
      },
    });
  }

  const selected = cappedCapabilities(capabilities, goal);
  return {
    source: { kind: 'browser_mcp', url, title: (() => { try { return new URL(url).hostname; } catch { return 'Browser target'; } })() },
    goal,
    summary: {
      controls: controls.length,
      buttons: controls.filter((control) => control.role === 'button').length,
      inputs: controls.filter((control) => inputRoles.has(control.role)).length,
      candidates: selected.capabilities.length,
      discoveredCandidates: selected.discoveredCount,
      omittedCandidates: selected.omittedCount,
    },
    capabilities: selected.capabilities,
    snapshot: snapshotText.slice(0, 40_000),
    warnings: selected.capabilities.length
      ? [selected.warning].filter(Boolean)
      : ['The browser snapshot did not contain recognizable interactive controls.'],
  };
}
