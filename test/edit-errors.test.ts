/**
 * Identity and messages of the editor's typed errors: `EditOverlapError`, `ForeignNodeError`
 * and `InvalidNodeError`.
 *
 * Each error carries a `name` matching its class, so it reads correctly in stack traces and
 * `String(error)`, and a message that names the problem without printing the rejected value.
 * `InvalidNodeError` names what it received by kind (`null`, `an array`, an object lacking a
 * string `Type`, or the `typeof` of a primitive).
 *
 * @see ../src/edit-errors.ts (TSDoc of each error class)
 * @see ../README.md
 * @see https://github.com/mike-north/eslint-sh/issues/182
 */
import assert from 'node:assert/strict';
import { walk, type Node } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  EditOverlapError,
  ForeignNodeError,
  InvalidNodeError,
  type Editor,
} from '../src/index.js';

/** Returns the first node of the given `Type`, in walk order, so tests can name a node by kind. */
function firstOfType(editor: Editor, type: string): Node {
  let found: Node | undefined;
  walk(editor.ast, (node) => {
    if (found === undefined && node?.Type === type) found = node;
    return found === undefined;
  });
  if (found === undefined) throw new Error(`no ${type} node`);
  return found;
}

/** Runs `fn` and returns what it throws, failing if it does not throw. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The last `Lit` in walk order; in `echo old` that is `old`. */
function lastLit(editor: Editor): Node {
  let last: Node | undefined;
  walk(editor.ast, (node) => {
    if (node?.Type === 'Lit') last = node;
    return true;
  });
  if (last === undefined) throw new Error('no Lit node');
  return last;
}

describe('EditOverlapError', () => {
  it('is named after its class and states both half-open ranges', () => {
    // `echo old\n`: the CallExpr spans [0, 8) and the word `old` spans [5, 8).
    const editor = createEditor('echo old\n');
    editor.replaceNode(firstOfType(editor, 'CallExpr'), 'ls');
    editor.replaceNode(lastLit(editor), 'x');
    const error = thrown(() => editor.apply());
    expect(error).toBeInstanceOf(EditOverlapError);
    assert.ok(error instanceof EditOverlapError);
    expect(error.name).toBe('EditOverlapError');
    expect(error.message).toBe(
      'Edits overlap: [0, 8) and [5, 8) both claim the same text',
    );
  });
});

describe('ForeignNodeError', () => {
  it('is named after its class and names the node type it refused', () => {
    const editor = createEditor('echo x\n');
    const foreign = firstOfType(createEditor('echo x\n'), 'CallExpr');
    const error = thrown(() => {
      editor.replaceNode(foreign, 'y');
    });
    expect(error).toBeInstanceOf(ForeignNodeError);
    assert.ok(error instanceof ForeignNodeError);
    expect(error.name).toBe('ForeignNodeError');
    expect(error.message).toBe(
      "Cannot edit a CallExpr node that does not belong to this editor's parse",
    );
  });
});

describe('InvalidNodeError', () => {
  /** Each non-node value a JavaScript caller might pass, and how the message must name it. */
  const cases: readonly { value: unknown; described: string }[] = [
    { value: null, described: 'null' },
    { value: [], described: 'an array' },
    { value: {}, described: 'an object without a string `Type`' },
    { value: { Type: 3 }, described: 'an object without a string `Type`' },
    { value: 3, described: 'number' },
    { value: 'Lit', described: 'string' },
    { value: true, described: 'boolean' },
  ];

  it.each(cases)(
    'names $described without printing the value',
    ({ value, described }) => {
      const editor = createEditor('echo x\n');
      const error = thrown(() => {
        // @ts-expect-error deliberately violating the types, as a JavaScript caller can
        editor.insertBefore(value, 'y');
      });
      expect(error).toBeInstanceOf(InvalidNodeError);
      assert.ok(error instanceof InvalidNodeError);
      expect(error.name).toBe('InvalidNodeError');
      expect(error.message).toBe(
        `Expected a syntax node from this editor's \`ast\`, received ${described}`,
      );
    },
  );
});
