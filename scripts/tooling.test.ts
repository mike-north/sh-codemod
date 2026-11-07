/** Tooling contracts are exercised with invalid programs rather than config snapshots. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import type { Linter } from 'eslint';

/** Tool-owned JSON and ESLint's untyped config result need runtime shape checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Assert the semantic policy without trusting ESLint's untyped config return. */
function assertStrictConfig(config: unknown): void {
  assert.ok(isRecord(config) && isRecord(config.rules));
  const explicitAny: unknown =
    config.rules['@typescript-eslint/no-explicit-any'];
  assert.ok(Array.isArray(explicitAny));
  assert.equal(explicitAny[0], 2);
  assert.ok(isRecord(config.languageOptions));
  assert.ok(isRecord(config.languageOptions.parserOptions));
  assert.equal(config.languageOptions.parserOptions.projectService, true);
}

/** Use a configured source path so the real project service supplies type information. */
async function diagnostics(source: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(source, {
    filePath: 'scripts/check-release.ts',
  });
  assert.ok(result, 'ESLint must return a result for the supplied source');
  return result.messages;
}

await test('explicit any and unsafe use of untyped JSON fail lint', async () => {
  const messages = await diagnostics(
    'const value: any = JSON.parse("{}");\nconsole.log(value.field);\n',
  );
  for (const rule of [
    'no-explicit-any',
    'no-unsafe-assignment',
    'no-unsafe-member-access',
  ]) {
    assert.ok(
      messages.some(
        (message) => message.ruleId === `@typescript-eslint/${rule}`,
      ),
      rule,
    );
  }
});

await test('unsafe calls, arguments, returns, and narrowing assertions fail lint', async () => {
  const messages = await diagnostics(`
const value: unknown = JSON.parse("{}");
console.log(value as { name: string });
const parsed = JSON.parse("{}");
parsed();
function read() { return JSON.parse("{}"); }
function consume(input: string) { console.log(input); }
consume(parsed);
console.log(read());
`);
  for (const rule of [
    'no-unsafe-call',
    'no-unsafe-argument',
    'no-unsafe-return',
    'no-unsafe-type-assertion',
  ]) {
    assert.ok(
      messages.some(
        (message) => message.ruleId === `@typescript-eslint/${rule}`,
      ),
      rule,
    );
  }
});

await test('maintained TypeScript extensions receive strict rules', async () => {
  const eslint = new ESLint();
  for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
    const config: unknown = await eslint.calculateConfigForFile(
      `test/probe.${extension}`,
    );
    assertStrictConfig(config);
  }
});

await test('disable directives need their own descriptions and must be used', async () => {
  const messages = await diagnostics(
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst value: any = 1;\nconsole.log(value);\n',
  );
  assert.ok(
    messages.some(
      (message) =>
        message.ruleId ===
        '@eslint-community/eslint-comments/require-description',
    ),
  );
  const unused = await diagnostics(
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- A deliberate unused suppression.\nconst value: unknown = 1;\nconsole.log(value);\n',
  );
  assert.ok(
    unused.some(
      (message) =>
        message.severity === 2 &&
        (message.ruleId ===
          '@eslint-community/eslint-comments/no-unused-disable' ||
          message.message.includes('Unused eslint-disable directive')),
    ),
  );
});

await test('unknown narrowed before use passes without suppression', async () => {
  assert.deepEqual(
    await diagnostics(
      'const value: unknown = JSON.parse("1");\nif (typeof value === "number") { console.log(value + 1); }\n',
    ),
    [],
  );
});

/** Temporary workspaces exercise the same compiler and CLIs that CI invokes. */
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/tooling-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test('implicit any fails type checking', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve('tsconfig.json'),
        include: ['index.ts'],
      }),
    );
    await writeFile(
      join(root, 'index.ts'),
      'export function identity(value) { return value; }\n',
    );
    const result = spawnSync(
      resolve('node_modules/.bin/tsc'),
      ['--project', root, '--noEmit'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /implicitly has an 'any' type/);
  });
});

await test('maintained JavaScript is rejected rather than omitted from strict policy', async () => {
  const eslint = new ESLint();
  for (const extension of ['js', 'mjs', 'cjs']) {
    const [result] = await eslint.lintText("console.log('untyped logic');\n", {
      filePath: `scripts/probe.${extension}`,
    });
    assert.ok(result);
    assert.ok(
      result.messages.some(
        (message) =>
          message.ruleId === 'no-restricted-syntax' &&
          message.message.includes('TypeScript'),
      ),
    );
  }
});

await test('the real compiler project covers every maintained TypeScript source and fixture', async () => {
  const ts = await import('typescript');
  const project = ts.getParsedCommandLineOfConfigFile(
    resolve('tsconfig.check.json'),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        );
      },
    },
  );
  assert.ok(project);
  const files = new Set(project.fileNames.map((path) => resolve(path)));
  const maintained = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  );
  assert.equal(maintained.status, 0, maintained.stderr);
  const sources = maintained.stdout
    .split('\0')
    .filter((path) => /\.(?:ts|mts|cts)$/u.test(path));
  assert.ok(
    sources.length > 20,
    'coverage must include actual runtime and tooling sources',
  );
  for (const path of sources) {
    assert.ok(files.has(resolve(path)), `Missing compiler coverage: ${path}`);
  }
});

await test('the maintained script project refuses an implicit-any helper at the actual root check boundary', async () => {
  const path = resolve('scripts/tooling-coverage-negative.ts');
  try {
    await writeFile(path, 'export function probe(value) { return value; }\n', {
      flag: 'wx',
    });
    const result = spawnSync('pnpm', ['check:types'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout + result.stderr,
      /tooling-coverage-negative\.ts.*TS7006/s,
    );
  } finally {
    await rm(path, { force: true });
  }
});

await test('singleton syncpack detects actual dependency-version disagreement', async () => {
  const { copyFile } = await import('node:fs/promises');
  await fixture(async (root) => {
    await copyFile('.syncpackrc.json', join(root, '.syncpackrc.json'));
    const path = join(root, 'package.json');
    const lint = () =>
      spawnSync(resolve('node_modules/.bin/syncpack'), ['lint'], {
        cwd: root,
        encoding: 'utf8',
      });
    await writeFile(
      path,
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0',
        dependencies: { typescript: '6.0.3' },
        devDependencies: { typescript: '6.0.2' },
      }),
    );
    assert.equal(lint().status, 1);
    await writeFile(
      path,
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0',
        dependencies: { typescript: '6.0.3' },
        devDependencies: { typescript: '6.0.3' },
      }),
    );
    const valid = lint();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  });
});

await test('singleton Knip refuses unused dependencies and unreferenced maintained files', async () => {
  const { copyFile } = await import('node:fs/promises');
  await fixture(async (root) => {
    await mkdir(join(root, 'src'));
    await copyFile('knip.json', join(root, 'knip.json'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        version: '0.1.0',
        type: 'module',
        dependencies: { yaml: '2.8.3' },
      }),
    );
    const lint = () =>
      spawnSync(resolve('node_modules/.bin/knip'), ['--no-progress'], {
        cwd: root,
        encoding: 'utf8',
      });
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1;\n');
    const unusedDependency = lint();
    assert.equal(
      unusedDependency.status,
      1,
      unusedDependency.stdout + unusedDependency.stderr,
    );
    assert.match(unusedDependency.stdout, /yaml/);
    await writeFile(
      join(root, 'src/index.ts'),
      "import { parse } from 'yaml';\nexport const value = parse('1');\n",
    );
    const valid = lint();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    await writeFile(join(root, 'src/unused.ts'), 'export const unused = 1;\n');
    const unusedFile = lint();
    assert.equal(unusedFile.status, 1, unusedFile.stdout + unusedFile.stderr);
    assert.match(unusedFile.stdout, /src\/unused\.ts/);
  });
});
