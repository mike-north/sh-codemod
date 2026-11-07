/** Real plans and archives use local tools; registry transport and every npm upload are fake. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { test } from 'node:test';

/** Resolve the installed pinned packer once, before replacing registry/upload clients. */
const pnpmLookup = spawnSync(
  'pnpm',
  ['exec', 'node', '-p', 'process.env.npm_execpath'],
  { encoding: 'utf8' },
);
assert.equal(pnpmLookup.status, 0, pnpmLookup.stdout + pnpmLookup.stderr);
const realPnpm = pnpmLookup.stdout.trim();
assert.ok(
  realPnpm.startsWith('/'),
  'pnpm must identify an installed native executable',
);
const packerVersion = spawnSync(realPnpm, ['--version'], {
  encoding: 'utf8',
});
assert.equal(
  packerVersion.status,
  0,
  packerVersion.stdout + packerVersion.stderr,
);
assert.equal(packerVersion.stdout.trim(), '12.16.1');

/** JSON fixture outputs remain untrusted until their dictionary shape is checked. */
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
  );
  return Object.fromEntries(Object.entries(value));
}

/** Registry/upload clients are fixture-local; only local packing reaches real installed tools. */
async function fixture(
  run: (root: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/native-publish-'));
  try {
    for (const path of [
      'bin',
      'uploads',
      '.changeset',
      '.github/workflows',
      'packages/example',
      'packages/dependent',
    ]) {
      await mkdir(join(root, path), { recursive: true });
    }
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        packageManager: 'pnpm@12.16.1',
      }),
    );
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    // Native pnpm's package-manager dependency resolution stays offline using its real lock receipt.
    await copyFile('pnpm-lock.yaml', join(root, 'pnpm-lock.yaml'));
    await copyFile(
      '.changeset/config.json',
      join(root, '.changeset/config.json'),
    );
    await copyFile(
      '.github/workflows/release.yml',
      join(root, '.github/workflows/release.yml'),
    );
    await writeFile(
      join(root, 'packages/example/package.json'),
      JSON.stringify({
        name: 'example',
        version: '0.1.0',
        publishConfig: { access: 'public' },
      }),
    );
    await writeFile(
      join(root, 'packages/dependent/package.json'),
      JSON.stringify({
        name: 'dependent',
        version: '0.1.0',
        publishConfig: { access: 'public' },
        dependencies: { example: 'workspace:0.1.0' },
      }),
    );
    await symlink(resolve('node_modules'), join(root, 'node_modules'));
    // Only local packing is delegated to real tools. Registry reads and every
    // upload stay fake; source uploads use real npm pack as an archive oracle.
    const fake = `#!${process.execPath}
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
const command = basename(process.argv[1] ?? '');
const args: string[] = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS ?? '', JSON.stringify({command, args, cwd:process.cwd()}) + '\\n');
if (command === 'pnpm') {
  if (args[0] === '--version') console.log('12.16.1');
  else if (args[0] === 'info') {
    const versions: unknown = JSON.parse(process.env.FIXTURE_VERSIONS ?? '[]');
    console.log(JSON.stringify({versions, 'dist-tags': {latest: '0.1.0'}}));
  } else if (args[0] === 'pack') {
    if (process.env.FAIL_PACK === basename(process.cwd())) process.exit(96);
    if (process.env.RAW_PACK === basename(process.cwd())) {
      const destination = args[args.indexOf('--out') + 1];
      if (!destination) process.exit(89);
      mkdirSync(dirname(destination), {recursive:true});
      const result = spawnSync('npm', ['pack','--offline','--ignore-scripts','--json','--pack-destination',dirname(destination)], {encoding:'utf8', env:{...process.env, PATH:process.env.ORIGINAL_PATH}});
      if (result.status !== 0) process.exit(88);
      const listing: unknown = JSON.parse(result.stdout);
      const first: unknown = Array.isArray(listing) ? listing[0] : undefined;
      if (typeof first !== 'object' || first === null || !('filename' in first) || typeof first.filename !== 'string') process.exit(87);
      copyFileSync(join(dirname(destination), first.filename), destination);
      process.exit(0);
    }
    const result = spawnSync(process.env.REAL_PNPM_CLI ?? '', args, {stdio:'inherit'});
    if (result.status !== 0) process.exit(result.status ?? 95);
    if (process.env.CORRUPT_PACK === basename(process.cwd())) {
      const path = args[args.indexOf('--out') + 1];
      if (!path) process.exit(94);
      writeFileSync(path, 'malformed archive');
    }
  } else process.exit(97);
} else if (command === 'npm') {
  if (args[0] === '--version') console.log(process.env.NPM_VERSION ?? '11.6.2');
  else if (args[0] === 'publish') {
    const uploadDir = process.env.FIXTURE_UPLOADS ?? '';
    const destination = join(uploadDir, basename(process.cwd()) + '.tgz');
    mkdirSync(uploadDir, {recursive:true});
    if (args[1]?.endsWith('.tgz')) copyFileSync(args[1], destination);
    else {
      // Oracle for the old source-directory path, never a compatibility uploader.
      const output = join(uploadDir, 'native-' + basename(process.cwd()));
      mkdirSync(output, {recursive:true});
      const result = spawnSync('npm', ['pack','--offline','--ignore-scripts','--json','--pack-destination',output], {encoding:'utf8', env:{...process.env, PATH:process.env.ORIGINAL_PATH}});
      if (result.status !== 0) { console.error(result.stderr); process.exit(93); }
      const listing: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(listing)) process.exit(92);
      const first: unknown = listing[0];
      if (typeof first !== 'object' || first === null || !('filename' in first) || typeof first.filename !== 'string') process.exit(91);
      copyFileSync(join(output, first.filename), destination);
    }
    const manifest = spawnSync('tar', ['-xOf', destination, 'package/package.json'], {encoding:'utf8'});
    if (manifest.status !== 0) process.exit(90);
    writeFileSync(destination + '.json', manifest.stdout);
    if (process.env.FAIL_PUBLISH) process.exit(1);
  } else process.exit(98);
} else process.exit(99);
`;
    for (const command of ['npm', 'pnpm']) {
      const source = join(root, 'bin', `${command}.ts`);
      await writeFile(source, fake);
      await chmod(source, 0o755);
      await symlink(source, join(root, 'bin', command));
    }
    await run(root, {
      ...process.env,
      PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      ORIGINAL_PATH: process.env.PATH,
      REAL_PNPM_CLI: realPnpm,
      FIXTURE_UPLOADS: join(root, 'uploads'),
      npm_config_offline: 'true',
      npm_config_cache: join(root, '.cache/npm'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      pnpm_config_offline: 'true',
      FIXTURE_CALLS: join(root, 'calls.jsonl'),
      FIXTURE_VERSIONS: '["0.0.1"]',
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'mike-north/sh-codemod',
      GITHUB_ACTOR: 'mike-north',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-only',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The real command boundary is exercised, including exit status and diagnostics. */
function invoke(
  root: string,
  env: NodeJS.ProcessEnv,
  script: string,
  args: readonly string[],
) {
  return spawnSync(process.execPath, [resolve('scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

/** Decode fake service calls without silently accepting malformed intercepted evidence. */
async function calls(root: string): Promise<Record<string, unknown>[]> {
  let source: string;
  try {
    source = await readFile(join(root, 'calls.jsonl'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return source
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
}

/** Publication calls are distinct from version checks and fake registry transport. */
async function publications(root: string) {
  return (await calls(root)).filter(
    (call) =>
      call.command === 'npm' &&
      Array.isArray(call.args) &&
      call.args[0] === 'publish',
  );
}

/** Concrete intended plan entries come from the fixture source contracts. */
const example = {
  kind: 'publish',
  name: 'example',
  version: '0.1.0',
  access: 'public',
  tag: 'latest',
};
const dependent = { ...example, name: 'dependent' };

await test('real installed publish-plan orders unpublished packages; native npm rerun is a deliberate no-op', async (context) => {
  await fixture(async (root, env) => {
    const cli = record(
      JSON.parse(
        await readFile(
          new URL(import.meta.resolve('@changesets/cli/package.json')),
          'utf8',
        ),
      ),
    );
    assert.equal(cli.version, '3.0.3');
    const planned = invoke(root, env, 'publishing.ts', ['plan']);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    const plan: unknown = JSON.parse(
      await readFile(join(root, '.tmp/publish-plan.json'), 'utf8'),
    );
    assert.deepEqual(plan, { version: 1, plan: [[example], [dependent]] });
    assert.equal(
      (await calls(root)).filter(
        (call) =>
          call.command === 'pnpm' &&
          Array.isArray(call.args) &&
          call.args[0] === 'info',
      ).length,
      2,
    );
    assert.deepEqual(await publications(root), []);
    const published = invoke(root, env, 'publish.ts', [
      '.tmp/publish-plan.json',
    ]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    const uploaded = await publications(root);
    assert.equal(uploaded.length, 2);
    for (const [index, name] of ['example', 'dependent'].entries()) {
      const call = uploaded[index];
      assert.ok(call && Array.isArray(call.args));
      assert.equal(call.cwd, join(root, 'packages', name));
      assert.equal(call.args[0], 'publish');
      assert.equal(typeof call.args[1], 'string');
      assert.match(String(call.args[1]), /\.tgz$/);
      assert.deepEqual(call.args.slice(2), [
        '--access',
        'public',
        '--tag',
        'latest',
      ]);
      const manifest = record(
        JSON.parse(
          await readFile(join(root, 'uploads', `${name}.tgz.json`), 'utf8'),
        ),
      );
      assert.equal(manifest.name, name);
      assert.equal(manifest.version, '0.1.0');
    }
    const preparedBefore = (await calls(root)).filter(
      (call) =>
        call.command === 'pnpm' &&
        Array.isArray(call.args) &&
        call.args[0] === 'pack',
    );
    assert.equal(preparedBefore.length, 2);
    const rerun = invoke(
      root,
      { ...env, FIXTURE_VERSIONS: '["0.0.1","0.1.0"]' },
      'publishing.ts',
      ['plan'],
    );
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, '.tmp/publish-plan.json'), 'utf8')),
      { version: 1, plan: [] },
    );
    const before = await publications(root);
    const noOp = invoke(root, env, 'publish.ts', ['.tmp/publish-plan.json']);
    assert.equal(noOp.status, 0, noOp.stdout + noOp.stderr);
    assert.match(noOp.stdout, /already published; nothing to do/i);
    assert.deepEqual(await publications(root), before);
    assert.deepEqual(
      (await calls(root)).filter(
        (call) =>
          call.command === 'pnpm' &&
          Array.isArray(call.args) &&
          call.args[0] === 'pack',
      ),
      preparedBefore,
    );
    context.diagnostic(
      `Real CLI plan: ${JSON.stringify(plan)}; rerun: ${noOp.stdout.trim()}; native npm calls: ${JSON.stringify(before)}`,
    );
  });
});

await test('zero public packages produce a real empty plan and truthful no-op', async () => {
  await fixture(async (root, env) => {
    await rm(join(root, 'packages'), { recursive: true });
    const result = invoke(root, env, 'publishing.ts', ['plan']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, '.tmp/publish-plan.json'), 'utf8')),
      { version: 1, plan: [] },
    );
    const publish = invoke(root, env, 'publish.ts', ['.tmp/publish-plan.json']);
    assert.equal(publish.status, 0, publish.stdout + publish.stderr);
    assert.match(publish.stdout, /no publishable packages; nothing to do/i);
    assert.deepEqual(await publications(root), []);
    assert.ok(
      !(await calls(root)).some(
        (call) =>
          Array.isArray(call.args) &&
          (call.args[0] === 'info' || call.args[0] === 'pack'),
      ),
    );
  });
});

/** Guard failures must precede every registry/publication request, even for a missing plan. */
const unauthorized: readonly Readonly<Record<string, string | undefined>>[] = [
  { GITHUB_ACTIONS: 'false' },
  { GITHUB_EVENT_NAME: 'push' },
  { GITHUB_EVENT_NAME: 'pull_request' },
  { GITHUB_REF: 'refs/heads/feature' },
  { GITHUB_REPOSITORY: 'outsider/sh-codemod' },
  { GITHUB_ACTOR: 'outsider' },
  { ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
  { ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined },
  { NPM_TOKEN: 'fixture-only-forbidden' },
  { NODE_AUTH_TOKEN: 'fixture-only-forbidden' },
];
for (const [index, override] of unauthorized.entries()) {
  await test(`owner dispatch guard rejects context ${String(index)} before registry and publication`, async () => {
    await fixture(async (root, env) => {
      for (const [script, args] of [
        ['publishing.ts', ['plan']],
        ['publish.ts', ['missing-plan.json']],
      ] as const) {
        const result = invoke(root, { ...env, ...override }, script, args);
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /owner-dispatched main workflow/i);
        assert.deepEqual(await calls(root), []);
      }
    });
  });
}

/** Unknown/ambiguous authority is rejected in full before the first publication. */
const invalidPlans: Readonly<Record<string, unknown>> = {
  'wrong schema': { version: 2, plan: [] },
  'missing plan': { version: 1 },
  'unexpected schema field': { version: 1, plan: [], extra: true },
  'invalid chunk': { version: 1, plan: [example] },
  'unknown package after valid entry': {
    version: 1,
    plan: [[example], [{ ...example, name: 'unknown' }]],
  },
  'wrong version': { version: 1, plan: [[{ ...example, version: '0.2.0' }]] },
  'nonzero major': { version: 1, plan: [[{ ...example, version: '1.0.0' }]] },
  'invalid semver': {
    version: 1,
    plan: [[{ ...example, version: '0.1.0-01' }]],
  },
  'wrong access': {
    version: 1,
    plan: [[{ ...example, access: 'restricted' }]],
  },
  'wrong tag': { version: 1, plan: [[{ ...example, tag: 'unrequested' }]] },
  'unsafe tag': { version: 1, plan: [[{ ...example, tag: '--flag' }]] },
  'tag-only operation': {
    version: 1,
    plan: [[{ ...example, kind: 'tag-only' }]],
  },
  'duplicate chunk entry': { version: 1, plan: [[example, example]] },
  'duplicate across chunks': { version: 1, plan: [[example], [example]] },
  'arbitrary path': { version: 1, plan: [[{ ...example, path: '/outside' }]] },
};
for (const [name, plan] of Object.entries(invalidPlans)) {
  await test(`native publication rejects ${name} without publishing anything`, async () => {
    await fixture(async (root, env) => {
      await writeFile(join(root, 'plan.json'), JSON.stringify(plan));
      const result = invoke(root, env, 'publish.ts', ['plan.json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /invalid|unexpected|duplicate/i);
      assert.deepEqual(await publications(root), []);
      assert.ok(
        !(await calls(root)).some(
          (call) =>
            call.command === 'pnpm' &&
            Array.isArray(call.args) &&
            call.args[0] === 'pack',
        ),
      );
    });
  });
}

await test('private or invalid source manifests cannot authorize a planned publication', async () => {
  for (const change of [
    { private: true },
    { version: '1.0.0' },
    { version: '0.1.0-01' },
  ]) {
    await fixture(async (root, env) => {
      const path = join(root, 'packages/example/package.json');
      const manifest = record(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(path, JSON.stringify({ ...manifest, ...change }));
      await writeFile(
        join(root, 'plan.json'),
        JSON.stringify({
          version: 1,
          plan: [
            [
              {
                ...example,
                ...(change.version ? { version: change.version } : {}),
              },
            ],
          ],
        }),
      );
      const result = invoke(root, env, 'publish.ts', ['plan.json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.deepEqual(await publications(root), []);
      assert.ok(
        !(await calls(root)).some(
          (call) =>
            call.command === 'pnpm' &&
            Array.isArray(call.args) &&
            call.args[0] === 'pack',
        ),
      );
    });
  }
});

/** A local consumer cannot borrow registry metadata or repair invalid workspace specs. */
const workspaceRanges = new Map([
  ['workspace:0.1.0', '0.1.0'],
  ['workspace:*', '0.1.0'],
  ['workspace:^', '^0.1.0'],
  ['workspace:~', '~0.1.0'],
]);
for (const [range, expected] of workspaceRanges) {
  await test(`prepared ${range} archive installs in a real offline npm consumer`, async (context) => {
    await fixture(async (root, env) => {
      const path = join(root, 'packages/dependent/package.json');
      const source = record(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(
        path,
        JSON.stringify({
          ...source,
          dependencies: { example: range },
          description: 'workspace: local packaging example',
          scripts: { example: 'workspace: ordinary script text' },
          customMetadata: { note: 'workspace: ordinary custom data' },
        }),
      );
      const plan = invoke(root, env, 'publishing.ts', ['plan']);
      assert.equal(plan.status, 0, plan.stdout + plan.stderr);
      const result = invoke(root, env, 'publish.ts', [
        '.tmp/publish-plan.json',
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const manifest = record(
        JSON.parse(
          await readFile(join(root, 'uploads/dependent.tgz.json'), 'utf8'),
        ),
      );
      const consumer = join(root, 'consumer');
      const cache = join(consumer, '.cache/npm');
      await mkdir(cache, { recursive: true });
      assert.deepEqual(await readdir(cache), []);
      await writeFile(
        join(consumer, 'package.json'),
        JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }),
      );
      const install = spawnSync(
        'npm',
        [
          'install',
          '--offline',
          '--ignore-scripts',
          '--workspaces=false',
          '--no-audit',
          '--no-fund',
          join(root, 'uploads/example.tgz'),
          join(root, 'uploads/dependent.tgz'),
        ],
        {
          cwd: consumer,
          encoding: 'utf8',
          env: {
            ...process.env,
            npm_config_offline: 'true',
            npm_config_cache: cache,
            npm_config_audit: 'false',
            npm_config_fund: 'false',
            npm_config_update_notifier: 'false',
          },
        },
      );
      context.diagnostic(
        `Would-upload manifest: ${JSON.stringify(manifest)}; real empty-cache offline consumer exit ${String(install.status)}\n${install.stdout}${install.stderr}`,
      );
      assert.equal(install.status, 0, install.stdout + install.stderr);
      assert.ok(record(manifest.dependencies).example === expected);
      assert.equal(manifest.description, 'workspace: local packaging example');
      assert.equal(
        record(manifest.scripts).example,
        'workspace: ordinary script text',
      );
      assert.equal(
        record(manifest.customMetadata).note,
        'workspace: ordinary custom data',
      );
      const installed = record(
        JSON.parse(
          await readFile(
            join(consumer, 'node_modules/dependent/package.json'),
            'utf8',
          ),
        ),
      );
      assert.equal(record(installed.dependencies).example, expected);
      assert.equal(installed.description, manifest.description);
      assert.deepEqual(installed.scripts, manifest.scripts);
      assert.deepEqual(installed.customMetadata, manifest.customMetadata);
      assert.equal(
        record(
          JSON.parse(
            await readFile(
              join(consumer, 'node_modules/example/package.json'),
              'utf8',
            ),
          ),
        ).version,
        '0.1.0',
      );
      // Archives passed to npm are ephemeral; retained copies belong only to the fake uploader.
      const published = await publications(root);
      assert.equal(published.length, 2);
      for (const call of published) {
        assert.ok(Array.isArray(call.args) && typeof call.args[1] === 'string');
        await assert.rejects(readFile(call.args[1]), { code: 'ENOENT' });
      }
    });
  });
}

await test('a later archive with changed identity is rejected before uploading any package', async () => {
  for (const override of [{ name: 'unexpected' }, { version: '0.2.0' }]) {
    await fixture(async (root, env) => {
      const path = join(root, 'packages/dependent/package.json');
      const source = record(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(
        path,
        JSON.stringify({
          ...source,
          publishConfig: { access: 'public', directory: 'artifact' },
        }),
      );
      await mkdir(join(root, 'packages/dependent/artifact'));
      await writeFile(
        join(root, 'packages/dependent/artifact/package.json'),
        JSON.stringify({ name: 'dependent', version: '0.1.0', ...override }),
      );
      await writeFile(
        join(root, 'plan.json'),
        JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
      );
      const result = invoke(root, env, 'publish.ts', ['plan.json']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /archive.*identity/i);
      assert.deepEqual(await publications(root), []);
      assert.deepEqual(await readdir(join(root, '.tmp')), []);
    });
  }
});

await test('packing failures and malformed archives clean up and never upload a partial plan', async () => {
  for (const override of [
    { FAIL_PACK: 'dependent' },
    { CORRUPT_PACK: 'dependent' },
    { RAW_PACK: 'dependent' },
  ]) {
    await fixture(async (root, env) => {
      await writeFile(
        join(root, 'plan.json'),
        JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
      );
      const result = invoke(root, { ...env, ...override }, 'publish.ts', [
        'plan.json',
      ]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /pack|archive/i);
      assert.deepEqual(await publications(root), []);
      assert.deepEqual(await readdir(join(root, '.tmp')), []);
    });
  }
});

await test('native upload failure reports failure and removes every prepared archive', async () => {
  await fixture(async (root, env) => {
    await writeFile(
      join(root, 'plan.json'),
      JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
    );
    const result = invoke(
      root,
      { ...env, FAIL_PUBLISH: 'true' },
      'publish.ts',
      ['plan.json'],
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /npm publication failed/i);
    assert.equal((await publications(root)).length, 1);
    const packs = (await calls(root)).filter(
      (call) =>
        call.command === 'pnpm' &&
        Array.isArray(call.args) &&
        call.args[0] === 'pack',
    );
    assert.equal(
      packs.length,
      2,
      'all archives must be prepared before any upload',
    );
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
  });
});

await test('unresolved specifiers in each npm dependency group still reject all uploads', async () => {
  for (const group of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    await fixture(async (root, env) => {
      const path = join(root, 'packages/dependent/package.json');
      const source = record(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(
        path,
        JSON.stringify({
          ...source,
          dependencies: undefined,
          [group]: { example: 'workspace:0.1.0' },
        }),
      );
      await writeFile(
        join(root, 'plan.json'),
        JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
      );
      const result = invoke(
        root,
        { ...env, RAW_PACK: 'dependent' },
        'publish.ts',
        ['plan.json'],
      );
      assert.equal(
        result.status,
        1,
        `${group}: ${result.stdout}${result.stderr}`,
      );
      assert.match(result.stderr, /unresolved workspace protocol/i);
      assert.deepEqual(await publications(root), []);
      assert.deepEqual(await readdir(join(root, '.tmp')), []);
    });
  }
});

await test('the real registry-aware CLI plan includes the unpublished public singleton root exactly once', async () => {
  await fixture(async (root, env) => {
    await rm(join(root, 'packages'), { recursive: true });
    const manifest = record(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        ...manifest,
        name: 'sh-codemod',
        version: '0.1.0',
        private: false,
      }),
    );
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n');
    const planned = invoke(root, env, 'publishing.ts', ['plan']);
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, '.tmp/publish-plan.json'), 'utf8')),
      { version: 1, plan: [[{ ...example, name: 'sh-codemod' }]] },
    );
    const published = invoke(root, env, 'publish.ts', [
      '.tmp/publish-plan.json',
    ]);
    assert.equal(published.status, 0, published.stdout + published.stderr);
    assert.equal((await publications(root)).length, 1);
    const rerun = invoke(
      root,
      { ...env, FIXTURE_VERSIONS: '["0.1.0"]' },
      'publishing.ts',
      ['plan'],
    );
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, '.tmp/publish-plan.json'), 'utf8')),
      { version: 1, plan: [] },
    );
  });
});

await test('native npm client floor rejects unsupported and malformed versions before registry work', async () => {
  for (const [version, status] of [
    ['11.5.0', 1],
    ['10.9.3', 1],
    ['11.5.1', 0],
    ['11.21.1', 0],
    ['12.0.0', 0],
    ['11.5.1\ntrailing', 1],
  ] as const) {
    await fixture(async (root, env) => {
      const result = invoke(
        root,
        { ...env, NPM_VERSION: version },
        'publishing.ts',
        ['runtime'],
      );
      assert.equal(result.status, status, result.stdout + result.stderr);
      assert.deepEqual(
        (await calls(root)).map((call) => call.args),
        [['--version']],
      );
    });
  }
});

await test('source publication overrides cannot introduce another registry, credentials or provenance', async () => {
  for (const override of [
    { registry: 'https://registry.invalid' },
    { provenance: true },
    { _authToken: 'fixture-only' },
  ]) {
    await fixture(async (root, env) => {
      const path = join(root, 'packages/example/package.json');
      const source = record(JSON.parse(await readFile(path, 'utf8')));
      await writeFile(
        path,
        JSON.stringify({
          ...source,
          publishConfig: { access: 'public', ...override },
        }),
      );
      await writeFile(
        join(root, 'plan.json'),
        JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
      );
      const planned = invoke(root, env, 'publishing.ts', ['plan']);
      assert.equal(planned.status, 1, planned.stdout + planned.stderr);
      assert.equal(
        (await calls(root)).filter(
          (call) => Array.isArray(call.args) && call.args[0] === 'info',
        ).length,
        0,
      );
      const published = invoke(root, env, 'publish.ts', ['plan.json']);
      assert.equal(published.status, 1, published.stdout + published.stderr);
      assert.deepEqual(await publications(root), []);
    });
  }
});

await test('a packed manifest cannot add registry or provenance authority absent from source', async () => {
  await fixture(async (root, env) => {
    const path = join(root, 'packages/dependent/package.json');
    const source = record(JSON.parse(await readFile(path, 'utf8')));
    await writeFile(
      path,
      JSON.stringify({
        ...source,
        publishConfig: { access: 'public', directory: 'artifact' },
      }),
    );
    await mkdir(join(root, 'packages/dependent/artifact'));
    await writeFile(
      join(root, 'packages/dependent/artifact/package.json'),
      JSON.stringify({
        name: 'dependent',
        version: '0.1.0',
        publishConfig: { access: 'public', provenance: true },
      }),
    );
    await writeFile(
      join(root, 'plan.json'),
      JSON.stringify({ version: 1, plan: [[example], [dependent]] }),
    );
    const published = invoke(root, env, 'publish.ts', ['plan.json']);
    assert.equal(published.status, 1, published.stdout + published.stderr);
    assert.deepEqual(await publications(root), []);
    assert.deepEqual(await readdir(join(root, '.tmp')), []);
  });
});
