import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const sourceCommit = String(process.env.META_WEBMCP_SOURCE_COMMIT || '').trim().toLowerCase();

if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
  throw new Error('Set META_WEBMCP_SOURCE_COMMIT to the exact full commit being deployed.');
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().toLowerCase();
if (head !== sourceCommit) {
  throw new Error('META_WEBMCP_SOURCE_COMMIT does not match the checked-out commit.');
}

const worktree = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  { cwd: root, encoding: 'utf8' },
).trim();
if (worktree) throw new Error('Refusing to deploy from a dirty worktree.');

const wrangler = path.join(directory, 'node_modules/wrangler/bin/wrangler.js');
const result = spawnSync(process.execPath, [
  wrangler,
  'deploy',
  ...process.argv.slice(2),
  '--strict',
  '--keep-vars',
  '--var',
  `META_WEBMCP_SOURCE_COMMIT:${sourceCommit}`,
  '--tag',
  `source-${sourceCommit.slice(0, 12)}`,
  '--message',
  `Source commit ${sourceCommit}`,
], {
  cwd: directory,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) throw new Error(`Wrangler terminated with signal ${result.signal}.`);
process.exitCode = result.status ?? 1;
