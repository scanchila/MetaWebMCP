# Test report

Local regression verification completed on **2026-09-03T21:45:47Z** (**2026-09-04 04:45:47, Asia/Ho_Chi_Minh**) against the working tree based on source commit `643db6c8e80e4e0f489c5d17d5a6b9bfb77ace20`. This run covers managing-agent-authored action and collection tools, bounded lazy-page capture, two cold/direct FincaRaíz pairs, the cross-site Metrocuadrado case, and the Steam multipage benchmark.

The retained production-native and Lighthouse evidence below was captured earlier against deployed Worker version `c5ac5494-8d79-413e-9a9c-8db3dcd3339c`, built from source commit `178f2ff8dd63dc6f1c29558f5ed36cf4798b23e8`.

## Environment

- Linux x86_64, kernel 6.8.0-138-generic
- Node.js 24.5.0
- npm 11.5.1
- Python 3.10.12 for evidence tests; Python 3.12.12 for the browser journey
- Playwright for Python 1.62.0
- Google Chrome 147.0.7727.116 for the deterministic local journey
- Google Chrome 154.0.8037.0 beta with `WebMCPTesting` for native-browser and Lighthouse validation
- Lighthouse 13.4.1
- Cloudflare Playwright MCP 0.0.5 with Cloudflare Playwright 1.3.6
- Wrangler 4.128.0

## Automated results

- Capture-script syntax checks: **passed**.
- Static repository checks: **passed**.
- Node unit and integration tests: **118 passed, 0 failed**.
- Evidence provenance tests: **11 passed, 0 failed**.
- Cloudflare Worker dry-run bundle: **passed** with Browser Run, Durable Object, Rate Limit, Static Assets, and Worker Version Metadata bindings.
- Recursive Chromium end-to-end journey: **21 checks passed** with no console or page errors.
- Generated runtime evaluations: **4 contracts evaluated, 4 passed, 0 failed, 0 skipped, 0 not run**.
- Retained production Lighthouse: **100 median performance (99–100 across three mobile samples)** and **100 accessibility, best practices, SEO, and agentic browsing in every sample**. Maximum CLS was **0.000106**; console errors were **0**.
- Retained independently served native export Lighthouse: **100 performance, accessibility, best practices, SEO, and agentic browsing**. CLS and console errors were **0**.

## Cold FincaRaíz benchmark

Fresh ephemeral Codex processes using CLI 0.150.1, `gpt-5.6-sol`, maximum
reasoning, Chrome 147, and Playwright MCP 0.0.55 ran two matched pairs from
empty working directories. All four candidates returned the 50 oracle URLs,
numeric fields, normalized laundry evidence, calculations, and ranks with no
duplicates:

| Pair | Arm | Wall time | Processed / non-cached tokens | Model-facing tool response | Calls |
|---|---|---:|---:|---:|---:|
| 1 | Direct browser parsing | 634.630 s | 5,997,779 / 336,723 | 1,205,716 characters | 15 browser navigations |
| 1 | Cold MetaWebMCP agent | 290.550 s | 345,737 / 71,689 | 51,277 characters | 8 semantic; 15 internal browser calls |
| 2 | Direct browser parsing | 713.181 s | 4,657,195 / 423,851 | 3,066,487 characters | 38 browser navigations |
| 2 | Cold MetaWebMCP agent | 373.607 s | 473,796 / 62,276 | 53,506 characters | 11 semantic; 15 internal browser calls |

The ratio of arm-median wall times was **2.029×** in MetaWebMCP's favor.
Median processed tokens fell **13.001×**, non-cached tokens fell **5.677×**,
and model-facing tool-response text fell **40.772×**. Pair-level wall ratios
were 2.184× and 1.909×. The cold timings retain every analysis, rejected
contract, activation, collection traversal, and final schema-generation cost.
Event audits contain no prohibited tools.

Each arm used a separate adjacent oracle because listings are volatile.
Non-interactive Codex used a thin stdio transport adapter for MetaWebMCP
because it cannot discover page-native Site Tools; the adapter called the
production analyzer, authoring validator, registry, and collection executor
and contained no domain ToolSpec or FincaRaíz parser. Two trials per arm are
still not a statistical estimate.

## Metrocuadrado crossover benchmark

The same cold isolation was applied to a one-page Metrocuadrado task with a
fixed 1280×20000 viewport so all lazy-rendered cards were observable. Both
arms returned the exact oracle top 10 with exact card fields and ranks:

| Arm | Wall time | Processed / non-cached tokens | Model-facing tool response | Calls |
|---|---:|---:|---:|---:|
| Direct browser parsing | 114.470 s | 147,997 / 59,421 | 549,894 characters | 5 browser calls |
| Cold MetaWebMCP agent | 159.678 s | 319,868 / 46,332 | 133,952 characters | 7 semantic; 7 internal browser calls |

Direct browsing was **45.208 seconds faster**, making MetaWebMCP **1.395× slower**
on wall time. Even in that latency loss, MetaWebMCP exposed **75.6% less
model-facing tool text** (**4.105×**) and used **22.0% fewer non-cached tokens**
(**1.283×**). Its total processed tokens including cached context were
**2.161× higher**. This single-page counterexample shows that cold analysis and
ToolSpec authoring have fixed cost that does not always amortize, while the
semantic boundary can still keep substantial raw page content out of the
managing agent's context. The quality gate is end to end: the captured ToolSpec
preserved tracking queries and the managing agent removed them in its final
schema-constrained response.

## Steam multipage benchmark

A cold 20-page Steam storefront task inspected 500 linked app cards, filtered
on displayed discount and two displayed prices, deduplicated app identities,
and applied a four-level ordering before returning 50 records. The untouched
generated execution, the cold final answer, and the direct-browser answer all
matched the corrected independent oracle for all 50 app IDs, fields, and
ranks:

| Arm | Wall time | Processed / non-cached tokens | Model-facing tool response | Calls |
|---|---:|---:|---:|---:|
| Direct browser parsing | 399.300 s | 2,634,279 / 240,935 | 628,090 characters | 21 browser calls |
| Cold MetaWebMCP agent | 287.680 s | 248,889 / 46,777 | 33,340 characters | 5 semantic; 62 internal browser calls |

MetaWebMCP was **1.388× faster**, saving 111.620 seconds. Processed tokens fell
**10.584×**, non-cached tokens **5.151×**, and model-facing response text
**18.839×**. The generated ToolSpec passed validation on its first authoring
attempt. An event/trace audit gives the accepted definition the same SHA-256
on both sides, and the raw execution result is byte-identical to the cold
agent's final result array.

The initially frozen oracle skipped Steam accessibility link keys enclosed in
single quotes when a title contained a colon, producing failed 47/50 and 48/50
gates even though the arms agreed. Those failures are retained. After both
arms completed, a one-character optional-quote parser correction and regression
test captured all 500 occurrences; all three corrected gates passed 50/50.
This post-run correction is a limitation, and a preregistered repeat is still
needed before treating the measured ratio as an expected effect size.

The Node suite covers HTML and accessibility-snapshot analysis, repeated-link collection discovery, managing-agent ToolSpec grounding, risk floors, common field parsers, filtering, computed fields, stable ranking, bounded lazy-page capture, pagination and stopping proofs, caller-browser recipe and collection handoff, independent FincaRaíz, Metrocuadrado, and Steam oracle/scoring behavior, inline hosted-browser image capture, complete form containment, required and constrained fields, rejection of ambiguous forms, repeated item-action grouping, bounded input-to-reference mappings, current and legacy Playwright reference schemas, response-scoped reference refresh, consequential-action classification, untrusted metadata containment, ZIP generation with portable Unix modes, runnable owner bundles, generated collection parity, unsafe bundle rejection, public-network target validation across reserved IPv4 and IPv6 ranges, DNS validation and proxy pinning, navigation and redirect validation, Streamable HTTP and long-lived SSE MCP clients, failed-analysis teardown, serialized operations, server-side workspace isolation, Cloudflare hosted-browser deployment gating, signed capability expiry and tamper rejection, cookie attributes, page-owned MCP session reuse and closure, capability-owned single-use exports, and deployment provenance enforcement. The Cloudflare compatibility check also executes the patched agent factory and proves that two Durable Object instances receive distinct MCP protocol servers.

The deterministic browser journey verifies:

1. The server health endpoint responds.
2. The landing page explains incremental compatibility, opens the workspace, reveals it for tool activity, and remains responsive.
3. Native-client prerequisites and the five-step browser fallback remain readable at every tested breakpoint.
4. Browser-local drafts, contracts, and active caller plans survive reload without reviving temporary export links; Reset removes the saved record.
5. The workspace remains functional when IndexedDB is unavailable.
6. Workspace reset awaits browser cleanup even before a successful analysis.
7. Caller-supplied observation produces a delegated recipe, exposes the collection authoring grammar, accepts a managing-agent-authored collection through the native meta-tool, and returns it as an explicit incomplete plan.
8. The human workspace is URL-first, has no snapshot/HTML data-entry controls, and retains a keyboard-accessible sample.
9. Hosted-browser rate limits expose agent-browser guidance and open the Run path guide.
10. Hosted inspection displays the rendered page and accessibility model in switchable views.
11. The fallback contains untrusted evidence, prevents risk downgrades, requires reviewed metadata, and never reports skipped verification as complete.
12. Seven permanent meta-tools register on the top-level page while the target iframe has no WebMCP registry.
13. `meta_analyze_site` derives four evidence-backed capabilities from the controlled target.
14. `meta_create_webmcp` constructs constrained ToolSpecs.
15. `meta_activate_webmcp` changes the top-level registry from seven to eleven tools.
16. The generated tools search sessions, add an itinerary item, inspect visible state, and clear it.
17. `meta_test_webmcp` completes registration, schema, execution, and visible-postcondition checks for all four tools.
18. `meta_export_webmcp` returns a valid 13-file repository ZIP with direct `document.modelContext.registerTool(...)` source.
19. The extracted site independently registers and executes all four exported tools, including a zero-item postcondition after `clear_itinerary`.
20. A browser-derived export validates inputs before effects, rejects form ambiguity, runs without MetaWebMCP or a browser bridge, and fails closed when the requested item disappears.
21. The completed workspace has no horizontal overflow from 390 px through 1440 px.

Deterministic local artifacts are retained in:

- `test-artifacts/e2e-result.json`
- `test-artifacts/metawebmcp-landing.png`
- `test-artifacts/metawebmcp-e2e.png`
- `test-artifacts/metawebmcp-mobile.png`
- `test-artifacts/relay-sessions-webmcp.zip`

## Production-native validation

Google Chrome 154 beta opened the deployed application with WebMCP testing enabled. The real top-level `document.modelContext` exposed seven permanent tools and eleven after activation. Analysis, ToolSpec creation, activation, all four generated-tool executions, complete evaluation, and export were invoked through tool objects discovered from that native registry. The downloaded archive was then extracted and served independently; its page registered and executed `find_sessions`, `add_session_to_itinerary`, `inspect_itinerary`, and `clear_itinerary` without the MetaWebMCP runtime. The retained result records nine native calls on the production page (five meta-tools and four generated tools) plus four generated-tool calls on the independent export: 13 native calls in total, eight of them domain-level. It also records no console errors, screenshot and ZIP hashes, deployed asset hashes, the capture-script hash, and the exact deployment provenance.

The deployed Browser MCP routes were also checked at their HTTP boundary. Nineteen assertions cover health and deployment identity, same-origin capability issuance, authorized analysis, rejection of unauthenticated API and raw SSE access, cross-origin issuance, tampered capabilities, and private-network targets. They also verify capability-required export creation, capability ownership, a valid ZIP response, and single-use download semantics. The issued cookie was observed with Secure, HttpOnly, SameSite=Strict, and root-path attributes. No capability or secret value is retained in the gate record.

Exact production-native records are retained in [`evidence/native-webmcp-result.json`](evidence/native-webmcp-result.json), [`evidence/relay-sessions-webmcp.zip`](evidence/relay-sessions-webmcp.zip), and [`evidence/deployment-security-gates.json`](evidence/deployment-security-gates.json).

## Hosted Browser MCP validation

The production Cloudflare browser path was exercised through Chrome's native `document.modelContext`, MetaWebMCP's generated semantic tools, and its page-owned Playwright MCP session:

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

The caller-browser path is tested through the native `meta_analyze_site` and `meta_create_webmcp` surfaces, including authoring guidance, complete agent-authored definitions, snapshot analysis, recipe and collection handoff, explicit `completed: false` reporting, skipped hosted verification, IndexedDB save/restore across a real reload, and fallback when IndexedDB is unavailable. Browser MCP clients remain tested against Streamable HTTP JSON/event responses and a long-lived SSE control connection, including session reuse, inline visual capture, failure cleanup, closure, concurrency, page-owned execution, capability binding, and server-side workspace isolation. The hosted Cloudflare path previously completed three live-site journeys with semantic postconditions and target screenshots. Verification inside ChatGPT's built-in browser remains client-specific and is therefore described in the usage instructions rather than represented as an automated result.
