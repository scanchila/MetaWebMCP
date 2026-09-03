# Cloudflare deployment

This deployment serves the MetaWebMCP application, its analysis and export APIs, and an isolated Playwright MCP browser runtime from one HTTPS origin.

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
- The page uses the package's SSE endpoint so one control connection remains open for the life of the browser session.
- Browser transport requests require a same-origin, short-lived signed capability stored in an HttpOnly SameSite cookie and are limited to 60 requests per source IP per minute.
- Browser HTTP traffic is intercepted and fulfilled through the Worker's public-Internet `fetch()` path with manual redirects, a 20-second per-request deadline, a 2 MB request cap, and an 8 MB response cap. Worker contexts, service workers, and direct socket APIs are disabled rather than allowed to bypass that route.
- Anonymous HTML and URL analysis is limited to 30 requests per source IP per minute. URL fetches share one 12-second deadline across redirects, and Worker fetches use public Internet routing rather than zone-origin routing.
- Export creation and download require that same page capability. Creation has a separate limit of twelve requests per source IP per minute, and archive bytes are stored in the Cache API rather than Worker process memory and deleted after retrieval.
- Generated recipes still pass through MetaWebMCP's narrow tool allowlist; the raw browser tool surface is not registered with WebMCP.

## Compatibility pins

`@cloudflare/playwright-mcp` is the current Cloudflare MCP package, but its published dependency range resolves an obsolete Browser Run client. The deployment overrides that client with `@cloudflare/playwright@1.3.6`. The current client requires response tracking to keep accessibility refs actionable and returns `{ full, incremental }` from `_snapshotForAI()`, while the MCP package expects the former untracked string result. Current locators also resolve tracked refs through `_resolveSelector()` and expose a public string representation instead of the package's former private `_generateLocatorString()` helper. Screenshot responses stay in memory because the Worker runtime has no persistent filesystem. The package's origin filters are not a network security boundary, so the compatibility patch also requires `blockPrivate` deployments to provide the connection-level request handler used here. The postinstall check applies these narrow adaptations to the package's ESM and CommonJS builds, and installation fails if the upstream shapes change instead of silently applying an unsafe patch.

The filesystem shim covers a legacy import in the MCP package. It throws if reached; the configured CDP browser-context path does not use persistent filesystem access.

## Smoke checks

After deployment:

```bash
curl https://metawebmcp.neuryta.com/health
```

The healthy response includes `deploymentVersion`, `sourceCommit`, `deployedAt`, and `deploymentTag`. Evidence capture rejects the deployment if those live values do not match the expected source.

Then open the site, choose **Any public site**, and analyze a public HTTP or HTTPS target. A healthy deployment reports the browser runtime as connected and preserves the same session through generated-tool execution and reset.
