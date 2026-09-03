# Security model

MetaWebMCP is an experimental compatibility studio. It processes untrusted websites and generates code that can act on those websites. Treat every generated integration as a review artifact, not as automatically production-safe code.

## Defenses implemented

### Server-side target fetching

- Only absolute HTTP and HTTPS URLs are accepted.
- Embedded URL credentials are rejected.
- `localhost`, `.local`, direct private IPs, loopback, link-local, carrier-grade NAT, documentation ranges, multicast, and reserved ranges are blocked.
- DNS answers are checked and a target is rejected if any answer resolves to a blocked range.
- The Node runtime connects to one address from that validated answer set while preserving the original HTTP Host header and TLS SNI.
- Every redirect destination is validated again.
- Redirect count, request duration, response size, and accepted content types are capped.
- `ALLOW_PRIVATE_TARGETS=1` exists only for deliberate local development of static HTML fetching; it does not relax Browser MCP egress.

The supplied Node path therefore does not perform a second hostname resolution between validation and connection. Container or VPC egress policy remains useful defense in depth on a public deployment.

### Browser MCP bridge

- The MCP endpoint is deployment configuration, not a user-provided URL.
- A same-origin deployment gives each open page its own MCP transport session and closes it on reset. The Node fallback keys distinct server-side sessions by unguessable workspace identifiers and expires inactive clients.
- Browser target validation rejects non-HTTP schemes and credentials, then applies a shared policy for local names, private/reserved IPs, IPv4-mapped and translation-prefix forms, common metadata names, and known wildcard-DNS aliases.
- The Node bridge performs DNS and private-network validation before analysis navigation and validates a reported final navigation URL. Navigation is not available to caller-supplied generated recipes.
- Node Browser MCP remains disabled unless `BROWSER_MCP_EGRESS_ISOLATED=1` declares an enforced runtime boundary. The declaration is a fail-closed configuration guard, not the boundary itself.
- The supplied Compose Playwright container has only an internal Docker network. Chromium's HTTP/HTTPS route is a forward proxy that validates every connection's full DNS answer set, permits only ports 80 and 443, and connects to one already-validated address. Chromium's implicit loopback and link-local proxy bypass is removed.
- The Cloudflare transport applies the shared direct-target policy, then fulfills every Browser Rendering HTTP request through the Worker's public-Internet `fetch()` path. Redirects are manual so Chromium's next request crosses the same boundary; response and request sizes and request duration are capped.
- Cloudflare Browser Rendering worker contexts, service-worker loads, and direct WebSocket, WebTransport, and WebRTC paths are disabled so page code cannot bypass the guarded HTTP route.
- `BROWSER_ALLOWED_ORIGINS` can constrain initial navigation.
- Generated recipes contain at most twelve steps.
- Only the following MCP tools can be called by recipes:
  - `browser_snapshot`
  - `browser_type`
  - `browser_click`
  - `browser_select_option`
  - `browser_wait_for`
- The Cloudflare Browser MCP transport advertises only navigation, snapshot, type, click, select, wait, close, and inline screenshot operations; calls outside that set are rejected before they reach the browser service.
- Arbitrary browser evaluation is deliberately excluded.
- The supplied Compose service runs sandboxed Chromium as the non-root `node` user under Playwright's user-namespace seccomp profile. Its root filesystem is read-only, capabilities are dropped except for the sandbox's `SYS_CHROOT` requirement, writable state is limited to bounded temporary filesystems, and image responses are omitted.

Playwright MCP origin filters and application-layer hostname checks are not complete network boundaries. The supplied Cloudflare and Compose paths add lower network controls covering redirects and subresources. Other Browser MCP endpoints must independently enforce equivalent private-network egress before `BROWSER_MCP_EGRESS_ISOLATED=1` is set. Keep browser runtimes isolated, without host filesystem mounts or persistent authenticated profiles.

A public same-origin MCP route is a powerful resource even when the product UI exposes only semantic generated tools. The Cloudflare deployment rejects cross-origin browser transport requests, limits them to 60 requests per source IP per minute, uses the account's browser quotas, and closes browser contexts on reset or page teardown. Production operators should also monitor abuse and account-level consumption.

### Generated tool execution

- Tool names, descriptions, input schemas, and executor types are validated.
- Runtime inputs are checked against their JSON schemas, including required fields, primitive types, enumerations, arrays, and unknown properties.
- Consequential tools are never auto-executed in the public studio.
- Browser MCP write recipes are skipped by automated tests pending explicit review.
- Native item-scoped exports require the selected item context to remain present and fail instead of falling back to another same-label control.
- Target content is returned under `untrustedContentHint`.
- Generated `AGENTS.md` guidance is fixed text; target metadata remains in JSON data files and is normalized when displayed in other Markdown artifacts.
- Bundled owner files cannot replace generated repository policy, manifest, runtime, report, or evaluation paths.
- Risk inference is visible and explicitly documented as requiring review.
- Reviewed risk overrides can only preserve or increase the inferred severity; callers cannot downgrade write or consequential actions.
- Dynamic generated tools can be removed independently via `AbortController`.

### Browser application

- A restrictive Content Security Policy allows only same-origin scripts, styles, frames, and network connections.
- The top-level page has no inline script or external CDN dependency.
- Generated target labels are inserted with `textContent`, not HTML.
- Static file paths are normalized and constrained to the public root.
- Export creation and download require the page's signed capability. Download URLs are bound to their creating page; retained archive bytes are deleted following a successful retrieval.
- The Node runtime retains at most eight pending archives and 16 MB of archive buffers, rejects archives over 3 MB, limits generation to twelve requests per minute, and expires pending downloads within twenty minutes.
- The Cloudflare runtime applies a separate twelve-per-minute-per-source-IP export limit. Its SQLite-backed Durable Object retains at most eight pending archives and 16 MB globally, with no more than two archives or 6 MB assigned to one keyed source. It rejects archives over 3 MB, expires them within twenty minutes, binds them to the creating page capability, and atomically deletes each archive after retrieval.
- Bundled owner-source file names and total sizes are validated before they are written into an export archive.

## Known limitations

- HTML analysis is heuristic and does not prove business semantics.
- Risk classification is linguistic inference, not authorization policy.
- DOM selectors can drift and can target the wrong control after a redesign.
- Accessible-name compatibility lookups in browser-derived exports can drift; install them only in owned source and replace them with stable application functions before production use.
- The target may contain prompt injection intended to manipulate the calling agent.
- Target interactions can reach other public origins; source owners must review each resulting workflow and deploy browser services with outbound controls.
- Generated tools run with the page's signed-in authority; they must not bypass normal application permissions or confirmations.
- The demo's internal WebMCP registry is for fallback execution and testing, not a replacement for the browser's native implementation.

## Production hardening checklist

1. Replace DOM actuation with existing typed application functions.
2. Recheck authentication and authorization inside every generated handler.
3. Require explicit human review for writes and confirmation for consequential actions.
4. Add outbound network policy and deny metadata endpoints outside the application layer.
5. Isolate each browser session and expire all state.
6. Treat target text, tool descriptions, and tool results as untrusted data.
7. Add organization-specific audit logs and rate limits.
8. Run journey-level evaluations against every supported application release.
9. Pin and scan the Playwright MCP image before production deployment.
10. Do not deploy with `ALLOW_PRIVATE_TARGETS=1`.
