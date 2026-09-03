from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright
from evidence_append_provenance import (
    apply_browser_capture_provenance,
    apply_static_capture_provenance,
)
from evidence_provenance import browser_identity, configured_source_commit, verified_deployment_identity


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('META_WEBMCP_EVIDENCE_OUT', ROOT / 'evidence'))
APP_URL = os.environ.get('META_WEBMCP_APP_URL', 'https://metawebmcp.neuryta.com')
EXPECTED_DEPLOYMENT_VERSION = os.environ.get('META_WEBMCP_DEPLOYMENT_VERSION', '').strip()
DRY_RUN = os.environ.get('META_WEBMCP_EVIDENCE_DRY_RUN') == '1'
APPEND = os.environ.get('META_WEBMCP_EVIDENCE_APPEND') == '1'
CASE_SLUG = os.environ.get('META_WEBMCP_EVIDENCE_CASE')
BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-features=WebMCPTesting']
PROVENANCE_HELPER = Path(__file__).with_name('evidence_provenance.py')
APPEND_PROVENANCE_HELPER = Path(__file__).with_name('evidence_append_provenance.py')


def chrome_executable():
    configured = os.environ.get('CHROME_PATH')
    candidates = [
        Path(configured) if configured else None,
        Path(value) if (value := shutil.which('google-chrome-beta')) else None,
        Path(value) if (value := shutil.which('google-chrome')) else None,
        Path(value) if (value := shutil.which('chromium')) else None,
    ]
    executable = next((candidate for candidate in candidates if candidate and candidate.is_file()), None)
    if executable is None:
        raise RuntimeError('Set CHROME_PATH to a Chrome build with WebMCPTesting support.')
    return str(executable)


CHROME = chrome_executable()
CAPTURE_SCRIPT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
PROVENANCE_HELPER_SHA256 = hashlib.sha256(PROVENANCE_HELPER.read_bytes()).hexdigest()
APPEND_PROVENANCE_HELPER_SHA256 = hashlib.sha256(APPEND_PROVENANCE_HELPER.read_bytes()).hexdigest()

CASES = [
    {
        'slug': 'wikipedia-search',
        'target': 'Wikipedia',
        'stages': [{
            'url': 'https://en.wikipedia.org/wiki/Main_Page',
            'goal': 'Search Wikipedia for a topic and return the resulting page.',
            'tool': 'search',
            'reviewed_description': 'Search Wikipedia for the reviewed topic and return the resulting visible page state.',
            'arguments': {'search_wikipedia': 'WebMCP'},
            'expected': ['WebMCP'],
        }],
    },
    {
        'slug': 'saucedemo-cart',
        'target': 'SauceDemo',
        'stages': [
            {
                'url': 'https://www.saucedemo.com/',
                'goal': 'Sign in with the public test account and inspect the product catalog.',
                'tool': 'login',
                'reviewed_description': 'Sign in with the reviewed public test credentials and return the resulting product page state.',
                'arguments': {'username': 'standard_user', 'password': 'secret_sauce'},
                'expected': ['Products'],
            },
            {
                'url': 'https://www.saucedemo.com/inventory.html',
                'goal': 'Add one selected product to the cart and return the updated catalog state.',
                'tool': 'add_to_cart',
                'reviewed_description': 'Add the reviewed visible product to the cart and return the updated catalog state.',
                'arguments': {'item': 'Sauce Labs Backpack'},
                'expected': ['Sauce Labs Backpack', 'Remove'],
                'export': 'saucedemo-cart-webmcp',
            },
        ],
    },
    {
        'slug': 'the-internet-add-element',
        'target': 'The Internet',
        'stages': [{
            'url': 'https://the-internet.herokuapp.com/add_remove_elements/',
            'goal': 'Add a visible element to the page and return the changed interface state.',
            'tool': 'add_element',
            'reviewed_description': 'Add one page element through the reviewed control and return the updated visible state.',
            'arguments': {},
            'expected': ['Delete'],
        }],
    },
]


def redact(value, sensitive_values=()):
    if isinstance(value, list):
        return [redact(item, sensitive_values) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            lowered = key.lower()
            result[key] = '[redacted]' if any(word in lowered for word in ('password', 'token', 'secret')) else redact(item, sensitive_values)
        return result
    if isinstance(value, str):
        redacted = value
        for sensitive in sensitive_values:
            if sensitive:
                redacted = redacted.replace(sensitive, '[redacted]')
        return redacted
    return value


def evidence_excerpt(text, needles):
    excerpts = []
    folded = text.casefold()
    for needle in needles:
        index = folded.find(needle.casefold())
        if index < 0:
            continue
        start = max(0, index - 160)
        end = min(len(text), index + len(needle) + 260)
        excerpt = ' '.join(text[start:end].split())
        if excerpt not in excerpts:
            excerpts.append(excerpt)
    return '\n…\n'.join(excerpts)[:1200]


def compact_result(payload, expected):
    execution = payload['execution']
    final_snapshot = str(execution.get('result') or '')
    diagnostics = re.search(r'Console:\s*(\d+)\s+errors?,\s*(\d+)\s+warnings?', final_snapshot, re.I)
    sensitive_values = tuple(
        str(value)
        for key, value in payload.get('arguments', {}).items()
        if any(word in key.lower() for word in ('password', 'token', 'secret')) and value is not None
    )
    return {
        'target': payload['target'],
        'goal': payload['goal'],
        'analysis': payload['analysis'],
        'generatedTools': payload['generatedTools'],
        'selectedTool': payload['selectedTool'],
        'nativeRegistered': payload.get('nativeRegistered') is True,
        'arguments': redact(payload['arguments'], sensitive_values),
        'execution': {
            'ok': execution.get('ok') is True,
            'targetPageDiagnostics': {
                'errors': int(diagnostics.group(1)) if diagnostics else None,
                'warnings': int(diagnostics.group(2)) if diagnostics else None,
            },
            'steps': [
                {
                    'tool': step.get('tool'),
                    'arguments': redact(step.get('arguments', {}), sensitive_values),
                }
                for step in execution.get('trace', [])
            ],
            'finalSnapshotExcerpt': redact(evidence_excerpt(final_snapshot, expected), sensitive_values),
        },
        'export': payload.get('export'),
    }

def deployed_asset_hashes(page):
    paths = [
        '/',
        '/styles.css',
        '/js/app.js',
        '/js/browser-mcp-session.js',
        '/js/demo-analyzer.js',
        '/js/mcp-http-client.js',
        '/js/mcp-recipe.js',
        '/js/network-policy.js',
        '/js/webmcp-runtime.js',
        '/demo/index.html',
        '/demo/demo.css',
        '/demo/demo.js',
    ]
    hashes = {}
    for path in paths:
        response = page.context.request.get(urljoin(APP_URL, path))
        if not response.ok:
            raise RuntimeError(f'Deployed asset {path} returned HTTP {response.status}')
        hashes[path] = hashlib.sha256(response.body()).hexdigest()
    return hashes


def main():
    OUT.mkdir(exist_ok=True)
    identity = verified_deployment_identity(
        APP_URL,
        configured_source_commit(),
        EXPECTED_DEPLOYMENT_VERSION,
    )
    report_path = OUT / 'public-site-results.json'
    appending_report = APPEND and report_path.exists()
    report = json.loads(report_path.read_text()) if appending_report else {
        'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'deployment': APP_URL,
        'deploymentVersion': identity['deploymentVersion'],
        'sourceCommit': identity['sourceCommit'],
        'deployedAt': identity['deployedAt'],
        'deploymentTag': identity['deploymentTag'],
        'identityVerifiedFromHealth': True,
        'runtime': 'Cloudflare Browser Run with Playwright MCP',
        'entrypoint': 'native document.modelContext',
        'feature': 'WebMCPTesting',
        'initialTools': [],
        'results': [],
    }
    if report.get('deploymentVersion') != identity['deploymentVersion']:
        raise RuntimeError('Existing evidence belongs to a different deployment version.')
    if report.get('sourceCommit') != identity['sourceCommit']:
        raise RuntimeError('Existing evidence belongs to a different source commit.')
    apply_static_capture_provenance(report, {
        'captureScript': Path(__file__).name,
        'captureScriptSha256': CAPTURE_SCRIPT_SHA256,
        'captureDependencies': {
            PROVENANCE_HELPER.name: PROVENANCE_HELPER_SHA256,
            APPEND_PROVENANCE_HELPER.name: APPEND_PROVENANCE_HELPER_SHA256,
        },
    }, append=appending_report)
    report['deployedAt'] = identity['deployedAt']
    report['deploymentTag'] = identity['deploymentTag']
    report['identityVerifiedFromHealth'] = True
    selected_cases = [case for case in CASES if CASE_SLUG in (None, case['slug'])]
    if not selected_cases:
        raise RuntimeError(f'Unknown evidence case: {CASE_SLUG}')

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=BROWSER_ARGS,
        )
        try:
            apply_browser_capture_provenance(report, {
                'browser': browser_identity(CHROME, browser.version),
                'browserLaunch': {
                    'executable': Path(CHROME).name,
                    'headless': True,
                    'args': BROWSER_ARGS,
                    'viewport': {'width': 1840, 'height': 1120},
                    'deviceScaleFactor': 1,
                },
            }, append=appending_report)
            for case in selected_cases:
                page = browser.new_page(viewport={'width': 1840, 'height': 1120}, device_scale_factor=1)
                page.set_default_timeout(20_000)
                console_errors = []
                page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
                page.on('pageerror', lambda error: console_errors.append(str(error)))
                reset_requested = False
                try:
                    response = page.goto(APP_URL, wait_until='networkidle', timeout=30_000)
                    if not response or response.status != 200:
                        raise RuntimeError(f"MetaWebMCP returned {response.status if response else 'no response'}")
                    if not page.evaluate('Boolean(document.modelContext)'):
                        raise RuntimeError(
                            'Chrome did not expose document.modelContext. '
                            'Headless evidence capture requires Chrome 152+ with WebMCPTesting enabled.'
                        )
                    page.locator('#native-status', has_text='WebMCP active').wait_for(state='visible')
                    initial_tools = page.evaluate("async () => (await document.modelContext.getTools()).map(tool => tool.name)")
                    if len(initial_tools) != 7:
                        raise AssertionError(f'Expected seven native meta-tools, received {initial_tools}')
                    if not report['initialTools']:
                        report['initialTools'] = sorted(initial_tools)
                    if not report.get('assetSha256'):
                        report['assetSha256'] = deployed_asset_hashes(page)
                    page.locator('#adapter-mode').click()
                    page.locator('#mcp-notice.connected').wait_for(state='visible', timeout=20_000)

                    stage_results = []
                    session_ids = []
                    all_matches = {}
                    for stage_index, stage in enumerate(case['stages'], start=1):
                        payload = page.evaluate(
                        """async stageInfo => {
                          const executeNative = async (name, args) => {
                            const tool = (await document.modelContext.getTools()).find(candidate => candidate.name === name);
                            if (!tool) throw new Error(`Native WebMCP tool not found: ${name}`);
                            try {
                              const raw = await document.modelContext.executeTool(tool, JSON.stringify(args));
                              if (raw === null || typeof raw !== 'string') return raw;
                              try { return JSON.parse(raw); } catch { return raw; }
                            } catch (error) {
                              const trace = window.MetaWebMCP?.getState?.().recentTrace?.slice(-4) || [];
                              throw new Error(`${name} failed: ${error?.message || error}; trace=${JSON.stringify(trace)}`);
                            }
                          };
                          const analysis = await executeNative('meta_analyze_site', {
                            source: 'browser_mcp', url: stageInfo.url, goal: stageInfo.goal,
                          });
                          const { browserMcpSession } = await import('/js/browser-mcp-session.js');
                          const client = await browserMcpSession.directClient();
                          if (!client) throw new Error('Page-owned Browser MCP client was unavailable.');
                          const availableMcpTools = (await client.listTools()).map(tool => tool.name).sort();
                          const sessionIdAfterAnalysis = client?.sessionId || client?.messageEndpoint || null;
                          const candidate = analysis.capabilities.find(tool => tool.name === stageInfo.tool);
                          if (!candidate) {
                            throw new Error(`Expected ${stageInfo.tool}; discovered ${analysis.capabilities.map(tool => tool.name).join(', ')}`);
                          }
                          const created = await executeNative('meta_create_webmcp', {
                            capability_ids: [candidate.id],
                            overrides: [{
                              capability_id: candidate.id,
                              name: stageInfo.tool,
                              description: stageInfo.reviewed_description,
                            }],
                          });
                          const selected = created.tools.find(tool => tool.name === stageInfo.tool);
                          if (!selected) {
                            throw new Error(`Expected ${stageInfo.tool}; generated ${created.tools.map(tool => tool.name).join(', ')}`);
                          }
                          const properties = selected.inputSchema?.properties || {};
                          const args = { ...(selected.sampleArgs || {}) };
                          for (const [name, value] of Object.entries(stageInfo.arguments || {})) {
                            if (Object.hasOwn(properties, name)) args[name] = value;
                          }
                          await executeNative('meta_activate_webmcp', {});
                          const activeNativeTools = await document.modelContext.getTools();
                          if (!activeNativeTools.some(tool => tool.name === selected.name)) {
                            throw new Error(`Generated tool ${selected.name} was not registered natively.`);
                          }
                          const execution = await executeNative(selected.name, args);
                          const sessionIdAfterExecution = client?.sessionId || client?.messageEndpoint || null;
                          const exported = stageInfo.export
                            ? await executeNative('meta_export_webmcp', { project_name: stageInfo.export })
                            : null;
                          return {
                            target: { title: analysis.source?.title, url: analysis.source?.url, kind: analysis.source?.kind },
                            goal: analysis.goal,
                            analysis: {
                              summary: analysis.summary,
                              warnings: analysis.warnings,
                              runtime: {
                                transport: 'page',
                                availableToolCount: availableMcpTools.length,
                                availableTools: availableMcpTools,
                                sessionEstablished: Boolean(sessionIdAfterAnalysis),
                                sessionReused: Boolean(sessionIdAfterAnalysis && sessionIdAfterAnalysis === sessionIdAfterExecution),
                              },
                              capabilities: analysis.capabilities.map(({ name, description, risk, inputSchema, evidence }) => ({
                                name, description, risk, inputSchema, evidenceCount: evidence?.length || 0,
                              })),
                            },
                            generatedTools: created.tools.map(({ name, risk, inputSchema }) => ({ name, risk, inputSchema })),
                            selectedTool: selected.name,
                            nativeRegistered: true,
                            arguments: args,
                            execution,
                            _sessionId: sessionIdAfterExecution,
                            export: exported ? {
                              fileName: exported.fileName,
                              fileCount: exported.fileCount,
                              bytes: exported.bytes,
                              downloadUrl: exported.downloadUrl,
                            } : null,
                          };
                        }""",
                        stage,
                        )

                        final_snapshot = str(payload['execution'].get('result') or '')
                        matches = {
                            needle: needle.casefold() in final_snapshot.casefold()
                            for needle in stage['expected']
                        }
                        if not all(matches.values()):
                            raise AssertionError(
                                f"Missing expected postcondition text for {stage['tool']}: {matches}"
                            )
                        session_ids.append(payload.pop('_sessionId', None))
                        exported = payload.get('export')
                        if exported:
                            download_url = exported.pop('downloadUrl')
                            download = page.context.request.get(f'{APP_URL}{download_url}')
                            if not download.ok:
                                raise AssertionError(f'Export download returned HTTP {download.status}')
                            archive_bytes = download.body()
                            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                                names = archive.namelist()
                                if len(names) != exported['fileCount']:
                                    raise AssertionError('Exported file count did not match the archive')
                                if any((item.external_attr >> 16) != 0o100644 for item in archive.infolist()):
                                    raise AssertionError('Export archive contained a non-portable file mode')
                                source_name = next(name for name in names if name.endswith('/src/webmcp.generated.js'))
                                spec_name = next(name for name in names if name.endswith('/src/tool-spec.json'))
                                source = archive.read(source_name).decode()
                                specs = json.loads(archive.read(spec_name))
                                if 'document.modelContext.registerTool({' not in source:
                                    raise AssertionError('Export source did not contain direct native registration')
                                if [item.get('name') for item in specs] != [stage['tool']]:
                                    raise AssertionError('Exported ToolSpec did not match the selected semantic tool')
                                exported.update({
                                    'archiveSha256': hashlib.sha256(archive_bytes).hexdigest(),
                                    'directRegisterTool': True,
                                    'unixFileMode': '0644',
                                    'toolNames': [item.get('name') for item in specs],
                                })
                        stage_result = compact_result(payload, stage['expected'])
                        stage_result['postconditions'] = matches
                        stage_results.append(stage_result)
                        all_matches.update({f"{stage['tool']}:{key}": value for key, value in matches.items()})
                        print({'target': case['target'], 'stage': stage_index, 'tool': stage_result['selectedTool'], 'postconditions': matches, 'ok': True})

                    screenshot_block = None if DRY_RUN else page.evaluate(
                        """async () => {
                          const { browserMcpSession } = await import('/js/browser-mcp-session.js');
                          const client = await browserMcpSession.directClient();
                          const response = await client.callTool('browser_take_screenshot', { raw: true });
                          const image = response?.content?.find(item => item.type === 'image');
                          if (!image?.data) throw new Error('Browser MCP did not return screenshot image content.');
                          return image;
                        }"""
                    )
                    image_bytes = b'' if DRY_RUN else base64.b64decode(screenshot_block['data'])
                    target_path = OUT / f"{case['slug']}-target.png"
                    ui_path = OUT / f"{case['slug']}-workspace.png"
                    ui_bytes = page.screenshot(full_page=True, animations='disabled')

                    if console_errors:
                        raise AssertionError(f"Browser console errors: {console_errors}")
                    if not DRY_RUN and not image_bytes.startswith(b'\x89PNG\r\n\x1a\n'):
                        raise AssertionError(f"Unexpected target screenshot type: {screenshot_block.get('mimeType')}")

                    if not DRY_RUN:
                        target_path.write_bytes(image_bytes)
                    ui_path.write_bytes(ui_bytes)

                    session_established = bool(session_ids) and all(session_ids)
                    session_reused = session_established and len(set(session_ids)) == 1
                    if not DRY_RUN and not session_reused:
                        raise AssertionError('Browser MCP session was not preserved across all stages')

                    compact = {
                        'target': case['target'],
                        'slug': case['slug'],
                        'stages': stage_results,
                        'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                        'postconditions': all_matches,
                        'session': {
                            'established': session_established,
                            'reusedAcrossStages': session_reused,
                            'stageCount': len(stage_results),
                        },
                        'workspaceScreenshot': ui_path.name,
                        'workspaceScreenshotSha256': hashlib.sha256(ui_bytes).hexdigest(),
                        **({
                            'targetScreenshot': target_path.name,
                            'targetScreenshotSha256': hashlib.sha256(image_bytes).hexdigest(),
                        } if not DRY_RUN else {}),
                        'consoleErrors': [],
                    }
                    report['results'] = [result for result in report['results'] if result['slug'] != case['slug']]
                    report['results'].append(compact)
                    order = {item['slug']: index for index, item in enumerate(CASES)}
                    report['results'].sort(key=lambda result: order[result['slug']])
                    report_path.write_text(json.dumps(report, indent=2) + '\n')
                finally:
                    try:
                        page.evaluate("""async () => {
                          const tool = (await document.modelContext?.getTools?.() || []).find(candidate => candidate.name === 'meta_reset_workspace');
                          if (tool) await document.modelContext.executeTool(tool, '{}');
                        }""")
                        reset_requested = True
                        page.wait_for_timeout(1200)
                    except Exception as error:
                        print({'target': case['target'], 'resetWarning': str(error)})
                    page.close()
                    if not reset_requested:
                        print({'target': case['target'], 'resetRequested': False})
        finally:
            browser.close()

    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print({'report': str(report_path), 'results': len(report['results'])})


if __name__ == '__main__':
    main()
