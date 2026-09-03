# Cloudflare deployment

This deployment serves the MetaWebMCP application, its analysis/export APIs, and the isolated browser behind the URL-first website viewer. The page displays an inline target screenshot and accessibility model while generated recipes operate the same session. Agents that already control an authorized browser may still supply observations through the tool API.

## Deploy

Requirements:

- A Cloudflare account with Workers, Browser Rendering, Durable Objects, Static Assets, and Rate Limiting enabled.
- Node.js 22.18 or newer.
- A scoped API token available as `CLOUDFLARE_API_TOKEN`.

```bash
cd deploy/cloudflare
npm ci
npm run check
npx wrangler secret put MCP_CAPABILITY_SECRET
export META_WEBMCP_SOURCE_COMMIT=$(git rev-parse HEAD)
npm run deploy
```

Set `MCP_CAPABILITY_SECRET` to a randomly generated value of at least 32 bytes. The deployment wrapper requires a clean worktree, verifies that `META_WEBMCP_SOURCE_COMMIT` exactly matches `HEAD`, and publishes that commit with Cloudflare's immutable Worker version metadata. The checked-in configuration publishes `metawebmcp.neuryta.com`. Change `routes` and the Worker name before deploying a fork.

## Runtime layout

- Cloudflare Static Assets serves `public/` through the Worker so document security headers apply on every route.
- The Worker handles `/health`, analysis, export, expiring ZIP downloads, and tokenized presentation workspaces.
- `PlaywrightMCP` is a Durable Object backed by the Browser Run binding.
- `ExportStore` is a SQLite-backed Durable Object that retains bounded, expiring ZIP archives with atomic owner claims.
- `SharedWorkspaceStore` is a SQLite-backed Durable Object per presentation workspace. It retains one sanitized, revisioned controlled-demo snapshot for one hour and enforces separate author/viewer capability hashes.
- The page uses the package's SSE endpoint so one control connection remains open for the life of the browser session.
- The showcase sets `HOSTED_BROWSER_ENABLED=1` for the in-site viewer. Set it to `0` when a deployment does not have suitable Browser Run capacity and abuse monitoring; the controlled sample and tool-only observation inputs continue to work.
- The showcase selects Chromium with `HOSTED_BROWSER_ENGINE=chromium`. Kitesurf remains available as an opt-in beta engine, but deployments should test target compatibility before selecting `HOSTED_BROWSER_ENGINE=kitesurf`.
- Browser transport requests require a same-origin, short-lived signed capability stored in an HttpOnly SameSite cookie and are limited to 60 requests per source IP per minute.
- Browser HTTP traffic is intercepted and fulfilled through the Worker's public-Internet `fetch()` path with manual redirects, a 20-second per-request deadline, a 2 MB request cap, and an 8 MB response cap. Worker contexts, service workers, and direct socket APIs are disabled rather than allowed to bypass that route.
- Anonymous HTML and URL analysis is limited to 30 requests per source IP per minute. URL fetches share one 12-second deadline across redirects, and Worker fetches use public Internet routing rather than zone-origin routing.
- Export creation and download require that same page capability. Creation has a separate limit of twelve requests per source IP per minute. The shared store retains at most eight archives and 16 MB, with a fair-share cap of two archives and 6 MB per keyed source. It rejects archives over 3 MB, expires them within twenty minutes, and atomically deletes each archive after its owner retrieves it.
- Presentation creation requires a same-origin page capability and is limited to twelve requests per source IP per minute. Reads and writes have a separate 240-request limit and require the corresponding 256-bit bearer capability; raw tokens remain in URL fragments and are never stored by the Durable Object.
- Generated recipes still pass through MetaWebMCP's narrow tool allowlist; the raw browser tool surface is not registered with WebMCP.

## Compatibility pins

`@cloudflare/playwright-mcp` is the current Cloudflare MCP package, but its published dependency ranges resolve obsolete Browser Run and agent clients. The deployment overrides those clients with `@cloudflare/playwright@1.3.6` and `agents@0.22.0`; the latter also resolves the reviewed MCP SDK 1.30.0. The compatibility patch creates the MCP connection inside each Durable Object instance because the published factory otherwise shares one protocol server across transports. It also adapts current response-tracked snapshots, locator APIs, and Kitesurf's viewport-free screenshot response, keeps screenshots in memory, enforces the deployment tool allowlist, and requires `blockPrivate` deployments to provide the connection-level request handler used here. The postinstall check covers both ESM and CommonJS builds, verifies the runtime pins and per-instance server behavior, and fails if upstream shapes change instead of silently applying an unsafe patch.

The filesystem shim covers a legacy import in the MCP package. It throws if reached; the configured CDP browser-context path does not use persistent filesystem access.

## Smoke checks

After deployment:

```bash
curl https://metawebmcp.neuryta.com/health
```

The healthy response includes `deploymentVersion`, `sourceCommit`, `deployedAt`, and `deploymentTag`. Evidence capture rejects the deployment if those live values do not match the expected source.

Then open the workspace, enter a public HTTP or HTTPS target, and select **Open and inspect website**. A healthy deployment reports the hosted website viewer as ready, shows **Page view** and **Accessibility** tabs after analysis, and refreshes the visual after generated-tool execution. `/health` should report `browserMcpConfigured: true`.

Also choose **Use sample** once. The deterministic sample must remain usable even if Browser Run capacity is temporarily unavailable.
