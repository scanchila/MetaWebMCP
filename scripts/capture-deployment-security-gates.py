from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

from evidence_provenance import configured_source_commit, verified_deployment_identity


ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('META_WEBMCP_EVIDENCE_OUT', ROOT / 'evidence'))
APP_URL = os.environ.get('META_WEBMCP_APP_URL', 'https://metawebmcp.neuryta.com')
EXPECTED_DEPLOYMENT_VERSION = os.environ.get('META_WEBMCP_DEPLOYMENT_VERSION', '').strip()
MAX_RESPONSE_BYTES = 4_000_000
SCRIPT_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
HELPER_PATH = Path(__file__).with_name('evidence_provenance.py')
HELPER_SHA256 = hashlib.sha256(HELPER_PATH.read_bytes()).hexdigest()


def deployment_origin():
    parsed = urlsplit(APP_URL)
    return f'{parsed.scheme}://{parsed.netloc}'


def http_request(path, *, method='GET', headers=None, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request_headers = {
        'accept': 'application/json',
        'user-agent': 'MetaWebMCP-Evidence/1.0',
        **(headers or {}),
    }
    if body is not None:
        request_headers['content-type'] = 'application/json'
    request = Request(
        urljoin(f'{deployment_origin()}/', str(path).lstrip('/')),
        data=body,
        headers=request_headers,
        method=method,
    )
    try:
        response = urlopen(request, timeout=30)
    except HTTPError as error:
        response = error
    except URLError as error:
        raise RuntimeError(f'Request failed before receiving an HTTP response: {path}') from error
    try:
        response_body = response.read(MAX_RESPONSE_BYTES + 1)
    finally:
        response.close()
    if len(response_body) > MAX_RESPONSE_BYTES:
        raise RuntimeError(f'Response exceeded the evidence limit: {path}')
    return {
        'status': int(response.status),
        'headers': response.headers,
        'body': response_body,
    }


def response_json(response):
    try:
        return json.loads(response['body'])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError(f"HTTP {response['status']} response did not contain JSON.") from error


def require_status(label, response, expected):
    if response['status'] != expected:
        raise AssertionError(f"{label} returned HTTP {response['status']}; expected {expected}.")


def capability_cookie(response):
    header = response['headers'].get('set-cookie', '')
    cookie = header.split(';', 1)[0]
    if '=' not in cookie:
        raise AssertionError('Capability response did not issue a cookie.')
    return cookie, header


def tampered_cookie(cookie):
    name, value = cookie.split('=', 1)
    if not value:
        raise AssertionError('Capability cookie value is empty.')
    replacement = 'A' if value[-1] != 'A' else 'B'
    return f'{name}={value[:-1]}{replacement}'


EXPORT_PAYLOAD = {
    'projectName': 'security-gate-export',
    'tools': [{
        'name': 'inspect_page',
        'description': 'Inspect the current visible page state.',
        'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
        'risk': 'read',
        'executor': {'type': 'dom-read', 'selector': 'body'},
    }],
}


def main():
    expected_source_commit = configured_source_commit()
    identity = verified_deployment_identity(
        APP_URL,
        expected_source_commit,
        EXPECTED_DEPLOYMENT_VERSION,
    )
    origin = deployment_origin()
    snapshot_payload = {
        'snapshot': '- button "Inspect" [ref=e1]',
        'url': 'https://example.com/',
        'goal': 'Inspect the visible page controls.',
    }

    unauthenticated_api = http_request('/api/mcp/analyze-snapshot', method='POST', payload=snapshot_payload)
    require_status('Unauthenticated Browser API', unauthenticated_api, 401)

    cross_origin = http_request('/api/browser-session', method='POST', headers={'origin': 'https://attacker.example'})
    require_status('Cross-origin capability issuance', cross_origin, 403)

    owner_issue = http_request('/api/browser-session', method='POST', headers={'origin': origin})
    require_status('Same-origin capability issuance', owner_issue, 201)
    owner_cookie, set_cookie = capability_cookie(owner_issue)

    other_issue = http_request('/api/browser-session', method='POST', headers={'origin': origin})
    require_status('Second capability issuance', other_issue, 201)
    other_cookie, _ = capability_cookie(other_issue)
    if owner_cookie == other_cookie:
        raise AssertionError('Independent page capabilities must not share a token.')

    authorized_api = http_request(
        '/api/mcp/analyze-snapshot',
        method='POST',
        headers={'origin': origin, 'cookie': owner_cookie},
        payload=snapshot_payload,
    )
    require_status('Authorized Browser API', authorized_api, 200)
    if response_json(authorized_api).get('ok') is not True:
        raise AssertionError('Authorized Browser API did not report success.')

    tampered_api = http_request(
        '/api/mcp/analyze-snapshot',
        method='POST',
        headers={'origin': origin, 'cookie': tampered_cookie(owner_cookie)},
        payload=snapshot_payload,
    )
    require_status('Tampered capability', tampered_api, 401)

    unauthenticated_sse = http_request('/sse', headers={'accept': 'text/event-stream'})
    require_status('Unauthenticated raw SSE', unauthenticated_sse, 401)

    private_target = http_request('/api/analyze', method='POST', payload={
        'source': 'url',
        'url': 'http://127.0.0.1/',
        'goal': 'Inspect.',
    })
    require_status('Private static target', private_target, 400)

    unauthenticated_export = http_request('/api/export', method='POST', payload=EXPORT_PAYLOAD)
    require_status('Unauthenticated export', unauthenticated_export, 401)

    created_export = http_request(
        '/api/export',
        method='POST',
        headers={'origin': origin, 'cookie': owner_cookie},
        payload=EXPORT_PAYLOAD,
    )
    require_status('Authorized export', created_export, 201)
    download_url = response_json(created_export).get('downloadUrl')
    if not isinstance(download_url, str) or not download_url.startswith('/api/download/'):
        raise AssertionError('Authorized export did not return a bounded download URL.')

    unauthenticated_download = http_request(download_url)
    require_status('Unauthenticated download', unauthenticated_download, 401)
    other_download = http_request(download_url, headers={'cookie': other_cookie})
    require_status('Other-capability download', other_download, 404)
    owner_download = http_request(download_url, headers={'cookie': owner_cookie})
    require_status('Owner download', owner_download, 200)
    if not owner_download['body'].startswith(b'PK'):
        raise AssertionError('Owner download did not return a ZIP archive.')
    repeated_download = http_request(download_url, headers={'cookie': owner_cookie})
    require_status('Repeated download', repeated_download, 404)

    cookie_attributes = {
        attribute.strip().lower()
        for attribute in set_cookie.split(';')[1:]
    }
    result = {
        'capturedAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'deployment': origin,
        'deploymentVersion': identity['deploymentVersion'],
        'sourceCommit': identity['sourceCommit'],
        'deployedAt': identity['deployedAt'],
        'deploymentTag': identity['deploymentTag'],
        'captureScript': Path(__file__).name,
        'captureScriptSha256': SCRIPT_SHA256,
        'captureDependencies': {HELPER_PATH.name: HELPER_SHA256},
        'identityVerifiedFromHealth': True,
        'checks': {
            'healthStatus': identity['healthStatus'],
            'unauthenticatedBrowserApiStatus': unauthenticated_api['status'],
            'crossOriginCapabilityIssueStatus': cross_origin['status'],
            'sameOriginCapabilityIssueStatus': owner_issue['status'],
            'authorizedBrowserApiStatus': authorized_api['status'],
            'tamperedCapabilityStatus': tampered_api['status'],
            'unauthenticatedRawSseStatus': unauthenticated_sse['status'],
            'privateTargetStatus': private_target['status'],
            'unauthenticatedExportStatus': unauthenticated_export['status'],
            'authorizedExportStatus': created_export['status'],
            'unauthenticatedDownloadStatus': unauthenticated_download['status'],
            'otherCapabilityDownloadStatus': other_download['status'],
            'authorizedDownloadStatus': owner_download['status'],
            'repeatedDownloadStatus': repeated_download['status'],
            'downloadZipSignature': True,
            'cookieSecure': 'secure' in cookie_attributes,
            'cookieHttpOnly': 'httponly' in cookie_attributes,
            'cookieSameSiteStrict': 'samesite=strict' in cookie_attributes,
            'cookiePathRoot': 'path=/' in cookie_attributes,
        },
        'sensitiveValuesRetained': False,
    }
    if not all((
        result['checks']['cookieSecure'],
        result['checks']['cookieHttpOnly'],
        result['checks']['cookieSameSiteStrict'],
        result['checks']['cookiePathRoot'],
    )):
        raise AssertionError('Capability cookie is missing a required security attribute.')

    OUT.mkdir(exist_ok=True)
    output = OUT / 'deployment-security-gates.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({
        'deploymentVersion': identity['deploymentVersion'],
        'sourceCommit': identity['sourceCommit'],
        'checksPassed': len(result['checks']),
        'sensitiveValuesRetained': False,
        'result': str(output),
    }, indent=2))


if __name__ == '__main__':
    main()
