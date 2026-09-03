# WebMCP Challenge submission runbook

Use this runbook for the final submission. The
[official rules](https://webmcp.devpost.com/rules) remain authoritative.

## Hard stops

- Submission deadline: **September 3, 2026, 13:00 PDT**
- UTC: **September 3, 2026, 20:00 UTC**
- Vietnam time: **September 4, 2026, 03:00 ICT**
- Judging ends: **September 21, 2026, 17:00 PDT**
- At the deadline, freeze the Devpost entry, public repository, YouTube video,
  and deployed site. Do not update them during judging.

## Blocking checklist

Status was observed at approximately 09:33 PDT on September 3.

- [x] Live URL responds without authentication:
  <https://metawebmcp.neuryta.com>
- [x] Repository contains an MIT `LICENSE`, detected by GitHub.
- [x] Repository contains source, assets, local instructions, deployment files,
  and actual WebMCP registration code.
- [x] The repository and its first commit were created during the submission
  period.
- [x] The latest pushed `main` commit at the snapshot time (`cd6ecff`) passed
  the repository's GitHub Actions CI workflow.
- [x] Controlled demo needs no credentials, paid service, or model API key.
- [ ] **BLOCKER:** change `scanchila/MetaWebMCP` from private to public.
- [ ] Open the repository in a logged-out/incognito browser.
- [ ] Confirm the MIT license appears in GitHub's About area.
- [ ] Run the final native-browser golden path from a clean browser session.
- [ ] Run `npm test`, inspect `test-artifacts/metawebmcp-e2e.png`, open the
  generated ZIP, and confirm its source contains
  `document.modelContext.registerTool({`.
- [ ] Record a public YouTube demo with clear audio and a duration under 3:00.
- [ ] Add the YouTube URL to Devpost.
- [ ] Add the live URL and public repository URL to Devpost.
- [ ] Paste the description and testing instructions below.
- [ ] Add representative screenshots with short captions.
- [ ] Confirm every teammate has accepted the invitation, if applicable.
- [ ] Confirm all materials are in English.
- [ ] Confirm Devpost shows **Submitted** in green, not Draft.
- [ ] Stop changing the submitted repository, deployment, video, and entry at
  13:00 PDT.

Changing visibility is an external repository action and should be performed by
the repository owner. With GitHub CLI, the command is:

```bash
gh repo edit scanchila/MetaWebMCP --visibility public --accept-visibility-change-consequences
```

Immediately verify from a logged-out browser; do not rely only on the CLI
success message.

## Recommended Devpost copy

### Name

MetaWebMCP

### Tagline

WebMCP builds WebMCP.

### One-sentence pitch

MetaWebMCP lets an agent make useful parts of any observable website
WebMCP-compatible by turning its workflows into reviewed, reusable semantic
recipes that can be activated as tools and exported as a native integration.

### Description

Most of the web was not built with WebMCP, yet its interfaces already expose
useful workflows. MetaWebMCP treats compatibility as a spectrum rather than a
binary property: an agent can observe a website it is allowed to access,
translate the useful parts of that interface into bounded semantic recipes,
and use those recipes through a small WebMCP tool surface. The agent no longer
has to reconstruct the same low-level browser procedure every time.

An agent starts with seven permanent `meta_*` tools on the top-level page. It
observes an owned interface, proposes evidence-backed capabilities, and leaves
the human in control of which contracts are accepted. Once approved,
MetaWebMCP activates a second domain-specific tool surface in the same page. In
the controlled demo, an ordinary conference planner begins with no WebMCP
tools. Activation adds `find_sessions`, `add_session_to_itinerary`,
`inspect_itinerary`, and `clear_itinerary`; those tools immediately read and
change the visible planner.

For a website the agent can visit but cannot modify, the same process produces
validated browser recipes based on accessible names and bounded context. A
generated tool returns the precise recipe the calling agent needs, while
low-level browser controls stay behind the semantic boundary. For an owned
site, the same reviewed contracts can be exported as direct native WebMCP code.
This makes useful portions of both owned and third-party sites compatible now,
without pretending that every action is observable, safe, or automatable.

That shared page is why WebMCP is essential. A standalone MCP server would not
automatically share the open page's state or make a new tool surface appear in
its live registry. DOM-only browser automation would expose low-level controls
and force an agent to infer intent repeatedly. MetaWebMCP instead turns observed
controls into a small semantic surface that a person can inspect before use.

Analyze, review, activate, execute, test, and export all use the same ToolSpec
objects. The deployed app has been exercised through a real native
`document.modelContext`: the registry grew from seven to eleven tools, all four
generated checks passed, and the downloaded 13-file repository registered and
executed the same four tools independently. The export contains direct
imperative registration, schemas, evidence, an integration report, and eval
prompts. Compatibility remains bounded by the page's accessible interface and
the caller's existing access. Ambiguous or consequential workflows remain
subject to review and confirmation, while site owners can replace generated
adapters with application functions, stores, API clients, and existing
permission checks when making an integration permanent.

The core has no runtime package dependencies and needs no separate model API.
It remains usable in an ordinary browser, while native WebMCP clients get the
full recursive experience.

### Why this is a strong fit for WebMCP

The product's central result only exists at the WebMCP boundary: tools already
discovered on an open page turn another website's observable workflows into
reusable semantic recipes and register them as a new tool surface. The person
reviews the proposed contract and watches the target state; the agent can then
invoke a stable, meaningful operation instead of rediscovering browser steps.
Both act on one visible workspace rather than exchanging an opaque automation
transcript.

### Testing instructions

No account or credentials are required.

1. Open <https://metawebmcp.neuryta.com> as a top-level page in the latest
   ChatGPT desktop in-app browser using a Site Tools-compatible model, or in
   Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.
2. Use the overview to understand the recipe model, then choose **Build a WebMCP
   recipe**. The permanent tools register even while the overview is visible.
3. Confirm the workspace header reads **WebMCP active** and seven `meta_*` tools
   are available.
4. Ask: “Analyze the conference planner. Agents should be able to find sessions,
   add selected sessions to an itinerary, and inspect schedule conflicts.”
5. Ask the agent to create and activate the proposed four-tool surface. Confirm
   the page reports eleven tools.
6. Ask: “Find the advanced session about agent evaluation, add it to my
   itinerary, and inspect the result.” Watch the target UI update.
7. Ask the agent to run the generated checks and export
   `relay-sessions-webmcp`.

If native tools are unavailable because of client rollout, use the numbered
buttons on the page. They invoke the same seven implementations and complete the
same controlled sequence. Retained native results and the exact production ZIP
are linked from the public repository's `evidence/` directory.

### Suggested primary prompt

```text
Analyze the conference planner. Review and activate a minimal tool surface for
finding sessions, adding a selected session to my itinerary, and checking the
result. Find the advanced session about agent evaluation, add it, verify the
integration, and export it as relay-sessions-webmcp.
```

## Video storyboard — target 2:30

Use the controlled Relay Sessions demo only. It is owned, deterministic, and
avoids third-party trademarks in the video.

| Time | Screen | Narration objective |
|---|---|---|
| 0:00–0:12 | Cold open: a generated tool adds a session and the target visibly changes | Show the project working immediately. Overlay: “A WebMCP app that builds WebMCP.” |
| 0:12–0:25 | Landing overview, then open the workspace and show the “no WebMCP” target plus seven `meta_*` Site Tools | State the compatibility premise and the use-now / integrate-later destinations. |
| 0:25–0:46 | Agent invokes `meta_analyze_site`; candidates appear | Show evidence, risk, and semantic boundaries rather than DOM controls. |
| 0:46–1:00 | Human reviews the four proposed capabilities | Make the person's authority visible. |
| 1:00–1:14 | Create and activate; count changes `7 → 11` | Show dynamic top-level registration. |
| 1:14–1:40 | Agent finds and adds the evaluation session, then inspects the itinerary | Show the generated tools changing shared visible state. |
| 1:40–1:55 | Four runtime checks pass | Establish execution quality without overstating model-eval coverage. |
| 1:55–2:18 | Export, open generated source, highlight direct registration | Prove that the live contract becomes owned native code. |
| 2:18–2:30 | Independent exported page or final workspace | Close: “From existing interface to reviewed native integration. WebMCP builds WebMCP.” |

Recording rules:

- Keep the final duration safely below 3:00; judges need not watch past 3:00.
- Use clear spoken audio and captions if practical.
- Do not use copyrighted music or unlicensed third-party marks.
- Keep zoom and text large enough for the tool count, tool names, target change,
  and verification result to be readable.
- Remove pauses, setup, deployment details, and optional hosted-browser modes.
- Paste prompts or cut directly to their submission; do not type long text live.
- Record short clips and use jump cuts instead of risking one continuous take.
- Do not claim that deterministic checks evaluate model intent selection.

## Final verification order

1. Finish only already-started, submission-critical work.
2. Run the complete local validation required by `AGENTS.md`.
3. Deploy once and verify the deployed asset/version evidence.
4. Test the live native path from a clean profile.
5. Record the live version that will remain deployed.
6. Upload the video and wait for YouTube processing.
7. Make the repository public; verify its license and files while logged out.
8. Complete every Devpost field and submit with buffer.
9. Reopen **My Projects** and verify the green Submitted state.
10. Freeze all submitted surfaces through the end of judging.
