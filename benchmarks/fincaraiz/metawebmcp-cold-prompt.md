Use only the MetaWebMCP tools provided by the `metawebmcp` MCP server. Do not
use shell commands, filesystem tools, web search, direct browser tools, page
source, network requests, APIs, or repository files.

Start with a new MetaWebMCP analysis of:

`https://www.fincaraiz.com.co/arriendo/apartamentos/bogota/bogota-dc/baratos`

Create, activate, and invoke a generated semantic tool that returns the 50
cheapest unique Bogota apartments for rent satisfying every condition:

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
Once at least 50 qualifying unique listings exist, continue until the smallest
displayed rent on a later page is strictly greater than the current 50th-ranked
total monthly cost.

Use `meta_analyze_site` first and derive the authored ToolSpec only from its
returned evidence, collection scaffold, and authoring grammar. Do not assume a
pre-existing generated tool. Pass the complete ToolSpec to
`meta_create_webmcp`, activate it, then invoke the newly generated tool. If the
generated tool does not appear dynamically, use `meta_invoke_webmcp` as the
transport fallback.

Do not infer missing listing values. If the managed browser becomes unavailable
or the generated tool cannot prove completion, return `partial` or `failed`
with only results actually verified and explain why. Output only the required
schema.
