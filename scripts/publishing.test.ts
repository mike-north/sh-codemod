/** Release workflow tests check its structure and runtime guard without contacting a service. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { checkWorkflow, checkRuntime, record } from './publishing.ts';

await test('the actual installed native npm satisfies the OIDC client floor', () => {
  checkRuntime();
});

await test('the checked-in release workflow is the Changesets push-to-main flow in three jobs', async () => {
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
    const sha = 'ae32849d5ba541f9ae29e40e22a623bc13562f51';
    for (const altered of [
      original.replace('push:\n    branches: [main]', 'workflow_dispatch:'),
      original.replace('branches: [main]', 'branches: [main, next]'),
      // Trust identity: the publish job's environment must stay `npm`, and only there.
      original.replace('environment: npm', 'environment: npm-publish'),
      original.replace('    environment: npm\n', ''),
      original.replace(
        "mode == 'version'\n    runs-on: ubuntu-latest",
        "mode == 'version'\n    runs-on: ubuntu-latest\n    environment: npm",
      ),
      // OIDC belongs to the publish job alone.
      original.replace('id-token: write', 'id-token: read'),
      original.replace(
        '      pull-requests: write',
        '      pull-requests: write\n      id-token: write',
      ),
      original.replace('permissions: {}', 'permissions:\n  contents: read'),
      original.replace(
        '      contents: read\n    outputs',
        '      contents: write\n    outputs',
      ),
      original.replace(
        '      contents: write\n      id-token: write',
        '      contents: read\n      id-token: write',
      ),
      original.replace(
        '      contents: write\n      id-token: write',
        '      contents: write\n      id-token: write\n      actions: write',
      ),
      // Tags and GitHub Releases must be requested explicitly on publish.
      original.replace('push-git-tags: true', 'push-git-tags: false'),
      original.replace(
        'create-github-releases: true',
        'create-github-releases: false',
      ),
      original.replace('          push-git-tags: true\n', ''),
      // Every action is pinned by SHA, and the Changesets sub-actions share one release.
      original.replaceAll(
        /actions\/checkout@[0-9a-f]{40} # v4.4.0/gu,
        'actions/checkout@v4',
      ),
      original.replace(`select-mode@${sha}`, 'select-mode@v2'),
      original.replace(`publish@${sha}`, `publish@${'0'.repeat(40)}`),
      original.replace(`version@${sha}`, 'version@v2'),
      original.replace(
        `changesets/action/publish@${sha}`,
        `changesets/action@${sha}`,
      ),
      original.replace(
        "github.repository == 'mike-north/sh-codemod'",
        "github.repository != ''",
      ),
      original.replace("mode == 'publish'", "mode == 'version'"),
      original.replace(
        'persist-credentials: false',
        'persist-credentials: true',
      ),
      original.replace('runs-on: ubuntu-latest', 'runs-on: self-hosted'),
      original.replace('script: pnpm release', 'script: npm publish'),
      original.replace(
        'script: pnpm version:packages',
        'script: changeset version',
      ),
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

/**
 * The release workflow's shape, written from the Changesets action v2 contract and npm trusted
 * publishing rather than from the file: v2 learns what was published from the CLI's output file
 * (read by the `publish` sub-action) and pushes tags and creates GitHub Releases through the
 * GitHub API, which needs `contents: write`; `select-mode` and `version` never need OIDC.
 * @see https://github.com/changesets/action/tree/ae32849d5ba541f9ae29e40e22a623bc13562f51
 * @see https://docs.npmjs.com/trusted-publishers/
 */
await test('release authority is split by job: OIDC and the npm environment only on publish, tags and releases created there', async () => {
  const workflow = record(
    parse(await readFile('.github/workflows/release.yml', 'utf8')),
  );
  assert.deepEqual(workflow.permissions, {});
  const jobs = record(workflow.jobs);
  assert.deepEqual(Object.keys(jobs).sort(), [
    'publish',
    'select-mode',
    'version',
  ]);
  assert.deepEqual(record(record(jobs['select-mode']).permissions), {
    contents: 'read',
  });
  assert.deepEqual(record(record(jobs.version).permissions), {
    contents: 'write',
    'pull-requests': 'write',
  });
  const publish = record(jobs.publish);
  assert.deepEqual(record(publish.permissions), {
    contents: 'write',
    'id-token': 'write',
  });
  assert.equal(publish.environment, 'npm');
  assert.equal(record(jobs.version).environment, undefined);
  assert.equal(record(jobs['select-mode']).environment, undefined);
  assert.ok(Array.isArray(publish.steps));
  const inputs = record(
    publish.steps
      .map((step: unknown) => record(step))
      .find((step) =>
        String(step.uses).startsWith('changesets/action/publish@'),
      )?.with,
  );
  assert.equal(inputs['push-git-tags'], true);
  assert.equal(inputs['create-github-releases'], true);
  assert.equal(inputs.script, 'pnpm release');
});

await test('every action in the release workflow is pinned by full commit SHA, and the Changesets sub-actions are v2.1.2', async () => {
  const text = await readFile('.github/workflows/release.yml', 'utf8');
  const uses = [...text.matchAll(/^\s*- uses: (\S+)/gmu)].map(
    (match) => match[1] ?? '',
  );
  assert.ok(uses.length > 0);
  for (const reference of uses) {
    assert.match(reference, /^[^@]+@[0-9a-f]{40}$/u, reference);
  }
  // v2.1.2 of changesets/action, which supports Changesets CLI 3 (the CLI this package installs).
  for (const subAction of ['select-mode', 'version', 'publish']) {
    assert.ok(
      uses.includes(
        `changesets/action/${subAction}@ae32849d5ba541f9ae29e40e22a623bc13562f51`,
      ),
      subAction,
    );
  }
});
