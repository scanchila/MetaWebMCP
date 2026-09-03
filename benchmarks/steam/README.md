# Steam multipage collection benchmark

## Result

On a cold 20-page storefront task, both the untouched generated-tool output
and direct browser output matched the corrected independent oracle's ordered
top 50. MetaWebMCP finished in 287.680 seconds versus 399.300 seconds for
direct parsing: a **1.39× wall-time advantage** and 111.620 seconds saved.

| Arm | Quality gate | Calls | Wall time | Processed / non-cached tokens | Model-facing tool text |
|---|---:|---:|---:|---:|---:|
| Direct browser parsing | 50/50 exact apps, fields, and ranks | 21 browser | 399.300 s | 2,634,279 / 240,935 | 628,090 characters |
| MetaWebMCP managing agent (cold) | raw tool 50/50; final 50/50 | 5 semantic; 62 internal browser | 287.680 s | 248,889 / 46,777 | 33,340 characters |

MetaWebMCP reduced processed tokens **10.58×**, non-cached tokens **5.15×**,
and model-facing tool-response text **18.84×**. The generated tool used more
low-level browser calls because it selected a two-second wait and fresh
snapshot for each page. Those responses stayed behind the semantic boundary;
the managing agent received the compact structured result.

This is one matched pair, not a statistical estimate. It is evidence of the
same crossover seen on FincaRaíz, in a different category, but it should be
repeated before treating 1.39× as an expected Steam effect size.

## Task

The source is Steam's public Windows-specials search sorted by lowest price.
The finite scope is exactly pages 1 through 20. Across every linked `/app/`
card in that scope, return the top 50 unique apps with:

1. A displayed discount from 50% through 80%, inclusive.
2. A displayed original price of at least $0.99 USD.
3. A displayed sale price of at most $0.49 USD.

Rank by sale price ascending, discount descending, original price descending,
then absolute app URL ascending. The corrected capture observed 500 card
occurrences, 490 unique app IDs, and 235 qualifiers. Because many prices and
discounts tie, every scoped page is needed before URL ordering determines the
top 50. This makes the workload a repetitive extraction, filtering,
deduplication, and ranking flow rather than one search-filter call.

The exact frozen prompts are in [`browser-prompt.md`](browser-prompt.md) and
[`metawebmcp-cold-prompt.md`](metawebmcp-cold-prompt.md). The shared final
contract is [`result.schema.json`](result.schema.json).

## Method and authorship boundary

Fresh ephemeral Codex 0.150.1 processes used `gpt-5.6-sol` with maximum
reasoning, Chrome 147, Playwright MCP 0.0.55, empty working directories, no
user configuration, no repository instructions, and no apps. Each valid arm
received a fresh isolated browser. No generated domain tool existed before the
cold arm, and no warm tool trial preceded it.

The direct arm called only `browser_navigate` and `browser_snapshot`. The cold
arm called only the five benchmark MetaWebMCP tools. Its adapter contained no
Steam ToolSpec, field definitions, parsers, filters, or ranking. The agent
authored a valid collection on its first attempt, activated it, and invoked it
through the dynamic-list transport fallback.

No one edited the generated definition. The raw JSONL
`meta_create_webmcp.arguments.authored_tools` value and retained
`trace.authoredDefinitions` serialize to the same SHA-256,
`35045a46bc60f850ea4a22f84cd4a91f02c49f3dd98a9d455993e9bb63cdb4b3`.
The normal validator then supplied the advertised server-controlled `scope`
and `startUrl`. The trace's untouched `execution.results` array is byte-for-byte
identical to the managing agent's final `results` array, and it independently
passes the 50/50 oracle gate. This prevents final-answer cleanup from masking a
generated-tool error.

The two arms returned the same ordered app IDs and numeric fields. Three apps
used different `snr` tracking-query variants because they appeared on adjacent
pages; scoring canonicalizes only the query and fragment and still requires
the URL's Steam app ID and path to agree.

## Oracle correction

The initially frozen oracle produced a real failed gate: 47/50 for the cold
arm and 48/50 for the direct arm. Both candidates nevertheless agreed on the
same canonical 50. Inspection found that the oracle's independent
accessibility parser recognized `- link "…"` but not Steam's valid YAML form
`- 'link "…: …"'`, used when an accessible game name contains a colon. For
example, the missed block for app `1578220` visibly contained its `/app/` URL,
51% discount, $0.99 original price, and $0.49 sale price.

The failed scores and three original captures are retained. After both arms
completed, the oracle changed by one optional quote in its link regex and
gained a regression test containing a colon-bearing card. The corrected
post-run oracle then saw all 500 card occurrences and both candidates passed
50/50. No prompt, scorer, runtime, bridge, ToolSpec, trace, or candidate result
changed. Because the correction was post-run, a future preregistered repeat is
still the strongest confirmation.

## Boundaries

- The collection executor deduplicates exact URLs, not canonical app IDs.
  Tracking variants therefore counted as 500 internal records for 490 app IDs.
  The returned top 50 happened to contain 50 unique app IDs and passed the
  explicit raw-output gate, but canonical-key deduplication remains a useful
  runtime primitive to add before broader reuse.
- The executor reports `complete: false` after reaching its 500-item safety
  ceiling. It nevertheless recorded all 20 pages required by this deliberately
  finite benchmark; no completeness claim is made about page 21 or later.
- Steam prices and search ordering are volatile. The retained oracle is a
  point-in-time observation, not a current price claim.
- One direct startup attempt configured Playwright's legacy `/sse` route
  instead of its advertised `/mcp` route. It made zero browser calls, returned
  `failed`, and is recorded but excluded. The measured direct arm used a new
  empty Codex session and a new isolated browser.

## Artifacts

- [`2026-09-04-metawebmcp-cold-run.json`](2026-09-04-metawebmcp-cold-run.json),
  [`2026-09-04-metawebmcp-cold-result.json`](2026-09-04-metawebmcp-cold-result.json),
  and [`2026-09-04-metawebmcp-cold-trace.json`](2026-09-04-metawebmcp-cold-trace.json):
  cold environment, result, exact authored contract, execution, calls, and
  token accounting.
- [`2026-09-04-browser-fresh-run.json`](2026-09-04-browser-fresh-run.json) and
  [`2026-09-04-browser-fresh-result.json`](2026-09-04-browser-fresh-result.json):
  valid direct environment and result.
- [`2026-09-04-corrected-post-run-oracle.json`](2026-09-04-corrected-post-run-oracle.json):
  corrected independent 20-page accessibility capture.
- [`2026-09-04-metawebmcp-cold-tool-corrected-score.json`](2026-09-04-metawebmcp-cold-tool-corrected-score.json),
  [`2026-09-04-metawebmcp-cold-corrected-score.json`](2026-09-04-metawebmcp-cold-corrected-score.json),
  and [`2026-09-04-browser-fresh-corrected-score.json`](2026-09-04-browser-fresh-corrected-score.json):
  exact raw-tool, cold-final, and direct-final gates.
- The original flawed oracles and failed scores are retained beside the
  corrected artifacts. Raw CLI logs are omitted because they may contain model
  reasoning; manifests retain their SHA-256 digests.

## Reproduce

Start separate isolated Playwright MCP servers for the oracle and each arm:

```bash
npx --yes @playwright/mcp@0.0.55 \
  --headless \
  --port 8942 \
  --host localhost \
  --executable-path /usr/bin/google-chrome \
  --isolated \
  --image-responses omit \
  --snapshot-mode full
```

Capture the oracle:

```bash
node scripts/capture-steam-benchmark.mjs \
  --endpoint http://localhost:8942/sse \
  --output benchmarks/steam/oracle.json
```

Run the cold arm from an empty temporary working directory, pointing the
benchmark adapter at a different fresh browser server:

```bash
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
  -c "mcp_servers.metawebmcp.args=[\"$repo_root/scripts/serve-metawebmcp-cold-benchmark.mjs\",\"--browser-endpoint\",\"http://localhost:8941/sse\",\"--trace\",\"/tmp/steam-metawebmcp-trace.json\",\"--benchmark\",\"steam-discounted-games-first-20-pages-v1\"]" \
  --output-schema "$repo_root/benchmarks/steam/result.schema.json" \
  --output-last-message /tmp/steam-metawebmcp-result.json \
  - < "$repo_root/benchmarks/steam/metawebmcp-cold-prompt.md" \
  > /tmp/steam-metawebmcp-events.jsonl
```

Run the direct arm from another empty directory, using a third fresh browser
server's advertised `/mcp` route:

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
  -c 'mcp_servers.playwright.url="http://localhost:8944/mcp"' \
  --output-schema "$repo_root/benchmarks/steam/result.schema.json" \
  --output-last-message /tmp/steam-browser-result.json \
  - < "$repo_root/benchmarks/steam/browser-prompt.md" \
  > /tmp/steam-browser-events.jsonl
```

Score the final output and the raw generated execution separately:

```bash
node scripts/score-steam-benchmark.mjs \
  --oracle benchmarks/steam/oracle.json \
  --candidate /tmp/steam-metawebmcp-result.json

node scripts/score-steam-benchmark.mjs \
  --oracle benchmarks/steam/oracle.json \
  --candidate /tmp/steam-metawebmcp-trace.json \
  --candidate-kind trace
```
