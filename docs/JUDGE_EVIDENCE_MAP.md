# Judge evidence map

This map keeps submission claims tied to inspectable evidence. It is designed
for the Devpost description, video, screenshots, and testing instructions.

## Golden-path claim map

| Claim | Fast visible proof | Retained proof | Implementation anchor |
|---|---|---|---|
| MetaWebMCP is itself WebMCP-native | Header shows **WebMCP active** and seven meta-tools | [`evidence/native-webmcp-result.json`](../evidence/native-webmcp-result.json) | [`public/js/webmcp-runtime.js`](../public/js/webmcp-runtime.js) and the seven specs in [`public/js/app.js`](../public/js/app.js) |
| The target begins without WebMCP | Relay Sessions is labeled **Legacy UI · no WebMCP** | End-to-end check and screenshot in [`TEST_REPORT.md`](../TEST_REPORT.md) | [`public/demo/`](../public/demo/) contains no registration |
| Analysis is grounded in the real interface | Candidate cards show selectors, schema, samples, and risk | Analyzer unit coverage in [`TEST_REPORT.md`](../TEST_REPORT.md) | [`lib/analyzer.mjs`](../lib/analyzer.mjs) |
| A person can review the semantic boundary | Capability review allows selection plus name and description edits | Browser journey exercises review and external-metadata controls | Review flow in [`public/js/app.js`](../public/js/app.js) |
| Activation creates a second live tool plane | Registry count visibly changes from seven to eleven | Native result records both tool surfaces | Dynamic registration and AbortController lifecycle in [`public/js/webmcp-runtime.js`](../public/js/webmcp-runtime.js) |
| Generated tools operate the original UI | Search, add, inspect, and clear calls visibly change/read Relay Sessions | Four native generated calls and postconditions in [`evidence/native-webmcp-result.json`](../evidence/native-webmcp-result.json) | DOM executors in [`public/js/webmcp-runtime.js`](../public/js/webmcp-runtime.js) |
| Verification checks behavior, not only schemas | Workspace reports four passed checks | Deterministic test scope in [`TEST_REPORT.md`](../TEST_REPORT.md) | Evaluation flow in [`public/js/app.js`](../public/js/app.js) |
| Export uses the same reviewed contracts | Download card reports a 13-file ZIP | Exact production archive: [`evidence/relay-sessions-webmcp.zip`](../evidence/relay-sessions-webmcp.zip) | [`lib/generator.mjs`](../lib/generator.mjs) |
| Exported output is genuinely native and standalone | Open the generated source at its direct `document.modelContext.registerTool({` call | Independent execution is recorded in the native result | Direct call template in [`lib/generator.mjs`](../lib/generator.mjs) |
| The experience survives without native WebMCP | Run the numbered five-step browser fallback | End-to-end fallback coverage in [`TEST_REPORT.md`](../TEST_REPORT.md) | Internal registry path in [`public/js/webmcp-runtime.js`](../public/js/webmcp-runtime.js) |
| The production surface is polished and accessible | Show the full responsive workspace | Production and native-export Lighthouse reports in [`evidence/`](../evidence/) | [`public/index.html`](../public/index.html) and [`public/styles.css`](../public/styles.css) |

## Rubric-to-proof selection

### WebMCP Leverage

Use these three proofs:

1. Seven permanent tools are discovered through a real top-level
   `document.modelContext`.
2. Activation dynamically adds four domain tools to that same native registry.
3. The same reviewed ToolSpec objects generate direct native registration in a
   repository that executes independently.

Avoid spending scarce video time on generic API definitions. The registry
transition and independent export demonstrate depth more efficiently.

### Execution

Use these four proofs:

1. A public URL with no login or paid dependency.
2. One coherent Observe → Shape → Activate → Verify → Ship workflow.
3. Four visible postcondition checks and a standalone export.
4. Production-native evidence, responsive end-to-end coverage, and retained
   Lighthouse reports.

The normal-browser fallback is insurance for testing instructions, not the main
video path.

### Potential Impact

Use this problem and benefit:

> Most websites do not expose WebMCP, but they already contain workflows an
> agent could use. MetaWebMCP makes compatibility incremental: it observes a
> website, converts useful interactions into bounded semantic recipes, and
> exposes them as easy-to-use WebMCP tools. The agent can reuse a meaningful
> operation instead of rediscovering low-level browser steps on every task.

Use this honest scope statement:

> “Any website” means any website the agent can legitimately reach and observe,
> to the degree its accessible interface exposes stable, safe actions. The
> system omits or constrains ambiguous and consequential operations, preserves
> the caller's authentication boundary, and gives owned sites a path from a
> compatibility recipe to permanent native integration.

Do not claim measured time savings, improved model accuracy, or production user
adoption; those have not been demonstrated. The credible impact claim is that
the project turns observable web interactions into reusable semantic recipes,
making useful parts of the existing web agent-operable without requiring every
site to implement WebMCP first.

### Creativity & Ambition

Use one sentence and then prove it:

> MetaWebMCP is a WebMCP application whose tools create, activate, test, and
> export other WebMCP tools.

The best supporting shot is the page's native tool count changing from seven to
eleven while the previously uninstrumented target remains visible.

## Claim boundaries

These distinctions keep the submission precise:

- **Observed:** Native Chrome exposed seven tools, then eleven; four generated
  tool checks passed; the exact exported repository registered and ran its four
  tools independently.
- **Observed previously:** The opt-in hosted Browser MCP path completed retained
  public-site exercises against Wikipedia, SauceDemo, and The Internet.
- **Current deployment behavior:** Anonymous hosted browsing is disabled by
  default; the quota-free public-site path asks the calling agent to supply an
  accessibility snapshot.
- **Not demonstrated:** Automated probabilistic model-selection evals, measured
  improvement over DOM-only automation, production adoption, or arbitrary
  client-rendered-site compatibility.
- **Generated-code boundary:** Controlled and browser-derived exports are
  runnable, but source owners should bind their final integration to stable
  application logic and preserve their existing security controls.
- **Compatibility boundary:** A recipe can only cover controls and state that
  are visible and usable in the agent's authorized session. “Compatible to
  some degree” is the claim; universal access or complete automation is not.

## Recommended screenshots

1. A final deployed landing-page capture — caption the existing-web promise and
   the use-now / integrate-into-your-site paths.
2. `native-webmcp-recursive-workspace.png` — caption the `7 → 11` registry and
   completed verification/export.
3. `native-export-owned-page.png` — caption the standalone generated repository
   running without MetaWebMCP.

Do not lead with the three third-party target screenshots. They demonstrate
adapter breadth, but the controlled recursive flow is more original, easier to
understand, and safer for the video requirement concerning third-party marks.

## Two-minute judge path

1. Open the live overview and identify the two destinations: use a recipe from
   the agent's browser or integrate it into an owned site.
2. Choose **Build a WebMCP recipe** and inspect the seven Site Tools.
3. Ask for a conference-planner surface that finds sessions and builds an
   itinerary.
4. Review, create, and activate the four proposed tools.
5. Confirm the count changes to eleven.
6. Find and add “Agent evals that catch regressions,” then inspect the plan.
7. Run the checks and export `relay-sessions-webmcp`.

If the client does not expose Site Tools, follow the numbered buttons and use
the evidence links to inspect the retained native run.
