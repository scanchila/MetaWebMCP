# Security model

MetaWebMCP is an experimental compatibility studio. It processes untrusted websites and generates code that can act on those websites. Treat every generated integration as a review artifact, not as automatically production-safe code.

## Defenses implemented

### Server-side target fetching

- Only absolute HTTP and HTTPS URLs are accepted.
- Embedded URL credentials are rejected.
- `localhost`, `.local`, direct private IPs, loopback, link-local, carrier-grade NAT, documentation ranges, multicast, and reserved ranges are blocked.
- DNS answers are checked and a target is rejected if any answer resolves to a blocked range.
- Every redirect destination is validated again.
- Redirect count, request duration, response size, and accepted content types are capped.
- `ALLOW_PRIVATE_TARGETS=1` exists only for deliberate local development.

These controls reduce, but do not mathematically eliminate, DNS-rebinding and network-side race risks. A hardened public deployment should add egress policy at the container or VPC layer.

### Browser MCP bridge

- The MCP endpoint is deployment configuration, not a user-provided URL.
- A same-origin deployment gives each open page its own MCP transport session and closes it on reset. The Node fallback keys distinct server-side sessions by unguessable workspace identifiers and expires inactive clients.
- The Node bridge performs DNS and private-network validation before analysis navigation. Navigation is not available to caller-supplied generated recipes.
- The Cloudflare transport rejects non-HTTP schemes, credentials, local names, direct private/reserved IPs, and common metadata hostnames. Browser-context routing applies the same direct-target checks to requests caused by redirects and page actions.
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
- The supplied Compose service uses an isolated, headless browser profile and omits image responses.

Playwright MCP and application-layer hostname checks are not complete network boundaries: DNS rebinding and environment-specific name resolution still require infrastructure controls. Use an isolated runtime with restricted egress, no cloud metadata access, no host filesystem mounts, and no persistent authenticated browser profile.

A public same-origin MCP route is a powerful resource even when the product UI exposes only semantic generated tools. The Cloudflare deployment rejects cross-origin browser transport requests, limits them to 60 requests per source IP per minute, uses the account's browser quotas, and closes browser contexts on reset or page teardown. Production operators should also monitor abuse and account-level consumption.

### Generated tool execution

- Tool names, descriptions, input schemas, and executor types are validated.
- Runtime inputs are checked against their JSON schemas, including required fields, primitive types, enumerations, arrays, and unknown properties.
- Consequential tools are never auto-executed in the public studio.
- Browser MCP write recipes are skipped by automated tests pending explicit review.
- Native item-scoped exports require the selected item context to remain present and fail instead of falling back to another same-label control.
- Target content is returned under `untrustedContentHint`.
- Risk inference is visible and explicitly documented as requiring review.
- Dynamic generated tools can be removed independently via `AbortController`.

### Browser application

- A restrictive Content Security Policy allows only same-origin scripts, styles, frames, and network connections.
- The top-level page has no inline script or external CDN dependency.
- Generated target labels are inserted with `textContent`, not HTML.
- Static file paths are normalized and constrained to the public root.
- Download artifacts are held in memory and expire after twenty minutes.
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
