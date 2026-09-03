# Test report

Local regression verification completed on **2026-09-03T16:43:05Z** (**2026-09-03 23:43:05, Asia/Ho_Chi_Minh**) against the working tree based on source commit `cd6ecff9bc6610956007516bc49ca4dcde0d9d8e`. At the time of this verification, these browser-local persistence changes had not yet been deployed.

The retained production-native and Lighthouse evidence below was captured earlier against deployed Worker version `c5ac5494-8d79-413e-9a9c-8db3dcd3339c`, built from source commit `178f2ff8dd63dc6f1c29558f5ed36cf4798b23e8`.

## Environment

- Linux x86_64, kernel 6.8.0-138-generic
- Node.js 24.5.0
- npm 11.5.1
- Python 3.10.12
- Playwright for Python 1.55.0
- Playwright Chromium 140.0.7339.16 for the deterministic local journey
- Google Chrome 154.0.8037.0 beta with `WebMCPTesting` for native-browser and Lighthouse validation
- Lighthouse 13.4.1
- Cloudflare Playwright MCP 0.0.5 with Cloudflare Playwright 1.3.6
- Wrangler 4.128.0

## Automated results

- Capture-script syntax checks: **passed**.
- Static repository checks: **107 release files passed**.
- Node unit and integration tests: **85 passed, 0 failed**.
- Evidence provenance tests: **11 passed, 0 failed**.
- Cloudflare Worker dry-run bundle: **passed** with Browser Run, Durable Object, Rate Limit, Static Assets, and Worker Version Metadata bindings.
- Recursive Chromium end-to-end journey: **18 checks passed** with no console or page errors.
- Generated runtime evaluations: **4 contracts evaluated, 4 passed, 0 failed, 0 skipped, 0 not run**.
- Retained production Lighthouse: **100 median performance (99–100 across three mobile samples)** and **100 accessibility, best practices, SEO, and agentic browsing in every sample**. Maximum CLS was **0.000106**; console errors were **0**.
- Retained independently served native export Lighthouse: **100 performance, accessibility, best practices, SEO, and agentic browsing**. CLS and console errors were **0**.

The Node suite covers HTML and accessibility-snapshot analysis, caller-browser recipe rendering, complete form containment, required and constrained fields, rejection of ambiguous forms, repeated item-action grouping, bounded input-to-reference mappings, current and legacy Playwright reference schemas, response-scoped reference refresh, consequential-action classification, untrusted metadata containment, ZIP generation with portable Unix modes, runnable owner bundles, unsafe bundle rejection, public-network target validation across reserved IPv4 and IPv6 ranges, DNS validation and proxy pinning, navigation and redirect validation, Streamable HTTP and long-lived SSE MCP clients, failed-analysis teardown, serialized operations, server-side workspace isolation, Cloudflare hosted-browser opt-in policy, signed capability expiry and tamper rejection, cookie attributes, page-owned MCP session reuse and closure, capability-owned single-use exports, and deployment provenance enforcement. The Cloudflare compatibility check also executes the patched agent factory and proves that two Durable Object instances receive distinct MCP protocol servers.

The deterministic browser journey verifies:

1. The server health endpoint responds.
2. The client guide identifies native and non-native states and remains usable without horizontal overflow from 1440 px down to 390 px.
3. Browser-local drafts, contracts, and active caller recipes survive a real reload; temporary export links do not, Reset removes the saved record, and unavailable IndexedDB leaves the in-memory workflow functional.
4. Source-mode controls expose pressed-button semantics and respond to native keyboard activation.
5. The fallback exposes source evidence for explicit review and never reports skipped or partial verification as complete, including after export.
6. Seven permanent meta-tools register on the top-level page while the target iframe has no WebMCP registry.
7. `meta_analyze_site` derives four evidence-backed capabilities from the live target.
8. `meta_create_webmcp` constructs constrained ToolSpecs.
9. `meta_activate_webmcp` changes the top-level registry from seven to eleven tools.
10. The generated tools search sessions, add an itinerary item, inspect the visible state, and clear it.
11. `meta_test_webmcp` completes registration, schema, execution, and visible-postcondition checks for all four tools.
12. `meta_export_webmcp` returns a valid 13-file repository ZIP with direct `document.modelContext.registerTool(...)` source.
13. The extracted site independently registers and executes all four exported tools, including a zero-item postcondition after `clear_itinerary`.
14. A browser-derived export validates inputs before effects, rejects form ambiguity, registers on a separate owned-page fixture, runs without MetaWebMCP or a browser bridge, and fails closed when the requested item disappears.
15. The completed workspace has no horizontal overflow at the tested responsive breakpoints.

Deterministic local artifacts are retained in:

- `test-artifacts/e2e-result.json`
- `test-artifacts/metawebmcp-e2e.png`
- `test-artifacts/metawebmcp-mobile.png`
- `test-artifacts/relay-sessions-webmcp.zip`

## Production-native validation

Google Chrome 154 beta opened the deployed application with WebMCP testing enabled. The real top-level `document.modelContext` exposed seven permanent tools and eleven after activation. Analysis, ToolSpec creation, activation, all four generated-tool executions, complete evaluation, and export were invoked through tool objects discovered from that native registry. The downloaded archive was then extracted and served independently; its page registered and executed `find_sessions`, `add_session_to_itinerary`, `inspect_itinerary`, and `clear_itinerary` without the MetaWebMCP runtime. The retained result records nine native calls on the production page (five meta-tools and four generated tools) plus four generated-tool calls on the independent export: 13 native calls in total, eight of them domain-level. It also records no console errors, screenshot and ZIP hashes, deployed asset hashes, the capture-script hash, and the exact deployment provenance.

The deployed Browser MCP routes were also checked at their HTTP boundary. Nineteen assertions cover health and deployment identity, same-origin capability issuance, authorized analysis, rejection of unauthenticated API and raw SSE access, cross-origin issuance, tampered capabilities, and private-network targets. They also verify capability-required export creation, capability ownership, a valid ZIP response, and single-use download semantics. The issued cookie was observed with Secure, HttpOnly, SameSite=Strict, and root-path attributes. No capability or secret value is retained in the gate record.

Exact production-native records are retained in [`evidence/native-webmcp-result.json`](evidence/native-webmcp-result.json), [`evidence/relay-sessions-webmcp.zip`](evidence/relay-sessions-webmcp.zip), and [`evidence/deployment-security-gates.json`](evidence/deployment-security-gates.json).

## Opt-in hosted Browser MCP validation

Before hosted browsing became opt-in, the production Cloudflare deployment was exercised through Chrome's native `document.modelContext`, MetaWebMCP's generated semantic tools, and its page-owned Playwright MCP session:

| Public target | Generated tool | Observed result |
|---|---|---|
| Wikipedia | `search(search_wikipedia)` | Submitted `WebMCP` and returned a search-result snapshot containing the query. |
| SauceDemo | `login(username, password)` → `add_to_cart(item)` | Used the site's published test account, retained that session while re-analyzing the catalog, selected “Sauce Labs Backpack,” and observed its control change to “Remove.” The retained result redacts the password. |
| The Internet | `add_element()` | Added a page element and observed the new “Delete” control. |

Each target started in a fresh browser session and used analyze → create → activate → generated semantic tool → reset. Across four semantic stages, the retained results verify session reuse from analysis through execution, every expected visible postcondition, and zero workspace console errors. The runtime advertised exactly eight allowlisted browser operations while the generated surface remained one semantic tool per stage. The result also records screenshot hashes, deployed asset hashes, the capture-script hash, browser launch configuration, and exact deployment provenance.

The redacted machine record and paired target/workspace screenshots are retained in [`evidence/public-site-results.json`](evidence/public-site-results.json) and documented in [`evidence/README.md`](evidence/README.md).

## Lighthouse evidence

Three complete production Lighthouse reports are retained rather than selecting only the best run. Their performance scores were 100, 100, and 99; the median was 100. Accessibility, best practices, SEO, and agentic browsing were 100 in all three. All samples recorded zero console errors, and maximum CLS was 0.000105686448327509. The exact retained native-export ZIP was then served independently and scored 100 in all five categories with zero CLS and no console errors.

The raw reports, their SHA-256 digests, the three-run aggregate, and compact summaries are retained under [`evidence/`](evidence/). Reproduction instructions are in [`scripts/README.md`](scripts/README.md).

## Commands

```bash
npm run check
npm run test:unit
npm run test:evidence
PATH=/path/to/playwright-venv/bin:$PATH npm run test:e2e
(cd deploy/cloudflare && npm run check)
```

## Coverage boundary

The deterministic browser suite injects a narrow implementation of the documented imperative `registerTool`, `getTools`, `executeTool`, cancellation, and tool-lifecycle shape. Production modules are otherwise executed unchanged, and every operation goes through that WebMCP-shaped surface. The end-to-end harness bridges same-origin requests to the real Node server and crosses the export and ZIP boundary for both the controlled application and a browser-derived form plus repeated item action.

The separate production-native run proves the current Chrome boundary without treating the deterministic mock as browser-native evidence. Native discovery in any particular client still depends on that client's WebMCP availability and rollout.

The caller-browser path is tested through the native `meta_analyze_site` surface, including snapshot analysis, generated recipe handoff, explicit `completed: false` reporting, skipped hosted verification, IndexedDB save/restore across a real reload, and fallback when IndexedDB is unavailable. Browser MCP clients remain tested against Streamable HTTP JSON/event responses and a long-lived SSE control connection, including session reuse, failure cleanup, closure, concurrency, page-owned execution, capability binding, and server-side workspace isolation. The opt-in hosted Cloudflare path previously completed three live-site journeys with semantic postconditions and target screenshots. Verification inside ChatGPT's built-in browser remains client-specific and is therefore described in the usage instructions rather than represented as an automated result.
