# FincaRaíz browser-parsing benchmark

## Result

On the 2026-09-04 point-in-time runs, both the direct-browser agent and a cold
MetaWebMCP managing agent returned the exact oracle top 50. The cold agent
started without a domain tool, analyzed the live page, authored and activated
one, invoked it, and produced the final schema in 290.550 seconds. The primary
matched direct-browser run took 634.630 seconds: a measured 2.18× wall-time
improvement after both arms passed the same quality gate.

| Arm | Quality gate | Results | Browser calls | Wall time | Processed / non-cached tokens |
|---|---:|---:|---:|---:|---:|
| Codex + navigation responses (fresh matched) | Pass | 50/50, exact URLs, fields, and ranks | 15 | 634.630 s | 5,997,779 / 336,723 |
| MetaWebMCP managing agent (cold) | Pass | 50/50, exact URLs, fields, and ranks | 8 semantic; 15 internal | 290.550 s | 345,737 / 71,689 |
| Codex + navigation responses (earlier trial) | Pass | Same byte-identical result | 18 | 571.262 s | 6,058,674 / 267,058 |
| Codex + explicit snapshots (sensitivity) | Pass | Same byte-identical result | 29 | 623.711 s | 1,673,496 / 163,608 |
| MetaWebMCP legacy analyzer | Fail: unsupported | 0/50 | 1 before analysis | 2.906 s to capability decision | Not comparable |
| MetaWebMCP authored collection (warm diagnostic) | Pass | 50/50, exact URLs, fields, and ranks | 1 semantic; 14 internal | 19.568 s | Not measured |

The cold agent received only MetaWebMCP's five benchmark-facing meta-tools. An
event audit found no shell, filesystem, web-search, or direct-browser tool
calls. It called analysis once, attempted contract creation five times,
activated the generated tool, and invoked it through the transport fallback.
The first four contracts were rejected because the generic authoring guide
described the ordered stopping rule without naming its exact `sourceField`
and `resultField` keys. Those failures and the agent's recovery are included
in the 290.550-second wall time and token totals.

The successful tool scanned 263 unique records over 13 pages, found 73
qualifying records, and stopped when page 13's minimum rent could no longer
improve rank 50. MetaWebMCP made 15 internal browser calls: an analysis
navigation and snapshot, then a fresh page-one navigation and pages 2–13. The
agent received 51,277 characters of semantic tool responses instead of the
direct arm's 1,205,716 browser-response characters, a 23.5× reduction. It
processed 345,737 tokens including cached input versus 5,997,779, a 17.3×
reduction; after subtracting cached input, the reduction was 4.70×. Both arms
made 15 browser calls internally.

This is one cold trial per primary arm on a volatile third-party site. They
ran about eleven minutes apart with separate adjacent correctness oracles.
This is evidence for this captured task, not a general Codex or WebMCP
performance claim. The 19.568-second warm run is
still useful for separating deterministic execution cost from the much larger
model analysis, authoring, retry, and response cost, but it is not used as the
end-to-end comparison.

## Task

Find the 50 cheapest unique Bogotá apartments for rent that satisfy all of the
following:

1. At least two bedrooms.
2. Area between 45 m² and 100 m², inclusive.
3. The listing description explicitly contains one of seven normalized
   laundry-area phrases.

Rank by displayed rent plus any separately displayed administration fee,
treating a missing fee as zero. Deduplicate by absolute listing URL and break
ties by rent, then URL.

The task starts from FincaRaíz's public rent-ascending Bogotá apartment route.
It deliberately combines structured card values, free-text evidence,
deduplication, derived cost, ranking, and a cross-page stopping proof. It is
not satisfied by applying one visible site filter.

The exact prompt is in [`browser-prompt.md`](browser-prompt.md), and the model
output contract is in [`result.schema.json`](result.schema.json).

## Method

Correctness is a prerequisite for comparing efficiency. Each completed arm is
scored against a fresh deterministic oracle for URL precision and recall,
field accuracy, arithmetic, and exact rank.

### Direct-browser arm

An ephemeral Codex 0.150.1 process with `gpt-5.6-sol` and maximum reasoning
used Playwright MCP 0.0.55 with Chrome 147 from an empty working directory,
matching the cold arm's CLI isolation. It was restricted to
`browser_navigate` and `browser_snapshot`. The prompt prohibited page-source
access, JavaScript/DOM evaluation, network inspection, APIs, web search,
filesystem access, and shell use. The event audit found only browser MCP calls.

The fresh run made 15 navigation calls across 13 unique pages, including two
repeated first-page navigations. It received 1,205,716 browser-response
characters, processed 5,997,779 tokens including cached input, and used
336,723 tokens after cached input was subtracted. Its result was byte-identical
to the earlier navigation-only and explicit-snapshot trials.

### MetaWebMCP cold managing-agent arm

A fresh ephemeral Codex 0.150.1 process used `gpt-5.6-sol` with maximum
reasoning and an empty working directory. User configuration and repository
instructions were disabled. Its prompt prohibited shell, filesystem, web
search, direct browser tools, page source, network requests, and APIs. The
recorded event stream contains only MetaWebMCP MCP calls and the final agent
message.

The non-interactive CLI cannot discover page-native Site Tools, so a thin
stdio MCP adapter exposed the real MetaWebMCP analysis, authoring validation,
registry, and collection runtime. The adapter contained no authored ToolSpec,
FincaRaíz fields, parser choices, filters, or stopping logic. The agent had to
derive those from the analysis response and generic grammar. Dynamic MCP tool
list refresh was not available in the client, so the final generated tool was
called through `meta_invoke_webmcp`; this changes the transport name, not its
validated execution path.

Analysis returned three repeated-link collection scaffolds. The agent selected
the apartment evidence and authored extraction for URL, rent,
administration, bedrooms, area, and laundry evidence; numeric and text
filters; a computed monthly total; stable sorting; a 50-result limit; bounded
pagination; and the ordered stopping proof. Four invalid stopping-rule shapes
were rejected before its fifth contract passed. The interval from completed
analysis to a valid contract was 137.444 seconds. The generated collection
itself completed in 21.771 seconds.

### MetaWebMCP warm executor diagnostic

MetaWebMCP navigated to the same first page and analyzed its 78,687-character
accessibility snapshot. In 10.525 ms the analyzer found three repeated-link
collection scaffolds alongside the page actions. The managing-agent role
selected the evidence containing apartment listing URLs and supplied a
complete `find_matching_apartments` ToolSpec using the advertised collection
grammar and parser catalog. Contract validation took 1.072 ms.

The registered tool then performed bounded, same-origin/path pagination,
typed field extraction, input-driven filters, a computed monthly total,
deduplication, stable ranking, and an ordered stopping proof in 16.544 seconds.
The complete pipeline, including the initial 3.009-second navigation, took
19.568 seconds. This is the same validated executor used by dynamically
registered and exported tools; the benchmark invokes it directly because
native Site Tools discovery is unavailable from the non-interactive CLI.

The earlier capability-failure capture is retained to show the before state:
the legacy analyzer exposed only contact, card-expansion, and menu actions and
could not attempt the task.

### Oracle

The oracle is not a benchmark arm. A dependency-free collector read the
server-rendered Next.js search payload, normalized the same fields, and used
the same stopping condition. The oracle paired with the cold run visited 13
pages, saw 273 rows (263 unique), and found 73 qualifying rows. The direct and
warm runs retain their own adjacent oracle captures because listings are
volatile.

Full descriptions are not retained. Each source page has an HTML SHA-256
digest and each expected row keeps only the normalized fields and matching
laundry phrase needed for scoring.

## Artifacts

- [`2026-09-04-metawebmcp-cold-run.json`](2026-09-04-metawebmcp-cold-run.json):
  cold environment, hashes, timings, calls, token accounting, and comparison.
- [`2026-09-04-metawebmcp-cold-result.json`](2026-09-04-metawebmcp-cold-result.json):
  schema-constrained final output written by the cold managing agent.
- [`2026-09-04-metawebmcp-cold-score.json`](2026-09-04-metawebmcp-cold-score.json):
  exact correctness metrics for the cold result.
- [`2026-09-04-metawebmcp-cold-oracle.json`](2026-09-04-metawebmcp-cold-oracle.json):
  oracle captured immediately before the cold run.
- [`2026-09-04-metawebmcp-cold-trace.json`](2026-09-04-metawebmcp-cold-trace.json):
  MetaWebMCP calls, generated contract, internal browser calls, and execution
  result. Raw model reasoning is not retained.
- [`2026-09-04-browser-fresh-run.json`](2026-09-04-browser-fresh-run.json):
  matched direct-browser environment, isolation, timings, calls, and tokens.
- [`2026-09-04-browser-fresh-result.json`](2026-09-04-browser-fresh-result.json)
  and [`2026-09-04-browser-fresh-score.json`](2026-09-04-browser-fresh-score.json):
  fresh direct output and exact correctness metrics.
- [`2026-09-04-browser-fresh-oracle.json`](2026-09-04-browser-fresh-oracle.json):
  oracle captured immediately before the fresh direct run.
- [`2026-09-04-metawebmcp-authored.json`](2026-09-04-metawebmcp-authored.json):
  deterministic warm ToolSpec summary, timings, traversal proof, and results.
- [`2026-09-04-metawebmcp-authored-score.json`](2026-09-04-metawebmcp-authored-score.json):
  quality metrics for the warm authored-tool arm.
- [`2026-09-04-authored-oracle.json`](2026-09-04-authored-oracle.json): oracle
  paired with the authored-tool run.
- [`2026-09-04-oracle.json`](2026-09-04-oracle.json): oracle paired with the
  direct-browser run.
- [`2026-09-04-browser-score.json`](2026-09-04-browser-score.json): exact
  direct-browser output and quality metrics.
- [`2026-09-04-metawebmcp.json`](2026-09-04-metawebmcp.json): retained legacy
  capability-failure capture.
- [`2026-09-04-run.json`](2026-09-04-run.json): direct-browser environment,
  calls, latency, and token accounting.

## Reproduce

Start an isolated Playwright MCP server:

```bash
npx --yes @playwright/mcp@0.0.55 \
  --headless \
  --port 8932 \
  --host localhost \
  --executable-path /usr/bin/google-chrome \
  --isolated \
  --image-responses omit \
  --snapshot-mode full
```

In another terminal, capture a fresh oracle, then run the cold managing agent
from an empty ephemeral working directory:

```bash
node scripts/capture-fincaraiz-benchmark.mjs \
  --output benchmarks/fincaraiz/oracle.json

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
  -c "mcp_servers.metawebmcp.args=[\"$repo_root/scripts/serve-metawebmcp-cold-benchmark.mjs\",\"--browser-endpoint\",\"http://localhost:8932/sse\",\"--trace\",\"/tmp/fincaraiz-metawebmcp-trace.json\"]" \
  --output-schema "$repo_root/benchmarks/fincaraiz/result.schema.json" \
  --output-last-message /tmp/fincaraiz-metawebmcp-result.json \
  - < "$repo_root/benchmarks/fincaraiz/metawebmcp-cold-prompt.md" \
  > /tmp/fincaraiz-metawebmcp-events.jsonl

node scripts/score-fincaraiz-benchmark.mjs \
  --oracle benchmarks/fincaraiz/oracle.json \
  --candidate /tmp/fincaraiz-metawebmcp-result.json \
  --output benchmarks/fincaraiz/metawebmcp-cold-score.json
```

The warm executor-only diagnostic remains reproducible separately:

```bash
node scripts/capture-fincaraiz-metawebmcp.mjs \
  --endpoint http://localhost:8932/sse \
  --output benchmarks/fincaraiz/metawebmcp.json

node scripts/score-fincaraiz-benchmark.mjs \
  --oracle benchmarks/fincaraiz/oracle.json \
  --candidate benchmarks/fincaraiz/metawebmcp.json \
  --output benchmarks/fincaraiz/metawebmcp-score.json
```

Run the browser-only Codex arm:

```bash
repo_root=$(pwd)
direct_work=$(mktemp -d)
codex exec \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --skip-git-repo-check \
  --approve-for-me \
  --enable browser_use \
  --disable apps \
  --json \
  -C "$direct_work" \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="max"' \
  -c 'mcp_servers.playwright.command="npx"' \
  -c 'mcp_servers.playwright.args=["--yes","@playwright/mcp@0.0.55","--headless","--executable-path","/usr/bin/google-chrome","--isolated","--image-responses","omit","--snapshot-mode","full"]' \
  -c 'mcp_servers.playwright.startup_timeout_sec=60' \
  --output-schema "$repo_root/benchmarks/fincaraiz/result.schema.json" \
  --output-last-message /tmp/fincaraiz-browser-result.json \
  - < "$repo_root/benchmarks/fincaraiz/browser-prompt.md" \
  > /tmp/fincaraiz-browser-events.jsonl
```

Then score that result with the same scorer and a temporally adjacent oracle.

## Interpretation and next gate

The cold result clears the missing-capability gate: a managing agent can turn
observed repeated records into a reusable tool without a prebuilt domain
contract, arbitrary JavaScript, or a generic browser MCP surface. It also
identifies the next concrete product fix: publish the exact stopping-rule
property schema so an agent does not need validation-driven guessing.

The next performance gate should run at least three fresh trials per arm and
report medians and dispersion. The current 2.18× wall-time result is the honest
single-run comparison; the former 29.2× figure describes warm deterministic
execution only.
