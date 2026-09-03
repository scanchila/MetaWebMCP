Run this benchmark using only the Playwright MCP `browser_navigate`,
`browser_wait_for`, and `browser_snapshot` tools. Do not use web search,
`browser_evaluate`, `browser_run_code`, JavaScript, page source, network
requests, APIs, shell commands, filesystem tools, or repository files.

Navigate to:

`https://www.metrocuadrado.com/apartamentos/arriendo/bogota/economicos/`

Wait 2 seconds, then take a fresh accessibility snapshot. The benchmark uses a
fixed tall viewport so the page's lazy-rendered promoted and ordinary listing
cards are observable. Consider every visible linked apartment card, including
promoted cards; do not assume their display order is the final ranking.

Return the 10 cheapest unique visible apartment rentals that satisfy both:

1. At least 2 bedrooms.
2. Area from 45 through 100 square metres, inclusive.

Use only explicitly displayed card values. Rank by displayed monthly rent
ascending, then area descending, then canonical absolute listing URL
ascending. Deduplicate and remove tracking query parameters from listing URLs.

If fewer than 10 qualifying cards are observable or the browser becomes
unavailable, return `partial` or `failed` with only verified results and explain
why. Output only the required schema.
