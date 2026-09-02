# Test report

Verification was performed on **2026-09-02T22:53Z** (**2026-09-03 05:53, Asia/Ho_Chi_Minh**).

## Environment

- Linux x86_64, kernel 6.8.0-138-generic
- Node.js 24.5.0
- npm 11.5.1
- Python 3.14.2
- Playwright for Python 1.62.0
- Playwright MCP 1.63.0-alpha-2026-08-31
- Google Chrome 147.0.7727.116
- Lighthouse 13.4.1

## Automated results

`npm test` runs static analysis, Node tests, and the Chromium journey.

- Static repository checks: **56 repository files passed**.
- Node unit and integration tests: **23 passed, 0 failed**.
- Cloudflare Worker dry-run bundle: **passed** with Browser Run, Durable Object, Rate Limit, and Static Assets bindings.
- Recursive Chromium end-to-end test: **passed** with no console or page errors.
- Generated runtime evaluations: **4 passed, 0 failed, 0 skipped**.
- Production Lighthouse: **100 performance, 100 accessibility, 100 best practices, 100 SEO, and 100 agentic browsing**. The equivalent local development-server profile scored 99 for performance and 100 in the other four categories.

The Node suite covers HTML and accessibility-snapshot analysis, required form fields across deep trees, repeated item-action grouping, bounded input-to-reference mappings, current and legacy Playwright reference schemas, ZIP generation with portable Unix file modes, runnable owner bundles, unsafe bundle rejection, SSRF and origin validation, Streamable HTTP and long-lived SSE MCP clients, serialized MCP operations, server-side workspace isolation, and page-owned MCP session reuse and closure.

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

Evidence from the final run is retained in:

- `test-artifacts/e2e-result.json`
- `test-artifacts/metawebmcp-e2e.png`
- `test-artifacts/metawebmcp-mobile.png`
- `test-artifacts/relay-sessions-webmcp.zip`

## Public-site Browser MCP validation

The Node deployment was connected to the current official Playwright MCP server and exercised through MetaWebMCP's generated semantic tools:

| Public target | Generated tool | Observed result |
|---|---|---|
| Wikipedia | `search(search_wikipedia, selection)` | Submitted `WebMCP` in English and returned a result snapshot containing the query. |
| SauceDemo | `login(username, password)` | Used the site's documented test account and reached the Products view. |
| Books to Scrape | `add_to_basket(item)` | Exposed all 20 visible book titles as one bounded enum, selected “A Light in the Attic,” and returned the changed basket state. |

Each run used the analyze → create → activate → execute → reset sequence. The MCP server received only its advertised tool schema, and MetaWebMCP adapted the `target` reference field used by the current server while retaining the `ref` field used by the Cloudflare MCP package.

## Commands

```bash
npm run check
npm run test:unit
npm run test:e2e
npm test
```

## Coverage boundary

The automated browser suite injects a narrow implementation of the documented imperative `registerTool`, `getTools`, `executeTool`, cancellation, and tool-lifecycle shape. Production modules are otherwise executed unchanged, and every test invocation goes through that WebMCP-shaped surface. Native-client verification remains a separate deployment gate because WebMCP availability depends on the browser build and feature rollout.

The Browser MCP clients are tested against Streamable HTTP JSON/event responses and a long-lived SSE control connection, including session reuse, closure, concurrency, page-owned execution, and isolation through the MetaWebMCP server. The hosted Cloudflare path has also completed a live Browser Run navigation and accessibility-snapshot smoke test. Native-client verification in ChatGPT's supported in-app browser remains a separate deployment gate because WebMCP availability depends on that browser build and feature rollout.

The end-to-end suite renders production HTML and modules in a network-independent page harness and bridges same-origin requests to the real Node server through Playwright's exposed-function mechanism. This keeps the control-plane test deterministic while exercising the real server endpoints and browser modules. It then crosses the export API and ZIP boundary twice: once for the controlled application and once for a browser-derived form plus repeated item action. Both generated modules register and execute on clean pages; the latter has no MetaWebMCP bridge global.
