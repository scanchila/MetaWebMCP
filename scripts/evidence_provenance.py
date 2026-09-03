from __future__ import annotations

import json
import os
import re
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


SOURCE_COMMIT_PATTERN = re.compile(r'^[0-9a-f]{40,64}$')
MAX_HEALTH_BYTES = 64 * 1024


def browser_identity(executable, runtime_version, *, runner=subprocess.run):
    version = str(runtime_version).strip()
    try:
        completed = runner(
            [str(executable), '--version'],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError('Could not read the launched browser executable identity.') from error

    output_lines = [
        line.strip()
        for stream in (completed.stdout or '', completed.stderr or '')
        for line in stream.splitlines()
        if line.strip()
    ]
    identity = next((line for line in output_lines if version and version in line), '')
    if completed.returncode != 0 or not identity:
        raise RuntimeError('Browser executable identity does not match the launched browser version.')
    return ' '.join(identity.split())


def configured_source_commit(environ=None):
    environment = os.environ if environ is None else environ
    source_commit = str(environment.get('META_WEBMCP_SOURCE_COMMIT', '')).strip().lower()
    if not SOURCE_COMMIT_PATTERN.fullmatch(source_commit):
        raise RuntimeError('Set META_WEBMCP_SOURCE_COMMIT to the exact full deployed commit.')
    return source_commit


def verified_deployment_identity(
    app_url,
    expected_source_commit,
    expected_deployment_version='',
    *,
    opener=urlopen,
    timeout=15,
):
    source_commit = str(expected_source_commit).strip().lower()
    if not SOURCE_COMMIT_PATTERN.fullmatch(source_commit):
        raise RuntimeError('Expected source commit must be a full hexadecimal commit identifier.')

    parsed_app = urlsplit(str(app_url))
    if parsed_app.scheme not in ('http', 'https') or not parsed_app.netloc or parsed_app.username or parsed_app.password:
        raise RuntimeError('META_WEBMCP_APP_URL must be an absolute HTTP or HTTPS origin.')
    health_url = urljoin(f'{parsed_app.scheme}://{parsed_app.netloc}/', 'health')
    request = Request(health_url, headers={
        'accept': 'application/json',
        'user-agent': 'MetaWebMCP-Evidence/1.0',
    })
    try:
        response = opener(request, timeout=timeout)
        try:
            status = int(getattr(response, 'status', None) or response.getcode())
            body = response.read(MAX_HEALTH_BYTES + 1)
        finally:
            if hasattr(response, 'close'):
                response.close()
    except HTTPError as error:
        error.close()
        raise RuntimeError(f'Deployment health returned HTTP {error.code}.') from error
    except URLError as error:
        raise RuntimeError('Deployment health could not be reached.') from error

    if status != 200:
        raise RuntimeError(f'Deployment health returned HTTP {status}.')
    if len(body) > MAX_HEALTH_BYTES:
        raise RuntimeError('Deployment health response is unexpectedly large.')
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError('Deployment health did not return valid JSON.') from error

    deployment_version = str(payload.get('deploymentVersion', '')).strip()
    actual_source_commit = str(payload.get('sourceCommit', '')).strip().lower()
    deployed_at = str(payload.get('deployedAt', '') or '').strip()
    deployment_tag = str(payload.get('deploymentTag', '') or '').strip() or None
    if payload.get('ok') is not True or payload.get('runtime') != 'cloudflare':
        raise RuntimeError('Deployment health did not identify a healthy Cloudflare runtime.')
    if not deployment_version or not SOURCE_COMMIT_PATTERN.fullmatch(actual_source_commit) or not deployed_at:
        raise RuntimeError('Deployment health is missing immutable deployment identity fields.')
    if actual_source_commit != source_commit:
        raise RuntimeError('Live deployment source commit does not match META_WEBMCP_SOURCE_COMMIT.')
    expected_version = str(expected_deployment_version or '').strip()
    if expected_version and deployment_version != expected_version:
        raise RuntimeError('Live Worker version does not match META_WEBMCP_DEPLOYMENT_VERSION.')

    return {
        'healthStatus': status,
        'deploymentVersion': deployment_version,
        'sourceCommit': actual_source_commit,
        'deployedAt': deployed_at,
        'deploymentTag': deployment_tag,
    }
