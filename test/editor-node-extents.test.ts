/**
 * The editor maps each node to its exact extent in the caller's string, across every UTF-8
 * encoding width, for carriage returns that belong to a node, and for comments the parser
 * attaches somewhere other than a statement.
 *
 * - UTF-8 encodes U+0000..U+007F in 1 byte, U+0080..U+07FF in 2, U+0800..U+FFFF in 3 and
 *   U+10000.. in 4 (the last as a UTF-16 surrogate pair). The parser reports byte offsets, so
 *   an edit after a character at each width boundary must still land on the right word.
 * - Only a `\r` immediately followed by `\n` is a line ending; a `\r` elsewhere inside a
 *   node's reported extent is part of that node and is replaced with it.
 * - Comments are kept so they can be edited, including ones the parser attaches to a case
 *   clause or an array element rather than to a statement.
 *
 * Every expected string is written out by hand.
 *
 * @see ../src/editor.ts (TSDoc of `Editor.replaceNode` and `createEditor`)
 * @see https://www.rfc-editor.org/rfc/rfc3629#section-3
 * @see https://github.com/mike-north/eslint-sh/issues/182
 */
import assert from 'node:assert/strict';
import { walk, type Node } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../src/index.js';

/** Require an existing fixture node so a missing parser result fails at the lookup. */
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) {
    throw new Error('Expected fixture node');
  }
  return value;
}

/** Returns every node of the given `Type` in walk order, which is source order here. */
function nodesOfType(editor: Editor, type: string): Node[] {
  const found: Node[] = [];
  walk(editor.ast, (node) => {
    if (node?.Type === type) found.push(node);
    return true;
  });
  return found;
}

describe('UTF-8 width boundaries', () => {
  it.each([
    { name: 'U+07FF, the last 2-byte character', char: '߿' },
    { name: 'U+0800, the first 3-byte character', char: 'ࠀ' },
    { name: 'U+FFFD, a 3-byte character near the top of the BMP', char: '�' },
    { name: 'U+10000, the first 4-byte character', char: '\u{10000}' },
  ])('lands an edit after $name', ({ char }) => {
    const editor = createEditor(`echo ${char} old\n`);
    const old = nodesOfType(editor, 'Lit').find(
      (n) => n.Type === 'Lit' && n.Value === 'old',
    );
    if (!old) throw new Error('no `old` literal');
    editor.replaceNode(old, 'new');
    expect(editor.apply()).toBe(`echo ${char} new\n`);
  });

  it('lands edits after every boundary character on one line', () => {
    const editor = createEditor('echo ߿ ࠀ \u{10000} a b\n');
    const lits = nodesOfType(editor, 'Lit');
    editor.replaceNode(required(lits[lits.length - 2]), 'A');
    editor.insertBefore(required(lits[lits.length - 1]), '>');
    expect(editor.apply()).toBe('echo ߿ ࠀ \u{10000} A >b\n');
  });
});

describe('carriage returns', () => {
  it('replaces a `\\r` that sits inside double quotes along with its word', () => {
    // `echo "a\r" b`: the literal inside the quotes is reported as [6, 8), covering `a\r`.
    const editor = createEditor('echo "a\r" b\n');
    const inner = required(nodesOfType(editor, 'DblQuoted')[0]);
    if (inner.Type !== 'DblQuoted' || !inner.Parts?.[0])
      throw new Error('no quoted literal');
    editor.replaceNode(inner.Parts[0], 'X');
    expect(editor.apply()).toBe('echo "X" b\n');
  });
});

describe('comments outside statements', () => {
  it('edits comments attached to case clauses', () => {
    const editor = createEditor('case x in\n# c1\na) :;; # c2\nesac\n');
    const comments = nodesOfType(editor, 'Comment');
    expect(comments.length).toBe(2);
    editor.replaceNode(required(comments[0]), '# one');
    editor.replaceNode(required(comments[1]), '# two');
    expect(editor.apply()).toBe('case x in\n# one\na) :;; # two\nesac\n');
  });

  it('edits a comment inside an array literal', () => {
    const editor = createEditor('x=(\n # c\n a\n)\n');
    const comment = required(nodesOfType(editor, 'Comment')[0]);
    editor.insertBefore(comment, '# note\n ');
    editor.replaceNode(comment, '# d');
    expect(editor.apply()).toBe('x=(\n # note\n # d\n a\n)\n');
  });
});
