# Cloudflare deployment

This deployment serves the MetaWebMCP application and its analysis/export APIs. Third-party analysis defaults to snapshots supplied by the calling agent, so the public service does not need to allocate a browser. An isolated Playwright MCP runtime remains available as an explicit opt-in.

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
- The Worker handles `/health`, analysis, export, and expiring ZIP downloads.
- `PlaywrightMCP` is a Durable Object backed by the Browser Run binding.
- `ExportStore` is a SQLite-backed Durable Object that retains bounded, expiring ZIP archives with atomic owner claims.
- When hosted browsing is enabled, the page uses the package's SSE endpoint so one control connection remains open for the life of the browser session.
- `HOSTED_BROWSER_ENABLED=0` disables the MCP transport routes by default. Set it to `1` only when the account has suitable Browser Run capacity and abuse monitoring.
- Browser transport requests require a same-origin, short-lived signed capability stored in an HttpOnly SameSite cookie and are limited to 60 requests per source IP per minute.
- Browser HTTP traffic is intercepted and fulfilled through the Worker's public-Internet `fetch()` path with manual redirects, a 20-second per-request deadline, a 2 MB request cap, and an 8 MB response cap. Worker contexts, service workers, and direct socket APIs are disabled rather than allowed to bypass that route.
- Anonymous HTML and URL analysis is limited to 30 requests per source IP per minute. URL fetches share one 12-second deadline across redirects, and Worker fetches use public Internet routing rather than zone-origin routing.
- Export creation and download require that same page capability. Creation has a separate limit of twelve requests per source IP per minute. The shared store retains at most eight archives and 16 MB, with a fair-share cap of two archives and 6 MB per keyed source. It rejects archives over 3 MB, expires them within twenty minutes, and atomically deletes each archive after its owner retrieves it.
- Generated recipes still pass through MetaWebMCP's narrow tool allowlist; the raw browser tool surface is not registered with WebMCP.

## Compatibility pins

`@cloudflare/playwright-mcp` is the current Cloudflare MCP package, but its published dependency ranges resolve obsolete Browser Run and agent clients. The deployment overrides those clients with `@cloudflare/playwright@1.3.6` and `agents@0.22.0`; the latter also resolves the reviewed MCP SDK 1.30.0. The compatibility patch creates the MCP connection inside each Durable Object instance because the published factory otherwise shares one protocol server across transports. It also adapts current response-tracked snapshots and locator APIs, keeps screenshots in memory, enforces the deployment tool allowlist, and requires `blockPrivate` deployments to provide the connection-level request handler used here. The postinstall check covers both ESM and CommonJS builds, verifies the runtime pins and per-instance server behavior, and fails if upstream shapes change instead of silently applying an unsafe patch.

The filesystem shim covers a legacy import in the MCP package. It throws if reached; the configured CDP browser-context path does not use persistent filesystem access.

## Smoke checks

After deployment:

```bash
curl https://metawebmcp.neuryta.com/health
```

The healthy response includes `deploymentVersion`, `sourceCommit`, `deployedAt`, and `deploymentTag`. Evidence capture rejects the deployment if those live values do not match the expected source.

Then open the site, choose **Any public site**, leave **Calling agent supplies snapshot** selected, and analyze a snapshot captured from a public target. This path should work while `/health` reports `browserMcpConfigured: false`.

To smoke-test the optional hosted runtime, deploy with `HOSTED_BROWSER_ENABLED=1`, select **Hosted Browser MCP**, and analyze a public HTTP or HTTPS target. A healthy enabled deployment reports the runtime as connected and preserves one isolated session through generated-tool execution and reset.
