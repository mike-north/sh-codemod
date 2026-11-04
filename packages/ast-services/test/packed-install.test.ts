/**
 * Packed-install test for criterion 7 of https://github.com/mike-north/eslint-sh/issues/180:
 * `format` runs from the published tarball in both an ESM and a CommonJS consumer, and a
 * TypeScript consumer resolves the matching declarations through each `exports` condition.
 *
 * This is a real pipeline: `pnpm pack` the package, `pnpm install` the tarball into a fresh
 * project, then run consumer files with Node and type-check them with `tsc`. Nothing from the
 * checkout is reachable except through the installed tarball.
 *
 * `--ignore-scripts` skips `prepack`; the declaration rollup and its `.d.cts` copy are produced
 * beforehand by `build`, which the Nx `test` target depends on.
 *
 * @see https://pnpm.io/cli/pack — `--json` output shape
 * @see https://nodejs.org/api/packages.html#conditional-exports — `import` and `require`
 * @see https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require — CJS loading ESM
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = join(packageDir, '..', '..');

/**
 * Each consumer formats the same hand-checked input and reports the result, the error class a
 * syntax error produces, and that error's position.
 */
const REPORT = `{
  formatted: format('if true;then\\n  echo   "日本語"  # c\\nfi\\n'),
  errorName: syntaxError.name,
  errorIsInstance: syntaxError instanceof FormatSyntaxError,
  errorLine: syntaxError.line,
  errorColumn: syntaxError.column,
}`;

const SYNTAX_ERROR = `(() => {
    try {
      format('echo ok\\necho "open');
    } catch (error) {
      return error;
    }
    throw new Error('no error thrown');
  })()`;

const ESM_CONSUMER = `import { format, FormatSyntaxError } from '@eslint-sh/ast-services';
const syntaxError = ${SYNTAX_ERROR};
console.log(JSON.stringify(${REPORT}));
`;

const CJS_CONSUMER = `const { format, FormatSyntaxError } = require('@eslint-sh/ast-services');
const syntaxError = ${SYNTAX_ERROR};
console.log(JSON.stringify(${REPORT}));
`;

/** Type-only consumers: one per module system, each using a value and a type from the package. */
const ESM_TYPES = `import { format, FormatSyntaxError, type FormatOptions } from '@eslint-sh/ast-services';
export const options: FormatOptions = { Indent: 2, Variant: 2, Filename: 'a.sh' };
export const text: string = format('echo hi', options);
export const line: number = new Error() instanceof FormatSyntaxError ? 1 : 0;
`;

const CJS_TYPES = `import services = require('@eslint-sh/ast-services');
export const options: services.FormatOptions = { SwitchCaseIndent: true };
export const text: string = services.format('echo hi', options);
export const code: 'ESLINT_SH_FORMAT_SYNTAX' | undefined = undefined as services.FormatSyntaxError['code'] | undefined;
`;

/** The expected report: formatted by hand with mvdan/sh's rules (tab indent, one space). */
const EXPECTED_REPORT = {
  formatted: 'if true; then\n\techo "日本語" # c\nfi\n',
  errorName: 'FormatSyntaxError',
  errorIsInstance: true,
  errorLine: 2,
  errorColumn: 6,
};

/** Packs the package with pnpm into `destination` and returns the tarball path. */
function pnpmPack(destination: string): string {
  const stdout = execFileSync(
    'pnpm',
    ['pack', '--json', '--pack-destination', destination, '--config.ignore-scripts=true'],
    { cwd: packageDir, encoding: 'utf8' },
  );
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`pnpm pack --json produced no JSON object:\n${stdout}`);
  }
  return (JSON.parse(stdout.slice(jsonStart)) as { filename: string }).filename;
}

/** The workspace's own release-age exclusions, so the install applies the same policy. */
function workspaceReleaseAgeExclusions(): string {
  const workspace = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
  return /^minimumReleaseAgeExclude:\n(?: {2}- .*\n)+/m.exec(workspace)?.[0] ?? '';
}

/** Runs one consumer file with Node inside the installed project and parses its report. */
function runConsumer(projectDir: string, file: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [file], { cwd: projectDir, encoding: 'utf8' }),
  ) as unknown;
}

/** Writes a strict `nodenext` project that checks one consumer file, and returns its name. */
function writeTypeProject(projectDir: string, file: string): string {
  const name = `tsconfig.${file}.json`;
  writeFileSync(
    join(projectDir, name),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2022',
        types: [],
      },
      files: [file],
    }),
  );
  return name;
}

/** Type-checks one consumer file under `nodenext`, returning tsc's exit status and output. */
function typeCheck(projectDir: string, file: string): { status: number | null; output: string } {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', writeTypeProject(projectDir, file)], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

let scratchDir: string;
let projectDir: string;

describe('packed install (issue #180, criterion 7)', () => {
  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'ast-services-install-'));
    const packsDir = join(scratchDir, 'packs');
    projectDir = join(scratchDir, 'project');
    mkdirSync(packsDir);
    mkdirSync(projectDir);

    const tarball = pnpmPack(packsDir);
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'ast-services-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { '@eslint-sh/ast-services': `file:${tarball}` },
      }),
    );
    writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceReleaseAgeExclusions());
    writeFileSync(join(projectDir, 'consumer.mjs'), ESM_CONSUMER);
    writeFileSync(join(projectDir, 'consumer.cjs'), CJS_CONSUMER);
    writeFileSync(join(projectDir, 'types-esm.mts'), ESM_TYPES);
    writeFileSync(join(projectDir, 'types-cjs.cts'), CJS_TYPES);

    execFileSync('pnpm', ['install', '--no-frozen-lockfile'], {
      cwd: projectDir,
      encoding: 'utf8',
    });
  }, 240_000);

  afterAll(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('formats from an ESM consumer', () => {
    expect(runConsumer(projectDir, 'consumer.mjs')).toEqual(EXPECTED_REPORT);
  });

  it('formats from a CommonJS consumer', () => {
    expect(runConsumer(projectDir, 'consumer.cjs')).toEqual(EXPECTED_REPORT);
  });

  it('ships no source maps, since the sources they point at are not packed', () => {
    const packageRoot = join(projectDir, 'node_modules', '@eslint-sh', 'ast-services');
    const files = readdirSync(join(packageRoot, 'dist'), { recursive: true, encoding: 'utf8' });
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    const entry = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');
    expect(entry).not.toContain('sourceMappingURL');
  });

  it('exposes ./package.json through exports', () => {
    const resolved = createRequire(join(projectDir, 'consumer.cjs')).resolve(
      '@eslint-sh/ast-services/package.json',
    );
    expect((JSON.parse(readFileSync(resolved, 'utf8')) as { name: string }).name).toBe(
      '@eslint-sh/ast-services',
    );
  });

  it('resolves declarations for an ESM TypeScript consumer', () => {
    const { status, output } = typeCheck(projectDir, 'types-esm.mts');
    expect(output).toBe('');
    expect(status).toBe(0);
  }, 60_000);

  it('resolves declarations for a CommonJS TypeScript consumer', () => {
    const { status, output } = typeCheck(projectDir, 'types-cjs.cts');
    expect(output).toBe('');
    expect(status).toBe(0);
  }, 60_000);
});
