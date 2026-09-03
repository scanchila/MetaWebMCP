# Release evidence scripts

The capture scripts reproduce the native WebMCP and hosted public-site records in `evidence/`. They require Python Playwright and a Chrome build that supports the `WebMCPTesting` feature. Each retained result records the capture script's SHA-256 digest, the exact deployed source commit and Worker version, the browser launch configuration, and deployed asset digests so a rerun can be tied to its inputs.

Set the exact deployed Worker version and source commit before capture:

```bash
export CHROME_PATH=/path/to/google-chrome-beta
export META_WEBMCP_DEPLOYMENT_VERSION=<worker-version>
export META_WEBMCP_SOURCE_COMMIT=$(git rev-parse HEAD)

python scripts/capture-native-evidence.py
python scripts/capture-public-evidence.py
```

`capture-public-evidence.py` contacts Wikipedia, SauceDemo, and The Internet. It uses SauceDemo's published test account and redacts the password from retained results. Set `META_WEBMCP_EVIDENCE_CASE` to one case slug and `META_WEBMCP_EVIDENCE_APPEND=1` to rerun a single target without discarding the other target records.

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

For repeated production samples, retain every complete report under a distinct filename and record the sample set in `evidence/lighthouse-production-samples.json`; do not replace a slower valid sample with only the best run. For the native-export Lighthouse record, extract the exact retained `evidence/relay-sessions-webmcp.zip`, run its `node serve.mjs`, capture `http://127.0.0.1:4173` to `evidence/lighthouse-native-export-report.json`, and pass that report through the same summarizer. Each summary records the raw report hash, source commit, Worker version, browser, and form factor.
