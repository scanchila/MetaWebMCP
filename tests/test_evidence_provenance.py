from copy import deepcopy
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from evidence_append_provenance import (  # noqa: E402
    apply_browser_capture_provenance,
    apply_static_capture_provenance,
)
from evidence_provenance import browser_identity, configured_source_commit, verified_deployment_identity  # noqa: E402


SOURCE_COMMIT = 'a' * 40
STATIC_PROVENANCE = {
    'captureScript': 'capture-public-evidence.py',
    'captureScriptSha256': 'a' * 64,
    'captureDependencies': {
        'evidence_provenance.py': 'b' * 64,
        'evidence_append_provenance.py': 'c' * 64,
    },
}
BROWSER_PROVENANCE = {
    'browser': 'Google Chrome 154.0.8037.0',
    'browserLaunch': {
        'executable': 'google-chrome-beta',
        'headless': True,
        'args': ['--no-sandbox', '--enable-features=WebMCPTesting'],
        'viewport': {'width': 1840, 'height': 1120},
        'deviceScaleFactor': 1,
    },
}


class Response:
    def __init__(self, payload, status=200):
        self.status = status
        self.payload = payload

    def getcode(self):
        return self.status

    def read(self, _limit):
        return json.dumps(self.payload).encode()


def opener(payload, calls):
    def open_request(request, timeout):
        calls.append({'url': request.full_url, 'timeout': timeout})
        return Response(payload)
    return open_request


class EvidenceProvenanceTest(unittest.TestCase):
    def test_browser_identity_preserves_the_executable_product_name(self):
        identities = (
            'Google Chrome Beta 152.0.7977.75',
            'Google Chrome for Testing 152.0.7977.75',
            'Chromium 152.0.7977.75',
        )
        for expected in identities:
            with self.subTest(identity=expected):
                calls = []

                def runner(command, **options):
                    calls.append((command, options))
                    return type('Completed', (), {
                        'returncode': 0,
                        'stdout': f'{expected}\n',
                        'stderr': '',
                    })()

                self.assertEqual(browser_identity('/browser', '152.0.7977.75', runner=runner), expected)
                self.assertEqual(calls, [(
                    ['/browser', '--version'],
                    {'capture_output': True, 'text': True, 'timeout': 10, 'check': False},
                )])

    def test_browser_identity_rejects_a_mismatched_runtime_version(self):
        def runner(_command, **_options):
            return type('Completed', (), {
                'returncode': 0,
                'stdout': 'Chromium 151.0.0.0\n',
                'stderr': '',
            })()

        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            browser_identity('/browser', '152.0.7977.75', runner=runner)

    def test_capture_scripts_use_the_current_headless_webmcp_feature_flag(self):
        for script_name in ('capture-native-evidence.py', 'capture-public-evidence.py'):
            source = (ROOT / 'scripts' / script_name).read_text()
            with self.subTest(script=script_name):
                self.assertIn("'--enable-features=WebMCPTesting'", source)
                self.assertNotIn('--enable-blink-features=WebMCPTesting', source)
                self.assertIn('Headless evidence capture requires Chrome 152+', source)

    def test_requires_an_explicit_full_source_commit(self):
        self.assertEqual(configured_source_commit({'META_WEBMCP_SOURCE_COMMIT': SOURCE_COMMIT.upper()}), SOURCE_COMMIT)
        with self.assertRaisesRegex(RuntimeError, 'exact full deployed commit'):
            configured_source_commit({})

    def test_accepts_matching_live_cloudflare_identity(self):
        calls = []
        payload = {
            'ok': True,
            'runtime': 'cloudflare',
            'deploymentVersion': 'worker-version-123',
            'sourceCommit': SOURCE_COMMIT,
            'deployedAt': '2026-09-03T05:00:00.000Z',
            'deploymentTag': 'source-aaaaaaaaaaaa',
        }
        result = verified_deployment_identity(
            'https://meta.example/path',
            SOURCE_COMMIT,
            'worker-version-123',
            opener=opener(payload, calls),
        )
        self.assertEqual(result['deploymentVersion'], 'worker-version-123')
        self.assertEqual(result['sourceCommit'], SOURCE_COMMIT)
        self.assertEqual(calls, [{'url': 'https://meta.example/health', 'timeout': 15}])

    def test_rejects_environment_values_that_do_not_match_the_live_deployment(self):
        payload = {
            'ok': True,
            'runtime': 'cloudflare',
            'deploymentVersion': 'actual-version',
            'sourceCommit': 'b' * 40,
            'deployedAt': '2026-09-03T05:00:00.000Z',
        }
        with self.assertRaisesRegex(RuntimeError, 'source commit does not match'):
            verified_deployment_identity(
                'https://meta.example',
                SOURCE_COMMIT,
                opener=opener(payload, []),
            )

    def test_rejects_incomplete_health_identity(self):
        with self.assertRaisesRegex(RuntimeError, 'missing immutable deployment identity'):
            verified_deployment_identity(
                'https://meta.example',
                SOURCE_COMMIT,
                opener=opener({'ok': True, 'runtime': 'cloudflare'}, []),
            )

    def test_seed_then_append_rejects_changed_static_capture_provenance(self):
        seeded_report = {}
        apply_static_capture_provenance(seeded_report, STATIC_PROVENANCE, append=False)

        matching_append = deepcopy(seeded_report)
        apply_static_capture_provenance(matching_append, STATIC_PROVENANCE, append=True)
        self.assertEqual(matching_append, seeded_report)

        mismatches = {
            'captureScriptSha256': {**STATIC_PROVENANCE, 'captureScriptSha256': 'd' * 64},
            'captureDependencies': {
                **STATIC_PROVENANCE,
                'captureDependencies': {
                    **STATIC_PROVENANCE['captureDependencies'],
                    'evidence_append_provenance.py': 'e' * 64,
                },
            },
        }
        for field, current_provenance in mismatches.items():
            with self.subTest(field=field):
                append_report = deepcopy(seeded_report)
                with self.assertRaisesRegex(RuntimeError, field):
                    apply_static_capture_provenance(append_report, current_provenance, append=True)
                self.assertEqual(append_report, seeded_report)

    def test_seed_then_append_rejects_changed_browser_provenance(self):
        seeded_report = {}
        apply_browser_capture_provenance(seeded_report, BROWSER_PROVENANCE, append=False)

        matching_append = deepcopy(seeded_report)
        apply_browser_capture_provenance(matching_append, BROWSER_PROVENANCE, append=True)
        self.assertEqual(matching_append, seeded_report)

        changed_launch = deepcopy(BROWSER_PROVENANCE)
        changed_launch['browserLaunch']['args'].append('--disable-dev-shm-usage')
        mismatches = {
            'browser': {**BROWSER_PROVENANCE, 'browser': 'Google Chrome 155.0.8100.0'},
            'browserLaunch': changed_launch,
        }
        for field, current_provenance in mismatches.items():
            with self.subTest(field=field):
                append_report = deepcopy(seeded_report)
                with self.assertRaisesRegex(RuntimeError, field):
                    apply_browser_capture_provenance(append_report, current_provenance, append=True)
                self.assertEqual(append_report, seeded_report)


if __name__ == '__main__':
    unittest.main()
