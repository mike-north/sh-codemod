/** Release workflow policy is checked structurally; no test commissions trust or contacts a service. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { checkWorkflow, checkRuntime } from './publishing.ts';

await test('the actual installed native npm satisfies the OIDC client floor', () => {
  checkRuntime();
});

await test('the checked-in release workflow is the Changesets push-to-main flow', async () => {
  await checkWorkflow('.');
});

await test('a workflow that drops trusted-publishing identity, widens authority or adds credentials is refused', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/workflow-'));
  const original = await readFile('.github/workflows/release.yml', 'utf8');
  try {
    await mkdir(join(root, '.github/workflows'), { recursive: true });
    const path = join(root, '.github/workflows/release.yml');
    await writeFile(path, original);
    await checkWorkflow(root);
    for (const altered of [
      original.replace('push:\n    branches: [main]', 'workflow_dispatch:'),
      original.replace('branches: [main]', 'branches: [main, next]'),
      original.replace('environment: npm', 'environment: npm-publish'),
      original.replace('id-token: write', 'id-token: read'),
      original.replace('contents: write', 'contents: write\n  actions: write'),
      original.replace(
        'pull-requests: write',
        'pull-requests: write\n    packages: write',
      ),
      original.replace(
        "github.repository == 'mike-north/sh-codemod'",
        "github.repository != ''",
      ),
      original.replace(
        'persist-credentials: false',
        'persist-credentials: true',
      ),
      original.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'),
      original.replace('publish: pnpm release', 'publish: npm publish'),
      original.replace('version: pnpm version:packages\n          ', ''),
      `${original}\nenv:\n  NODE_AUTH_TOKEN: credential\n`,
      original + '\nenv:\n  CREDENTIAL: ${{ secrets.PUBLISH }}\n',
      original + '\nenv:\n  NPM_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
    ]) {
      assert.notEqual(altered, original);
      await writeFile(path, altered);
      await assert.rejects(checkWorkflow(root));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A fully authorized push to main inside the release workflow's OIDC environment. */
const authorized: Readonly<Record<string, string>> = {
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'mike-north/sh-codemod',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only',
};

/** Run the guard with a controlled environment; PATH is empty so no client could ever start. */
function guard(overrides: Readonly<Record<string, string | undefined>>) {
  const env: Record<string, string | undefined> = {
    ...authorized,
    PATH: '',
    ...overrides,
  };
  return spawnSync(
    process.execPath,
    [resolve('scripts/publishing.ts'), 'guard'],
    {
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
  );
}

await test('the guard authorizes a push to main of mike-north/sh-codemod and then needs a Node 24 npm runtime', () => {
  // With an empty PATH the runtime check is what stops this run, proving the authority check passed.
  const result = guard({});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /Publication requires a push to main/);
});

for (const [name, override] of [
  ['outside GitHub Actions', { GITHUB_ACTIONS: 'false' }],
  ['a workflow_dispatch run', { GITHUB_EVENT_NAME: 'workflow_dispatch' }],
  ['a pull request run', { GITHUB_EVENT_NAME: 'pull_request' }],
  ['another branch', { GITHUB_REF: 'refs/heads/feature' }],
  ['a fork', { GITHUB_REPOSITORY: 'outsider/sh-codemod' }],
  ['no OIDC request URL', { ACTIONS_ID_TOKEN_REQUEST_URL: undefined }],
  ['no OIDC request token', { ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }],
  ['an NPM_TOKEN fallback', { NPM_TOKEN: 'fixture-only-forbidden' }],
  ['a NODE_AUTH_TOKEN fallback', { NODE_AUTH_TOKEN: 'fixture-only-forbidden' }],
] as const) {
  await test(`the guard rejects ${name} before any client command`, () => {
    const result = guard(override);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Publication requires a push to main/);
  });
}
