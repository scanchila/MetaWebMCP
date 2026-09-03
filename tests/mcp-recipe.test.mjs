import test from 'node:test';
import assert from 'node:assert/strict';

import { runMcpRecipe } from '../public/js/mcp-recipe.js';

const availableTools = new Set([
  'browser_type',
  'browser_click',
  'browser_snapshot',
]);

test('multi-step browser recipes refresh response-scoped refs by exact accessible name', async () => {
  const calls = [];
  const responses = [
    `### Page Snapshot
\`\`\`yaml
- textbox "Username" [ref=u1]
- textbox "Password" [ref=u2]
- button "Login" [ref=u3]
\`\`\``,
    `### Page Snapshot
\`\`\`yaml
- textbox "Username" [ref=p1]
- textbox "Password" [ref=p2]
- button "Login" [ref=p3]
\`\`\``,
    '### Page Snapshot\n```yaml\n- heading "Products" [ref=h1]\n```',
    '### Page Snapshot\n```yaml\n- heading "Products" [ref=h1]\n```',
  ];

  const result = await runMcpRecipe({
    executor: {
      type: 'mcp-recipe',
      steps: [
        { tool: 'browser_type', arguments: { element: 'Username', ref: 'e1', text: '{{username}}' } },
        { tool: 'browser_type', arguments: { element: 'Password', ref: 'e2', text: '{{password}}' } },
        { tool: 'browser_click', arguments: { element: 'Login', ref: 'e3' } },
        { tool: 'browser_snapshot', arguments: {} },
      ],
    },
    input: { username: 'standard_user', password: 'public_test_password' },
    availableTools,
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      return responses[calls.length - 1];
    },
    resultText: String,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    { tool: 'browser_type', args: { element: 'Username', ref: 'e1', text: 'standard_user' } },
    { tool: 'browser_type', args: { element: 'Password', ref: 'u2', text: 'public_test_password' } },
    { tool: 'browser_click', args: { element: 'Login', ref: 'p3' } },
    { tool: 'browser_snapshot', args: {} },
  ]);
});

test('browser recipe ref refresh fails closed when accessible names are ambiguous', async () => {
  const calls = [];
  await runMcpRecipe({
    executor: {
      type: 'mcp-recipe',
      steps: [
        { tool: 'browser_click', arguments: { element: 'Open menu', ref: 'e1' } },
        { tool: 'browser_click', arguments: { element: 'Continue', ref: 'e2' } },
      ],
    },
    availableTools,
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      return calls.length === 1
        ? '- button "Continue" [ref=n1]\n- button "Continue" [ref=n2]'
        : '- heading "Done" [ref=h1]';
    },
    resultText: String,
  });

  assert.equal(calls[1].args.ref, 'e2');
});
