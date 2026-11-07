/** Accepted project dialect vocabulary and deliberate service option failures. */
import { LangBats, LangMirBSDKorn, LangZsh } from 'sh-ast';
import { LangBash, LangPOSIX } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { createEditor, format, FormatSyntaxError } from '../src/index.js';
import type { FormatOptions } from '../src/index.js';

/** Capture a real boundary error without translating its identity. */
function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected refusal');
}

describe('project dialect and filename options', () => {
  it.each([
    [LangBash, 'a=(one two)\n'],
    [LangPOSIX, 'case x in x) echo yes;; esac\n'],
    [LangMirBSDKorn, 'print hello\n'],
    [LangBats, '@test "hello" { true; }\n'],
    [LangZsh, 'function one two { true; }\n'],
  ] as const)('accepts %s in both services', (dialect, text) => {
    // The cast permits tests to run red before the accepted option type exists.
    const options = { dialect } as unknown as FormatOptions;
    expect(format(text, options)).toContain(
      dialect === LangBats
        ? '@test'
        : dialect === LangZsh
          ? 'function'
          : dialect === LangBash
            ? 'a='
            : dialect === LangMirBSDKorn
              ? 'print'
              : 'case',
    );
    expect(createEditor(text, options).apply()).toBe(text);
  });
  it('defaults to Bash and preserves upstream printer knobs', () => {
    expect(format('a=(one two)\n')).toBe('a=(one two)\n');
    expect(format('if true;then\necho hi\nfi', { Indent: 2 })).toBe(
      'if true; then\n  echo hi\nfi\n',
    );
  });
  it('uses filename in actual syntax diagnostics without reclassifying syntax as configuration', () => {
    const options = { dialect: LangPOSIX, filename: '漢字.sh' } as unknown as FormatOptions;
    const formatted = failure(() => format('if\n', options));
    expect(formatted).toBeInstanceOf(FormatSyntaxError);
    expect(formatted).toMatchObject({
      code: 'SH_CODEMOD_FORMAT_SYNTAX',
      filename: '漢字.sh',
      cause: { code: 'SH_AST_SYNTAX_PARSE' },
    });
    const edited = failure(() => createEditor('if\n', options));
    expect(edited).toMatchObject({ code: 'SH_AST_SYNTAX_PARSE', Filename: '漢字.sh' });
  });
  it.each([
    [{ dialect: null }, 'dialect', 'null'],
    [{ dialect: 'bash' }, 'dialect', '"bash"'],
    [{ dialect: 'fish' }, 'dialect', '"fish"'],
    [{ filename: 12 }, 'filename', '12'],
    [{ Variant: undefined }, 'Variant', 'undefined'],
    [{ Filename: 'old.sh' }, 'Filename', '"old.sh"'],
  ] as const)('rejects removed or invalid options %s', (options, path, received) => {
    for (const service of [format, createEditor]) {
      const error = failure(() => service('echo hi\n', options as unknown as FormatOptions));
      expect(error.constructor).toBe(TypeError);
      expect(error).toHaveProperty('code', 'SH_CODEMOD_SERVICE_OPTION');
      expect(error.message).toMatch(
        new RegExp(`^${service.name} options.${path}: .+; received `, 'u'),
      );
      expect(error.message.endsWith(`; received ${received}.`)).toBe(true);
    }
  });
});

it('rejects upstream editor parser knobs instead of silently ignoring removed controls', () => {
  const error = failure(() =>
    createEditor('echo hi\n', { KeepComments: false } as unknown as FormatOptions),
  );
  expect(error).toHaveProperty('code', 'SH_CODEMOD_SERVICE_OPTION');
  expect(error.message).toContain('createEditor options.KeepComments: ');
});

it.each([1n, Symbol('dialect'), { value: undefined }])(
  'keeps service option errors stable for non-JSON dialect values: %s',
  (dialect) => {
    for (const service of [format, createEditor]) {
      const error = failure(() => service('echo hi\n', { dialect } as unknown as FormatOptions));
      expect(error.constructor).toBe(TypeError);
      expect(error).toHaveProperty('code', 'SH_CODEMOD_SERVICE_OPTION');
      expect(error.message).toContain(`${service.name} options.dialect: `);
      expect(error.message).toMatch(/; received .+\.$/u);
    }
  },
);
