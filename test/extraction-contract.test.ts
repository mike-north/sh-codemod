/** Standalone outcomes: producer-native grammars, service errors and public printer ownership. */
import { record } from './assertions.js';
import { readFileSync } from 'node:fs';
import { LangAuto, LangBash, LangPOSIX, parseSync, printSync } from 'sh-ast';
import { describe, expect, it, vi } from 'vitest';
import { createEditor, format } from '../src/index.js';
import type { FormatOptions } from '../src/index.js';

vi.mock('sh-ast', async (original) => {
  const module = await original<typeof import('sh-ast')>();
  return { ...module, printSync: vi.fn(module.printSync) };
});

/** Observe actual errors so tests compare the rejecting boundary, not invented messages. */
function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected refusal');
}

describe('standalone extraction contract', () => {
  it.each([undefined, LangBash, 0] as const)(
    'uses the native Bash/default meaning for %s',
    (dialect) => {
      const options: FormatOptions = dialect === undefined ? {} : { dialect };
      expect(format('a=(one two)\n', options)).toBe('a=(one two)\n');
      expect(createEditor('a=(one two)\n', options).apply()).toBe(
        'a=(one two)\n',
      );
      expect(
        printSync(
          parseSync(
            'a=(one two)\n',
            dialect === undefined ? {} : { Variant: dialect },
          ),
        ),
      ).toBe('a=(one two)\n');
    },
  );

  it('uses the public root printer for canonical output', () => {
    vi.mocked(printSync).mockClear();
    expect(format('echo   日本語\n', { dialect: LangPOSIX })).toBe(
      'echo 日本語\n',
    );
    expect(printSync).toHaveBeenCalledOnce();
  });

  it('preserves the parser refusal for known LangAuto and unknown numeric variants', () => {
    for (const dialect of [LangAuto, 999, NaN]) {
      const upstream = failure(() =>
        parseSync('echo ok\n', { Variant: dialect }),
      );
      expect(upstream).toHaveProperty('code', 'SH_AST_SYNTAX_INPUT');
      for (const service of [format, createEditor]) {
        // @ts-expect-error Deliberately exercise JavaScript callers with options outside the public contract.
        const error = failure(() => service('echo ok\n', { dialect }));
        expect(error.constructor).toBe(upstream.constructor);
        expect(error.message).toBe(upstream.message);
        expect(error).toHaveProperty('code', 'SH_AST_SYNTAX_INPUT');
      }
    }
  });

  it.each(['bash', 'posix', null])(
    'rejects removed label or invalid caller dialect %s',
    (dialect) => {
      for (const service of [format, createEditor]) {
        // @ts-expect-error Deliberately exercise JavaScript callers with options outside the public contract.
        expect(failure(() => service('echo hi\n', { dialect }))).toMatchObject({
          code: 'SH_CODEMOD_SERVICE_OPTION',
        });
      }
    },
  );

  it('uses standalone service identities and retains caller option validation', () => {
    expect(failure(() => format('if\n'))).toHaveProperty(
      'code',
      'SH_CODEMOD_FORMAT_SYNTAX',
    );
    for (const service of [format, createEditor]) {
      for (const options of [
        { filename: 12 },
        { Variant: undefined },
        { Filename: 'old.sh' },
      ]) {
        // @ts-expect-error Deliberately exercise JavaScript callers with options outside the public contract.
        expect(failure(() => service('echo hi\n', options))).toMatchObject({
          code: 'SH_CODEMOD_SERVICE_OPTION',
        });
      }
    }
  });

  it('has one runtime dependency and the standalone package identity', () => {
    const manifest = record(
      JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      ),
    );
    expect(manifest.name).toBe('sh-codemod');
    expect(Object.keys(record(manifest.dependencies))).toEqual(['sh-ast']);
    expect(manifest.types).toBe('./dist/sh-codemod.d.ts');
  });
});
