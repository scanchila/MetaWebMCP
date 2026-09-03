import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const required = [
  'server.mjs',
  'egress-proxy.mjs',
  'scripts/capture-deployment-security-gates.py',
  'scripts/evidence_provenance.py',
  'public/index.html',
  'public/js/app.js',
  'public/js/webmcp-runtime.js',
  'public/js/workspace-store.js',
  'public/js/network-policy.js',
  'public/demo/index.html',
  'README.md',
  'LICENSE',
];

async function walk(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    if (['.git', '.playwright-mcp', '.wrangler', 'node_modules'].includes(name)) continue;
    if (name === '.env' || name === '.DS_Store' || name.endsWith('.log')) continue;
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

function repositoryFiles() {
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.status !== 0) return null;
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .map((name) => path.join(root, name));
}

for (const relative of required) {
  await stat(path.join(root, relative)).catch(() => { throw new Error(`Required file is missing: ${relative}`); });
}

const files = repositoryFiles() || await walk(root);
for (const file of files.filter((name) => /\.(?:mjs|js)$/.test(name))) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(`Syntax check failed for ${path.relative(root, file)}:\n${checked.stderr}`);
}

for (const file of files.filter((name) => name.endsWith('.py'))) {
  const checked = spawnSync('python3', [
    '-c',
    'import pathlib, sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")',
    file,
  ], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(`Syntax check failed for ${path.relative(root, file)}:\n${checked.stderr}`);
}

const app = await readFile(path.join(root, 'public/js/app.js'), 'utf8');
const generator = await readFile(path.join(root, 'lib/generator.mjs'), 'utf8');
if (!app.includes("name: 'meta_analyze_site'")) throw new Error('Meta WebMCP control-plane tools are missing.');
if (!app.includes("name: 'meta_activate_webmcp'")) throw new Error('Recursive activation tool is missing.');
if (!generator.includes('document.modelContext.registerTool({')) throw new Error('Generated repositories must directly register WebMCP tools.');

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length) throw new Error('Core app must remain dependency-free.');
console.log(`Static checks passed for ${files.length} repository files.`);
