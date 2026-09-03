# Devpost submission material

## Name

MetaWebMCP

## Tagline

**WebMCP builds WebMCP.**

## Links

- Live application: <https://metawebmcp.neuryta.com>
- Source repository: <https://github.com/scanchila/MetaWebMCP>
- Production evidence: <https://github.com/scanchila/MetaWebMCP/tree/main/evidence>

## One-sentence pitch

MetaWebMCP is a WebMCP-native compatibility studio that lets an agent observe a website, create a minimal semantic tool surface, activate it immediately, verify it against real page state, and export the same contracts as a native integration repository.

## Submission description

Websites contain useful workflows, but most expose them only through interfaces designed for people. Adding WebMCP manually requires a developer to understand the page's state, choose the right semantic boundaries, write schemas and descriptions an agent can select reliably, preserve existing permissions and confirmations, and test the result against the real interface.

MetaWebMCP makes that process itself agent-operable.

The application exposes seven permanent WebMCP tools: analyze a target, construct reviewed tool contracts, activate the generated tools, evaluate them, export a native repository, inspect state, and reset. When the agent activates a project, MetaWebMCP dynamically registers a second set of domain tools on the same top-level page. In the included demonstration, an ordinary conference planner starts with no WebMCP integration. The agent uses MetaWebMCP to derive and register `find_sessions`, `add_session_to_itinerary`, `inspect_itinerary`, and `clear_itinerary`, then uses those generated tools to operate the original interface.

For a site owner, MetaWebMCP analyzes live or supplied HTML and produces a standalone integration pack containing direct imperative WebMCP registration, the tool manifest, evidence, installation instructions, and agent eval prompts. For a third-party site, the calling agent can supply an accessibility snapshot from its own browser and receive bounded semantic recipes to execute there. An opt-in Playwright MCP runtime can instead provide a hosted session. Both paths export the same reviewed ToolSpecs with a constrained owned-page runtime; low-level browser operations never become the registered semantic interface.

The project does not need a separate model API. The WebMCP client is the reasoning agent: it reviews the discovered evidence, chooses the capabilities, refines contracts when needed, activates the new surface, and asks MetaWebMCP to test and export it.

## Production proof

- The live page exposed seven permanent tools through a real `document.modelContext`, dynamically expanded to eleven, and passed all four generated-tool checks.
- Its 13-file export registered four native tools on an independently served page and completed search, itinerary mutation, and state inspection without MetaWebMCP as the runtime.
- Through the same native entrypoint, the hosted, page-scoped Browser MCP path generated and executed semantic adapters for Wikipedia search, a two-stage SauceDemo sign-in and cart workflow, and a visible state change on The Internet test site.
- Three production Lighthouse samples scored 99–100 performance (median 100), with 100 for accessibility, best practices, SEO, and agentic browsing in every run. The independently served native export scored 100 in all five categories. Every run recorded zero console errors; production CLS remained below 0.000106 and export CLS was zero.

The retained screenshots and redacted machine results are in `evidence/` in the public repository.

## What makes it technically distinct

- The project is recursive: its WebMCP tools create and register other WebMCP tools.
- Immediate virtual execution and native export share one ToolSpec representation.
- The controlled target has no hidden WebMCP implementation.
- Generated tools are domain-level and compact; browser automation remains behind the boundary.
- Every candidate retains interface evidence, risk, schema, sample arguments, and a deterministic executor.
- Dynamic lifecycle management unregisters generated tools without removing the builder control plane.
- The core server and ZIP generator have no runtime package dependencies.

## Under-three-minute video script (2:48 target)

### 0:00–0:15 — Problem

“Most websites can already perform useful work, but agents see either a page made for humans or a large set of low-level browser controls. Adding a good semantic WebMCP surface still requires substantial design and testing.”

Show the Relay Sessions target. Point out the visible “Legacy UI · no WebMCP” label.

### 0:15–0:30 — Recursive premise

“MetaWebMCP is a WebMCP application whose tools create other WebMCP tools.”

Open the top-level page in ChatGPT's supported browser. Show the seven discovered `meta_*` tools.

### 0:30–0:54 — Analyze

Prompt:

> Analyze the conference planner. Agents should be able to find relevant sessions, add them to an itinerary, and inspect conflicts.

Show ChatGPT call `meta_analyze_site`. Briefly display the four evidence-backed candidates and their read/write classifications.

### 0:54–1:15 — Create and activate

Prompt:

> The proposed surface is appropriate. Create and activate it.

Show `meta_create_webmcp`, then `meta_activate_webmcp`. Emphasize that the registry changes from seven to eleven top-level tools.

### 1:15–1:43 — Use the generated WebMCP

Prompt:

> Find advanced sessions about agent evaluation and add the matching evaluation session to my itinerary. Then tell me whether it conflicts with anything.

Show calls to `find_sessions`, `add_session_to_itinerary`, and `inspect_itinerary`. Keep the live target visible as its state changes.

### 1:43–2:05 — Verify

Prompt:

> Test the generated integration.

Show deterministic discovery, schema, execution, and post-state checks. State precisely that intent-selection prompts are included in the export rather than claiming the deterministic suite evaluates an LLM.

### 2:05–2:35 — Ship native

Prompt:

> Export this as `relay-sessions-webmcp`.

Download/open the generated repository. Search for `document.modelContext.registerTool({`, show the preserved ToolSpec evidence, and show the manual agent eval plan.

Run the exported repository and briefly show that the same four tools register from its own top-level page and can still update the itinerary without MetaWebMCP acting as the runtime.

### 2:35–2:48 — Close

“MetaWebMCP lets an agent use the web as it exists, while giving site owners a direct path from observed interface to reviewed native WebMCP. WebMCP builds WebMCP.”

## Suggested prompts

```text
Analyze this target. Agents should be able to find conference sessions, add selected sessions to an itinerary, and inspect schedule conflicts.
```

```text
Review the candidates. Keep the four narrow workflows, create their contracts, and activate them.
```

```text
Find sessions related to agent evaluation. Add “Agent evals that catch regressions” to the itinerary and inspect the result.
```

```text
Run the generated WebMCP evaluation suite and export a repository named relay-sessions-webmcp.
```

## Judge setup

### Native WebMCP path

1. Choose a native client:
   - **ChatGPT Site Tools:** In the latest ChatGPT desktop app, open the deployed HTTPS URL as a top-level page in the built-in browser. Use ChatGPT Work or Codex with GPT‑5.6 Sol or Terra. Site Tools are disabled on Luna and unavailable in ChatGPT Enterprise and Edu. Availability is still rolling out and can differ between otherwise eligible workspaces; the current requirements are in the [Site Tools setup reference](https://learn.chatgpt.com/docs/webmcp).
   - **Google Chrome 149 or later:** Open `chrome://flags/#enable-webmcp-testing`, enable the WebMCP testing flag, restart Chrome, then open the deployed HTTPS URL as a top-level page.
2. Confirm that the page header reads **WebMCP active** and the seven `meta_*` tools appear.
3. Run the prompt sequence above.

### Ordinary browser fallback

If native tools do not appear or the header reads **Preview registry**, use the in-page controls. They call the same implementations as the seven registered meta-tools.

1. Keep **Owned page → Controlled legacy demo**, then select **Observe this interface** (1).
2. Review the evidence-backed candidates and select **Shape selected tools** (2).
3. Select **Activate tools** (3) and confirm the registry grows from seven to eleven tools.
4. Select **Run live checks** (4) and confirm that all four generated-tool checks pass.
5. Select **Export native repository** (5), download the ZIP, and compare it with the [retained production export](https://github.com/scanchila/MetaWebMCP/blob/main/evidence/relay-sessions-webmcp.zip) and its [validation record](https://github.com/scanchila/MetaWebMCP/blob/main/evidence/native-webmcp-result.json).

The controlled demo requires no account, credentials, model API, or external service. The live **Any public site** path defaults to an accessibility snapshot supplied from the calling agent's browser; operators may explicitly enable the isolated hosted Browser MCP runtime.
