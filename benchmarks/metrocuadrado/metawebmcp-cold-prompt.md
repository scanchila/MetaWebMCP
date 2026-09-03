Use only the MetaWebMCP tools provided by the `metawebmcp` MCP server. Do not
use shell commands, filesystem tools, web search, direct browser tools, page
source, network requests, APIs, or repository files.

Start with a new MetaWebMCP analysis of:

`https://www.metrocuadrado.com/apartamentos/arriendo/bogota/economicos/`

Create, activate, and invoke one generated semantic read-only collection tool
that considers every promoted and ordinary linked apartment card visible on
that first page and returns the 10 cheapest unique listings satisfying both:

1. At least 2 bedrooms.
2. Area from 45 through 100 square metres, inclusive.

Use only explicitly displayed card values. Rank by displayed monthly rent
ascending, then area descending, then canonical absolute listing URL
ascending. Deduplicate by canonical URL and remove tracking query parameters
from the final URLs.

The target lazy-renders cards. Use the collection grammar's bounded
`pageCapture` option with `snapshotAfterNavigate: true` and `waitSeconds: 2`.
This is a single-page collection; do not invent pagination.

Derive the authored ToolSpec only from the analysis evidence and returned
authoring grammar. Do not assume a pre-existing generated tool. Pass the
complete ToolSpec to `meta_create_webmcp`, activate it, then invoke it. If the
generated tool does not appear dynamically, use `meta_invoke_webmcp` as the
transport fallback.

If fewer than 10 qualifying cards are observable or the generated tool cannot
prove completion, return `partial` or `failed` with only verified results and
explain why. Output only the required schema.
