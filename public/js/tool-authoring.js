import { collectionScopeForTarget, validateCollectionExecutor } from './mcp-collection.js';
import { prepareMcpRecipe } from './mcp-recipe.js';

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RISK_SEVERITY = Object.freeze({ read: 0, write: 1, consequential: 2 });
const MAX_DEFINITIONS = 12;
const MAX_AUTHORING_CHARACTERS = 120_000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validateInputSchema(schema, toolName) {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    throw new Error(`Authored tool ${toolName} needs an object input_schema with properties.`);
  }
  if (schema.additionalProperties !== false) {
    throw new Error(`Authored tool ${toolName} must reject undeclared input properties.`);
  }
  if (schema.required != null) {
    if (!Array.isArray(schema.required)
      || schema.required.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties, name))) {
      throw new Error(`Authored tool ${toolName} has invalid required inputs.`);
    }
  }
}

function observedCollectionUrls(capabilities) {
  return new Set(capabilities.flatMap((capability) => (capability.evidence || [])
    .filter((item) => item?.type === 'collection-item' && typeof item.url === 'string')
    .map((item) => item.url)));
}

function executorRiskSeverity(executor) {
  if (executor?.type !== 'mcp-recipe' || !Array.isArray(executor.steps)) return RISK_SEVERITY.read;
  return executor.steps.some((step) => ['browser_type', 'browser_click', 'browser_select_option'].includes(step?.tool))
    ? RISK_SEVERITY.write
    : RISK_SEVERITY.read;
}

function authoredExecutor(definition, capabilities, targetUrl, inputSchema, sampleArgs) {
  const raw = definition.executor;
  if (!isRecord(raw)) throw new Error(`Authored tool ${definition.name} needs an executor.`);
  if (raw.type === 'mcp-recipe') {
    prepareMcpRecipe({ executor: raw, input: sampleArgs });
    return clone(raw);
  }
  if (raw.type === 'mcp-collection') {
    const observedUrls = observedCollectionUrls(capabilities);
    const matchingUrls = [...observedUrls].filter((url) => url.includes(String(raw.item?.urlContains || '')));
    if (!raw.item?.urlContains || matchingUrls.length < 2) {
      throw new Error(`Authored collection ${definition.name} must match at least two observed collection items.`);
    }
    const executor = {
      ...clone(raw),
      scope: collectionScopeForTarget(targetUrl),
      startUrl: new URL(targetUrl).href,
    };
    validateCollectionExecutor(executor, { inputSchema });
    return executor;
  }
  throw new Error(`Authored tool ${definition.name} has an unsupported executor ${raw.type || '(missing)'}.`);
}

export function buildAuthoredToolSpecs({ definitions, capabilities, targetUrl, reservedNames = new Set() }) {
  if (!Array.isArray(definitions) || definitions.length < 1 || definitions.length > MAX_DEFINITIONS) {
    throw new Error(`authored_tools must contain 1–${MAX_DEFINITIONS} tool definitions.`);
  }
  if (JSON.stringify(definitions).length > MAX_AUTHORING_CHARACTERS) {
    throw new Error(`authored_tools exceeds ${MAX_AUTHORING_CHARACTERS} characters.`);
  }
  const byId = new Map((capabilities || []).map((capability) => [capability.id, capability]));
  const reserved = reservedNames instanceof Set ? reservedNames : new Set(reservedNames || []);
  const used = new Set();

  return definitions.map((definition, index) => {
    if (!isRecord(definition)) throw new Error(`Authored tool ${index + 1} must be an object.`);
    if (!TOOL_NAME.test(definition.name || '')) throw new Error(`Invalid authored tool name: ${definition.name || '(missing)'}.`);
    if (used.has(definition.name) || reserved.has(definition.name)) {
      throw new Error(`Authored tool name ${definition.name} is duplicated or reserved.`);
    }
    used.add(definition.name);
    if (typeof definition.description !== 'string'
      || definition.description.trim().length < 8
      || definition.description.length > 600) {
      throw new Error(`Authored tool ${definition.name} needs a description between 8 and 600 characters.`);
    }
    if (!Array.isArray(definition.capability_ids)
      || definition.capability_ids.length < 1
      || definition.capability_ids.length > 12) {
      throw new Error(`Authored tool ${definition.name} must cite 1–12 observed capability IDs.`);
    }
    const selected = definition.capability_ids.map((id) => {
      const capability = byId.get(id);
      if (!capability) throw new Error(`Unknown authored-tool capability: ${id}.`);
      return capability;
    });
    const inferredSeverity = Math.max(
      executorRiskSeverity(definition.executor),
      ...selected.map((capability) => RISK_SEVERITY[capability.risk] ?? 1),
    );
    if (!Object.hasOwn(RISK_SEVERITY, definition.risk)) throw new Error(`Authored tool ${definition.name} has an invalid risk.`);
    if (RISK_SEVERITY[definition.risk] < inferredSeverity) {
      throw new Error(`Authored tool ${definition.name} cannot downgrade the observed capability risk.`);
    }
    validateInputSchema(definition.input_schema, definition.name);
    const sampleArgs = definition.sample_args == null ? {} : definition.sample_args;
    if (!isRecord(sampleArgs)) throw new Error(`Authored tool ${definition.name} sample_args must be an object.`);
    const executor = authoredExecutor(definition, selected, targetUrl, definition.input_schema, sampleArgs);
    const evidence = selected.flatMap((capability) => clone(capability.evidence || [])).slice(0, 60);

    return {
      id: `authored_${index + 1}_${definition.name}`,
      kind: 'agent-authored',
      name: definition.name,
      title: definition.name.replace(/_/g, ' '),
      description: definition.description.trim(),
      risk: definition.risk,
      inputSchema: clone(definition.input_schema),
      sampleArgs: clone(sampleArgs),
      evidence,
      executor,
    };
  });
}
