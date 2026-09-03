# Architecture

## Product invariant

MetaWebMCP must use WebMCP to construct another usable WebMCP surface. A form wizard that merely prints source code would not satisfy that invariant.

The application therefore maintains two registries on one top-level page:

1. A permanent **control plane** of seven meta-tools.
2. A replaceable **generated plane** containing domain tools inferred from the current target.

Both planes use one `ToolRegistry`. The registry always stores an internal executable copy for deterministic development and, when the browser implements the imperative API, also calls `document.modelContext.registerTool`. Generated entries carry their own `AbortController`, so rebuilding or resetting aborts and unregisters only the generated plane.

## Recursive sequence

```text
meta_analyze_site
  └─ capability candidates + schemas + evidence + risk + executor

meta_create_webmcp
  └─ reviewed ToolSpec[]

meta_activate_webmcp
  ├─ register generated tool A
  ├─ register generated tool B
  └─ emit registry change

<generated tool>
  └─ execute against controlled DOM or Browser MCP recipe

meta_test_webmcp
  └─ discovery + schema + execution + visible-state checks

meta_export_webmcp
  └─ standalone repository ZIP from the same ToolSpec[]
```

The same tool contract drives immediate execution and native export. There is no separate hard-coded export model. Browser-derived recipes use MCP references while the session is open and accessible-name/item-context resolution after installation in an owned page. When target source is available, the export also bundles the target page and assets, installs the generated module into the top-level document, and retains a separate integration report for review. The browser suite exercises both virtual execution and standalone native exports.

## ToolSpec

Every capability carries:

- A stable tool name and concise description.
- A JSON object input schema.
- A risk classification: `read`, `write`, or `consequential`.
- Evidence references such as selectors, labels, accessible references, and observed item identifiers.
- Sample arguments for runtime evaluation.
- One deterministic executor.

Supported executor types:

- `dom-form`
- `dom-action-group`
- `dom-button`
- `dom-read`
- `mcp-recipe`

The Browser MCP recipe language is not arbitrary JavaScript. Each step names an allowlisted MCP tool and validated JSON arguments; string templates can interpolate only declared input keys.

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
WebMCP agent
    │ semantic tool call
    ▼
MetaWebMCP top-level generated tool
    │ shared allowlisted recipe interpreter
    ▼
Page-scoped MCP client ── same-origin /mcp
          or
Node workspace bridge ── configured MCP endpoint
    │ tools/call
    ▼
Isolated Playwright MCP server
    │ browser action
    ▼
Third-party site
```

Initial analysis owns the `browser_navigate` and `browser_snapshot` calls. MetaWebMCP parses interactive roles and references into candidate semantic tools, whose recipes can use only snapshot, type, click, select, and wait operations. Caller-provided recipes cannot navigate or open URL-bearing tabs.

On the hosted path, one `BrowserMcpSession` instance lives in the top-level page. It retains the MCP session identifier across analysis and every generated semantic tool call, then closes that session on reset. This aligns browser lifetime with the ChatGPT-opened page and avoids depending on process-local state in a serverless deployment.

The Node deployment remains compatible with a separate Playwright MCP service. In that layout, each open page receives a random workspace identifier and a distinct server-side client/session. Resetting or expiring one workspace closes only that session. Both layouts use the same MCP client and recipe interpreter.

The public deployment mounts Cloudflare's Playwright MCP agent as a Durable Object alongside the static application. Its Browser Run binding creates an isolated, non-persistent browser context. A long-lived SSE connection ties that context to the page; reset and page teardown issue `browser_close`. Same-origin checks and an edge rate-limit binding guard the transport route. The agent advertises only the eight operations used by the product and evidence capture. Transport validation checks explicit navigation targets, while browser-context routing blocks direct local, private, reserved, and common metadata destinations reached through redirects or page actions.

This is a virtual, session-scoped adapter. It does not modify the third-party origin or claim that the target itself is natively WebMCP-compatible.

Export is a separate, source-owner path: the generated module interprets the reviewed recipe against the owned page's normal controls. It does not include MetaWebMCP and does not need a browser MCP service. Item-scoped actions resolve within the matching visible item's container and fail closed if that item is no longer present.

## Generated repository

`lib/generator.mjs` serializes the reviewed ToolSpec array into a standalone module. The generated module:

- Calls `document.modelContext.registerTool` directly.
- Preserves the normal interface when WebMCP is absent.
- Uses one `AbortController` per tool.
- Sets read-only and untrusted-content annotations.
- Implements the same deterministic executor types.
- Executes browser-derived form and item recipes through constrained owned-page DOM lookups, with an optional explicit browser bridge.
- Documents where source owners should replace selectors with application functions.

The dependency-free ZIP implementation uses stored entries, UTF-8 filenames, CRC32, central directory records, and safe relative paths.

## Why the core has no dependencies

The hackathon demonstration needs a reliable deployment more than a broad framework. Node 20+ provides the HTTP server, `fetch`, Web Streams, DNS APIs, and cryptography needed here. Avoiding package installation reduces supply-chain and deployment failure modes while keeping the generated output legible to judges.
