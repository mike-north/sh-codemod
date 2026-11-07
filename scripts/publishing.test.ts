/** Owner workflow policy is checked structurally; no test commissions trust or contacts a service. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkWorkflow, checkRuntime } from './publishing.ts';

await test('the actual installed native npm satisfies the OIDC client floor', () => {
  checkRuntime();
});

await test('a widened OR guard, elevated permissions, credentials or automatic trigger is refused', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/workflow-'));
  const original = await readFile('.github/workflows/release.yml', 'utf8');
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    const path = join(root, '.github/workflows/release.yml');
    await writeFile(path, original);
    await checkWorkflow(root);
    for (const altered of [
      original.replace(' && ', ' || '),
      original.replace('workflow_dispatch:', 'push:'),
      original.replace('contents: read', 'contents: write'),
      original.replace(
        'id-token: write',
        'id-token: write\n      actions: write',
      ),
      original.replace(
        'persist-credentials: false',
        'persist-credentials: true',
      ),
      original.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'),
      `${original}\nenv:\n  NODE_AUTH_TOKEN: credential\n`,
      original + '\nenv:\n  CREDENTIAL: ${{ secrets.PUBLISH }}\n',
    ]) {
      assert.notEqual(altered, original);
      await writeFile(path, altered);
      await assert.rejects(checkWorkflow(root));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('ordinary local planning and publication reject authority before a client command', () => {
  for (const [script, args] of [
    ['publishing.ts', ['plan']],
    ['publish.ts', ['missing-plan.json']],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts', script), ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: 'false', PATH: '' },
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /owner-dispatched main workflow/);
  }
});
