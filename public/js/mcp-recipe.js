export const ALLOWED_MCP_TOOLS = Object.freeze([
  'browser_navigate',
  'browser_snapshot',
  'browser_find',
  'browser_type',
  'browser_fill_form',
  'browser_click',
  'browser_select_option',
  'browser_wait_for',
  'browser_tabs',
]);

const ALLOWED_MCP_TOOL_SET = new Set(ALLOWED_MCP_TOOLS);

function renderValue(value, input) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(input, key)) throw new Error(`Generated recipe requires input “${key}”.`);
      return String(input[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => renderValue(item, input));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$pick')) {
      if (typeof value.$pick !== 'string' || !value.cases || typeof value.cases !== 'object' || Array.isArray(value.cases)) {
        throw new Error('Generated recipe contains an invalid input mapping.');
      }
      if (!Object.hasOwn(input, value.$pick)) throw new Error(`Generated recipe requires input “${value.$pick}”.`);
      const selected = String(input[value.$pick]);
      if (!Object.hasOwn(value.cases, selected)) throw new Error(`Generated recipe does not recognize ${value.$pick}=${selected}.`);
      return renderValue(value.cases[selected], input);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, input)]));
  }
  return value;
}

function availableToolDetails(availableTools) {
  if (availableTools instanceof Set) return { names: availableTools, definitions: new Map() };
  const items = Array.isArray(availableTools) ? availableTools : [];
  return {
    names: new Set(items.map((tool) => typeof tool === 'string' ? tool : tool?.name).filter(Boolean)),
    definitions: new Map(items.filter((tool) => tool?.name).map((tool) => [tool.name, tool])),
  };
}

function normalizeReferenceArgument(name, args, definitions) {
  const properties = definitions.get(name)?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return args;
  if (Object.hasOwn(args, 'ref') && !Object.hasOwn(properties, 'ref') && Object.hasOwn(properties, 'target')) {
    const { ref, ...rest } = args;
    return { ...rest, target: ref };
  }
  if (Object.hasOwn(args, 'target') && !Object.hasOwn(properties, 'target') && Object.hasOwn(properties, 'ref')) {
    const { target, ...rest } = args;
    return { ...rest, ref: target };
  }
  return args;
}

export async function runMcpRecipe({ executor, input = {}, availableTools, callTool, resultText }) {
  if (!executor || executor.type !== 'mcp-recipe' || !Array.isArray(executor.steps)) {
    throw new Error('A valid MCP recipe is required.');
  }
  if (executor.steps.length < 1 || executor.steps.length > 12) {
    throw new Error('MCP recipes must contain 1–12 steps.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MCP recipe input must be an object.');
  }
  if (typeof callTool !== 'function' || typeof resultText !== 'function') {
    throw new Error('MCP recipe execution requires a tool client and result formatter.');
  }

  const { names: available, definitions } = availableToolDetails(availableTools);
  const trace = [];
  for (const step of executor.steps) {
    if (!step || !ALLOWED_MCP_TOOL_SET.has(step.tool)) {
      throw new Error(`MCP tool ${step?.tool || '(missing)'} is not allowed.`);
    }
    if (!available.has(step.tool)) throw new Error(`Connected MCP server does not expose ${step.tool}.`);
    const args = normalizeReferenceArgument(step.tool, renderValue(step.arguments || {}, input), definitions);
    const result = await callTool(step.tool, args);
    trace.push({ tool: step.tool, arguments: args, result: String(resultText(result)).slice(0, 18_000) });
  }
  return { ok: true, trace, result: trace.at(-1)?.result || '' };
}
