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

The same tool contract drives immediate execution and native export. There is no separate hard-coded export model. When target source is available, the export also bundles the target page and assets, installs the generated module into the top-level document, and retains a separate integration report for review. The controlled demo exercises both the virtual adapter and this standalone native export.

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
    │ POST /api/mcp/execute
    ▼
MCP Streamable HTTP client
    │ tools/call
    ▼
Isolated Playwright MCP server
    │ browser action
    ▼
Third-party site
```

Initial analysis uses `browser_navigate` and `browser_snapshot`. MetaWebMCP parses interactive roles and references into candidate semantic tools. Execution is constrained to an allowlist in `server.mjs`.

Each open MetaWebMCP workspace receives a random workspace identifier and a distinct server-side MCP client/session. Resetting or expiring one workspace closes only that session, preventing browser state from leaking between concurrent users.

This is a virtual, session-scoped adapter. It does not modify the third-party origin or claim that the target itself is natively WebMCP-compatible.

## Generated repository

`lib/generator.mjs` serializes the reviewed ToolSpec array into a standalone module. The generated module:

- Calls `document.modelContext.registerTool` directly.
- Preserves the normal interface when WebMCP is absent.
- Uses one `AbortController` per tool.
- Sets read-only and untrusted-content annotations.
- Implements the same deterministic executor types.
- Documents where source owners should replace selectors with application functions.

The dependency-free ZIP implementation uses stored entries, UTF-8 filenames, CRC32, central directory records, and safe relative paths.

## Why the core has no dependencies

The hackathon demonstration needs a reliable deployment more than a broad framework. Node 20+ provides the HTTP server, `fetch`, Web Streams, DNS APIs, and cryptography needed here. Avoiding package installation reduces supply-chain and deployment failure modes while keeping the generated output legible to judges.
