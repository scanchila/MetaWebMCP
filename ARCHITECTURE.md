# Architecture

## Product invariant

MetaWebMCP must use WebMCP to construct another usable WebMCP surface. A form wizard that merely prints source code would not satisfy that invariant.

The application therefore maintains two registries on one top-level page:

1. A permanent **control plane** of seven meta-tools.
2. A replaceable **generated plane** containing domain tools inferred from the current target.

Both planes use one `ToolRegistry`. The registry always stores an internal executable copy for deterministic development and, when the browser implements the imperative API, also calls `document.modelContext.registerTool`. Generated entries carry their own `AbortController`, so rebuilding or resetting aborts and unregisters only the generated plane.

The top-level application also keeps one versioned workspace record in same-origin IndexedDB. It saves drafts, analysis evidence, reviewed ToolSpecs and recipes, evaluation and trace state, and whether generated tools were active. On reload, validated contracts are registered through the same `ToolRegistry`; malformed or incompatible records are discarded. Reset deletes the record. IndexedDB failure is non-fatal and leaves the existing in-memory flow intact.

## Recursive sequence

```text
meta_analyze_site
  └─ capability candidates + schemas + evidence + risk + executor

meta_create_webmcp
  ├─ reviewed inferred ToolSpec[]
  └─ or managing-agent-authored ToolSpec[] grounded in observed capability IDs

meta_activate_webmcp
  ├─ register generated tool A
  ├─ register generated tool B
  └─ emit registry change

<generated tool>
  └─ execute against controlled DOM, hosted Browser MCP, or return a caller-browser recipe

meta_test_webmcp
  └─ discovery + schema + execution + visible-state checks

meta_export_webmcp
  └─ standalone repository ZIP from the same ToolSpec[]
```

The same tool contract drives activation and native export. There is no separate hard-coded export model. Hosted browser recipes and collections execute while their MCP session is open. Caller-browser plans are returned as an explicit, incomplete handoff for the invoking agent to execute. After installation in an owned page, actions use accessible-name/item-context resolution and single-page collections use normal links without MetaWebMCP. Paginated owned-page collections require an explicit source-owner adapter or browser bridge. When target source is available, the export also bundles the target page and assets, installs the generated module into the top-level document, and retains a separate integration report for review.

## ToolSpec

Every capability carries:

- A stable tool name and concise description.
- A JSON object input schema.
- A risk classification: `read`, `write`, or `consequential`.
- Evidence references such as selectors, labels, accessible references, and observed item identifiers.
- Sample arguments for runtime evaluation.
- One deterministic executor.

When a page exposes more than twelve candidates, the analyzer scores every discovered workflow by normalized token overlap with the stated goal, selects the strongest twelve with document order as the deterministic tie-breaker, and reports the omitted count.

Supported executor types:

- `dom-form`
- `dom-action-group`
- `dom-button`
- `dom-read`
- `mcp-recipe`
- `mcp-collection`

The managing agent may author any domain ToolSpec expressible by the two
constrained browser executors. It must cite one or more observed capability
IDs, cannot lower their inferred risk, and must provide a closed input schema.
`mcp-recipe` contains at most twelve steps selected from snapshot, type, click,
select, and wait. String templates can interpolate only declared input keys.
`mcp-collection` describes observed repeated links, typed fields, common
parsers, filters, computed sums, stable sorting, a result limit, and optional
pagination. The runtime injects the analyzed origin/path scope, requires the
item matcher to cover observed evidence, and bounds the plan, pages, records,
and output. Neither executor accepts JavaScript or unrestricted MCP calls.

## Owner mode

The controlled demo is a separate iframe application. It registers no WebMCP tools. MetaWebMCP reads its live same-origin DOM after rendering, sends that HTML through the same analyzer used for pasted content, normalizes the candidate contracts, and registers the resulting executors in the parent.

For public URL analysis, the server:

1. Validates scheme and credentials.
2. Resolves DNS and rejects private/reserved addresses.
3. Follows a limited number of redirects, validating each destination.
4. Requires an HTML content type and caps response size.
5. Extracts forms, fields, option values, grouped actions, labels, and stable selectors.

Static URL and pasted-HTML modes are export-oriented. A DOM adapter can only execute once installed inside the real target page.

## Any-site mode

```text
MetaWebMCP workspace
    │ public URL
    ▼
Isolated hosted browser session
    │ rendered screenshot + accessibility model
    ▼
Generated semantic tool
    │ bounded recipe or collection plan
    ▼
Visible target state refreshes in the workspace
```

The hosted path is the public workspace default. One `BrowserMcpSession` in the top-level page retains the MCP session across analysis and every generated semantic tool call. Analysis navigates once, derives capability candidates and repeated-link collection scaffolds from the accessibility model, and captures an inline screenshot. The managing agent can submit complete ToolSpecs through `meta_create_webmcp.authored_tools`; those contracts pass through the same registry, activation, evaluation, persistence, and export flow as inferred tools. Generated actions use only snapshot, type, click, select, and wait steps. Collection navigation is computed from a reviewed template within the analyzed origin/path and is capped at twenty pages. After execution the workspace refreshes both the visual page and accessibility result.

Caller-browser observation remains an agent-only alternative. A calling agent that already controls an authorized target session can pass a bounded accessibility snapshot and target URL directly to `meta_analyze_site(source: agent_snapshot)`. Active tools return `completed: false` recipes or collection plans for that agent to execute and verify. They never claim that a handed-off collection was completed. The human workspace does not expose raw snapshot entry.

The Node deployment remains compatible with a separate Playwright MCP service. In that layout, each open page receives a random workspace identifier and a distinct server-side client/session. Resetting or expiring one workspace closes only that session. Both layouts use the same MCP client and recipe interpreter. The supplied Compose Playwright container has only an internal network, and Chromium is configured to send HTTP and HTTPS through a proxy that validates all DNS answers and pins the socket to the selected public address. An external browser endpoint must provide an equivalent boundary before the Node bridge can be enabled.

The public deployment mounts Cloudflare's Playwright MCP agent as a Durable Object alongside the static application and sets `HOSTED_BROWSER_ENABLED=1`. The showcase selects Chromium; Kitesurf remains an opt-in beta engine for deployments that have verified target compatibility. The Browser Run binding creates an isolated, non-persistent browser context. A long-lived SSE connection ties that context to the page; failed analysis, reset, and page teardown issue `browser_close`. Same-origin checks and an edge rate-limit binding guard the transport route. The agent advertises only the eight operations used by the product, including inline viewport capture. Transport validation checks explicit navigation targets, while browser-context routing blocks direct local, private, reserved, and common metadata destinations reached through redirects or page actions. Operators can set the enabled flag to `0` to disable this resource-intensive path without affecting the controlled sample or tool-only observation inputs.

This is a virtual, session-scoped adapter. It does not modify the third-party origin or claim that the target itself is natively WebMCP-compatible.

Caller-browser contracts can be restored after a MetaWebMCP reload because execution remains with the caller and stale references must already be resolved by accessible name. A hosted Browser MCP session is intentionally not restorable: its contracts remain saved for review, while activation, evaluations, and target state are cleared until a fresh analysis establishes a new isolated browser session.

Export is a separate, source-owner path: the generated module interprets the reviewed recipe against the owned page's normal controls and can extract a reviewed collection from the current page. It does not include MetaWebMCP. Item-scoped actions resolve within the matching visible item's container and fail closed if that item is no longer present. Cross-page collection traversal is intentionally explicit: the owner supplies `window.MetaWebMCPCollectionAdapter` or `window.MetaWebMCPBrowserBridge`, rather than granting generated code a general navigation primitive.

## Generated repository

`lib/generator.mjs` serializes the reviewed ToolSpec array into a standalone module. The generated module:

- Calls `document.modelContext.registerTool` directly.
- Preserves the normal interface when WebMCP is absent.
- Uses one `AbortController` per tool.
- Validates every invocation against the serialized ToolSpec before changing page state.
- Sets read-only and untrusted-content annotations.
- Implements the same deterministic executor types.
- Executes browser-derived form and item recipes through constrained owned-page DOM lookups, with an optional explicit browser bridge.
- Executes single-page collection contracts through the same serialized parsers and filters, and fails transparently when pagination needs an owner adapter.
- Documents where source owners should replace selectors with application functions.

The dependency-free ZIP implementation uses stored entries, UTF-8 filenames, CRC32, central directory records, and safe relative paths.

Export response metadata is not part of the IndexedDB record. The server-side archive remains capability-bound, single-use, and short-lived, so a restored workspace must create a fresh export.

## Why the core has no dependencies

The hackathon demonstration needs a reliable deployment more than a broad framework. Node 20+ provides the HTTP server, `fetch`, Web Streams, DNS APIs, and cryptography needed here. Avoiding package installation reduces supply-chain and deployment failure modes while keeping the generated output legible to judges.
