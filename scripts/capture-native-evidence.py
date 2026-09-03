from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('META_WEBMCP_EVIDENCE_OUT', ROOT / 'evidence'))
APP_URL = os.environ.get('META_WEBMCP_APP_URL', 'https://metawebmcp.neuryta.com')
DEPLOYMENT_VERSION = os.environ.get('META_WEBMCP_DEPLOYMENT_VERSION', '').strip()
SOURCE_COMMIT = os.environ.get('META_WEBMCP_SOURCE_COMMIT', '').strip() or subprocess.check_output(
    ['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True
).strip()
BROWSER_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--enable-blink-features=WebMCPTesting']


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


if not DEPLOYMENT_VERSION:
    raise RuntimeError('Set META_WEBMCP_DEPLOYMENT_VERSION to the deployed Worker version.')

CHROME = chrome_executable()


def native_execute(page, name, arguments):
    return page.evaluate(
        """async ({ name, arguments }) => {
          const tools = await document.modelContext.getTools();
          const tool = tools.find(candidate => candidate.name === name);
          if (!tool) throw new Error(`Native WebMCP tool not found: ${name}`);
          const raw = await document.modelContext.executeTool(tool, JSON.stringify(arguments));
          if (raw === null) return null;
          if (typeof raw !== 'string') return raw;
          try { return JSON.parse(raw); } catch { return raw; }
        }""",
        {'name': name, 'arguments': arguments},
    )


def deployed_asset_hashes(page):
    paths = [
        '/',
        '/styles.css',
        '/js/app.js',
        '/js/browser-mcp-session.js',
        '/js/demo-analyzer.js',
        '/js/mcp-http-client.js',
        '/js/mcp-recipe.js',
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


def validate_native_export(browser, source_page, exported):
    download_url = f"{APP_URL}{exported['downloadUrl']}"
    response = source_page.context.request.get(download_url)
    if not response.ok:
        raise RuntimeError(f'Native export download returned HTTP {response.status}')
    archive_bytes = response.body()
    archive_hash = hashlib.sha256(archive_bytes).hexdigest()
    archive_path = OUT / 'relay-sessions-webmcp.zip'
    archive_path.write_bytes(archive_bytes)
    screenshot_path = OUT / 'native-export-owned-page.png'

    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        names = archive.namelist()
        if len(names) != 13:
            raise AssertionError(f'Expected 13 archive entries, received {len(names)}')
        if any(Path(name).is_absolute() or '..' in Path(name).parts for name in names):
            raise AssertionError('Export archive contains an unsafe path')
        if any((item.external_attr >> 16) != 0o100644 for item in archive.infolist()):
            raise AssertionError('Export archive does not preserve readable Unix file modes')
        source_name = next(name for name in names if name.endswith('/src/webmcp.generated.js'))
        source = archive.read(source_name).decode()
        if 'document.modelContext.registerTool({' not in source:
            raise AssertionError('Export source does not directly register WebMCP tools')

        with tempfile.TemporaryDirectory(prefix='metawebmcp-native-export-') as directory:
            archive.extractall(directory)
            project_root = Path(directory) / names[0].split('/')[0]
            process = subprocess.Popen(
                ['node', 'serve.mjs'],
                cwd=project_root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            export_page = None
            try:
                deadline = time.monotonic() + 10
                while True:
                    try:
                        with socket.create_connection(('127.0.0.1', 4173), timeout=0.25):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('Exported repository server exited before becoming ready')
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Exported repository server did not become ready')
                        time.sleep(0.1)

                export_errors = []
                failed_responses = []
                export_page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
                export_page.on('console', lambda message: export_errors.append({'text': message.text, 'location': message.location}) if message.type == 'error' else None)
                export_page.on('pageerror', lambda error: export_errors.append(str(error)))
                export_page.on('response', lambda item: failed_responses.append({'status': item.status, 'url': item.url}) if item.status >= 400 else None)
                export_page.goto('http://127.0.0.1:4173', wait_until='networkidle')
                export_page.wait_for_function(
                    "async () => document.modelContext && (await document.modelContext.getTools()).length === 4"
                )
                tool_names = export_page.evaluate(
                    "async () => (await document.modelContext.getTools()).map(tool => tool.name)"
                )
                search = native_execute(export_page, 'find_sessions', {
                    'query': 'agent',
                    'level': 'all',
                    'day': 'all',
                })
                added = native_execute(export_page, 'add_session_to_itinerary', {
                    'item_id': 'agent-evals-that-catch-regressions',
                })
                inspected = native_execute(export_page, 'inspect_itinerary', {})
                expected_title = 'Agent evals that catch regressions'
                if search.get('ok') is not True or expected_title not in str(search.get('visibleState', '')):
                    raise AssertionError('Exported search did not expose the requested matching session')
                if added.get('ok') is not True or expected_title not in str(added.get('visibleState', '')):
                    raise AssertionError('Exported add tool did not expose the selected itinerary item')
                if inspected.get('ok') is not True or expected_title not in str(inspected.get('visibleState', '')):
                    raise AssertionError('Exported inspect tool did not read the selected itinerary item')
                export_page.wait_for_timeout(350)
                screenshot_bytes = export_page.screenshot(full_page=True, animations='disabled')
                cleared = native_execute(export_page, 'clear_itinerary', {})
                cleared_state = export_page.evaluate('window.demoApp.getState().itinerary.length')
                if cleared.get('ok') is not True or '0 SESSIONS' not in str(cleared.get('visibleState', '')) or cleared_state != 0:
                    raise AssertionError('Exported clear tool did not empty the itinerary')
                if export_errors:
                    raise AssertionError(f'Exported repository console errors: {export_errors}; failed responses: {failed_responses}')
                screenshot_path.write_bytes(screenshot_bytes)
                return {
                    'archive': archive_path.name,
                    'archiveSha256': archive_hash,
                    'fileCount': len(names),
                    'unixFileMode': '0644',
                    'directRegisterTool': True,
                    'registeredTools': tool_names,
                    'search': {
                        'ok': search.get('ok'),
                        'matchedTitle': expected_title,
                        'postcondition': expected_title in str(search.get('visibleState', '')),
                    },
                    'added': {
                        'ok': added.get('ok'),
                        'selectedTitle': expected_title,
                        'postcondition': expected_title in str(added.get('visibleState', '')),
                    },
                    'inspected': {
                        'ok': inspected.get('ok'),
                        'visibleState': inspected.get('visibleState'),
                        'postcondition': expected_title in str(inspected.get('visibleState', '')),
                    },
                    'cleared': {
                        'ok': cleared.get('ok'),
                        'visibleState': cleared.get('visibleState'),
                        'remainingItems': cleared_state,
                        'postcondition': cleared_state == 0,
                    },
                    'consoleErrors': [],
                    'screenshot': screenshot_path.name,
                    'screenshotSha256': hashlib.sha256(screenshot_bytes).hexdigest(),
                }
            finally:
                if export_page:
                    export_page.close()
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def main():
    OUT.mkdir(exist_ok=True)
    screenshot_path = OUT / 'native-webmcp-recursive-workspace.png'
    result_path = OUT / 'native-webmcp-result.json'
    console_errors = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=BROWSER_ARGS,
        )
        try:
            page = browser.new_page(viewport={'width': 1840, 'height': 1215}, device_scale_factor=1)
            page.set_default_timeout(20_000)
            page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
            page.on('pageerror', lambda error: console_errors.append(str(error)))

            response = page.goto(APP_URL, wait_until='networkidle', timeout=30_000)
            if not response or response.status != 200:
                raise RuntimeError(f"MetaWebMCP returned {response.status if response else 'no response'}")
            page.locator('#native-status', has_text='WebMCP active').wait_for(state='visible')

            browser_api = page.evaluate(
                """() => ({
                  modelContext: Boolean(document.modelContext),
                  registerTool: typeof document.modelContext?.registerTool,
                  getTools: typeof document.modelContext?.getTools,
                  executeTool: typeof document.modelContext?.executeTool,
                })"""
            )
            initial_tools = page.evaluate(
                "async () => (await document.modelContext.getTools()).map(tool => tool.name)"
            )
            asset_hashes = deployed_asset_hashes(page)

            analysis_arguments = {
                'source': 'demo',
                'goal': 'Find conference sessions, add useful ones to an itinerary, and inspect the resulting plan.',
            }
            search_arguments = {
                'query': 'agent',
                'level': 'all',
                'day': 'all',
            }
            add_arguments = {'item_id': 'agent-evals-that-catch-regressions'}
            export_arguments = {'project_name': 'relay-sessions-webmcp'}

            analysis = native_execute(page, 'meta_analyze_site', analysis_arguments)
            created = native_execute(page, 'meta_create_webmcp', {})
            activated = native_execute(page, 'meta_activate_webmcp', {})
            active_tools = page.evaluate(
                "async () => (await document.modelContext.getTools()).map(tool => tool.name)"
            )

            search = native_execute(page, 'find_sessions', search_arguments)
            added = native_execute(page, 'add_session_to_itinerary', add_arguments)
            inspected = native_execute(page, 'inspect_itinerary', {})
            cleared = native_execute(page, 'clear_itinerary', {})
            evaluation = native_execute(page, 'meta_test_webmcp', {})
            exported = native_execute(page, 'meta_export_webmcp', export_arguments)
            exported_native = validate_native_export(browser, page, exported)

            page.wait_for_timeout(750)
            trace_times = page.locator('.trace-entry time').all_inner_texts()
            if any(len(value) > 11 for value in trace_times):
                raise AssertionError(f'Unexpected trace timestamp: {trace_times}')
            page.screenshot(path=str(screenshot_path), full_page=True, animations='disabled')
            screenshot_bytes = screenshot_path.read_bytes()

            if len(initial_tools) != 7:
                raise AssertionError(f'Expected seven initial tools, received {len(initial_tools)}')
            if len(active_tools) != 11:
                raise AssertionError(f'Expected eleven active tools, received {len(active_tools)}')
            if not evaluation.get('ok'):
                raise AssertionError('Native runtime evaluation did not pass')
            if cleared.get('ok') is not True or cleared.get('state', {}).get('itinerary') != []:
                raise AssertionError('Native clear tool did not empty the itinerary')
            if exported.get('fileCount') != 13:
                raise AssertionError(f"Expected 13 exported files, received {exported.get('fileCount')}")
            if console_errors:
                raise AssertionError(f'Browser console errors: {console_errors}')

            result = {
                'browserApi': browser_api,
                'initialTools': initial_tools,
                'analysis': {
                    'summary': analysis.get('summary'),
                    'capabilities': [
                        {'name': item.get('name'), 'risk': item.get('risk')}
                        for item in analysis.get('capabilities', [])
                    ],
                },
                'created': {'toolCount': created.get('toolCount')},
                'activated': {
                    'ok': activated.get('ok'),
                    'generatedTools': activated.get('generatedTools'),
                    'registrySize': activated.get('registrySize'),
                },
                'activeTools': active_tools,
                'search': {
                    'ok': search.get('ok'),
                    'visibleSessionCount': len(search.get('state', {}).get('visibleSessions', [])),
                },
                'added': {
                    'ok': added.get('ok'),
                    'itinerary': [
                        {'id': item.get('id'), 'title': item.get('title')}
                        for item in added.get('state', {}).get('itinerary', [])
                    ],
                },
                'inspected': {
                    'ok': inspected.get('ok'),
                    'visibleState': inspected.get('visibleState'),
                },
                'cleared': {
                    'ok': cleared.get('ok'),
                    'remainingItems': len(cleared.get('state', {}).get('itinerary', [])),
                    'postcondition': cleared.get('state', {}).get('itinerary') == [],
                },
                'evaluation': {
                    'ok': evaluation.get('ok'),
                    'results': [
                        {
                            'tool': item.get('tool'),
                            'status': item.get('status'),
                            'checks': item.get('checks'),
                        }
                        for item in evaluation.get('results', [])
                    ],
                },
                'exported': {
                    'fileName': exported.get('fileName'),
                    'fileCount': exported.get('fileCount'),
                    'bytes': exported.get('bytes'),
                },
                'exportedNativeValidation': exported_native,
                'semanticToolTrace': [
                    {'tool': 'meta_analyze_site', 'arguments': analysis_arguments, 'completed': True},
                    {'tool': 'meta_create_webmcp', 'arguments': {}, 'completed': True},
                    {'tool': 'meta_activate_webmcp', 'arguments': {}, 'ok': activated.get('ok')},
                    {'tool': 'find_sessions', 'arguments': search_arguments, 'ok': search.get('ok')},
                    {'tool': 'add_session_to_itinerary', 'arguments': add_arguments, 'ok': added.get('ok')},
                    {'tool': 'inspect_itinerary', 'arguments': {}, 'ok': inspected.get('ok')},
                    {'tool': 'clear_itinerary', 'arguments': {}, 'ok': cleared.get('ok')},
                    {'tool': 'meta_test_webmcp', 'arguments': {}, 'ok': evaluation.get('ok')},
                    {'tool': 'meta_export_webmcp', 'arguments': export_arguments, 'completed': True},
                ],
                'uiStatus': page.locator('#native-status').inner_text().strip(),
                'generatedToolCount': page.locator('#generated-tool-count').inner_text().strip(),
                'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'deployment': APP_URL,
                'deploymentVersion': DEPLOYMENT_VERSION,
                'sourceCommit': SOURCE_COMMIT,
                'browser': f'Google Chrome {browser.version} beta',
                'browserLaunch': {
                    'executable': Path(CHROME).name,
                    'headless': True,
                    'args': BROWSER_ARGS,
                    'viewport': {'width': 1840, 'height': 1215},
                    'deviceScaleFactor': 1,
                },
                'feature': 'WebMCPTesting',
                'assetSha256': asset_hashes,
                'consoleErrors': [],
                'screenshot': screenshot_path.name,
                'screenshotSha256': hashlib.sha256(screenshot_bytes).hexdigest(),
            }
            result_path.write_text(json.dumps(result, indent=2) + '\n')
            print(json.dumps({
                'initialTools': len(initial_tools),
                'activeTools': len(active_tools),
                'evaluationPassed': evaluation.get('ok'),
                'exportedFiles': exported.get('fileCount'),
                'exportedNativeTools': len(exported_native.get('registeredTools', [])),
                'consoleErrors': len(console_errors),
                'result': str(result_path),
            }, indent=2))
        finally:
            browser.close()


if __name__ == '__main__':
    main()
