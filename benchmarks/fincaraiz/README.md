# FincaRaíz browser-parsing benchmark

## Result

Across two point-in-time matched pairs, all four runs matched the oracle top 50
under the normalized scoring contract. Median wall time was 332.079 seconds for
the MetaWebMCP managing agent and 673.906 seconds for direct browser parsing, a
2.03× ratio after both
arms passed the same quality gate. No generated domain tool existed before
either cold run, and no warm trial preceded them.

| Matched pair | Arm | Quality gate | Browser calls | Wall time | Processed / non-cached tokens |
|---|---|---:|---:|---:|---:|
| 1 | Codex + direct browser parsing | 50/50 exact | 15 | 634.630 s | 5,997,779 / 336,723 |
| 1 | MetaWebMCP managing agent (cold) | 50/50 exact | 15 internal | 290.550 s | 345,737 / 71,689 |
| 2 | Codex + direct browser parsing | 50/50 exact | 38 | 713.181 s | 4,657,195 / 423,851 |
| 2 | MetaWebMCP managing agent (cold) | 50/50 exact | 15 internal | 373.607 s | 473,796 / 62,276 |
| Median | Codex + direct browser parsing | 50/50 exact | 26.5 | 673.906 s | 5,327,487 / 380,287 |
| Median | MetaWebMCP managing agent (cold) | 50/50 exact | 15 | 332.079 s | 409,767 / 66,983 |

At the two-trial medians, MetaWebMCP used 13.00× fewer processed tokens,
5.68× fewer non-cached tokens, and 40.77× less model-facing tool-response text.
Pair-level wall-time ratios were 2.18× and 1.91×. The direct agent repeated
navigation substantially more often in pair 2, while the generated collection
made the same deterministic 15 internal browser calls in both trials.

The cold agents received only MetaWebMCP's five benchmark-facing meta-tools.
Event audits found no shell, filesystem, web-search, or direct-browser calls.
Both analyzed the site, authored a collection ToolSpec, activated it, and
invoked it through the transport fallback. The first cold run needed five
authoring attempts and the second needed seven. Their rejected contracts and
recovery time remain included in all timings and token totals.

The authoring retries revealed that the generic guide described the ordered
stopping rule without enumerating its exact `sourceField`, `resultField`, and
`rank` shape. The guide has since been corrected, but the captured results are
unchanged. Both successful tools scanned 263 unique records over 13 pages,
found 73 qualifying records, and stopped when page 13's minimum rent could no
longer improve rank 50.

Two trials per arm are still too few for a statistical claim, and the site is
volatile. Each arm has a separate temporally adjacent correctness oracle. The
pair manifests retain different repository baseline identifiers, so the
primary comparisons remain matched within each pair; the prompt, schema, and
benchmark-bridge hashes are identical across them. The 19.568-second warm run
remains useful for separating deterministic execution cost from model
analysis, authoring, retry, and response cost, but it is not
part of the cold end-to-end comparison.

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

Fresh ephemeral Codex 0.150.1 processes with `gpt-5.6-sol` and maximum
reasoning used Playwright MCP 0.0.55 with Chrome 147 from empty working
directories, matching the cold arms' CLI isolation. They were restricted to
`browser_navigate` and `browser_snapshot`. The prompt prohibited page-source
access, JavaScript/DOM evaluation, network inspection, APIs, web search,
filesystem access, and shell use. Event audits found only browser MCP calls.

The two retained matched runs made 15 and 38 navigation calls across the same
13 unique pages. They received 1,205,716 and 3,066,487 browser-response
characters and processed 5,997,779 and 4,657,195 tokens. Both matched their
adjacent oracles for URLs, numeric fields, normalized laundry evidence, and
rank. Their raw evidence strings differ only in casing and accent preservation.

### MetaWebMCP cold managing-agent arm

Fresh ephemeral Codex 0.150.1 processes used `gpt-5.6-sol` with maximum
reasoning and empty working directories. User configuration and repository
instructions were disabled. Their prompt prohibited shell, filesystem, web
search, direct browser tools, page source, network requests, and APIs. The
recorded event streams contain only MetaWebMCP MCP calls and final messages.

The non-interactive CLI cannot discover page-native Site Tools, so a thin
stdio MCP adapter exposed the real MetaWebMCP analysis, authoring validation,
registry, and collection runtime. The adapter contained no authored ToolSpec,
FincaRaíz fields, parser choices, filters, or stopping logic. The agent had to
derive those from the analysis response and generic grammar. Dynamic MCP tool
list refresh was not available in the client, so the final generated tool was
called through `meta_invoke_webmcp`; this changes the transport name, not its
validated execution path.

Analysis returned three repeated-link collection scaffolds. Each agent selected
the apartment evidence and authored extraction for URL, rent, administration,
bedrooms, area, and laundry evidence; numeric and text filters; a computed
monthly total; stable sorting; a 50-result limit; bounded pagination; and the
ordered stopping proof. The first run's valid contract arrived 137.444 seconds
after analysis and executed in 21.771 seconds. The second arrived after
207.117 seconds and executed in 16.791 seconds.

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

- [`2026-09-04-cold-pairs-summary.json`](2026-09-04-cold-pairs-summary.json):
  matched trial values, arm medians, ratios, and aggregate quality gate.
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
- [`2026-09-04-metawebmcp-cold-run-2.json`](2026-09-04-metawebmcp-cold-run-2.json):
  second cold environment, isolation, hashes, timings, calls, tokens, and its
  matched comparison.
- [`2026-09-04-metawebmcp-cold-run-2-result.json`](2026-09-04-metawebmcp-cold-run-2-result.json),
  [`2026-09-04-metawebmcp-cold-run-2-score.json`](2026-09-04-metawebmcp-cold-run-2-score.json),
  [`2026-09-04-metawebmcp-cold-run-2-oracle.json`](2026-09-04-metawebmcp-cold-run-2-oracle.json),
  and [`2026-09-04-metawebmcp-cold-run-2-trace.json`](2026-09-04-metawebmcp-cold-run-2-trace.json):
  second cold result, exact score, adjacent oracle, and execution trace.
- [`2026-09-04-browser-fresh-run-2.json`](2026-09-04-browser-fresh-run-2.json):
  second matched direct environment, isolation, timings, calls, and tokens.
- [`2026-09-04-browser-fresh-run-2-result.json`](2026-09-04-browser-fresh-run-2-result.json),
  [`2026-09-04-browser-fresh-run-2-score.json`](2026-09-04-browser-fresh-run-2-score.json),
  and [`2026-09-04-browser-fresh-run-2-oracle.json`](2026-09-04-browser-fresh-run-2-oracle.json):
  second direct result, exact score, and adjacent oracle.
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
  -c "mcp_servers.metawebmcp.args=[\"$repo_root/scripts/serve-metawebmcp-cold-benchmark.mjs\",\"--browser-endpoint\",\"http://localhost:8932/sse\",\"--trace\",\"/tmp/fincaraiz-metawebmcp-trace.json\",\"--benchmark\",\"fincaraiz-cheapest-with-laundry-v1\"]" \
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
identified a concrete authoring-guide defect: the stopping-rule property names
were not published. The guide now exposes the exact validated shape, with a
regression test that prevents the contract from drifting back to prose.

The next performance gate should add at least one more fresh matched pair and
report a minimum three-trial median and dispersion. The current cold evidence
is a two-pair 2.03× ratio of arm medians; the former 29.2× figure describes warm
deterministic execution only.
