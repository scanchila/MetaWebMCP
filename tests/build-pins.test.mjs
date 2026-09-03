import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const NODE_IMAGE = 'node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';

test('container and CI runtime inputs are immutable', async () => {
  for (const filename of ['Dockerfile', 'Dockerfile.egress']) {
    const dockerfile = await readFile(new URL(filename, ROOT), 'utf8');
    assert.match(dockerfile, new RegExp(`^FROM ${NODE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }

  const workflow = await readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8');
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /ubuntu-latest/);
  assert.match(workflow, /node-version: 22\.23\.2/);
  assert.match(workflow, /python-version: '3\.12\.14'/);
  assert.match(workflow, /python -m pip install --require-hashes -r requirements-ci\.txt/);
  assert.doesNotMatch(workflow, /pip install playwright(?:\s|$)/);
});
