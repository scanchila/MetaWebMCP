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
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, input)]));
  }
  return value;
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

  const available = availableTools instanceof Set ? availableTools : new Set(availableTools || []);
  const trace = [];
  for (const step of executor.steps) {
    if (!step || !ALLOWED_MCP_TOOL_SET.has(step.tool)) {
      throw new Error(`MCP tool ${step?.tool || '(missing)'} is not allowed.`);
    }
    if (!available.has(step.tool)) throw new Error(`Connected MCP server does not expose ${step.tool}.`);
    const args = renderValue(step.arguments || {}, input);
    const result = await callTool(step.tool, args);
    trace.push({ tool: step.tool, arguments: args, result: String(resultText(result)).slice(0, 18_000) });
  }
  return { ok: true, trace, result: trace.at(-1)?.result || '' };
}
