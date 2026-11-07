/** The parser owns numeric Variant validation, including nonfinite values. */
import { parseSync } from 'sh-ast';
import { expect, it } from 'vitest';
import { createEditor, format } from '../src/index.js';

/** Capture producer and consumer failures without replacing their error objects. */
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
it.each([NaN, Infinity, -Infinity])(
  'preserves producer numeric refusal for %s',
  (dialect) => {
    const upstream = failure(() =>
      parseSync('echo hi\n', { Variant: dialect }),
    );
    for (const service of [format, createEditor]) {
      // @ts-expect-error Deliberately exercise JavaScript callers with options outside the public contract.
      const error = failure(() => service('echo hi\n', { dialect }));
      expect(error.constructor).toBe(upstream.constructor);
      expect(error.message).toBe(upstream.message);
      expect(error).toHaveProperty('code', 'SH_AST_SYNTAX_INPUT');
    }
  },
);
