/** Release policy tests use real files and the installed Changesets planner. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Every failure must explain the version boundary and the absence of a bypass. */
const policy =
  /This project stays in the 0\.x series\. There is no override flag\./;
const gate = resolve('scripts/check-release.ts');
/**
 * The repository's GitHub changelog generator needs a network token; fixtures keep every other
 * setting but use the CLI's offline generator so `changeset version` runs hermetically.
 */
const config = (await readFile('.changeset/config.json', 'utf8')).replace(
  /"changelog": \[[^\]]*\]/u,
  '"changelog": "@changesets/cli/changelog"',
);
assert.match(config, /@changesets\/cli\/changelog/u);

/** Isolate fixture writes inside this worktree and remove them even on failure. */
async function fixture(
  version: string,
  bump: string | undefined,
  run: (root: string) => Promise<void> | void,
): Promise<void> {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/release-gates-'));
  try {
    await mkdir(join(root, '.changeset'));
    await mkdir(join(root, 'packages/example'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '0.0.0', private: true }),
    );
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    await writeFile(join(root, '.changeset/config.json'), config);
    await writeFile(
      join(root, 'packages/example/package.json'),
      JSON.stringify({ name: 'example', version }),
    );
    if (bump !== undefined) {
      await writeFile(
        join(root, '.changeset/change.md'),
        `---\n"example": ${bump}\n---\nA deliberate behavior change.\n`,
      );
    }
    git(root, ['init', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'Fixture baseline']);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Git history belongs to each fixture; no test may consult the enclosing worktree. */
function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mike North',
      GIT_AUTHOR_EMAIL: 'michael.l.north@gmail.com',
      GIT_COMMITTER_NAME: 'Mike North',
      GIT_COMMITTER_EMAIL: 'michael.l.north@gmail.com',
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

/** Installed release tooling supplies the independent oracle for fixture outcomes. */
function changeset(
  root: string,
  args: readonly string[],
  fails = false,
): string {
  const result = spawnSync(
    process.execPath,
    [new URL(import.meta.resolve('@changesets/cli/bin.js')).pathname, ...args],
    { cwd: root, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, fails ? 1 : 0, output);
  return output;
}

/** Exercise the same process exit and diagnostics that CI relies on. */
function check(root: string, mode: string, fails: boolean): string {
  const result = spawnSync(process.execPath, [gate, mode], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, fails ? 1 : 0, output);
  if (fails) {
    assert.match(output, policy);
  }
  return output;
}

await test('The changeset check rejects a major changeset', async () => {
  await fixture('0.2.0', 'major', (root) => {
    check(root, 'changesets', true);
  });
});

await test('the version check rejects existing 1.0.0 and later versions, including prereleases', async () => {
  for (const version of ['1.0.0', '2.3.0', '1.0.0-beta.1']) {
    await fixture(version, undefined, (root) => {
      check(root, 'versions', true);
    });
  }
});

await test('the version check rejects the real Changesets projection from 0.x to 1.0.0', async () => {
  await fixture('0.2.0', 'major', (root) => {
    assert.match(check(root, 'versions', true), /1\.0\.0/);
  });
});

await test('a 0.x manifest and minor changeset pass both gates', async () => {
  await fixture('0.2.0', 'minor', (root) => {
    check(root, 'changesets', false);
    check(root, 'versions', false);
  });
});

await test('The changeset check checks nested changesets and quoted bumps', async () => {
  await fixture('0.2.0', undefined, async (root) => {
    await mkdir(join(root, '.changeset/nested'));
    await writeFile(
      join(root, '.changeset/nested/major.md'),
      "---\n'example': 'major' # breaking\n---\nChange.\n",
    );
    check(root, 'changesets', true);
  });
});

await test('The changeset check accepts empty changesets and does not mistake prose for a bump', async () => {
  await fixture('0.2.0', 'minor', async (root) => {
    await writeFile(
      join(root, '.changeset/empty.md'),
      '---\n---\nexample: major\n',
    );
    check(root, 'changesets', false);
  });
});

await test('The changeset check fails closed on malformed frontmatter', async () => {
  await fixture('0.2.0', 'unknown', (root) => {
    check(root, 'changesets', true);
  });
});

await test('the version check checks publishable manifests outside workspace globs', async () => {
  await fixture('0.2.0', undefined, async (root) => {
    await mkdir(join(root, 'tools'));
    await writeFile(
      join(root, 'tools/package.json'),
      '{"name":"tool","version":"1.0.0"}',
    );
    check(root, 'versions', true);
  });
});

/** Publication eligibility never grants an exception to the version boundary. */
const manifestLocations: readonly string[] = [
  'package.json',
  'packages/example/package.json',
  'tools/package.json',
];
const privacyStates: readonly boolean[] = [false];

for (const location of manifestLocations) {
  for (const privatePackage of privacyStates) {
    await test(`the version check rejects non-0.x or invalid versions at ${location}, private=${String(privatePackage)}`, async () => {
      for (const version of [
        '1.0.0',
        '5.0.0',
        '1.0.0-beta.1',
        'invalid',
        undefined,
      ]) {
        await fixture('0.2.0', undefined, async (root) => {
          const path = join(root, location);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(
            path,
            JSON.stringify({
              name: location === 'package.json' ? 'fixture' : 'example',
              version,
              private: privatePackage,
            }),
          );
          const output = check(root, 'versions', true);
          assert.ok(output.includes(path), output);
        });
      }
    });
  }
}

await test('the version check accepts valid 0.x private and publishable manifests, including the root', async () => {
  for (const location of manifestLocations) {
    for (const privatePackage of privacyStates) {
      await fixture('0.2.0', 'minor', async (root) => {
        const path = join(root, location);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          JSON.stringify({
            name: location === 'package.json' ? 'fixture' : 'example',
            version: '0.2.0',
            private: privatePackage,
          }),
        );
        check(root, 'changesets', false);
        check(root, 'versions', false);
      });
    }
  }
});

await test('the version check fails closed for invalid versions and planner errors', async () => {
  await fixture('invalid', undefined, (root) => {
    check(root, 'versions', true);
  });
  await fixture('0.2.0', 'unknown', (root) => {
    check(root, 'versions', true);
  });
});

await test('the version command produces a 0.x version and changelog', async () => {
  await fixture('0.2.0', 'minor', async (root) => {
    check(root, 'changesets', false);
    check(root, 'versions', false);
    const result = spawnSync(
      process.execPath,
      [
        new URL(import.meta.resolve('@changesets/cli/bin.js')).pathname,
        'version',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // Parsed metadata is untrusted until its structure has been checked.
    const manifest: unknown = JSON.parse(
      await readFile(join(root, 'packages/example/package.json'), 'utf8'),
    );
    assert.ok(
      typeof manifest === 'object' &&
        manifest !== null &&
        'version' in manifest,
    );
    assert.equal(manifest.version, '0.3.0');
    assert.match(
      await readFile(join(root, 'packages/example/CHANGELOG.md'), 'utf8'),
      /0\.3\.0/,
    );
    check(root, 'versions', false);
  });
});

await test('The changeset check accepts the installed CLI empty changeset and major prose', async () => {
  await fixture('0.8.0', undefined, async (root) => {
    changeset(root, ['add', '--empty']);
    const name = (await readdir(join(root, '.changeset'))).find((name) =>
      name.endsWith('.md'),
    );
    assert.ok(name);
    const path = join(root, '.changeset', name);
    assert.equal(await readFile(path, 'utf8'), '---\n---\n');
    check(root, 'changesets', false);
    await writeFile(path, '---\n---\nexample: major\n');
    check(root, 'changesets', false);
    await writeFile(path, '---\n"example": major\n---\n');
    assert.match(
      check(root, 'changesets', true),
      /Major changeset is forbidden/,
    );
  });
});

await test('the version check validates complete SemVer independently of the major boundary', async () => {
  for (const version of [
    '0.8.0-rc..1',
    '0.8.0-01',
    '0.08.0',
    '0.8.00',
    '0.8.0-',
    '0.8.0+',
    '0.8.0+a..b',
    '0.8.0-rc_1',
  ]) {
    await fixture(version, undefined, (root) => {
      assert.match(
        check(root, 'versions', true),
        /must have a valid 0.x version/,
      );
    });
  }
  for (const version of [
    '0.8.0-rc.1',
    '0.8.0-0',
    '0.8.0-01a',
    '0.8.0+01.build',
    '0.8.0-rc.1+build.2',
  ]) {
    await fixture(version, undefined, (root) => {
      changeset(root, ['status', '--output=plan.json']);
      check(root, 'versions', false);
    });
  }
});

await test('the version check accepts a shallow detached checkout without main history', async () => {
  await fixture('0.8.0', undefined, (root) => {
    const clone = join(root, 'checkout');
    git(root, ['clone', '--depth=1', '--no-local', `file://${root}`, clone]);
    git(clone, ['checkout', '--detach']);
    git(clone, ['update-ref', '-d', 'refs/heads/main']);
    git(clone, ['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.equal(
      git(clone, ['rev-parse', '--is-shallow-repository']).trim(),
      'true',
    );
    assert.match(
      changeset(clone, ['status', '--output=plan.json'], true),
      /main|diverged/i,
    );
    check(clone, 'versions', false);
  });
});

await test('the version check accepts an empty next plan after Version Packages consumes changesets', async () => {
  await fixture('0.8.0', 'minor', async (root) => {
    git(root, ['checkout', '-b', 'version-packages']);
    changeset(root, ['status', '--output=before.json']);
    changeset(root, ['version']);
    git(root, ['add', 'packages', '.changeset']);
    git(root, ['commit', '-m', 'Apply package versions']);
    assert.match(
      changeset(root, ['status', '--output=after.json'], true),
      /no changesets were found/,
    );
    const manifest: unknown = JSON.parse(
      await readFile(join(root, 'packages/example/package.json'), 'utf8'),
    );
    assert.ok(
      typeof manifest === 'object' &&
        manifest !== null &&
        'version' in manifest,
    );
    assert.equal(manifest.version, '0.9.0');
    check(root, 'versions', false);
  });
});

await test('the version check agrees with installed status and version for fixed, dependency, and prerelease plans', async () => {
  for (const prerelease of [false, true]) {
    await fixture('0.8.0', 'minor', async (root) => {
      await mkdir(join(root, 'packages/dependent'));
      await writeFile(
        join(root, 'packages/dependent/package.json'),
        JSON.stringify({
          name: 'dependent',
          version: '0.7.0',
          dependencies: { example: 'workspace:^' },
        }),
      );
      const settings: unknown = JSON.parse(config);
      assert.ok(typeof settings === 'object' && settings !== null);
      await writeFile(
        join(root, '.changeset/config.json'),
        JSON.stringify({ ...settings, fixed: [['example', 'dependent']] }),
      );
      if (prerelease) {
        changeset(root, ['pre', 'enter', 'next']);
      }
      changeset(root, ['status', '--output=oracle.json']);
      const plan: unknown = JSON.parse(
        await readFile(join(root, 'oracle.json'), 'utf8'),
      );
      assert.ok(
        typeof plan === 'object' &&
          plan !== null &&
          'releases' in plan &&
          Array.isArray(plan.releases),
      );
      assert.equal(plan.releases.length, 2);
      for (const entry of plan.releases) {
        const release: unknown = entry;
        assert.ok(
          typeof release === 'object' &&
            release !== null &&
            'newVersion' in release,
        );
        assert.equal(release.newVersion, prerelease ? '0.9.0-next.0' : '0.9.0');
      }
      check(root, 'versions', false);
      changeset(root, ['version']);
      for (const name of ['example', 'dependent']) {
        const manifest: unknown = JSON.parse(
          await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
        );
        assert.ok(
          typeof manifest === 'object' &&
            manifest !== null &&
            'version' in manifest,
        );
        assert.equal(manifest.version, prerelease ? '0.9.0-next.0' : '0.9.0');
      }
    });
  }
});

await test('the version check preserves dependency-only propagation and fails closed on invalid config', async () => {
  await fixture('0.8.0', 'minor', async (root) => {
    await mkdir(join(root, 'packages/dependent'));
    await writeFile(
      join(root, 'packages/dependent/package.json'),
      JSON.stringify({
        name: 'dependent',
        version: '0.7.0',
        dependencies: { example: '0.8.0' },
      }),
    );
    changeset(root, ['status', '--output=oracle.json']);
    const plan: unknown = JSON.parse(
      await readFile(join(root, 'oracle.json'), 'utf8'),
    );
    assert.ok(
      typeof plan === 'object' &&
        plan !== null &&
        'releases' in plan &&
        Array.isArray(plan.releases),
    );
    assert.equal(plan.releases.length, 2);
    for (const entry of plan.releases) {
      const release: unknown = entry;
      assert.ok(
        typeof release === 'object' &&
          release !== null &&
          'name' in release &&
          'newVersion' in release,
      );
      assert.equal(
        release.newVersion,
        release.name === 'example' ? '0.9.0' : '0.7.1',
      );
    }
    check(root, 'versions', false);
    await writeFile(
      join(root, '.changeset/config.json'),
      '{"fixed": "invalid"}',
    );
    assert.match(check(root, 'versions', true), /Invalid Changesets config/);
  });
});

/** Persisted fixture metadata is untrusted until its object shape is established. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

await test('the CLI and direct dependency resolve the identical installed planner source', async (context) => {
  const cliPackagePath = fileURLToPath(
    import.meta.resolve('@changesets/cli/package.json'),
  );
  const cliOrigin = join(dirname(cliPackagePath), 'dist/status.mjs');
  // Resolve from the actual status module's origin, rather than assuming root hoisting.
  const fromCli = createRequire(cliOrigin);
  const cliPlanner = await realpath(
    fromCli.resolve('@changesets/assemble-release-plan'),
  );
  const directPlanner = await realpath(
    fileURLToPath(import.meta.resolve('@changesets/assemble-release-plan')),
  );
  assert.equal(cliPlanner, directPlanner);
  const cliPlannerPackagePath = await realpath(
    fromCli.resolve('@changesets/assemble-release-plan/package.json'),
  );
  const directPlannerPackagePath = await realpath(
    fileURLToPath(
      import.meta.resolve('@changesets/assemble-release-plan/package.json'),
    ),
  );
  assert.equal(cliPlannerPackagePath, directPlannerPackagePath);
  const cliManifest: unknown = JSON.parse(
    await readFile(cliPackagePath, 'utf8'),
  );
  const plannerManifest: unknown = JSON.parse(
    await readFile(cliPlannerPackagePath, 'utf8'),
  );
  assert.ok(isRecord(cliManifest) && isRecord(plannerManifest));
  assert.equal(cliManifest.version, '3.0.3');
  assert.equal(plannerManifest.version, '7.0.0');
  const cliSource = await readFile(cliPlanner);
  const directSource = await readFile(directPlanner);
  const cliHash = createHash('sha256').update(cliSource).digest('hex');
  const directHash = createHash('sha256').update(directSource).digest('hex');
  assert.equal(cliHash, directHash);
  assert.match(
    await readFile(cliOrigin, 'utf8'),
    /import \{ assembleReleasePlan \} from "@changesets\/assemble-release-plan"/,
  );
  context.diagnostic(
    `Planner identity: ${JSON.stringify({ cliPackagePath, cliVersion: cliManifest.version, cliOrigin, cliPlanner, directPlanner, cliPlannerPackagePath, directPlannerPackagePath, plannerVersion: plannerManifest.version, cliHash, directHash })}`,
  );
});

await test('the version check names a dependent reaching 1.0.0 through an explicit major intent', async (context) => {
  await fixture('0.8.0', 'minor', async (root) => {
    await mkdir(join(root, 'packages/dependent'));
    await writeFile(
      join(root, 'packages/dependent/package.json'),
      JSON.stringify({
        name: 'dependent',
        version: '0.3.0',
        peerDependencies: { example: '^0.8.0' },
      }),
    );
    // This is a distinct boundary case: the major is explicit, not dependency-inferred.
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"example": minor\n"dependent": major\n---\nChange both contracts.\n',
    );
    changeset(root, ['status', '--output=oracle.json']);
    const plan: unknown = JSON.parse(
      await readFile(join(root, 'oracle.json'), 'utf8'),
    );
    assert.ok(
      typeof plan === 'object' &&
        plan !== null &&
        'releases' in plan &&
        Array.isArray(plan.releases),
    );
    assert.equal(plan.releases.length, 2);
    const releases: readonly unknown[] = plan.releases;
    const [source, dependent] = releases;
    assert.ok(
      typeof source === 'object' &&
        source !== null &&
        'name' in source &&
        'newVersion' in source,
    );
    assert.equal(source.name, 'example');
    assert.equal(source.newVersion, '0.9.0');
    assert.ok(
      typeof dependent === 'object' &&
        dependent !== null &&
        'name' in dependent &&
        'newVersion' in dependent,
    );
    assert.equal(dependent.name, 'dependent');
    assert.equal(dependent.newVersion, '1.0.0');
    context.diagnostic(`Explicit-major CLI oracle: ${JSON.stringify(plan)}`);
    check(root, 'changesets', true);
    assert.match(
      check(root, 'versions', true),
      /Projected version for dependent must have a valid 0\.x version; found 1\.0\.0/,
    );
  });
});

await test('the version check rejects whitespace and trailing line terminators in manifest versions', async () => {
  for (const version of [
    '0.8.0\n',
    '0.8.0\r\n',
    '0.8.0\u2028',
    ' 0.8.0',
    '0.8.0 ',
  ]) {
    await fixture(version, undefined, (root) => {
      assert.match(
        check(root, 'versions', true),
        /must have a valid 0.x version/,
      );
    });
  }
});

await test('private source metadata alone is exempt while every planned private release is checked', async () => {
  await fixture('0.8.0', undefined, async (root) => {
    await mkdir(join(root, 'metadata'));
    await writeFile(
      join(root, 'metadata/package.json'),
      JSON.stringify({ name: 'metadata', private: true, version: '2.0.0' }),
    );
    check(root, 'versions', false);
    await writeFile(
      join(root, '.changeset/config.json'),
      JSON.stringify({
        ...JSON.parse(config),
        privatePackages: { version: true, tag: false },
      }),
    );
    const path = join(root, 'packages/example/package.json');
    await writeFile(
      path,
      JSON.stringify({ name: 'example', private: true, version: '0.8.0' }),
    );
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"example": major\n---\nChange private contract.\n',
    );
    assert.match(check(root, 'versions', true), /example.*1\.0\.0/s);
  });
});

await test('the public singleton root actually participates in the version plan', async () => {
  await fixture('0.8.0', undefined, async (root) => {
    await rm(join(root, 'packages'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'sh-codemod', version: '0.1.1' }),
    );
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n');
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"sh-codemod": major\n---\nRoot API change.\n',
    );
    assert.match(check(root, 'versions', true), /sh-codemod.*1\.0\.0/s);
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"sh-codemod": minor\n---\nRoot API change.\n',
    );
    check(root, 'versions', false);
  });
});

await test('missing config and malformed prerelease inputs fail closed', async () => {
  await fixture('0.8.0', undefined, async (root) => {
    const path = join(root, '.changeset/config.json');
    await rm(path);
    check(root, 'versions', true);
    await writeFile(path, config);
    await writeFile(join(root, '.changeset/pre.json'), '{');
    check(root, 'versions', true);
  });
});

await test('The changeset check accepts supported type-none intent while the version check checks actual inferred private type-none versions', async (context) => {
  await fixture('0.8.0', 'minor', async (root) => {
    for (const [name, version] of [
      ['private-a', '1.0.0'],
      ['private-b', '2.0.0'],
    ] as const) {
      await mkdir(join(root, 'packages', name));
      await writeFile(
        join(root, 'packages', name, 'package.json'),
        JSON.stringify({
          name,
          version,
          private: true,
          devDependencies: { example: '0.8.0' },
        }),
      );
    }
    changeset(root, ['status', '--output=oracle.json']);
    const plan: unknown = JSON.parse(
      await readFile(join(root, 'oracle.json'), 'utf8'),
    );
    assert.ok(isRecord(plan) && Array.isArray(plan.releases));
    assert.deepEqual(plan.releases, [
      {
        name: 'example',
        type: 'minor',
        oldVersion: '0.8.0',
        changesets: ['change'],
        newVersion: '0.9.0',
      },
      {
        name: 'private-a',
        type: 'none',
        oldVersion: '1.0.0',
        changesets: [],
        newVersion: '1.0.0',
      },
      {
        name: 'private-b',
        type: 'none',
        oldVersion: '2.0.0',
        changesets: [],
        newVersion: '2.0.0',
      },
    ]);
    assert.match(
      check(root, 'versions', true),
      /private-a.*1\.0\.0.*private-b.*2\.0\.0/s,
    );
    context.diagnostic(
      `Actual private/inferred/type-none CLI oracle: ${JSON.stringify(plan.releases)}`,
    );
    await rm(join(root, '.changeset/change.md'));
    check(root, 'versions', false);
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"example": none\n---\nNo version change.\n',
    );
    check(root, 'changesets', false);
  });
});

await test('linked releases match handwritten CLI versions and preserve full plan order', async () => {
  await fixture('0.8.0', 'minor', async (root) => {
    await mkdir(join(root, 'packages/dependent'));
    await writeFile(
      join(root, 'packages/dependent/package.json'),
      JSON.stringify({
        name: 'dependent',
        version: '0.7.0',
        peerDependencies: { example: '^0.8.0' },
      }),
    );
    const settings: unknown = JSON.parse(config);
    assert.ok(isRecord(settings));
    await writeFile(
      join(root, '.changeset/config.json'),
      JSON.stringify({ ...settings, linked: [['example', 'dependent']] }),
    );
    await writeFile(
      join(root, '.changeset/change.md'),
      '---\n"example": minor\n"dependent": patch\n---\nBoth linked contracts.\n',
    );
    changeset(root, ['status', '--output=oracle.json']);
    const plan: unknown = JSON.parse(
      await readFile(join(root, 'oracle.json'), 'utf8'),
    );
    assert.ok(isRecord(plan) && Array.isArray(plan.releases));
    assert.deepEqual(plan.releases, [
      {
        name: 'example',
        type: 'minor',
        oldVersion: '0.8.0',
        changesets: ['change'],
        newVersion: '0.9.0',
      },
      {
        name: 'dependent',
        type: 'minor',
        oldVersion: '0.8.0',
        changesets: ['change'],
        newVersion: '0.9.0',
      },
    ]);
    check(root, 'versions', false);
    changeset(root, ['version']);
    for (const name of ['example', 'dependent']) {
      const manifest: unknown = JSON.parse(
        await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
      );
      assert.ok(isRecord(manifest));
      assert.equal(manifest.version, '0.9.0');
    }
  });
});

await test('the complete direct planner stack resolves to the same installed modules as CLI 3.0.3', async (context) => {
  const cliOrigin = join(
    dirname(fileURLToPath(import.meta.resolve('@changesets/cli/package.json'))),
    'dist/status.mjs',
  );
  const fromCli = createRequire(cliOrigin);
  for (const [name, version] of [
    ['@changesets/assemble-release-plan', '7.0.0'],
    ['@changesets/config', '4.0.1'],
    ['@changesets/pre', '3.0.0'],
    ['@changesets/read', '1.0.1'],
    ['@manypkg/get-packages', '3.1.0'],
  ] as const) {
    const direct = await realpath(fileURLToPath(import.meta.resolve(name)));
    assert.equal(await realpath(fromCli.resolve(name)), direct);
    const manifest: unknown = JSON.parse(
      await readFile(fromCli.resolve(`${name}/package.json`), 'utf8'),
    );
    assert.ok(isRecord(manifest));
    assert.equal(manifest.version, version);
    context.diagnostic(
      `${name}@${version}: ${direct}; sha256 ${createHash('sha256')
        .update(await readFile(direct))
        .digest('hex')}`,
    );
  }
  const fromReader = createRequire(fromCli.resolve('@changesets/read'));
  assert.equal(
    await realpath(fromReader.resolve('@changesets/parse')),
    await realpath(fileURLToPath(import.meta.resolve('@changesets/parse'))),
  );
});

/**
 * The repository states its private-package policy instead of inheriting the Changesets default:
 * private packages are neither versioned nor tagged, so a changed default cannot alter releases.
 */
await test('the changeset configuration pins private packages as neither versioned nor tagged', () => {
  const written: unknown = JSON.parse(config);
  assert.ok(
    typeof written === 'object' &&
      written !== null &&
      'privatePackages' in written,
    'privatePackages must be written explicitly',
  );
  assert.deepEqual(written.privatePackages, {
    version: false,
    tag: false,
  });
});
