Run the benchmark task below using only the Playwright MCP `browser_navigate` and
`browser_snapshot` tools. Do not use web search, `browser_evaluate`,
`browser_run_code`, JavaScript, page source, network requests, APIs, or shell
commands.

`browser_navigate` returns the destination's accessibility snapshot. Parse that
response directly. Do not call `browser_snapshot` after a successful navigation
unless the navigation response did not contain the page content.

Source pages:

- Page 1: `https://www.fincaraiz.com.co/arriendo/apartamentos/bogota/bogota-dc/baratos`
- Later pages: append `/pagina2`, `/pagina3`, and so on.

Return the 50 cheapest unique Bogotá apartments for rent that satisfy every
condition:

1. At least 2 bedrooms.
2. Area from 45 through 100 square metres, inclusive.
3. The visible listing description explicitly contains, case- and
   accent-insensitively, one of: `zona de ropas`, `zona de lavado`,
   `zona de lavanderia`, `area de ropas`, `area de lavado`,
   `area de lavanderia`, or `lavanderia independiente`.

Rank by total monthly displayed cost: displayed rent plus any separately
displayed administration fee. Treat a missing administration fee as zero.
Deduplicate by absolute listing URL. Resolve ties by rent, then URL. Record the
exact matching laundry phrase as evidence.

The pages are sorted by displayed rent ascending. Visit pages sequentially.
Once you have at least 50 qualifying unique listings, continue until the
smallest displayed rent on a later page is strictly greater than the current
50th-ranked total monthly cost. Do not infer missing values. If the browser
becomes unavailable or you cannot finish, return `partial` or `failed` with the
results actually verified and explain why. Output only the required schema.
