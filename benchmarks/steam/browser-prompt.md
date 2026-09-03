Run this benchmark using only the Playwright MCP `browser_navigate` and
`browser_snapshot` tools. Do not use web search, `browser_evaluate`,
`browser_run_code`, JavaScript, page source, network requests, APIs, shell
commands, filesystem tools, or repository files.

Inspect exactly pages 1 through 20 of this Steam query by changing only its
`page` query parameter:

`https://store.steampowered.com/search/?sort_by=Price_ASC&os=win&specials=1&ndl=1&cc=us&l=english&page=1`

Consider every linked `/app/` result card across those 20 pages. Return the top
50 unique apps satisfying all three conditions:

1. Displayed discount is from 50% through 80%, inclusive.
2. Displayed original price is at least $0.99 USD.
3. Displayed sale price is at most $0.49 USD.

Use only values explicitly displayed in each result card. Rank by displayed
sale price ascending, displayed discount descending, displayed original price
descending, then absolute app URL ascending. Deduplicate apps. Preserve a
valid absolute Steam app URL; tracking query parameters are allowed and URL
comparison ignores them. Return fields named exactly `app_id`, `app_url`,
`discount_pct`, `original_price_usd`, and `sale_price_usd`, parsing `app_id`
from the numeric path segment after `/app/`.

Do not stop after finding 50 matches: every page in the finite scope is needed
to resolve ties. If all 20 pages cannot be inspected or fewer than 50
qualifying unique apps are observed, return `partial` or `failed` with only
verified results and an explanation. Output only the required schema.
