import { browserMcpSession } from './browser-mcp-session.js';
import { prepareMcpRecipe } from './mcp-recipe.js';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function assertSchemaValue(schema, value, path = 'input') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} must be one of: ${schema.enum.join(', ')}.`);
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) throw new Error(`${path}.${required} is required.`);
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unexpected) throw new Error(`${path}.${unexpected} is not accepted.`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) assertSchemaValue(properties[key], item, `${path}.${key}`);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) throw new Error(`${path} needs at least ${schema.minItems} items.`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) throw new Error(`${path} accepts at most ${schema.maxItems} items.`);
    value.forEach((item, index) => assertSchemaValue(schema.items, item, `${path}[${index}]`));
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string.`);
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) throw new Error(`${path} must contain at least ${schema.minLength} characters.`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) throw new Error(`${path} must contain at most ${schema.maxLength} characters.`);
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern).test(value))) throw new Error(`${path} does not match its required pattern.`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${path} must be a finite number.`);
    if (schema.type === 'integer' && !Number.isInteger(value)) throw new Error(`${path} must be an integer.`);
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw new Error(`${path} must be at least ${schema.minimum}.`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw new Error(`${path} must be at most ${schema.maximum}.`);
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) throw new Error(`${path} must be greater than ${schema.exclusiveMinimum}.`);
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) throw new Error(`${path} must be less than ${schema.exclusiveMaximum}.`);
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('A tool specification is required.');
  if (!TOOL_NAME.test(spec.name || '')) throw new Error(`Invalid WebMCP tool name: ${spec.name || '(missing)'}.`);
  if (typeof spec.description !== 'string' || spec.description.trim().length < 8) throw new Error(`Tool ${spec.name} needs a useful description.`);
  if (!spec.inputSchema || spec.inputSchema.type !== 'object') throw new Error(`Tool ${spec.name} needs an object input schema.`);
}

function changeEvent(detail) {
  return new CustomEvent('registrychange', { detail });
}

/**
 * A dual registry: every tool is callable by the app for deterministic tests,
 * and is also registered with the browser's WebMCP implementation when present.
 */
export class ToolRegistry extends EventTarget {
  constructor(modelContext = document.modelContext) {
    super();
    this.modelContext = modelContext;
    this.entries = new Map();
    this.nativeFailures = [];
  }

  get nativeSupported() {
    return typeof this.modelContext?.registerTool === 'function';
  }

  list() {
    return [...this.entries.values()].map(({ spec, origin, nativeRegistered }) => ({
      ...clone(spec),
      origin,
      nativeRegistered,
    }));
  }

  get(name) {
    const entry = this.entries.get(name);
    return entry ? { ...clone(entry.spec), origin: entry.origin, nativeRegistered: entry.nativeRegistered } : null;
  }

  async register(spec, execute, options = {}) {
    validateSpec(spec);
    if (typeof execute !== 'function') throw new Error(`Tool ${spec.name} needs an executor.`);
    if (this.entries.has(spec.name)) this.unregister(spec.name);

    const controller = new AbortController();
    const origin = options.origin || 'generated';
    const entry = {
      spec: clone(spec),
      execute,
      origin,
      controller,
      nativeRegistered: false,
      nativeError: null,
    };

    const wrappedExecute = async (input = {}, context = {}) => {
      const normalized = input == null ? {} : input;
      assertSchemaValue(spec.inputSchema, normalized);
      return execute(normalized, {
        ...context,
        signal: context?.signal || controller.signal,
      });
    };

    entry.wrappedExecute = wrappedExecute;
    this.entries.set(spec.name, entry);

    if (this.nativeSupported) {
      try {
        await this.modelContext.registerTool({
          name: spec.name,
          description: spec.description,
          inputSchema: clone(spec.inputSchema),
          annotations: {
            readOnlyHint: spec.risk === 'read',
            untrustedContentHint: spec.untrustedContentHint !== false,
            ...(spec.annotations || {}),
          },
          execute: wrappedExecute,
        }, { signal: controller.signal });
        entry.nativeRegistered = true;
      } catch (error) {
        entry.nativeError = error instanceof Error ? error.message : String(error);
        this.nativeFailures.push({ name: spec.name, error: entry.nativeError });
      }
    }

    this.dispatchEvent(changeEvent({ action: 'register', name: spec.name, origin }));
    return this.get(spec.name);
  }

  unregister(name) {
    const entry = this.entries.get(name);
    if (!entry) return false;
    entry.controller.abort();
    this.entries.delete(name);
    this.dispatchEvent(changeEvent({ action: 'unregister', name, origin: entry.origin }));
    return true;
  }

  unregisterOrigin(origin) {
    const names = [...this.entries.entries()]
      .filter(([, entry]) => entry.origin === origin)
      .map(([name]) => name);
    names.forEach((name) => this.unregister(name));
    return names;
  }

  async execute(name, input = {}, context = {}) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`WebMCP tool ${name} is not registered.`);
    return entry.wrappedExecute(input, context);
  }
}

function targetWindowFor(documentTarget) {
  return documentTarget?.defaultView || window;
}

function compactText(root) {
  return String(root?.innerText || root?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}

function stateFromTarget(targetDocument) {
  const targetWindow = targetWindowFor(targetDocument);
  if (typeof targetWindow.demoApp?.getState === 'function') return clone(targetWindow.demoApp.getState());
  return {
    title: targetDocument?.title || '',
    url: targetWindow.location?.href || '',
    visibleState: compactText(targetDocument?.body),
  };
}

function setControlValue(control, value, targetDocument) {
  if (!control) throw new Error('A generated selector did not resolve to a form control.');
  const targetWindow = targetWindowFor(targetDocument);
  const isCheckbox = control.matches?.('input[type="checkbox"], input[type="radio"]');
  if (isCheckbox) {
    control.checked = Boolean(value);
  } else if (control.matches?.('select[multiple]') && Array.isArray(value)) {
    [...control.options].forEach((option) => { option.selected = value.includes(option.value); });
  } else {
    control.value = value == null ? '' : String(value);
  }
  control.dispatchEvent(new targetWindow.Event('input', { bubbles: true }));
  control.dispatchEvent(new targetWindow.Event('change', { bubbles: true }));
}

async function settle(delay = 70) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function resultFor(spec, targetDocument, extra = {}) {
  return {
    ok: true,
    tool: spec.name,
    risk: spec.risk,
    state: stateFromTarget(targetDocument),
    ...extra,
  };
}

function uniqueForm(targetDocument, selector) {
  const forms = [...targetDocument.querySelectorAll(selector)].filter((element) => element.matches?.('form'));
  if (forms.length !== 1) throw new Error(forms.length ? `Form selector is ambiguous: ${selector}` : `Form not found: ${selector}`);
  return forms[0];
}

function uniqueFormControl(targetDocument, form, selector) {
  const controls = [...targetDocument.querySelectorAll(selector)]
    .filter((element) => form.contains?.(element) || element.form === form);
  if (controls.length !== 1) {
    throw new Error(controls.length
      ? `Form control is ambiguous within the resolved form: ${selector}`
      : `Form control not found within the resolved form: ${selector}`);
  }
  return controls[0];
}

async function executeDomSpec(spec, input, context) {
  const targetDocument = context.getTargetDocument?.();
  if (!targetDocument) {
    throw new Error('This DOM adapter has no live same-origin target. Install the exported module in the target site, or use Browser MCP mode.');
  }
  const executor = spec.executor;

  if (executor.type === 'dom-form') {
    const form = uniqueForm(targetDocument, executor.formSelector);
    for (const field of executor.fields || []) {
      if (!Object.hasOwn(input, field.name)) continue;
      const control = uniqueFormControl(targetDocument, form, field.selector);
      setControlValue(control, input[field.name], targetDocument);
    }
    const submit = executor.submitSelector ? uniqueFormControl(targetDocument, form, executor.submitSelector) : null;
    if (submit?.click) submit.click();
    else if (!executor.submitSelector && typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new (targetWindowFor(targetDocument).Event)('submit', { bubbles: true, cancelable: true }));
    await settle(90);
    return resultFor(spec, targetDocument);
  }

  if (executor.type === 'dom-action-group') {
    const candidates = [...targetDocument.querySelectorAll(executor.selector)];
    const target = candidates.find((element) => element.getAttribute(executor.itemAttribute) === String(input.item_id));
    if (!target?.click) throw new Error(`No action target matched item_id=${input.item_id}.`);
    target.click();
    await settle();
    return resultFor(spec, targetDocument, { actedOn: input.item_id });
  }

  if (executor.type === 'dom-button') {
    const button = targetDocument.querySelector(executor.selector);
    if (!button?.click) throw new Error(`Button not found: ${executor.selector}`);
    button.click();
    await settle();
    return resultFor(spec, targetDocument);
  }

  if (executor.type === 'dom-read') {
    const region = targetDocument.querySelector(executor.selector);
    if (!region) throw new Error(`Readable region not found: ${executor.selector}`);
    return resultFor(spec, targetDocument, { visibleState: compactText(region) });
  }

  throw new Error(`Unsupported DOM executor: ${executor.type}`);
}

async function executeMcpSpec(spec, input, context) {
  if (context.browserExecution === 'agent') {
    return {
      execution: 'agent_browser_required',
      completed: false,
      tool: spec.name,
      risk: spec.risk,
      targetUrl: context.targetUrl,
      steps: prepareMcpRecipe({ executor: spec.executor, input }),
      instruction: 'Execute these bounded steps in the same caller-controlled browser session, then inspect the visible result. Re-resolve stale references by exact accessible name.',
    };
  }
  return browserMcpSession.execute({ executor: spec.executor, input, workspaceId: context.workspaceId });
}

export async function executeGeneratedSpec(spec, input, context = {}) {
  if (spec.risk === 'consequential' && context.allowConsequential !== true) {
    throw new Error('Consequential generated tools are disabled in this public compatibility studio. Review and install the export in the owned site.');
  }
  if (spec.executor?.type === 'mcp-recipe') return executeMcpSpec(spec, input, context);
  return executeDomSpec(spec, input, context);
}

export function compactRegistryState(registry) {
  return registry.list().map(({ name, description, risk, origin, nativeRegistered }) => ({
    name,
    description,
    risk,
    origin,
    nativeRegistered,
  }));
}
