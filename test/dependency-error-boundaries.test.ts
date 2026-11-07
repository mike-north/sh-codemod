/** Syntax wrappers preserve causes; non-syntax dependency failures retain their original identity. */
import { parseSync, parseWithPositionsSync, printSync } from 'sh-ast';
import { expect, it, vi } from 'vitest';
import { createEditor, format, FormatSyntaxError } from '../src/index.js';

vi.mock('sh-ast', async (original) => {
  const module = await original<typeof import('sh-ast')>();
  return {
    ...module,
    parseSync: vi.fn(module.parseSync),
    parseWithPositionsSync: vi.fn(module.parseWithPositionsSync),
    printSync: vi.fn(module.printSync),
  };
});

/** Obtain the dependency's actual error from an actual failing call, not a local imitation. */
function failure(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected failure');
}

it('wraps actual parser syntax failures with their original cause and Unicode coordinates', async () => {
  const upstream = await vi.importActual<typeof import('sh-ast')>('sh-ast');
  const original = failure(() => upstream.parseSync('echo 漢字\nif\n', { Filename: '漢字.sh' }));
  vi.mocked(parseSync).mockImplementationOnce(() => {
    throw original;
  });
  const error = failure(() => format('echo 漢字\nif\n', { filename: '漢字.sh' }));
  expect(error).toBeInstanceOf(FormatSyntaxError);
  expect(error.cause).toBe(original);
  expect(error).toMatchObject({ code: 'SH_CODEMOD_FORMAT_SYNTAX', filename: '漢字.sh', line: 2 });
});

it('passes actual parser syntax failures through createEditor unchanged', async () => {
  const upstream = await vi.importActual<typeof import('sh-ast')>('sh-ast');
  const original = failure(() => upstream.parseWithPositionsSync('if\n'));
  vi.mocked(parseWithPositionsSync).mockImplementationOnce(() => {
    throw original;
  });
  expect(failure(() => createEditor('if\n'))).toBe(original);
  expect(original).toHaveProperty('code', 'SH_AST_SYNTAX_PARSE');
});

it('passes malformed-Unicode input failures through format unchanged', async () => {
  const upstream = await vi.importActual<typeof import('sh-ast')>('sh-ast');
  const original = failure(() => upstream.parseSync('\ud800'));
  vi.mocked(parseSync).mockImplementationOnce(() => {
    throw original;
  });
  expect(failure(() => format('\ud800'))).toBe(original);
  expect(original).toHaveProperty('code', 'SH_AST_SYNTAX_INPUT');
});

it('passes actual incompatible-printer-option failures through format unchanged', async () => {
  const upstream = await vi.importActual<typeof import('sh-ast')>('sh-ast');
  const ast = upstream.parseSync('echo hi\n');
  const original = failure(() => upstream.printSync(ast, { Minify: true, SingleLine: true }));
  vi.mocked(printSync).mockImplementationOnce(() => {
    throw original;
  });
  expect(failure(() => format('echo hi\n'))).toBe(original);
  expect(original).toHaveProperty('code', 'SH_AST_SYNTAX_PRINT');
});
