/** Prerelease projection must inspect one supported planner view without migrating the checked source. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';

/** Fixture roots and temporary planner data have separate inventories, so cleanup cannot hide source writes. */
interface IFixture {
  readonly root: string;
  readonly temporary: string;
  readonly oracle: string;
}

/** A process exit and its diagnostics are independent evidence of the gate's actual outcome. */
interface IResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Exercise the installed command without relying on Git eligibility or any registry client. */
const gate = resolve('scripts/check-release.ts');
/** The real singleton configuration is reused without introducing another release policy. */
const configuration = await readFile('.changeset/config.json');

/** Every directory and file's raw bytes participate, including empty directories and non-Markdown inputs. */
async function inventory(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result[`${entry.name}/`] = 'directory';
      for (const [name, bytes] of Object.entries(await inventory(path))) {
        result[`${entry.name}/${name}`] = bytes;
      }
    } else {
      assert.ok(entry.isFile(), 'Fixture inputs must be ordinary files');
      result[entry.name] = (await readFile(path)).toString('base64');
    }
  }
  return result;
}

/** Isolate source, oracle and temporary writes; absence of pre.json is distinct from any present JSON value. */
async function fixture(
  state: unknown,
  run: (value: IFixture) => Promise<void>,
): Promise<void> {
  await mkdir('.tmp', { recursive: true });
  const directory = await mkdtemp(resolve('.tmp/prerelease-state-'));
  const value = {
    root: join(directory, 'source'),
    temporary: join(directory, 'temporary'),
    oracle: join(directory, 'oracle'),
  };
  try {
    await mkdir(join(value.root, '.changeset'), { recursive: true });
    await mkdir(value.temporary);
    await writeFile(
      join(value.root, 'package.json'),
      JSON.stringify({ name: 'sh-codemod', version: '0.1.1', type: 'module' }),
    );
    await writeFile(
      join(value.root, 'pnpm-workspace.yaml'),
      'allowBuilds: {}\n',
    );
    await writeFile(join(value.root, '.changeset/config.json'), configuration);
    await writeFile(
      join(value.root, '.changeset/metadata.bin'),
      Buffer.from([0, 255, 13, 10]),
    );
    if (state !== undefined) {
      await writeFile(
        join(value.root, '.changeset/pre.json'),
        JSON.stringify(state),
      );
    }
    await run(value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Supported legacy data consumes the named changeset through the installed reader's migration. */
async function legacyChanges(root: string, consumed = 'minor'): Promise<void> {
  await writeFile(
    join(root, '.changeset/old-change.md'),
    `---\n"sh-codemod": ${consumed}\n---\nAn already-consumed change.\n`,
  );
  await writeFile(
    join(root, '.changeset/next-change.md'),
    '---\n"sh-codemod": patch\n---\nAn outstanding change.\n',
  );
}

/** Point only planner temporary storage at the fixture; source and installed tool identities remain actual. */
function environment(value: IFixture): NodeJS.ProcessEnv {
  return { ...process.env, TMPDIR: value.temporary };
}

/** Drive the same source gate that ordinary CI and root checks invoke. */
function invoke(value: IFixture, mode = 'versions'): IResult {
  const result = spawnSync(process.execPath, [gate, mode], {
    cwd: value.root,
    encoding: 'utf8',
    env: environment(value),
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Observe overlapping read-only G1/G2 invocations with at most two command processes. */
async function invokeConcurrent(
  value: IFixture,
  mode: string,
): Promise<IResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [gate, mode], {
      cwd: value.root,
      env: environment(value),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      stdout += text;
    });
    child.stderr.on('data', (text: string) => {
      stderr += text;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolveResult({ status, stdout, stderr });
    });
  });
}

await test('legacy G2 leaves the full source inventory and bytes unchanged on repeated and concurrent checks', async (context) => {
  await fixture(
    {
      mode: 'pre',
      tag: 'next',
      initialVersions: { 'sh-codemod': '0.1.1' },
      changesets: ['old-change'],
      compatible: { retained: true },
    },
    async (value) => {
      await legacyChanges(value.root);
      const before = await inventory(join(value.root, '.changeset'));
      const result = invoke(value);
      const after = await inventory(join(value.root, '.changeset'));
      context.diagnostic(
        JSON.stringify({
          command: [process.execPath, gate, 'versions'],
          result,
          before,
          after,
        }),
      );
      assert.deepEqual(
        after,
        before,
        'Version checks must not migrate the checked source',
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (let round = 0; round < 2; round += 1) {
        const results = await Promise.all([
          invokeConcurrent(value, 'changesets'),
          invokeConcurrent(value, 'versions'),
        ]);
        for (const concurrent of results) {
          assert.equal(
            concurrent.status,
            0,
            concurrent.stdout + concurrent.stderr,
          );
        }
        assert.deepEqual(
          await inventory(join(value.root, '.changeset')),
          before,
        );
        assert.deepEqual(
          await readdir(value.temporary),
          [],
          'Planner snapshots must be cleaned',
        );
      }
    },
  );
});

/** Each present value violates only the supported required object/mode/tag contract. */
const invalidStates: Readonly<Record<string, unknown>> = {
  'empty object': {},
  array: ['not', 'state'],
  null: null,
  false: false,
  zero: 0,
  string: 'pre',
  'missing mode': { tag: 'next' },
  'invalid mode': { mode: 'typo', tag: 'next' },
  'nonstring mode': { mode: 0, tag: 'next' },
  'missing tag': { mode: 'pre' },
  'numeric tag': { mode: 'pre', tag: 123 },
  'null tag': { mode: 'exit', tag: null },
};
for (const [name, state] of Object.entries(invalidStates)) {
  await test(`G2 refuses present ${name} prerelease state even for an empty plan`, async (context) => {
    await fixture(state, async (value) => {
      const before = await inventory(join(value.root, '.changeset'));
      const result = invoke(value);
      context.diagnostic(JSON.stringify({ input: state, result }));
      assert.deepEqual(await inventory(join(value.root, '.changeset')), before);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /prerelease state/iu);
      assert.deepEqual(await readdir(value.temporary), []);
    });
  });
}

await test('G2 refuses malformed required state when a nonempty plan would otherwise produce valid SemVer', async () => {
  for (const state of [
    {},
    { mode: 'typo', tag: 'next' },
    { mode: 'pre', tag: 123 },
  ]) {
    await fixture(state, async (value) => {
      await writeFile(
        join(value.root, '.changeset/change.md'),
        '---\n"sh-codemod": patch\n---\nA change.\n',
      );
      const before = await inventory(join(value.root, '.changeset'));
      const result = invoke(value);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /prerelease state/iu);
      assert.deepEqual(await inventory(join(value.root, '.changeset')), before);
      assert.deepEqual(await readdir(value.temporary), []);
    });
  }
});

await test('absent state and both supported modes accept compatible extra fields without a new tag policy', async () => {
  for (const state of [
    undefined,
    { mode: 'pre', tag: 'next' },
    { mode: 'exit', tag: 'next' },
    { mode: 'pre', tag: '', compatible: true },
  ]) {
    await fixture(state, async (value) => {
      const before = await inventory(join(value.root, '.changeset'));
      const result = invoke(value);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(await inventory(join(value.root, '.changeset')), before);
      assert.deepEqual(await readdir(value.temporary), []);
    });
  }
});

await test('isolated projection matches supported migration and handwritten pre/exit releases on an independent copy', async (context) => {
  for (const mode of ['pre', 'exit']) {
    await fixture(
      {
        mode,
        tag: 'next',
        initialVersions: { 'sh-codemod': '0.1.1' },
        changesets: ['old-change'],
        compatible: { retained: true },
      },
      async (value) => {
        await legacyChanges(value.root, 'major');
        await writeFile(
          join(value.root, '.changeset/next-change.md'),
          '---\n"sh-codemod": minor\n---\nAn outstanding minor change.\n',
        );
        const before = await inventory(join(value.root, '.changeset'));
        await cp(value.root, value.oracle, { recursive: true });
        const packages = await getPackages(value.oracle);
        const settings = await readConfig(value.oracle, packages);
        assert.equal(settings.errors, undefined);
        const state = await readPreState(value.oracle);
        const changesets = await readChangesets(value.oracle);
        const oracle = assembleReleasePlan(
          changesets,
          packages,
          settings.config,
          state,
        );
        const expected =
          mode === 'pre'
            ? [
                {
                  name: 'sh-codemod',
                  type: 'minor',
                  oldVersion: '0.1.1',
                  changesets: ['next-change'],
                  newVersion: '0.2.0-next.0',
                },
              ]
            : [
                {
                  name: 'sh-codemod',
                  type: 'major',
                  oldVersion: '0.1.1',
                  changesets: ['next-change', 'pre/old-change'],
                  newVersion: '1.0.0',
                },
              ];
        assert.deepEqual(oracle.releases, expected);
        assert.notDeepEqual(
          await inventory(join(value.oracle, '.changeset')),
          before,
          'The independent reader actually migrated its own copy',
        );
        const projection = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `const { projectReleasePlan } = await import(${JSON.stringify(new URL('./release-plan.ts', import.meta.url).href)}); console.log(JSON.stringify((await projectReleasePlan(process.cwd())).releases));`,
          ],
          { cwd: value.root, encoding: 'utf8', env: environment(value) },
        );
        assert.equal(
          projection.status,
          0,
          projection.stdout + projection.stderr,
        );
        const releases: unknown = JSON.parse(projection.stdout);
        assert.deepEqual(releases, expected);
        const result = invoke(value);
        assert.equal(
          result.status,
          mode === 'pre' ? 0 : 1,
          result.stdout + result.stderr,
        );
        if (mode === 'exit') {
          assert.match(result.stderr, /sh-codemod.*1\.0\.0/su);
        }
        context.diagnostic(JSON.stringify({ mode, expected, result }));
        assert.deepEqual(
          await inventory(join(value.root, '.changeset')),
          before,
        );
        assert.deepEqual(await readdir(value.temporary), []);
      },
    );
  }
});

await test('reader and planner failures propagate and clean snapshots while leaving legacy source untouched', async (context) => {
  for (const failure of ['json', 'reader', 'config', 'planner']) {
    await fixture(
      {
        mode: 'pre',
        tag: 'next',
        initialVersions: { 'sh-codemod': '0.1.1' },
        changesets: ['old-change'],
      },
      async (value) => {
        await legacyChanges(value.root);
        if (failure === 'json') {
          await writeFile(join(value.root, '.changeset/pre.json'), '{');
        }
        if (failure === 'reader') {
          await writeFile(
            join(value.root, '.changeset/pre.json'),
            JSON.stringify({ mode: 'pre', tag: 'next', changesets: 42 }),
          );
        }
        if (failure === 'config') {
          await writeFile(
            join(value.root, '.changeset/config.json'),
            '{"fixed":"invalid"}',
          );
        }
        if (failure === 'planner') {
          await writeFile(
            join(value.root, '.changeset/next-change.md'),
            '---\n"unknown-package": patch\n---\nInvalid package relationship.\n',
          );
        }
        const before = await inventory(join(value.root, '.changeset'));
        const result = invoke(value);
        context.diagnostic(JSON.stringify({ failure, result }));
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.deepEqual(
          await inventory(join(value.root, '.changeset')),
          before,
        );
        assert.deepEqual(await readdir(value.temporary), []);
      },
    );
  }
});

await test('supported legacy field subsets and a real CLI exit version preserve ordinary source inputs', async (context) => {
  for (const legacy of [
    { initialVersions: { 'sh-codemod': '0.1.1' } },
    { changesets: ['old-change'] },
  ]) {
    await fixture({ mode: 'pre', tag: 'next', ...legacy }, async (value) => {
      await legacyChanges(value.root);
      const before = await inventory(join(value.root, '.changeset'));
      const result = invoke(value);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(await inventory(join(value.root, '.changeset')), before);
      assert.deepEqual(await readdir(value.temporary), []);
    });
  }
  await fixture(
    {
      mode: 'exit',
      tag: 'next',
      initialVersions: { 'sh-codemod': '0.1.1' },
      changesets: ['old-change'],
    },
    async (value) => {
      await legacyChanges(value.root);
      const before = await inventory(join(value.root, '.changeset'));
      await cp(value.root, value.oracle, { recursive: true });
      const cli = spawnSync(
        process.execPath,
        [
          new URL(import.meta.resolve('@changesets/cli/bin.js')).pathname,
          'version',
        ],
        { cwd: value.oracle, encoding: 'utf8' },
      );
      assert.equal(cli.status, 0, cli.stdout + cli.stderr);
      const versioned: unknown = JSON.parse(
        await readFile(join(value.oracle, 'package.json'), 'utf8'),
      );
      assert.ok(
        typeof versioned === 'object' &&
          versioned !== null &&
          'version' in versioned,
      );
      assert.equal(versioned.version, '0.2.0');
      const projection = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { projectReleasePlan } = await import(${JSON.stringify(new URL('./release-plan.ts', import.meta.url).href)}); console.log(JSON.stringify((await projectReleasePlan(process.cwd())).releases));`,
        ],
        { cwd: value.root, encoding: 'utf8', env: environment(value) },
      );
      assert.equal(projection.status, 0, projection.stdout + projection.stderr);
      const releases: unknown = JSON.parse(projection.stdout);
      assert.deepEqual(releases, [
        {
          name: 'sh-codemod',
          type: 'minor',
          oldVersion: '0.1.1',
          changesets: ['next-change', 'pre/old-change'],
          newVersion: '0.2.0',
        },
      ]);
      const result = invoke(value);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(await inventory(join(value.root, '.changeset')), before);
      assert.deepEqual(await readdir(value.temporary), []);
      context.diagnostic(
        JSON.stringify({
          cliCommand: [
            process.execPath,
            new URL(import.meta.resolve('@changesets/cli/bin.js')).pathname,
            'version',
          ],
          cliExit: cli.status,
          expectedVersion: '0.2.0',
          releases,
        }),
      );
    },
  );
});
