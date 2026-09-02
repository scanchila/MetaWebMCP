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
npm run deploy
```

The checked-in configuration publishes `metawebmcp.neuryta.com`. Change `routes` and the Worker name before deploying a fork.

## Runtime layout

- Cloudflare Static Assets serves `public/`.
- The Worker handles `/health`, analysis, export, and expiring ZIP downloads.
- `PlaywrightMCP` is a Durable Object backed by the Browser Run binding.
- The page uses the package's SSE endpoint so one control connection remains open for the life of the browser session.
- Browser transport requests require a same-origin browser request and are limited to 60 requests per source IP per minute.
- Generated recipes still pass through MetaWebMCP's narrow tool allowlist; the raw browser tool surface is not registered with WebMCP.

## Compatibility pins

`@cloudflare/playwright-mcp` is the current Cloudflare MCP package, but its published dependency range resolves an obsolete Browser Run client. The deployment overrides that client with `@cloudflare/playwright@1.3.6`. The current client returns `{ full, incremental }` from `_snapshotForAI()`, while the MCP formatter expects the former string result, so the postinstall check applies that narrow return-shape adaptation. Installation fails if the upstream formatter changes instead of silently applying an unsafe patch.

The filesystem shim covers a legacy import in the MCP package. It throws if reached; the configured CDP browser-context path does not use persistent filesystem access.

## Smoke checks

After deployment:

```bash
curl https://metawebmcp.neuryta.com/health
```

Then open the site, choose **Use any site**, and analyze a public HTTP or HTTPS target. A healthy deployment reports the browser runtime as connected and preserves the same session through generated-tool execution and reset.
