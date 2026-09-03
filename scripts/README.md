# Release evidence scripts

The capture scripts reproduce the native WebMCP, hosted public-site, and deployment-security records in `evidence/`. The browser journeys require Python Playwright and a Chrome build that supports the `WebMCPTesting` feature. Each script queries `/health` before capture and rejects a source or optional Worker-version mismatch. Retained results record the live Worker identity, capture script and helper SHA-256 digests, browser launch configuration, and deployed asset digests so a rerun can be tied to its inputs.

Set the exact deployed source commit before capture. `META_WEBMCP_DEPLOYMENT_VERSION` is an optional additional assertion; the retained value always comes from the live Worker:

```bash
export CHROME_PATH=/path/to/google-chrome-beta
export META_WEBMCP_SOURCE_COMMIT=<exact-deployed-commit>
# Optional: export META_WEBMCP_DEPLOYMENT_VERSION=<expected-worker-version>

python scripts/capture-deployment-security-gates.py
python scripts/capture-native-evidence.py
python scripts/capture-public-evidence.py
```

`capture-public-evidence.py` contacts Wikipedia, SauceDemo, and The Internet. It uses SauceDemo's published test account and redacts the password from retained results. Set `META_WEBMCP_EVIDENCE_CASE` to one case slug and `META_WEBMCP_EVIDENCE_APPEND=1` to rerun a single target without discarding the other target records. Append mode requires the retained capture script and helper hashes, browser identity, and browser launch configuration to match the current run; after any of those inputs changes, run a full capture with `META_WEBMCP_EVIDENCE_APPEND` unset.

`capture-deployment-security-gates.py` verifies unauthenticated, cross-origin, authorized, and tampered-capability behavior. It also creates one bounded export, confirms capability ownership and single-use download semantics, and deletes the cached archive by consuming it. Cookie and capability values are never written to the result.

Retain complete Lighthouse JSON before generating the compact summaries:

```bash
npx --yes lighthouse@13.4.1 https://metawebmcp.neuryta.com \
  --chrome-flags="--headless --no-sandbox --enable-blink-features=WebMCPTesting" \
  --output=json \
  --output-path=evidence/lighthouse-production-report.json

node scripts/summarize-lighthouse.mjs \
  evidence/lighthouse-production-report.json \
  evidence/lighthouse-production-summary.json
```

For repeated production samples, retain every complete report under a distinct filename and record the sample set in `evidence/lighthouse-production-samples.json`; do not replace a slower valid sample with only the best run. For the native-export Lighthouse record, extract the exact retained `evidence/relay-sessions-webmcp.zip`, run its `node serve.mjs`, capture `http://127.0.0.1:4173` to `evidence/lighthouse-native-export-report.json`, and set `META_WEBMCP_INPUT_ARTIFACT=evidence/relay-sessions-webmcp.zip` when passing that report through the summarizer. Each summary records the raw report hash, live deployment identity, summarizer hash, browser, form factor, and any local input-artifact hash.
