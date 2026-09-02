# MetaWebMCP

**A WebMCP application that creates other WebMCP applications.**

MetaWebMCP exposes a permanent WebMCP control plane that lets an agent inspect a website, turn observed workflows into narrow semantic tools, register those tools immediately on the same top-level page, verify their execution, and export a standalone native integration repository.

The central demonstration is recursive:

```text
ChatGPT / a WebMCP agent
        │
        │ calls MetaWebMCP's seven permanent tools
        ▼
MetaWebMCP control plane
        │ analyze → contract → activate → test → export
        ▼
Dynamically registered domain tools
        │
        │ find_sessions / add_session_to_itinerary / ...
        ▼
An ordinary website that initially had no WebMCP tools
```

No model API key is required. The browser agent supplies the reasoning and calls the meta-tools. MetaWebMCP handles deterministic discovery, contracts, runtime registration, execution, tests, and code generation.

![MetaWebMCP recursive end-to-end run](test-artifacts/metawebmcp-e2e.png)

## What is included

- A polished, top-level MetaWebMCP workspace.
- Seven permanent imperative WebMCP tools:
  - `meta_analyze_site`
  - `meta_create_webmcp`
  - `meta_activate_webmcp`
  - `meta_test_webmcp`
  - `meta_export_webmcp`
  - `meta_get_state`
  - `meta_reset_workspace`
- A controlled “legacy” conference planner with no WebMCP implementation of its own.
- Live DOM analysis that derives four domain tools from that target.
- Dynamic registration and unregistration through `document.modelContext.registerTool(...)` and `AbortController`.
- A dependency-free native integration ZIP generator. The controlled demo export includes the target UI and executes as a standalone WebMCP site.
- URL and pasted-HTML analysis for site owners.
- An optional Streamable HTTP client for the official Playwright MCP server, used as the low-level runtime for third-party sites. Each open MetaWebMCP page receives an independent MCP transport session.
- SSRF defenses, an allowlisted browser recipe executor, risk annotations, and disabled consequential actions.
- Node unit tests and a Chromium end-to-end test that drives the full recursive sequence through a WebMCP-shaped browser mock.

## Run locally

Requirements: Node.js 20 or newer. There is no `npm install` step because the core application has no runtime dependencies.

```bash
npm start
# open http://localhost:8787
```

The controlled demo works immediately. Use the numbered actions or invoke the tools from a WebMCP-enabled agent:

```text
1. meta_analyze_site({ source: "demo", goal: "Find sessions and build an itinerary" })
2. meta_create_webmcp({})
3. meta_activate_webmcp({})
4. find_sessions({ query: "agent", level: "all", day: "all" })
5. add_session_to_itinerary({ item_id: "agent-evals-that-catch-regressions" })
6. meta_test_webmcp({})
7. meta_export_webmcp({ project_name: "relay-sessions-webmcp" })
```

After step 3, the top-level page contains eleven tools: seven meta-tools and four newly generated domain tools. The target iframe remains uninstrumented; all agent-facing registration occurs in the parent page.

## Modes

### Own the site

Choose one of three inputs:

- **Controlled legacy demo:** analyzes a live same-origin application, activates the generated tools, executes them, and exports native code.
- **Public URL:** safely fetches server-rendered HTML, extracts stable forms and action groups, and exports an integration pack.
- **Pasted HTML:** performs the same analysis without a network request.

A generated pack includes:

```text
<project>/
├── README.md
├── AGENTS.md
├── LICENSE
├── package.json
├── serve.mjs
├── index.html
├── integration-report.html
├── target.css                 # when target source was bundled
├── target.js                  # when target source was bundled
├── src/
│   ├── webmcp.generated.js
│   └── tool-spec.json
├── metawebmcp-report.json
└── tests/manual-evals.md
```

The generated module contains direct `document.modelContext.registerTool(...)` calls. For the controlled demo and pasted HTML, `index.html` includes the target UI with that module installed, so the exported repository can be run and tested immediately. DOM adapters remain an installation bridge; in an owned repository, replace clicks and selectors with existing client functions, stores, API clients, and permission checks.

### Use any site

MetaWebMCP can connect to a standard Streamable HTTP browser MCP endpoint. The generated WebMCP tools stay semantic; low-level `browser_snapshot`, `browser_type`, `browser_click`, and related calls remain hidden behind the adapter.

Start both services with Docker Compose:

```bash
docker compose up --build
# MetaWebMCP: http://localhost:8787
# Playwright MCP: http://localhost:8931/mcp
```

Or start Playwright MCP separately:

```bash
npx @playwright/mcp@latest \
  --headless \
  --browser chromium \
  --isolated \
  --image-responses omit \
  --port 8931

BROWSER_MCP_URL=http://127.0.0.1:8931/mcp npm start
```

The public server validates initial URLs, blocks private/reserved networks by default, and can restrict initial browser targets with `BROWSER_ALLOWED_ORIGINS`. Playwright MCP itself is not a security boundary. Run it in an isolated container or equivalent sandbox and do not give the public demo persistent authenticated profiles.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `BROWSER_MCP_URL` | empty | Streamable HTTP endpoint, normally `http://127.0.0.1:8931/mcp` |
| `MCP_SESSION_TTL_MS` | `1200000` | Inactivity timeout for each page-scoped Browser MCP client |
| `ALLOW_PRIVATE_TARGETS` | `0` | Local development override; never enable on a public deployment |
| `BROWSER_ALLOWED_ORIGINS` | empty | Optional comma-separated initial target origin allowlist |

## Tests

```bash
npm run check
npm run test:unit
npm run test:e2e
npm test
```

The end-to-end test launches the included server and an available Chromium build, injects a minimal implementation of the current imperative `registerTool`, `getTools`, and `executeTool` contract, and invokes every operation through that registered surface. It verifies:

1. Seven control-plane tools register.
2. The legacy target has no registered WebMCP tools.
3. Live analysis produces evidence-backed capabilities.
4. Activation increases the parent registry from seven to eleven tools.
5. Generated semantic tools mutate and read real target state.
6. Deterministic evals pass.
7. The exported ZIP opens and contains directly registered WebMCP source.
8. The extracted repository registers and executes its four generated WebMCP tools against the bundled target UI.

The unit/integration suite also verifies that Browser MCP transport sessions are isolated per MetaWebMCP workspace.

See [`TEST_REPORT.md`](TEST_REPORT.md) for the exact environment and latest run.

## Design constraints

- MetaWebMCP uses the imperative API on the top-level page. It does not depend on tool discovery inside an iframe.
- Generated tools are small and domain-specific rather than exposing an entire browser MCP tool surface.
- Target content and generated metadata are treated as untrusted.
- Consequential tools can be generated for review but are not automatically executed in the public studio.
- Browser MCP recipes are restricted to a small allowlist and have a maximum step count.
- The static analyzer is intentionally conservative. Client-rendered sites should use Browser MCP mode.
- The app remains usable as an ordinary human interface where WebMCP is not present; its internal registry provides the same deterministic demo path.

## Deployment

The repository includes:

- `Dockerfile` for any container host.
- `render.yaml` for a basic Render deployment.
- `docker-compose.yml` for MetaWebMCP plus Playwright MCP.
- GitHub Actions CI for static, unit, and Chromium end-to-end tests.

For the hackathon demo, deploy MetaWebMCP at a stable HTTPS URL. The controlled recursive path does not require the Browser MCP sidecar, so it can run on a small single-container host. Add the sidecar only for the “any site” path.

## Repository guide

```text
lib/analyzer.mjs             conservative HTML and accessibility-tree analysis
lib/generator.mjs            native integration repository generator
lib/mcp-http-client.mjs      dependency-free Streamable HTTP MCP client
lib/security.mjs             URL, DNS, redirect, and network validation
lib/zip.mjs                  dependency-free ZIP writer
public/js/app.js             meta-tool control plane and UI state machine
public/js/webmcp-runtime.js  dual internal/native registry and executors
public/demo/                 target application with no WebMCP registration
tests/                       unit and full recursive browser tests
```

More detail is in [`ARCHITECTURE.md`](ARCHITECTURE.md), [`SECURITY.md`](SECURITY.md), and [`DEVPOST.md`](DEVPOST.md).

## License

MIT.

## Primary references

- WebMCP imperative API: https://developer.chrome.com/docs/ai/webmcp/imperative-api
- ChatGPT site tools: https://learn.chatgpt.com/docs/webmcp
- WebMCP draft specification: https://webmachinelearning.github.io/webmcp/
- Playwright MCP: https://github.com/microsoft/playwright-mcp
