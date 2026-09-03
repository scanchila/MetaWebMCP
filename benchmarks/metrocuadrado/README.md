# Metrocuadrado lazy-collection benchmark

## Result

Metrocuadrado provides a useful counterexample to the multipage FincaRaíz
result. Both cold-start arms returned the exact same oracle top 10, but direct
browser parsing finished in 114.470 seconds while the cold MetaWebMCP managing
agent took 159.678 seconds. On this one-page task, MetaWebMCP was 1.40× slower
by wall time.

| Arm | Quality gate | Browser calls | Wall time | Processed / non-cached tokens | Model-facing tool text |
|---|---:|---:|---:|---:|---:|
| Codex + direct browser parsing | 10/10 exact URLs, fields, and ranks | 5 | 114.470 s | 147,997 / 59,421 | 549,894 characters |
| MetaWebMCP managing agent (cold) | 10/10 exact URLs, fields, and ranks | 7 internal | 159.678 s | 319,868 / 46,332 | 133,952 characters |

Despite losing on wall time, MetaWebMCP still delivered a clear
**context-efficiency win**: it exposed **75.6% less model-facing tool-response
text** (a 4.11× reduction) and used **22.0% fewer non-cached tokens** (a 1.28×
reduction). It processed 2.16× more total tokens including cached context,
however, and made two analysis calls before authoring its valid collection
ToolSpec on the first attempt. The generated collection itself took 5.859
seconds. The fixed analysis and authoring cost did not amortize over a single
page, so direct inspection won by 45.208 seconds even though MetaWebMCP kept
far more raw page content out of the managing agent's context.

This result sharpens the expected crossover: a generated semantic collection
can pay off when it replaces many large snapshots, repeated parsing, or future
invocations. It should not be expected to reduce latency for every small
one-off page.

## Task

The source is Metrocuadrado's public Bogotá apartment-rental route ordered by
lower price. The benchmark considers all promoted and ordinary linked cards
rendered on the first page, then returns the 10 cheapest unique cards with:

1. At least two bedrooms.
2. Area from 45 m² through 100 m², inclusive.

It ranks by displayed monthly rent ascending, displayed area descending, then
canonical URL ascending. Tracking query parameters are removed before
deduplication. Combining promoted and ordinary streams, extracting typed card
fields, applying two filters, canonicalizing URLs, deduplicating, and applying
a custom stable tie-break makes this more than one site-filter call.

Metrocuadrado lazy-renders below-fold results. Both arms therefore used the
same fixed 1280×20000 viewport. The cold agent was told only to use the generic
bounded `pageCapture` grammar (`snapshotAfterNavigate: true`, `waitSeconds: 2`);
it still had to select the observed collection, choose parsers, construct the
filters and ranking, create the ToolSpec, activate it, and invoke it.

The exact prompts are in [`browser-prompt.md`](browser-prompt.md) and
[`metawebmcp-cold-prompt.md`](metawebmcp-cold-prompt.md). The shared result
contract is [`result.schema.json`](result.schema.json).

## Method

Fresh ephemeral Codex 0.150.1 processes used `gpt-5.6-sol` with maximum
reasoning, Chrome 147, Playwright MCP 0.0.55, empty working directories, no
user configuration, no repository instructions, and no apps. No generated
domain tool existed before the cold arm, and no warm trial preceded it.

The direct arm could call only `browser_navigate`, `browser_wait_for`, and
`browser_snapshot`. The MetaWebMCP arm could call only the five benchmark
meta-tools. Its stdio adapter delegated to the production analyzer, authoring
validator, registry, and collection runtime over the same browser MCP. The
adapter contained no Metrocuadrado ToolSpec, selectors, fields, filters,
parsers, or ranking logic.

Correctness is gated against separate deterministic accessibility-snapshot
oracles. Each oracle observed 53 unique listing links, of which 16 qualified.
Both candidates returned all 10 expected URLs with exact rent, bedroom, area,
and rank fields and no duplicates.

The quality gate is end to end. The captured generated tool preserved each
listing's `src_url` tracking query, and the managing agent removed it when
forming the schema-constrained final response. The run therefore proves that
the managed workflow canonicalized URLs, not that this ToolSpec encoded URL
canonicalization itself. A canonical-URL/deduplication primitive is the next
useful common parser addition if that normalization must be reusable inside
the registered tool.

An initial scoring pass exposed an oracle ambiguity: some image alternative
text carried stale area metadata that disagreed with the explicit card row.
The retained oracle gives precedence to visible `hab.` and `m²` card markers,
falls back to image text only when those markers are absent, and has a
regression test for the conflict. The corrected cold oracle was captured 55
seconds after that arm completed; its expected rows were identical to the
direct arm's subsequent adjacent oracle.

This is one matched trial per arm on a volatile third-party page. Completeness
means the linked cards rendered in the fixed first-page viewport, not every
listing in Metrocuadrado. It is a crossover observation, not a general
performance estimate.

## Artifacts

- [`2026-09-04-metawebmcp-cold-run.json`](2026-09-04-metawebmcp-cold-run.json):
  cold environment, isolation, hashes, timing, calls, tokens, and comparison.
- [`2026-09-04-metawebmcp-cold-result.json`](2026-09-04-metawebmcp-cold-result.json)
  and [`2026-09-04-metawebmcp-cold-score.json`](2026-09-04-metawebmcp-cold-score.json):
  cold candidate and exact score.
- [`2026-09-04-metawebmcp-cold-oracle.json`](2026-09-04-metawebmcp-cold-oracle.json):
  corrected point-in-time oracle paired with the cold result.
- [`2026-09-04-metawebmcp-cold-trace.json`](2026-09-04-metawebmcp-cold-trace.json):
  meta-tool calls, generated ToolSpec, internal browser calls, and execution.
- [`2026-09-04-browser-fresh-run.json`](2026-09-04-browser-fresh-run.json):
  direct environment, isolation, timing, calls, tokens, and comparison.
- [`2026-09-04-browser-fresh-result.json`](2026-09-04-browser-fresh-result.json),
  [`2026-09-04-browser-fresh-score.json`](2026-09-04-browser-fresh-score.json),
  and [`2026-09-04-browser-fresh-oracle.json`](2026-09-04-browser-fresh-oracle.json):
  direct candidate, exact score, and adjacent oracle.

Raw CLI event logs are not retained because they can contain model reasoning;
their SHA-256 digests are recorded in the run manifests.

## Reproduce

Start an isolated browser MCP with the fixed viewport:

```bash
npx --yes @playwright/mcp@0.0.55 \
  --headless \
  --port 8936 \
  --host localhost \
  --executable-path /usr/bin/google-chrome \
  --isolated \
  --image-responses omit \
  --snapshot-mode full \
  --viewport-size 1280x20000
```

Capture an oracle and run the cold managing-agent arm from an empty temporary
working directory:

```bash
node scripts/capture-metrocuadrado-benchmark.mjs \
  --endpoint http://localhost:8936/sse \
  --output benchmarks/metrocuadrado/oracle.json

repo_root=$(pwd)
cold_work=$(mktemp -d)
codex exec \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --skip-git-repo-check \
  --approve-for-me \
  --disable apps \
  --json \
  -C "$cold_work" \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="max"' \
  -c 'mcp_servers.metawebmcp.command="node"' \
  -c "mcp_servers.metawebmcp.args=[\"$repo_root/scripts/serve-metawebmcp-cold-benchmark.mjs\",\"--browser-endpoint\",\"http://localhost:8936/sse\",\"--trace\",\"/tmp/metrocuadrado-metawebmcp-trace.json\",\"--benchmark\",\"metrocuadrado-cheapest-visible-v1\"]" \
  --output-schema "$repo_root/benchmarks/metrocuadrado/result.schema.json" \
  --output-last-message /tmp/metrocuadrado-metawebmcp-result.json \
  - < "$repo_root/benchmarks/metrocuadrado/metawebmcp-cold-prompt.md" \
  > /tmp/metrocuadrado-metawebmcp-events.jsonl

node scripts/score-metrocuadrado-benchmark.mjs \
  --oracle benchmarks/metrocuadrado/oracle.json \
  --candidate /tmp/metrocuadrado-metawebmcp-result.json \
  --output benchmarks/metrocuadrado/metawebmcp-cold-score.json
```

Run the direct arm against a fresh isolated server or reset browser state
before reusing the endpoint:

```bash
repo_root=$(pwd)
direct_work=$(mktemp -d)
codex exec \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --skip-git-repo-check \
  --approve-for-me \
  --disable apps \
  --json \
  -C "$direct_work" \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="max"' \
  -c 'mcp_servers.playwright.url="http://localhost:8936/sse"' \
  --output-schema "$repo_root/benchmarks/metrocuadrado/result.schema.json" \
  --output-last-message /tmp/metrocuadrado-browser-result.json \
  - < "$repo_root/benchmarks/metrocuadrado/browser-prompt.md" \
  > /tmp/metrocuadrado-browser-events.jsonl
```

Capture a temporally adjacent oracle for each arm and score with the same
script. Treat the wall-time comparison as valid only when both quality gates
pass.
