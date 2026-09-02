#!/usr/bin/env python3
"""Full recursive browser test for MetaWebMCP.

The test renders a network-independent page harness, injects the production
browser modules, and bridges same-origin API calls to the real Node server via
Playwright's exposed-function mechanism. This executes the production UI,
registry, target application, analyzer, generator, and export endpoints in a
real Chromium JavaScript/DOM environment.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "test-artifacts"
ARTIFACTS.mkdir(exist_ok=True)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(url: str, process: subprocess.Popen[str]) -> dict[str, Any]:
    deadline = time.time() + 12
    last_error: Exception | None = None
    while time.time() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate(timeout=2)
            raise RuntimeError(f"Server exited early.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            last_error = error
            time.sleep(0.1)
    raise RuntimeError(f"Server did not become healthy: {last_error}")


def fetch_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.read()


def browser_module_url(source: str) -> str:
    encoded = base64.b64encode(source.encode("utf-8")).decode("ascii")
    return f"data:text/javascript;base64,{encoded}"


def build_browser_sources() -> tuple[str, str, str, str]:
    index_html = (ROOT / "public/index.html").read_text()
    index_html = index_html.replace('<link rel="stylesheet" href="/styles.css">', "")
    index_html = index_html.replace('<script type="module" src="/js/app.js"></script>', "")
    index_html = index_html.replace('src="/demo/"', 'src="about:blank"')

    demo_html = (ROOT / "public/demo/index.html").read_text()
    demo_css = (ROOT / "public/demo/demo.css").read_text()
    demo_js = (ROOT / "public/demo/demo.js").read_text().replace(
        "window.parent.postMessage({ type: 'relay-state', state: getState() }, location.origin);",
        "window.parent.postMessage({ type: 'relay-state', state: getState() }, '*');",
    )
    demo_html = demo_html.replace('<link rel="stylesheet" href="/demo/demo.css">', f"<style>{demo_css}</style>")
    demo_html = demo_html.replace('<script type="module" src="/demo/demo.js"></script>', f"<script>{demo_js}</script>")

    mcp_client_url = browser_module_url((ROOT / "public/js/mcp-http-client.js").read_text())
    recipe_url = browser_module_url((ROOT / "public/js/mcp-recipe.js").read_text())
    browser_session_source = (ROOT / "public/js/browser-mcp-session.js").read_text()
    browser_session_source = browser_session_source.replace("'./mcp-http-client.js'", json.dumps(mcp_client_url))
    browser_session_source = browser_session_source.replace("'./mcp-recipe.js'", json.dumps(recipe_url))
    browser_session_url = browser_module_url(browser_session_source)

    runtime_source = (ROOT / "public/js/webmcp-runtime.js").read_text()
    runtime_source = runtime_source.replace("'./browser-mcp-session.js'", json.dumps(browser_session_url))
    analyzer_source = (ROOT / "public/js/demo-analyzer.js").read_text().replace(
        "new URL('/demo/', location.href)",
        "new URL('/demo/', 'http://metawebmcp.test/')",
    )
    analyzer_source = analyzer_source.replace("'./browser-mcp-session.js'", json.dumps(browser_session_url))
    runtime_url = browser_module_url(runtime_source)
    analyzer_url = browser_module_url(analyzer_source)
    app_source = (ROOT / "public/js/app.js").read_text()
    app_source = app_source.replace("'./demo-analyzer.js'", json.dumps(analyzer_url))
    app_source = app_source.replace("'./webmcp-runtime.js'", json.dumps(runtime_url))
    app_source = app_source.replace("'./browser-mcp-session.js'", json.dumps(browser_session_url))
    return index_html, (ROOT / "public/styles.css").read_text(), demo_html, app_source


def make_api_bridge(base_url: str):
    def api_bridge(request: dict[str, Any]) -> dict[str, Any]:
        path = str(request.get("path", "/"))
        if not path.startswith("/"):
            raise ValueError("Test bridge accepts only same-origin paths")
        method = str(request.get("method", "GET")).upper()
        body = request.get("body")
        data = None if body is None else str(body).encode("utf-8")
        headers = {str(k): str(v) for k, v in (request.get("headers") or {}).items()}
        outgoing = urllib.request.Request(f"{base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(outgoing, timeout=12) as response:
                return {
                    "status": response.status,
                    "headers": dict(response.headers.items()),
                    "body": response.read().decode("utf-8"),
                }
        except urllib.error.HTTPError as error:
            return {
                "status": error.code,
                "headers": dict(error.headers.items()),
                "body": error.read().decode("utf-8"),
            }

    return api_bridge


def progress(message: str) -> None:
    print(f"[e2e] {message}", flush=True)


def chromium_executable(playwright: Any) -> str:
    configured = os.environ.get("CHROMIUM_PATH")
    candidates = [
        Path(configured) if configured else None,
        Path(playwright.chromium.executable_path),
        Path("/usr/bin/chromium"),
        Path("/usr/bin/chromium-browser"),
        Path("/usr/bin/google-chrome"),
        Path("/usr/bin/google-chrome-stable"),
    ]
    available = next((candidate for candidate in candidates if candidate and candidate.is_file()), None)
    if available is None:
        raise RuntimeError(
            "No Chromium executable found. Run `python -m playwright install chromium` "
            "or set CHROMIUM_PATH."
        )
    return str(available)


def main() -> int:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    env = os.environ.copy()
    env.update({"PORT": str(port), "HOST": "127.0.0.1", "NODE_ENV": "test"})
    server = subprocess.Popen(
        ["node", "server.mjs"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    result: dict[str, Any] = {"baseUrl": base_url, "checks": []}
    console_errors: list[str] = []
    try:
        progress("waiting for server")
        health = wait_for_health(f"{base_url}/health", server)
        assert health["ok"] is True
        result["checks"].append("server health endpoint")

        progress("building browser harness")
        index_html, styles, demo_html, app_source = build_browser_sources()
        with sync_playwright() as playwright:
            progress("launching Chromium")
            browser = playwright.chromium.launch(
                executable_path=chromium_executable(playwright),
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"],
            )
            try:
                context = browser.new_context(viewport={"width": 1840, "height": 1120}, device_scale_factor=1)
                page = context.new_page()
                page.set_default_timeout(12_000)
                progress("Chromium page created")
                page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
                page.on("pageerror", lambda error: console_errors.append(str(error)))
                page.expose_function("__metaApiBridge", make_api_bridge(base_url))
                progress("rendering production HTML")
                page.set_content(index_html, wait_until="domcontentloaded")
                page.add_style_tag(content=styles)

                page.evaluate(
                    """
                    () => {
                      const registered = Object.create(null);
                      Object.defineProperty(window, '__nativeTools', { configurable: false, value: registered });
                      Object.defineProperty(document, 'modelContext', {
                        configurable: true,
                        value: {
                          async registerTool(tool, options = {}) {
                            if (!tool || !tool.name || typeof tool.execute !== 'function') throw new Error('Invalid test WebMCP tool');
                            if (registered[tool.name]) throw new Error(`Duplicate tool: ${tool.name}`);
                            registered[tool.name] = tool;
                            options.signal?.addEventListener('abort', () => {
                              if (registered[tool.name] === tool) delete registered[tool.name];
                              window.dispatchEvent(new Event('toolchange'));
                            }, { once: true });
                            window.dispatchEvent(new Event('toolchange'));
                          },
                          async getTools() {
                            return Object.values(registered)
                              .map(({ execute, ...tool }) => tool)
                              .sort((left, right) => left.name.localeCompare(right.name));
                          },
                          async executeTool(tool, inputJson = '{}', options = {}) {
                            const registeredTool = registered[tool?.name];
                            if (!registeredTool) throw new Error(`Unknown tool ${tool?.name}`);
                            const input = typeof inputJson === 'string' ? JSON.parse(inputJson) : inputJson;
                            return registeredTool.execute(input, { signal: options.signal });
                          }
                        }
                      });
                      window.__callNative = async (name, input = {}) => {
                        const tool = (await document.modelContext.getTools()).find((candidate) => candidate.name === name);
                        if (!tool) throw new Error(`Unknown native tool ${name}`);
                        return document.modelContext.executeTool(tool, JSON.stringify(input));
                      };

                      window.fetch = async (input, options = {}) => {
                        const raw = typeof input === 'string' ? input : input.url;
                        const parsed = new URL(raw, 'http://metawebmcp.test/');
                        if (parsed.origin !== 'http://metawebmcp.test') throw new Error(`Blocked test fetch: ${parsed.href}`);
                        const response = await window.__metaApiBridge({
                          path: parsed.pathname + parsed.search,
                          method: options.method || 'GET',
                          headers: options.headers || {},
                          body: options.body ?? null,
                        });
                        return new Response(response.body, { status: response.status, headers: response.headers });
                      };
                    }
                    """
                )
                progress("loading controlled target")
                page.locator("#target-frame").evaluate("(frame, html) => { frame.srcdoc = html; }", demo_html)
                page.wait_for_function("document.querySelector('#target-frame').contentWindow?.demoApp")
                progress("loading production browser modules")
                page.add_script_tag(content=app_source, type="module")
                page.wait_for_function("window.MetaWebMCP && Object.keys(window.__nativeTools || {}).length === 7")

                progress("meta-tools registered")
                native_names = page.evaluate("async () => (await document.modelContext.getTools()).map(tool => tool.name)")
                expected_meta = [
                    "meta_activate_webmcp",
                    "meta_analyze_site",
                    "meta_create_webmcp",
                    "meta_export_webmcp",
                    "meta_get_state",
                    "meta_reset_workspace",
                    "meta_test_webmcp",
                ]
                assert native_names == expected_meta, native_names
                assert page.locator("#target-frame").evaluate("frame => frame.contentDocument.modelContext === undefined") is True
                result["checks"].append("seven native meta-tools; target has no WebMCP registry")

                progress("invoking meta_analyze_site")
                analysis = page.evaluate(
                    """async () => window.__callNative('meta_analyze_site', {
                      source: 'demo',
                      goal: 'Find conference sessions, add useful sessions to an itinerary, and inspect schedule conflicts.'
                    })"""
                )
                assert analysis["summary"]["candidates"] == 4, analysis
                capability_names = [item["name"] for item in analysis["capabilities"]]
                assert capability_names == [
                    "find_sessions",
                    "add_session_to_itinerary",
                    "inspect_itinerary",
                    "clear_itinerary",
                ], capability_names
                assert all(item["evidence"] for item in analysis["capabilities"])
                assert page.locator("#goal").input_value() == (
                    "Find conference sessions, add useful sessions to an itinerary, and inspect schedule conflicts."
                )
                assert page.locator("#capability-section").evaluate("element => element.open") is True
                result["checks"].append("live target analysis, synchronized agent brief, and four evidence-backed candidates")

                progress("invoking meta_create_webmcp")
                created = page.evaluate("async () => window.__callNative('meta_create_webmcp', {})")
                assert created["toolCount"] == 4
                assert all(tool["inputSchema"]["type"] == "object" for tool in created["tools"])
                assert page.locator("#capability-section").evaluate("element => element.open") is False
                result["checks"].append("ToolSpec creation")

                progress("invoking meta_activate_webmcp")
                activated = page.evaluate("async () => window.__callNative('meta_activate_webmcp', {})")
                assert activated["registrySize"] == 11, activated
                generated_names = page.evaluate(
                    "async () => (await document.modelContext.getTools()).map(tool => tool.name).filter(name => !name.startsWith('meta_')).sort()"
                )
                assert generated_names == [
                    "add_session_to_itinerary",
                    "clear_itinerary",
                    "find_sessions",
                    "inspect_itinerary",
                ]
                visible_registry_names = page.locator("#tool-list .tool-card").evaluate_all(
                    "cards => cards.map(card => card.dataset.toolName)"
                )
                assert visible_registry_names[:4] == [
                    "find_sessions",
                    "add_session_to_itinerary",
                    "inspect_itinerary",
                    "clear_itinerary",
                ]
                result["checks"].append("recursive dynamic registration from seven to eleven tools")

                progress("invoking generated domain tools")
                search_result = page.evaluate(
                    """async () => window.__callNative('find_sessions', {
                      query: 'agent', level: 'all', day: 'all'
                    })"""
                )
                assert search_result["ok"] is True
                assert len(search_result["state"]["visibleSessions"]) >= 2

                add_result = page.evaluate(
                    """async () => window.__callNative('add_session_to_itinerary', {
                      item_id: 'agent-evals-that-catch-regressions'
                    })"""
                )
                assert any(
                    session["id"] == "agent-evals-that-catch-regressions"
                    for session in add_result["state"]["itinerary"]
                )
                itinerary_text = page.locator("#target-frame").evaluate(
                    "frame => frame.contentDocument.querySelector('#itinerary-panel').innerText"
                )
                assert "Agent evals that catch regressions" in itinerary_text

                inspect_result = page.evaluate("async () => window.__callNative('inspect_itinerary', {})")
                assert inspect_result["state"]["itinerary"][0]["id"] == "agent-evals-that-catch-regressions"
                result["checks"].append("generated tools execute against real target state")

                progress("invoking meta_test_webmcp")
                evaluation = page.evaluate("async () => window.__callNative('meta_test_webmcp', {})")
                assert evaluation["ok"] is True, evaluation
                assert len(evaluation["results"]) == 4
                assert all(item["status"] == "passed" for item in evaluation["results"]), evaluation
                result["checks"].append("four deterministic runtime evaluations")

                progress("invoking meta_export_webmcp")
                exported = page.evaluate(
                    "async () => window.__callNative('meta_export_webmcp', { project_name: 'relay-sessions-webmcp' })"
                )
                assert exported["fileCount"] == 13, exported
                archive_bytes = fetch_bytes(f"{base_url}{exported['downloadUrl']}")
                archive_path = ARTIFACTS / exported["fileName"]
                archive_path.write_bytes(archive_bytes)

                with zipfile.ZipFile(archive_path) as archive:
                    names = set(archive.namelist())
                    generated_path = "relay-sessions-webmcp/src/webmcp.generated.js"
                    assert generated_path in names
                    generated_source = archive.read(generated_path).decode("utf-8")
                    generated_html = archive.read("relay-sessions-webmcp/index.html").decode("utf-8")
                    generated_css = archive.read("relay-sessions-webmcp/target.css").decode("utf-8")
                    generated_target_js = archive.read("relay-sessions-webmcp/target.js").decode("utf-8")
                    assert "document.modelContext.registerTool({" in generated_source
                    assert "find_sessions" in generated_source
                    assert "add_session_to_itinerary" in generated_source
                    assert '<script type="module" src="./src/webmcp.generated.js"></script>' in generated_html
                    assert "relay-sessions-webmcp/integration-report.html" in names
                    assert "relay-sessions-webmcp/tests/manual-evals.md" in names
                    with tempfile.TemporaryDirectory() as temp_dir:
                        source_path = Path(temp_dir) / "webmcp.generated.js"
                        source_path.write_text(generated_source)
                        checked = subprocess.run(
                            ["node", "--check", str(source_path)],
                            capture_output=True,
                            text=True,
                            check=False,
                        )
                        assert checked.returncode == 0, checked.stderr
                result["checks"].append("downloadable runnable repository, expected files, and generated JavaScript syntax")

                progress("executing exported WebMCP repository")
                generated_page = context.new_page()
                generated_page.set_default_timeout(12_000)
                generated_page.on(
                    "console",
                    lambda message: console_errors.append(f"export: {message.text}") if message.type == "error" else None,
                )
                generated_page.on("pageerror", lambda error: console_errors.append(f"export: {error}"))
                generated_shell = re.sub(r'<link[^>]+href="\./target\.css"[^>]*>', "", generated_html)
                generated_shell = re.sub(r'<script[^>]+src="\./target\.js"[^>]*></script>', "", generated_shell)
                generated_shell = re.sub(
                    r'<script[^>]+src="\./src/webmcp\.generated\.js"[^>]*></script>', "", generated_shell
                )
                generated_page.set_content(generated_shell, wait_until="domcontentloaded")
                generated_page.add_style_tag(content=generated_css)
                generated_page.evaluate(
                    """
                    () => {
                      const registered = Object.create(null);
                      Object.defineProperty(document, 'modelContext', {
                        configurable: true,
                        value: {
                          async registerTool(tool, options = {}) {
                            if (!tool || !tool.name || typeof tool.execute !== 'function') throw new Error('Invalid generated WebMCP tool');
                            registered[tool.name] = tool;
                            options.signal?.addEventListener('abort', () => {
                              if (registered[tool.name] === tool) delete registered[tool.name];
                            }, { once: true });
                          },
                          async getTools() {
                            return Object.values(registered)
                              .map(({ execute, ...tool }) => tool)
                              .sort((left, right) => left.name.localeCompare(right.name));
                          },
                          async executeTool(tool, inputJson = '{}', options = {}) {
                            const registeredTool = registered[tool?.name];
                            if (!registeredTool) throw new Error(`Unknown tool ${tool?.name}`);
                            return registeredTool.execute(JSON.parse(inputJson), { signal: options.signal });
                          }
                        }
                      });
                      window.__callNative = async (name, input = {}) => {
                        const tool = (await document.modelContext.getTools()).find((candidate) => candidate.name === name);
                        if (!tool) throw new Error(`Unknown native tool ${name}`);
                        return document.modelContext.executeTool(tool, JSON.stringify(input));
                      };
                    }
                    """
                )
                generated_target_js = generated_target_js.replace(
                    "window.parent.postMessage({ type: 'relay-state', state: getState() }, location.origin);",
                    "window.parent.postMessage({ type: 'relay-state', state: getState() }, '*');",
                )
                generated_page.add_script_tag(content=generated_target_js)
                generated_page.add_script_tag(content=generated_source, type="module")
                generated_page.wait_for_function("document.modelContext.getTools().then(tools => tools.length === 4)")
                generated_tool_names = generated_page.evaluate(
                    "async () => (await document.modelContext.getTools()).map(tool => tool.name)"
                )
                assert generated_tool_names == [
                    "add_session_to_itinerary",
                    "clear_itinerary",
                    "find_sessions",
                    "inspect_itinerary",
                ]
                generated_search = generated_page.evaluate(
                    "async () => window.__callNative('find_sessions', { query: 'agent', level: 'all', day: 'all' })"
                )
                assert "Agent evals that catch regressions" in generated_search["visibleState"]
                generated_add = generated_page.evaluate(
                    "async () => window.__callNative('add_session_to_itinerary', { item_id: 'agent-evals-that-catch-regressions' })"
                )
                assert "Agent evals that catch regressions" in generated_add["visibleState"]
                generated_inspect = generated_page.evaluate(
                    "async () => window.__callNative('inspect_itinerary', {})"
                )
                assert "1 SESSION" in generated_inspect["visibleState"]
                result["checks"].append("exported repository registers and executes its four native WebMCP tools")
                generated_page.close()

                progress("executing standalone browser-derived export")
                browser_export_payload = {
                    "projectName": "catalog-browser-adapter",
                    "target": {"url": "https://catalog.example/", "title": "Catalog"},
                    "goal": "Search products and add a selected product to the cart.",
                    "mode": "browser_mcp",
                    "tools": [
                        {
                            "id": "mcp_form_search_catalog",
                            "kind": "form",
                            "name": "search_catalog",
                            "title": "Search catalog",
                            "description": "Search the owned product catalog and return the resulting visible state.",
                            "risk": "read",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"query": {"type": "string", "description": "Catalog query."}},
                                "required": ["query"],
                                "additionalProperties": False,
                            },
                            "sampleArgs": {"query": "WebMCP"},
                            "evidence": [
                                {"type": "textbox", "ref": "e1", "label": "Catalog query"},
                                {"type": "button", "ref": "e2", "label": "Search catalog"},
                            ],
                            "executor": {
                                "type": "mcp-recipe",
                                "steps": [
                                    {
                                        "tool": "browser_type",
                                        "arguments": {
                                            "element": "Catalog query",
                                            "ref": "e1",
                                            "text": "{{query}}",
                                        },
                                    },
                                    {
                                        "tool": "browser_click",
                                        "arguments": {"element": "Search catalog", "ref": "e2"},
                                    },
                                    {"tool": "browser_snapshot", "arguments": {}},
                                ],
                            },
                        },
                        {
                            "id": "mcp_group_add_to_cart",
                            "kind": "action-group",
                            "name": "add_to_cart",
                            "title": "Add to cart",
                            "description": "Add one visible product to the owned cart and return the changed state.",
                            "risk": "write",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "item": {
                                        "type": "string",
                                        "description": "Visible product to add.",
                                        "enum": ["Alpha", "Beta"],
                                    }
                                },
                                "required": ["item"],
                                "additionalProperties": False,
                            },
                            "sampleArgs": {"item": "Alpha"},
                            "evidence": [
                                {"type": "button", "ref": "e3", "label": "Add to cart", "item": "Alpha"},
                                {"type": "button", "ref": "e4", "label": "Add to cart", "item": "Beta"},
                            ],
                            "executor": {
                                "type": "mcp-recipe",
                                "steps": [
                                    {
                                        "tool": "browser_click",
                                        "arguments": {
                                            "element": "Add to cart for {{item}}",
                                            "ref": {"$pick": "item", "cases": {"Alpha": "e3", "Beta": "e4"}},
                                        },
                                    },
                                    {"tool": "browser_snapshot", "arguments": {}},
                                ],
                            },
                        },
                    ],
                    "ownerBundle": {
                        "html": """<!doctype html><html><body>
                          <form id="catalog-search"><label for="catalog-query">Catalog query</label><input id="catalog-query"><button>Search catalog</button></form>
                          <output id="search-result" aria-live="polite"></output>
                          <section id="products">
                            <article data-item="Alpha"><h2>Alpha</h2><button type="button">Add to cart</button></article>
                            <article data-item="Beta"><h2>Beta</h2><button type="button">Add to cart</button></article>
                          </section>
                          <output id="cart-state" aria-live="polite">Cart is empty</output>
                          <script src="./target.js"></script>
                        </body></html>""",
                        "files": {
                            "target.js": """document.querySelector('#catalog-search').addEventListener('submit', (event) => {
                              event.preventDefault();
                              document.querySelector('#search-result').textContent = `Results for ${document.querySelector('#catalog-query').value}`;
                            });
                            document.querySelectorAll('#products button').forEach((button) => button.addEventListener('click', () => {
                              document.querySelector('#cart-state').textContent = `Cart: ${button.closest('article').dataset.item}`;
                            }));""",
                        },
                    },
                }
                browser_export = page.evaluate(
                    """async payload => {
                      const response = await fetch('/api/export', {
                        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
                      });
                      const result = await response.json();
                      if (!response.ok) throw new Error(result.error || `Export failed: ${response.status}`);
                      return result;
                    }""",
                    browser_export_payload,
                )
                browser_archive = fetch_bytes(f"{base_url}{browser_export['downloadUrl']}")
                with zipfile.ZipFile(io.BytesIO(browser_archive)) as archive:
                    browser_source = archive.read(
                        "catalog-browser-adapter/src/webmcp.generated.js"
                    ).decode("utf-8")
                    browser_html = archive.read("catalog-browser-adapter/index.html").decode("utf-8")
                    browser_target_js = archive.read("catalog-browser-adapter/target.js").decode("utf-8")

                browser_adapter_page = context.new_page()
                browser_adapter_page.set_default_timeout(12_000)
                browser_adapter_page.on(
                    "console",
                    lambda message: console_errors.append(f"browser export: {message.text}")
                    if message.type == "error"
                    else None,
                )
                browser_adapter_page.on(
                    "pageerror", lambda error: console_errors.append(f"browser export: {error}")
                )
                browser_shell = re.sub(
                    r'<script[^>]+src="\./target\.js"[^>]*></script>', "", browser_html
                )
                browser_shell = re.sub(
                    r'<script[^>]+src="\./src/webmcp\.generated\.js"[^>]*></script>', "", browser_shell
                )
                browser_adapter_page.set_content(browser_shell, wait_until="domcontentloaded")
                browser_adapter_page.evaluate(
                    """() => {
                      const registered = Object.create(null);
                      Object.defineProperty(document, 'modelContext', {
                        configurable: true,
                        value: {
                          async registerTool(tool) { registered[tool.name] = tool; },
                          async getTools() { return Object.values(registered).map(({ execute, ...tool }) => tool); },
                          async executeTool(tool, inputJson = '{}') {
                            return registered[tool.name].execute(JSON.parse(inputJson));
                          }
                        }
                      });
                      window.__callNative = async (name, input = {}) => {
                        const tool = (await document.modelContext.getTools()).find(candidate => candidate.name === name);
                        return document.modelContext.executeTool(tool, JSON.stringify(input));
                      };
                    }"""
                )
                browser_adapter_page.add_script_tag(content=browser_target_js)
                browser_adapter_page.add_script_tag(content=browser_source, type="module")
                browser_adapter_page.wait_for_function(
                    "document.modelContext.getTools().then(tools => tools.length === 2)"
                )
                assert browser_adapter_page.evaluate("window.MetaWebMCPBrowserBridge === undefined") is True
                native_search = browser_adapter_page.evaluate(
                    "async () => window.__callNative('search_catalog', { query: 'WebMCP' })"
                )
                assert native_search["ok"] is True
                assert browser_adapter_page.locator("#search-result").inner_text() == "Results for WebMCP"
                native_add = browser_adapter_page.evaluate(
                    "async () => window.__callNative('add_to_cart', { item: 'Beta' })"
                )
                assert native_add["ok"] is True
                assert browser_adapter_page.locator("#cart-state").inner_text() == "Cart: Beta"
                browser_adapter_page.locator('article[data-item="Beta"] button').evaluate("element => element.remove()")
                browser_adapter_page.locator("#cart-state").evaluate(
                    "element => { element.textContent = 'Cart is empty'; }"
                )
                missing_item = browser_adapter_page.evaluate(
                    """async () => {
                      try {
                        await window.__callNative('add_to_cart', { item: 'Beta' });
                        return { rejected: false, message: '' };
                      } catch (error) {
                        return { rejected: true, message: String(error.message || error) };
                      }
                    }"""
                )
                assert missing_item["rejected"] is True, missing_item
                assert "Beta" in missing_item["message"]
                assert browser_adapter_page.locator("#cart-state").inner_text() == "Cart is empty"
                result["checks"].append(
                    "browser-derived export executes natively without the bridge and fails closed when an item disappears"
                )
                browser_adapter_page.close()

                final_state = page.evaluate("window.MetaWebMCP.getState()")
                assert final_state["phase"] == 5
                assert final_state["export"]["fileName"] == "relay-sessions-webmcp.zip"
                assert page.locator("#download-link").is_visible()
                assert page.locator("#generated-tool-count").inner_text() == "4"

                screenshot_path = ARTIFACTS / "metawebmcp-e2e.png"
                page.wait_for_timeout(750)
                page.screenshot(path=str(screenshot_path), full_page=True, animations="disabled")
                result["screenshot"] = str(screenshot_path.relative_to(ROOT))
                layouts = []
                for width in [1440, 1221, 1220, 1024, 901, 900, 768, 390]:
                    page.set_viewport_size({"width": width, "height": 844})
                    page.wait_for_timeout(25)
                    layout = page.evaluate(
                        """() => ({
                          viewport: window.innerWidth,
                          documentWidth: document.documentElement.scrollWidth,
                          targetWidth: document.querySelector('.target-column').getBoundingClientRect().width,
                          buildWidth: document.querySelector('.build-column').getBoundingClientRect().width,
                          toolsWidth: document.querySelector('.tools-column').getBoundingClientRect().width,
                        })"""
                    )
                    assert layout["documentWidth"] <= layout["viewport"], layout
                    assert all(
                        layout[key] <= layout["viewport"]
                        for key in ["targetWidth", "buildWidth", "toolsWidth"]
                    ), layout
                    layouts.append(layout)
                page.locator("#trace").evaluate("element => { element.scrollTop = element.scrollHeight; }")
                mobile_screenshot_path = ARTIFACTS / "metawebmcp-mobile.png"
                page.wait_for_timeout(100)
                page.screenshot(path=str(mobile_screenshot_path), full_page=True, animations="disabled")
                result["responsiveScreenshot"] = str(mobile_screenshot_path.relative_to(ROOT))
                result["responsiveLayouts"] = layouts
                result["checks"].append("workspace has no horizontal overflow from 390px through 1440px")
                result["exportArchive"] = str(archive_path.relative_to(ROOT))
                result["nativeToolCount"] = page.evaluate("async () => (await document.modelContext.getTools()).length")
                result["evaluation"] = evaluation
                result["consoleErrors"] = console_errors
                assert not console_errors, console_errors
            finally:
                browser.close()

        (ARTIFACTS / "e2e-result.json").write_text(json.dumps(result, indent=2) + "\n")
        progress("complete")
        print(json.dumps({"ok": True, **result}, indent=2))
        return 0
    except Exception as error:  # noqa: BLE001 - test runner needs complete diagnostics
        result["ok"] = False
        result["error"] = repr(error)
        result["consoleErrors"] = console_errors
        (ARTIFACTS / "e2e-result.json").write_text(json.dumps(result, indent=2) + "\n")
        raise
    finally:
        server.terminate()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=2)
        stdout, stderr = server.communicate()
        if stdout:
            (ARTIFACTS / "server.stdout.log").write_text(stdout)
        if stderr:
            (ARTIFACTS / "server.stderr.log").write_text(stderr)


if __name__ == "__main__":
    sys.exit(main())
