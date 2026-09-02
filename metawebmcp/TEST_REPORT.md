# Test report

Final pre-package verification was performed on **2026-09-02T18:30Z** (**2026-09-03 01:30, Asia/Ho_Chi_Minh**).

## Environment

- Linux x86_64, kernel 6.18.35
- Node.js 22.16.0
- npm 10.9.2
- Python 3.13.5
- Playwright for Python 1.57.0
- Chromium 144.0.7559.96

## Automated results

`npm test` runs static analysis, Node tests, and the Chromium journey.

- Static repository checks: **39 repository files passed**.
- Node unit and integration tests: **16 passed, 0 failed**.
- Recursive Chromium end-to-end test: **passed** with no console or page errors.
- Generated runtime evaluations: **4 passed, 0 failed, 0 skipped**.

The Node suite covers HTML and accessibility-snapshot analysis, schema and tool-name generation, ZIP generation, runnable owner bundles, unsafe bundle rejection, SSRF and origin validation, Streamable HTTP MCP initialization and SSE/JSON handling, serialized MCP operations, and page-scoped Browser MCP session isolation.

The browser journey verifies the following sequence:

1. The server health endpoint responds.
2. Seven permanent meta-tools register on the top-level page while the target iframe has no WebMCP registry.
3. `meta_analyze_site` derives four evidence-backed capabilities from the live target.
4. `meta_create_webmcp` constructs the ToolSpecs.
5. `meta_activate_webmcp` changes the top-level registry from seven to eleven tools.
6. The generated tools search sessions, mutate the itinerary, and read the resulting state.
7. `meta_test_webmcp` passes registration, schema, execution, and visible-postcondition checks for all four generated tools.
8. `meta_export_webmcp` returns a valid repository ZIP with direct `document.modelContext.registerTool(...)` source.
9. The extracted exported site registers its own four tools and executes them against its bundled target UI.

Evidence from the final run is retained in:

- `test-artifacts/e2e-result.json`
- `test-artifacts/metawebmcp-e2e.png`
- `test-artifacts/relay-sessions-webmcp.zip`

## Commands

```bash
npm run check
npm run test:unit
npm run test:e2e
npm test
```

## Coverage boundary

The execution environment's installed Chromium does not expose the experimental native WebMCP API, so the automated browser suite injects a narrow implementation of the documented imperative `registerTool`, `getTools`, `executeTool`, cancellation, and tool-lifecycle shape. Production modules are otherwise executed unchanged, and every test invocation goes through that WebMCP-shaped surface.

The optional external Playwright MCP Docker sidecar could not be launched in this environment because Docker is unavailable. Its Streamable HTTP protocol client is tested against JSON and SSE responses, including session reuse, closure, concurrency, and isolation through the MetaWebMCP server. The supplied Compose command follows the official Playwright MCP long-running HTTP configuration. A final deployed smoke test should still be performed in ChatGPT's supported in-app browser and, for arbitrary-site mode, against the actual sidecar.

The container's system Chromium is managed with a URL block policy. The end-to-end suite therefore renders production HTML and modules in `about:blank` and bridges same-origin requests to the real Node server through Playwright's exposed-function mechanism; it does not bypass the managed policy.
