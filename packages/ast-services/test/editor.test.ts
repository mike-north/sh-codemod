/**
 * Behavior of `createEditor` (https://github.com/mike-north/eslint-sh/issues/182).
 *
 * Criterion → test mapping:
 *   - criterion 1 (shape: ast, replaceNode, insertBefore, apply) → "editor shape".
 *   - criterion 2 (text outside edits preserved: comments, whitespace, CRLF, multibyte) →
 *     "preservation".
 *   - criterion 3 (typed overlap error; defined order for adjacent edits and same-position
 *     inserts) → "overlap" and "ordering".
 *   - criterion 4 (node from another parse rejected) → "foreign nodes".
 *   - criterion 5 (emoji, CJK, combining marks) → "multibyte ranges".
 *   - criterion 6 (README example executes) → test/readme-example.test.ts.
 *
 * Every expected string is written out by hand.
 */
import { walk, type Node } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  EditOverlapError,
  ForeignNodeError,
  InvalidNodeError,
  type Editor,
} from '../src/index.js';

/** Returns every node of the given `Type` in source order. */
function nodesOfType(editor: Editor, type: string): Node[] {
  const found: Node[] = [];
  walk(editor.ast, (node) => {
    if (node?.Type === type) found.push(node);
    return true;
  });
  return found;
}

/** Returns the `Lit` nodes whose value is `value`, in source order. */
function lits(editor: Editor, value: string): Node[] {
  return nodesOfType(editor, 'Lit').filter((n) => n.Type === 'Lit' && n.Value === value);
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

describe('editor shape', () => {
  it('exposes the parsed file and applies nothing when no edit is queued', () => {
    const text = 'echo   hi # c\r\n';
    const editor = createEditor(text);
    expect(editor.ast.Type).toBe('File');
    expect(editor.ast.Stmts?.length).toBe(1);
    expect(editor.apply()).toBe(text);
  });

  it('replaces a node and inserts before another', () => {
    const editor = createEditor('echo a b\n');
    editor.replaceNode(lits(editor, 'b')[0], 'BEE');
    editor.insertBefore(lits(editor, 'a')[0], '>');
    expect(editor.apply()).toBe('echo >a BEE\n');
  });

  it('passes parser options through (dialect errors surface from sh-ast)', () => {
    expect(() => createEditor('echo "oops')).toThrow();
  });

  it('can apply repeatedly, and queued edits are applied by position not call order', () => {
    const editor = createEditor('a b c\n');
    editor.replaceNode(lits(editor, 'c')[0], 'C');
    editor.replaceNode(lits(editor, 'a')[0], 'A');
    expect(editor.apply()).toBe('A b C\n');
    expect(editor.apply()).toBe('A b C\n');
  });

  it('edits an empty file by inserting at its only node', () => {
    const editor = createEditor('');
    editor.insertBefore(editor.ast, '# hi\n');
    expect(editor.apply()).toBe('# hi\n');
  });
});

describe('preservation', () => {
  it('keeps comments, odd spacing, blank lines and CRLF outside the edit', () => {
    const text = '# lead\r\n\r\necho   old    # trail\r\n\r\n\r\nls\t-l\r\n';
    const editor = createEditor(text);
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    expect(editor.apply()).toBe('# lead\r\n\r\necho   new    # trail\r\n\r\n\r\nls\t-l\r\n');
  });

  it('keeps a here-document body byte for byte around an edit to its command', () => {
    const text = "cat   <<'EOF'\n  keep   $HOME\nEOF\necho  old\n";
    const editor = createEditor(text);
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    expect(editor.apply()).toBe("cat   <<'EOF'\n  keep   $HOME\nEOF\necho  new\n");
  });

  it('edits a comment node that stands on its own line', () => {
    const editor = createEditor('\n# old\n');
    editor.replaceNode(nodesOfType(editor, 'Comment')[0], '# new');
    expect(editor.apply()).toBe('\n# new\n');
  });

  it('keeps the carriage return when the edited word ends a CRLF line', () => {
    const editor = createEditor('echo old\r\necho b\r\n');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    editor.replaceNode(nodesOfType(editor, 'Stmt')[1], 'ls');
    expect(editor.apply()).toBe('echo new\r\nls\r\n');
  });

  it('does not reprint: an unedited statement with irregular layout is untouched', () => {
    const text = 'if   true;then\n   echo   x\nfi\necho  old\n';
    const editor = createEditor(text);
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    expect(editor.apply()).toBe('if   true;then\n   echo   x\nfi\necho  new\n');
  });
});

describe('here-document bodies', () => {
  /** The last `Lit` of the first here-document body. */
  function bodyLit(editor: Editor): Node {
    const redirect = nodesOfType(editor, 'Redirect')[0];
    if (redirect.Type !== 'Redirect' || !redirect.Hdoc) throw new Error('no here-document');
    const parts = redirect.Hdoc.Parts ?? [];
    const last = parts[parts.length - 1];
    if (!last) throw new Error('empty body');
    return last;
  }

  it('makes an identity replacement of the body a no-op', () => {
    const text = 'cat <<EOF\nhello\nEOF\necho x\n';
    const editor = createEditor(text);
    editor.replaceNode(bodyLit(editor), 'hello\n');
    expect(editor.apply()).toBe(text);
  });

  it('replaces the body and keeps the delimiter and what follows', () => {
    const editor = createEditor('cat <<EOF\nhello\nEOF\necho x\n');
    editor.replaceNode(bodyLit(editor), 'bye\nbye\n');
    expect(editor.apply()).toBe('cat <<EOF\nbye\nbye\nEOF\necho x\n');
  });

  it('keeps the delimiter when the whole body Word (Redirect.Hdoc) is replaced', () => {
    const editor = createEditor('cat <<EOF\nhello\nEOF\necho x\n');
    const redirect = nodesOfType(editor, 'Redirect')[0];
    if (redirect.Type !== 'Redirect' || !redirect.Hdoc) throw new Error('no here-document');
    editor.replaceNode(redirect.Hdoc, 'new\n');
    expect(editor.apply()).toBe('cat <<EOF\nnew\nEOF\necho x\n');
  });

  it('keeps a <<- delimiter and its tab indentation', () => {
    const text = 'cat <<-EOF\n\thello\n\tEOF\necho x\n';
    const identity = createEditor(text);
    identity.replaceNode(bodyLit(identity), '\thello\n\t');
    expect(identity.apply()).toBe(text);

    const edited = createEditor(text);
    edited.replaceNode(bodyLit(edited), '\tbye\n\t');
    expect(edited.apply()).toBe('cat <<-EOF\n\tbye\n\tEOF\necho x\n');
  });

  it('keeps a CRLF here-document delimiter and its line endings', () => {
    const text = 'cat <<EOF\r\nhello\r\nEOF\r\necho x\r\n';
    const identity = createEditor(text);
    identity.replaceNode(bodyLit(identity), 'hello\r\n');
    expect(identity.apply()).toBe(text);

    const edited = createEditor(text);
    edited.replaceNode(bodyLit(edited), 'bye\r\n');
    expect(edited.apply()).toBe('cat <<EOF\r\nbye\r\nEOF\r\necho x\r\n');
  });

  it('keeps a quoted delimiter, and a multi-line body, around a multibyte body', () => {
    const editor = createEditor("cat <<'EOF'\n你好 🎉\nsecond\nEOF\necho x\n");
    editor.replaceNode(bodyLit(editor), 'é\n');
    expect(editor.apply()).toBe("cat <<'EOF'\né\nEOF\necho x\n");
  });

  it('keeps the delimiter when a body ending in an expansion text is replaced', () => {
    const editor = createEditor('cat <<EOF\n$x and y\nEOF\n');
    editor.replaceNode(bodyLit(editor), ' and z\n');
    expect(editor.apply()).toBe('cat <<EOF\n$x and z\nEOF\n');
  });

  it('still lets the whole redirect, delimiter included, be replaced', () => {
    const editor = createEditor('cat <<EOF\nhello\nEOF\necho x\n');
    editor.replaceNode(nodesOfType(editor, 'Redirect')[0], '<in');
    expect(editor.apply()).toBe('cat <in\necho x\n');
  });

  it('keeps the delimiter of a backslash-escaped delimiter word', () => {
    const editor = createEditor('cat <<\\EOF\nhi\nEOF\n');
    editor.replaceNode(bodyLit(editor), 'yo\n');
    expect(editor.apply()).toBe('cat <<\\EOF\nyo\nEOF\n');
  });
});

describe('comments attached to statements', () => {
  it('edits leading, middle, trailing and final comments, byte-exact around multibyte text', () => {
    const editor = createEditor('# top é\necho a # trail 🎉\n# mid\necho b\n# last\n');
    const comments = nodesOfType(editor, 'Comment');
    expect(comments.length).toBe(4);
    editor.replaceNode(comments[0], '# TOP');
    editor.replaceNode(comments[1], '# TRAIL');
    editor.replaceNode(comments[2], '# MID');
    editor.replaceNode(comments[3], '# LAST');
    expect(editor.apply()).toBe('# TOP\necho a # TRAIL\n# MID\necho b\n# LAST\n');
  });

  it('inserts before an attached comment and keeps CRLF', () => {
    const editor = createEditor('echo a # c\r\necho b\r\n');
    editor.insertBefore(nodesOfType(editor, 'Comment')[0], '# note ');
    expect(editor.apply()).toBe('echo a # note # c\r\necho b\r\n');
  });

  it('edits a comment taken straight from Stmt.Comments', () => {
    const editor = createEditor('echo a # c\n');
    const stmt = editor.ast.Stmts?.[0];
    const comment = stmt?.Comments?.[0];
    if (!comment) throw new Error('no attached comment');
    editor.replaceNode(comment, '# d');
    expect(editor.apply()).toBe('echo a # d\n');
  });

  it('rejects an attached comment from another parse whose position or text differs', () => {
    const editor = createEditor('echo a # c\n');
    const other = createEditor('echo aa # c\n');
    const different = createEditor('echo a # z\n');
    expect(
      thrown(() => {
        editor.replaceNode(nodesOfType(other, 'Comment')[0], '#');
      }),
    ).toBeInstanceOf(ForeignNodeError);
    expect(
      thrown(() => {
        editor.replaceNode(nodesOfType(different, 'Comment')[0], '#');
      }),
    ).toBeInstanceOf(ForeignNodeError);
  });
});

describe('invalid arguments', () => {
  it('throws InvalidNodeError for undefined, null and non-objects from JavaScript callers', () => {
    const editor = createEditor('echo x\n');
    for (const bad of [undefined, null, 'Lit', 3]) {
      const error = thrown(() => {
        // @ts-expect-error deliberately violating the types, as a JavaScript caller can
        editor.replaceNode(bad, 'y');
      });
      expect(error).toBeInstanceOf(InvalidNodeError);
      expect((error as InvalidNodeError).code).toBe('ESLINT_SH_EDIT_INVALID_NODE');
      expect((error as InvalidNodeError).received).toBe(bad);
    }
    for (const bad of [[], [lits(editor, 'x')[0]], {}, { Type: 3 }]) {
      const error = thrown(() => {
        // @ts-expect-error deliberately violating the types, as a JavaScript caller can
        editor.replaceNode(bad, 'y');
      });
      expect(error).toBeInstanceOf(InvalidNodeError);
      expect((error as InvalidNodeError).received).toBe(bad);
    }
    const error = thrown(() => {
      // @ts-expect-error deliberately violating the types, as a JavaScript caller can
      editor.insertBefore(undefined, 'y');
    });
    expect(error).toBeInstanceOf(InvalidNodeError);
    expect((error as Error).message).toBe(
      "Expected a syntax node from this editor's `ast`, received undefined",
    );
  });
});

describe('multibyte ranges', () => {
  it('lands an edit after emoji (4-byte, 2 UTF-16 units)', () => {
    const editor = createEditor('echo 🎉🎉 old\n');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    expect(editor.apply()).toBe('echo 🎉🎉 new\n');
  });

  it('replaces a word that is itself emoji', () => {
    const editor = createEditor('echo a🎉b tail\n');
    editor.replaceNode(lits(editor, 'a🎉b')[0], 'X');
    expect(editor.apply()).toBe('echo X tail\n');
  });

  it('lands an edit after CJK (3-byte, 1 UTF-16 unit)', () => {
    const editor = createEditor('echo 你好世界 old 日本語\n');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    editor.replaceNode(lits(editor, '日本語')[0], '語');
    expect(editor.apply()).toBe('echo 你好世界 new 語\n');
  });

  it('lands an edit after combining marks (e + U+0301)', () => {
    const editor = createEditor('echo éé old\n');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    expect(editor.apply()).toBe('echo éé new\n');
  });

  it('lands edits after 2-byte accented text, mixed with CRLF lines', () => {
    const editor = createEditor('echo é\r\necho ñ 🎉 你 old\r\n');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    editor.insertBefore(lits(editor, 'ñ')[0], '~');
    expect(editor.apply()).toBe('echo é\r\necho ~ñ 🎉 你 new\r\n');
  });

  it('inserts before a node that follows multibyte characters on the same line', () => {
    const editor = createEditor('echo "🎉" "你" tail\n');
    editor.insertBefore(lits(editor, 'tail')[0], '>');
    expect(editor.apply()).toBe('echo "🎉" "你" >tail\n');
  });
});

describe('ordering', () => {
  it('applies adjacent edits separated only by a `;`', () => {
    const editor = createEditor('echo a;b\n');
    const [a] = lits(editor, 'a');
    const [b] = lits(editor, 'b');
    editor.replaceNode(b, 'B');
    editor.replaceNode(a, 'A');
    expect(editor.apply()).toBe('echo A;B\n');
  });

  it('applies a replacement whose end touches the start of the next replacement', () => {
    const editor = createEditor('echo "x"y\n');
    editor.replaceNode(nodesOfType(editor, 'DblQuoted')[0], '1');
    editor.replaceNode(lits(editor, 'y')[0], '2');
    expect(editor.apply()).toBe('echo 12\n');
  });

  it('puts two inserts at one position in call order', () => {
    const editor = createEditor('echo x\n');
    const x = lits(editor, 'x')[0];
    editor.insertBefore(x, '1');
    editor.insertBefore(x, '2');
    editor.insertBefore(x, '3');
    expect(editor.apply()).toBe('echo 123x\n');
  });

  it("puts an insert at a replaced node's start before the replacement, however it was queued", () => {
    const first = createEditor('echo x\n');
    const x1 = lits(first, 'x')[0];
    first.insertBefore(x1, '<');
    first.replaceNode(x1, 'X');
    expect(first.apply()).toBe('echo <X\n');

    const second = createEditor('echo x\n');
    const x2 = lits(second, 'x')[0];
    second.replaceNode(x2, 'X');
    second.insertBefore(x2, '<');
    expect(second.apply()).toBe('echo <X\n');
  });

  it('puts an insert at the end of a replaced node after it', () => {
    const editor = createEditor('echo a;b\n');
    editor.insertBefore(lits(editor, 'b')[0], '+');
    editor.replaceNode(lits(editor, 'a')[0], 'A');
    expect(editor.apply()).toBe('echo A;+b\n');
  });
});

describe('overlap', () => {
  it('throws EditOverlapError when a node and its ancestor are both replaced', () => {
    const editor = createEditor('echo old\n');
    editor.replaceNode(nodesOfType(editor, 'CallExpr')[0], 'ls');
    editor.replaceNode(lits(editor, 'old')[0], 'new');
    const error = thrown(() => editor.apply());
    expect(error).toBeInstanceOf(EditOverlapError);
    const overlap = error as EditOverlapError;
    expect(overlap.code).toBe('ESLINT_SH_EDIT_OVERLAP');
    expect(overlap.first).toEqual({ range: [0, 8], text: 'ls' });
    expect(overlap.second).toEqual({ range: [5, 8], text: 'new' });
  });

  it('throws when one node is replaced twice', () => {
    const editor = createEditor('echo x\n');
    const x = lits(editor, 'x')[0];
    editor.replaceNode(x, '1');
    editor.replaceNode(x, '2');
    expect(thrown(() => editor.apply())).toBeInstanceOf(EditOverlapError);
  });

  it('throws when an insertion falls strictly inside a replaced node', () => {
    const editor = createEditor('echo "inner"\n');
    editor.replaceNode(nodesOfType(editor, 'DblQuoted')[0], 'X');
    editor.insertBefore(lits(editor, 'inner')[0], '>');
    expect(thrown(() => editor.apply())).toBeInstanceOf(EditOverlapError);
  });

  it('throws for partially overlapping ranges, detected in a multibyte file', () => {
    const editor = createEditor('echo 🎉 "a b"\n');
    editor.replaceNode(nodesOfType(editor, 'DblQuoted')[0], 'Q');
    editor.replaceNode(nodesOfType(editor, 'Word')[2], 'W');
    expect(thrown(() => editor.apply())).toBeInstanceOf(EditOverlapError);
  });

  it('leaves the editor usable; no partial text was produced', () => {
    const editor = createEditor('echo x\n');
    const x = lits(editor, 'x')[0];
    editor.replaceNode(x, '1');
    editor.replaceNode(x, '2');
    expect(thrown(() => editor.apply())).toBeInstanceOf(EditOverlapError);
    expect(thrown(() => editor.apply())).toBeInstanceOf(EditOverlapError);
  });
});

describe('foreign nodes', () => {
  it('rejects a node from a different parse of identical text', () => {
    const editor = createEditor('echo x\n');
    const other = createEditor('echo x\n');
    const foreign = lits(other, 'x')[0];
    const error = thrown(() => {
      editor.replaceNode(foreign, 'y');
    });
    expect(error).toBeInstanceOf(ForeignNodeError);
    expect((error as ForeignNodeError).code).toBe('ESLINT_SH_EDIT_FOREIGN_NODE');
    expect((error as ForeignNodeError).node).toBe(foreign);
    expect(
      thrown(() => {
        editor.insertBefore(foreign, 'y');
      }),
    ).toBeInstanceOf(ForeignNodeError);
    expect(editor.apply()).toBe('echo x\n');
  });

  it('rejects a structuredClone of an own node, whose offsets are stale', () => {
    const editor = createEditor('echo x\n');
    const copy = structuredClone(lits(editor, 'x')[0]);
    expect(
      thrown(() => {
        editor.replaceNode(copy, 'y');
      }),
    ).toBeInstanceOf(ForeignNodeError);
  });
});
