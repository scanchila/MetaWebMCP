# Test report

Verification was performed on **2026-09-03T00:53Z** (**2026-09-03 07:53, Asia/Ho_Chi_Minh**).

## Environment

- Linux x86_64, kernel 6.8.0-138-generic
- Node.js 24.5.0
- npm 11.5.1
- Python 3.14.2
- Playwright for Python 1.62.0
- Playwright MCP 0.0.80 for the local compatibility run
- Google Chrome 147.0.7727.116
- Google Chrome 154.0.8037.0 beta with `WebMCPTesting` for native-browser validation
- Lighthouse 13.4.1
- Cloudflare Playwright MCP 0.0.5 with Cloudflare Playwright 1.3.6

## Automated results

`npm test` runs static analysis, Node tests, and the Chromium journey.

- Static repository checks: **69 repository files passed**.
- Node unit and integration tests: **25 passed, 0 failed**.
- Cloudflare Worker dry-run bundle: **passed** with Browser Run, Durable Object, Rate Limit, and Static Assets bindings.
- Recursive Chromium end-to-end test: **passed** with no console or page errors.
- Generated runtime evaluations: **4 passed, 0 failed, 0 skipped**.
- Production Lighthouse: **96 performance, 100 accessibility, 100 best practices, 100 SEO, and 100 agentic browsing**.
- Generated native preview Lighthouse: **100 performance, 100 accessibility, 100 best practices, 100 SEO, and 100 agentic browsing**.

The Node suite covers HTML and accessibility-snapshot analysis, required form fields across deep trees, repeated item-action grouping, bounded input-to-reference mappings, current and legacy Playwright reference schemas, response-scoped reference refresh, ZIP generation with portable Unix file modes, runnable owner bundles, unsafe bundle rejection, SSRF and origin validation, Streamable HTTP and long-lived SSE MCP clients, serialized MCP operations, server-side workspace isolation, and page-owned MCP session reuse and closure. The deployment compatibility check also executes the patched inline screenshot response without persistent filesystem access.

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
10. A browser-derived export registers on a separate owned-page fixture, searches and changes the requested item without MetaWebMCP or a browser bridge, then fails closed when that item disappears.
11. The completed workspace reflows from 1440 px down to 390 px without horizontal overflow across the brief, conversation, and live registry.

Evidence from the deterministic local run is retained in:

- `test-artifacts/e2e-result.json`
- `test-artifacts/metawebmcp-e2e.png`
- `test-artifacts/metawebmcp-mobile.png`
- `test-artifacts/relay-sessions-webmcp.zip`

Production-native and hosted public-site evidence is retained in [`evidence/`](evidence/). The JSON records include the deployed Worker version, tool surfaces, execution postconditions, console-error results, and screenshot hashes.

## Public-site Browser MCP validation

The production Cloudflare deployment was exercised through Chrome's native `document.modelContext`, MetaWebMCP's generated semantic tools, and its page-owned Playwright MCP session:

| Public target | Generated tool | Observed result |
|---|---|---|
| Wikipedia | `search(search_wikipedia)` | Submitted `WebMCP` and returned a search-result snapshot containing the query. |
| SauceDemo | `login(username, password)` → `add_to_cart(item)` | Used the site's public test account, retained that session while re-analyzing the catalog, selected “Sauce Labs Backpack,” and observed its control change to “Remove.” |
| The Internet | `add_element()` | Added a page element and observed the new “Delete” control. |

Each target started in a fresh browser session and used the analyze → create → activate → execute → reset sequence. Across four semantic stages, the retained results verify that the same transport session was reused from analysis through generated-tool execution and that the page-owned runtime exposed 15 low-level tools. MetaWebMCP adapted the `target` reference field used by the current server while retaining the `ref` field used by the Cloudflare package.

## Commands

```bash
npm run check
npm run test:unit
npm run test:e2e
npm test
```

## Coverage boundary

The automated browser suite injects a narrow implementation of the documented imperative `registerTool`, `getTools`, `executeTool`, cancellation, and tool-lifecycle shape. Production modules are otherwise executed unchanged, and every test invocation goes through that WebMCP-shaped surface.

A separate production gate used Google Chrome 154 beta with WebMCP testing enabled. The deployed page exposed a real `document.modelContext`; all builder and generated calls went through its discovered tool objects. The downloaded export was then served independently and registered and executed its own four native tools. This proves the native browser boundary without treating the deterministic mock as browser-native evidence. Availability in a particular client still depends on that client's WebMCP rollout.

The Browser MCP clients are tested against Streamable HTTP JSON/event responses and a long-lived SSE control connection, including session reuse, closure, concurrency, page-owned execution, and isolation through the MetaWebMCP server. The hosted Cloudflare path completed three live Browser Run journeys with semantic postconditions and target screenshots. Verification inside ChatGPT's in-app browser remains client-specific and is therefore included in the judge instructions rather than represented as an automated result.

The end-to-end suite renders production HTML and modules in a network-independent page harness and bridges same-origin requests to the real Node server through Playwright's exposed-function mechanism. This keeps the control-plane test deterministic while exercising the real server endpoints and browser modules. It then crosses the export API and ZIP boundary twice: once for the controlled application and once for a browser-derived form plus repeated item action. Both generated modules register and execute on clean pages; the latter has no MetaWebMCP bridge global.
