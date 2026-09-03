Use only the MetaWebMCP tools provided by the `metawebmcp` MCP server. Do not
use shell commands, filesystem tools, web search, direct browser tools, page
source, network requests, APIs, or repository files.

Start with a new MetaWebMCP analysis of this exact page-1 URL:

`https://store.steampowered.com/search/?sort_by=Price_ASC&os=win&specials=1&ndl=1&cc=us&l=english&page=1`

Create, activate, and invoke one generated semantic read-only collection tool.
Its finite benchmark scope is exactly Steam search result pages 1 through 20
for that query. It must inspect every linked `/app/` result card in that scope
and return the top 50 unique apps satisfying all three conditions:

1. Displayed discount is from 50% through 80%, inclusive.
2. Displayed original price is at least $0.99 USD.
3. Displayed sale price is at most $0.49 USD.

Use only values explicitly displayed in each result card. Rank by displayed
sale price ascending, displayed discount descending, displayed original price
descending, then absolute app URL ascending. Deduplicate apps. Preserve a
valid absolute Steam app URL; tracking query parameters are allowed and URL
comparison ignores them.

The generated tool's result fields must be named exactly `app_id`, `app_url`,
`discount_pct`, `original_price_usd`, and `sale_price_usd`. Parse `app_id` from
the numeric path segment after `/app/`. The collection starts with page 1 and
then paginates from page 2, for 20 total pages and up to 500 unique records.
Do not stop after finding 50 matches: every page in the finite scope is needed
to resolve ties. Completion means all 20 scoped pages were scanned; it makes no
claim about page 21 or the rest of Steam.

Derive the complete ToolSpec from the analysis evidence and returned generic
authoring grammar. Do not assume a pre-existing generated tool. Pass the
ToolSpec to `meta_create_webmcp`, activate it, and invoke it. If the generated
tool does not appear dynamically, use `meta_invoke_webmcp` only as the
transport fallback. Do not alter, replace, repair, or post-process the
generated tool definition or its result. Copy its ordered result records into
the required final schema.

If all 20 pages cannot be inspected or fewer than 50 qualifying unique apps
are observed, return `partial` or `failed` with only verified results and an
explanation. Output only the required schema.
