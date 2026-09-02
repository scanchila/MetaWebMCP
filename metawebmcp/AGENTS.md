# AGENTS.md

## Objective

Maintain MetaWebMCP as a narrowly scoped proof that WebMCP can be used to create, activate, test, and export other WebMCP integrations.

## Invariants

- The top-level page directly registers the permanent meta-tools through the imperative WebMCP API when available.
- The controlled target registers no WebMCP tools.
- Generated domain tools are added dynamically to the top-level registry and use the same ToolSpec objects that are exported.
- The application must remain functional without a native WebMCP implementation so local tests and ordinary browsers work.
- Do not introduce an LLM API requirement for the core recursive flow. The calling WebMCP agent is responsible for semantic review.
- Do not expose arbitrary JavaScript or unrestricted browser MCP tool calls.
- Do not weaken target authentication, authorization, validation, or confirmation boundaries.
- Keep the core deployable without an npm dependency installation step unless a dependency has clear, material value.

## Validation

Before committing:

```bash
npm test
```

Inspect `test-artifacts/metawebmcp-e2e.png`, confirm the exported ZIP opens, and verify the generated source contains a direct `document.modelContext.registerTool({` call.
