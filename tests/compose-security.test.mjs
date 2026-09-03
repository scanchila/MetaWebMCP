import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);

test('Compose runs the browser sandboxed with least-privilege container settings', async () => {
  const compose = await readFile(new URL('docker-compose.yml', ROOT), 'utf8');
  const browserService = compose.match(/\n  playwright-mcp:\n([\s\S]*?)\n  egress-proxy:/)?.[1];
  assert.ok(browserService, 'playwright-mcp service must be present');

  assert.doesNotMatch(browserService, /--no-sandbox/);
  assert.match(browserService, /\n      - --sandbox\n/);
  assert.match(browserService, /\n    user: node\n/);
  assert.match(browserService, /\n    read_only: true\n/);
  assert.match(browserService, /\n    cap_drop:\n      - ALL\n/);
  assert.match(browserService, /\n    cap_add:\n      - SYS_CHROOT\n/);
  assert.match(browserService, /\n      - no-new-privileges:true\n/);
  assert.match(browserService, /\n      - seccomp=\.\/seccomp_profile\.json\n/);
  assert.match(browserService, /\n      - \/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777\n/);
  assert.match(
    browserService,
    /\n      - \/home\/node\/\.cache:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=1000,gid=1000\n/,
  );
  assert.match(
    browserService,
    /\n      - \/home\/node\/\.config:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=1000,gid=1000\n/,
  );
  assert.match(browserService, /\n    shm_size: "512mb"\n/);

  const profile = JSON.parse(await readFile(new URL('seccomp_profile.json', ROOT), 'utf8'));
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  const userNamespaceRule = profile.syscalls.find((rule) => rule.comment === 'Allow create user namespaces');
  assert.ok(userNamespaceRule, 'Playwright user-namespace allowance must be present');
  assert.equal(userNamespaceRule.action, 'SCMP_ACT_ALLOW');
  assert.deepEqual(new Set(userNamespaceRule.names), new Set(['clone', 'setns', 'unshare']));
});
