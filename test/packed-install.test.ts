/**
 * Packed-install test for criterion 7 of https://github.com/mike-north/eslint-sh/issues/180:
 * `format` runs from the published tarball in both an ESM and a CommonJS consumer, and a
 * TypeScript consumer resolves the matching declarations through each `exports` condition.
 *
 * This is a real pipeline: `pnpm pack` the package, `pnpm install` the tarball into a fresh
 * project, then run consumer files with Node and type-check them with `tsc`. Nothing from the
 * checkout is reachable except through the installed tarball.
 *
 * The real prepack rebuilds declarations and both module formats, removing stale outputs first.
 *
 * @see https://pnpm.io/cli/pack — `--json` output shape
 * @see https://nodejs.org/api/packages.html#conditional-exports — `import` and `require`
 * @see https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require — CJS loading ESM
 */
import { record } from './assertions.js';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Locate this package independently of the test runner's cwd. */
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  errorFilename: syntaxError.filename,
  dialectFormatted: format('a=(one two)\\n', { dialect: LangBash, filename: 'array.sh' }),
  editorText: createEditor('echo 日本語\\n', { dialect: LangPOSIX, filename: 'editor.sh' }).apply(),
  removedCode: (() => { try { format('echo ok', { Variant: 2 }); } catch (error) { return error.code; } })(),
}`;

const SYNTAX_ERROR = `(() => {
    try {
      format('echo ok\\necho "open', { filename: '日本語.sh' });
    } catch (error) {
      return error;
    }
    throw new Error('no error thrown');
  })()`;

const ESM_CONSUMER = `import { LangBash, LangPOSIX } from 'sh-ast';
import { format, createEditor, FormatSyntaxError } from 'sh-codemod';
const syntaxError = ${SYNTAX_ERROR};
console.log(JSON.stringify(${REPORT}));
`;

const CJS_CONSUMER = `const { LangBash, LangPOSIX } = require('sh-ast');
const { format, createEditor, FormatSyntaxError } = require('sh-codemod');
const syntaxError = ${SYNTAX_ERROR};
console.log(JSON.stringify(${REPORT}));
`;

/** Type-only consumers: one per module system, each using a value and a type from the package. */
const ESM_TYPES = `import { LangPOSIX } from 'sh-ast';
import type { LangVariant as ProducerVariant } from 'sh-ast';
import { format, createEditor, FormatSyntaxError, type FormatOptions, type EditorOptions, type LangVariant } from 'sh-codemod';
export const dialect: LangVariant = LangPOSIX;
export const options: FormatOptions = { Indent: 2, dialect, filename: 'a.sh' };
// @ts-expect-error string labels are removed from the public dialect contract
format('echo hi', { dialect: 'posix' });
export const producerDialect: ProducerVariant = dialect;
export const formatterDialect: NonNullable<FormatOptions['dialect']> = undefined as unknown as ProducerVariant;
export const editorDialect: NonNullable<EditorOptions['dialect']> = undefined as unknown as ProducerVariant;
export const editorOptions: EditorOptions = { dialect, filename: 'a.sh' };
createEditor('echo hi', editorOptions);
// @ts-expect-error removed parser vocabulary is not a formatter option
format('echo hi', { Variant: 2 });
// @ts-expect-error removed parser vocabulary is not an editor option
createEditor('echo hi', { Filename: 'old.sh' });
export const text: string = format('echo hi', options);
export const line: number = new Error() instanceof FormatSyntaxError ? 1 : 0;
`;

const CJS_TYPES = `import { LangBash } from 'sh-ast';
import services = require('sh-codemod');
export const dialect: services.LangVariant = LangBash;
export const options: services.FormatOptions = { SwitchCaseIndent: true, dialect, filename: 'cjs.sh' };
export const editorOptions: services.EditorOptions = { dialect, filename: 'cjs.sh' };
services.createEditor('echo hi', editorOptions);
// @ts-expect-error removed option names are rejected in CommonJS types too
services.format('echo hi', { Filename: 'old.sh' });
export const text: string = services.format('echo hi', options);
export const code: 'SH_CODEMOD_FORMAT_SYNTAX' | undefined = undefined as services.FormatSyntaxError['code'] | undefined;
`;

/** The expected report: formatted by hand with mvdan/sh's rules (tab indent, one space). */
const EXPECTED_REPORT = {
  formatted: 'if true; then\n\techo "日本語" # c\nfi\n',
  errorName: 'FormatSyntaxError',
  errorIsInstance: true,
  errorLine: 2,
  errorColumn: 6,
  errorFilename: '日本語.sh',
  dialectFormatted: 'a=(one two)\n',
  editorText: 'echo 日本語\n',
  removedCode: 'SH_CODEMOD_SERVICE_OPTION',
};

/** Packs the package with pnpm into `destination` and returns the tarball path. */
function pnpmPack(destination: string): string {
  const stdout = execFileSync(
    'pnpm',
    [
      'pack',
      '--json',
      '--pack-destination',
      destination,
      '--config.ignore-scripts=false',
    ],
    { cwd: packageDir, encoding: 'utf8' },
  );
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    throw new Error(`pnpm pack --json produced no JSON object:\n${stdout}`);
  }
  const packed = record(JSON.parse(stdout.slice(jsonStart)));
  if (typeof packed.filename !== 'string') {
    throw new Error('Missing archive filename');
  }
  return packed.filename;
}

/** The workspace's own release-age exclusions, so the install applies the same policy. */
function workspaceReleaseAgeExclusions(): string {
  const workspace = readFileSync(
    join(packageDir, 'pnpm-workspace.yaml'),
    'utf8',
  );
  return (
    /^minimumReleaseAgeExclude:\n(?: {2}- .*\n)+/m.exec(workspace)?.[0] ?? ''
  );
}

/** Runs one consumer file with Node inside the installed project and parses its report. */
function runConsumer(projectDir: string, file: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [file], {
      cwd: projectDir,
      encoding: 'utf8',
    }),
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
function typeCheck(
  projectDir: string,
  file: string,
): { status: number | null; output: string } {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const result = spawnSync(
    process.execPath,
    [tsc, '-p', writeTypeProject(projectDir, file)],
    {
      cwd: projectDir,
      encoding: 'utf8',
    },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

let scratchDir: string;
let projectDir: string;

describe('packed install (issue #180, criterion 7)', () => {
  beforeAll(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'sh-codemod-install-'));
    const packsDir = join(scratchDir, 'packs');
    projectDir = join(scratchDir, 'project');
    mkdirSync(packsDir);
    mkdirSync(projectDir);

    // A release must rebuild from source even when dist contains obsolete output.
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'dist', 'stale-namespace.js'),
      ['@eslint', 'sh/obsolete'].join('-'),
    );
    writeFileSync(join(packageDir, 'dist', 'stale.wasm'), 'obsolete runtime');
    const tarball = pnpmPack(packsDir);
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'sh-codemod-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { 'sh-codemod': `file:${tarball}`, 'sh-ast': '0.10.0' },
      }),
    );
    writeFileSync(
      join(projectDir, 'pnpm-workspace.yaml'),
      workspaceReleaseAgeExclusions(),
    );
    writeFileSync(join(projectDir, 'consumer.mjs'), ESM_CONSUMER);
    writeFileSync(join(projectDir, 'consumer.cjs'), CJS_CONSUMER);
    writeFileSync(join(projectDir, 'types-esm.mts'), ESM_TYPES);
    writeFileSync(join(projectDir, 'types-cjs.cts'), CJS_TYPES);

    execFileSync(
      'pnpm',
      [
        'install',
        '--no-frozen-lockfile',
        '--store-dir',
        join(scratchDir, 'empty-store'),
      ],
      {
        cwd: projectDir,
        encoding: 'utf8',
      },
    );
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

  it('ships clean output without stale namespaces, runtime assets or source maps', () => {
    const packageRoot = join(projectDir, 'node_modules', 'sh-codemod');
    const files = readdirSync(join(packageRoot, 'dist'), {
      recursive: true,
      encoding: 'utf8',
    });
    expect(files.filter((file) => file.endsWith('.map'))).toEqual([]);
    expect(files).not.toContain('stale-namespace.js');
    expect(files).not.toContain('stale.wasm');
    for (const file of readdirSync(packageRoot, {
      recursive: true,
      encoding: 'utf8',
    })) {
      const path = join(packageRoot, file);
      if (!statSync(path).isFile()) {
        continue;
      }
      expect(file).not.toMatch(/\.(?:wasm|go|map)$/u);
      expect(readFileSync(path, 'utf8')).not.toContain(
        ['@eslint', 'sh'].join('-'),
      );
      expect(readFileSync(path, 'utf8')).not.toContain(
        ['ESLINT', 'SH'].join('_'),
      );
    }
    const entry = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');
    expect(entry).not.toContain('sourceMappingURL');
  });

  it('installs without an ESLint runtime dependency', () => {
    const installedRequire = createRequire(join(projectDir, 'consumer.cjs'));
    expect(() => installedRequire.resolve('eslint')).toThrow();
    const manifest = record(
      JSON.parse(
        readFileSync(
          installedRequire.resolve('sh-codemod/package.json'),
          'utf8',
        ),
      ),
    );
    expect(Object.keys(record(manifest.dependencies))).toEqual(['sh-ast']);
  });

  it('exposes ./package.json through exports', () => {
    const resolved = createRequire(join(projectDir, 'consumer.cjs')).resolve(
      'sh-codemod/package.json',
    );
    expect(record(JSON.parse(readFileSync(resolved, 'utf8'))).name).toBe(
      'sh-codemod',
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
