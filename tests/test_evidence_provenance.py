import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))

from evidence_provenance import configured_source_commit, verified_deployment_identity  # noqa: E402


SOURCE_COMMIT = 'a' * 40


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


if __name__ == '__main__':
    unittest.main()
