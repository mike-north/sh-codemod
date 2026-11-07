/**
 * The editor keeps every here-document's closing delimiter line when a body is replaced,
 * whatever form the delimiter word takes and wherever the here-document sits.
 *
 * mvdan/sh reports a body as ending after its closing delimiter; the editor ends the body
 * where the delimiter line begins instead. That correction must:
 * - recognise the delimiter however it is quoted (`"EOF"`, `'E\F'` where the backslash is
 *   literal), since quoting only disables expansion of the body;
 * - apply to here-documents nested in command substitutions, including one inside another
 *   here-document's body or inside a plain redirect's target;
 * - leave nodes that end before the body's last part (an expansion early in the body) at their
 *   own extent;
 * - tolerate commands that also carry ordinary redirects.
 *
 * Every expected string is written out by hand.
 *
 * @see ../src/editor.ts (TSDoc of `createEditor` and `findHeredocBodyEnds`)
 * @see https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html#tag_19_07_04
 * @see https://github.com/mike-north/eslint-sh/issues/182
 */
import { walk, type Node, type Redirect } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { createEditor, type Editor } from '../src/index.js';

/** Returns every `Redirect` in walk order, which is source order for the fixtures below. */
function redirects(editor: Editor): Redirect[] {
  const found: Redirect[] = [];
  walk(editor.ast, (node) => {
    if (node?.Type === 'Redirect') found.push(node);
    return true;
  });
  return found;
}

/** The body word (`Redirect.Hdoc`) of the `index`-th redirect, failing if it has none. */
function body(editor: Editor, index: number): Node {
  const hdoc = redirects(editor)[index]?.Hdoc;
  if (!hdoc) throw new Error(`redirect ${String(index)} has no here-document body`);
  return hdoc;
}

describe('delimiter word forms', () => {
  it('keeps a double-quoted delimiter', () => {
    const editor = createEditor('cat <<"EOF"\nhi\nEOF\necho x\n');
    editor.replaceNode(body(editor, 0), 'yo\n');
    expect(editor.apply()).toBe('cat <<"EOF"\nyo\nEOF\necho x\n');
  });

  it('keeps a single-quoted delimiter whose backslash is literal', () => {
    // Inside single quotes the backslash is part of the delimiter, so the closing line is `E\F`.
    const editor = createEditor("cat <<'E\\F'\nhi\nE\\F\necho x\n");
    editor.replaceNode(body(editor, 0), 'yo\n');
    expect(editor.apply()).toBe("cat <<'E\\F'\nyo\nE\\F\necho x\n");
  });
});

describe('nested here-documents', () => {
  it('keeps the delimiter of a here-document inside another here-document body', () => {
    const editor = createEditor('cat <<A\n$(cat <<B\nb\nB\n)\nA\n');
    editor.replaceNode(body(editor, 1), 'c\n');
    expect(editor.apply()).toBe('cat <<A\n$(cat <<B\nc\nB\n)\nA\n');
  });

  it('keeps the delimiter of a here-document inside a plain redirect target', () => {
    const editor = createEditor('echo hi >"$(cat <<E\nf\nE\n)"\n');
    editor.replaceNode(body(editor, 1), 'g\n');
    expect(editor.apply()).toBe('echo hi >"$(cat <<E\ng\nE\n)"\n');
  });

  it('keeps the delimiter of the second of two here-documents on one command', () => {
    const editor = createEditor('cat <<A <<B\na\nA\nb\nB\n');
    editor.replaceNode(body(editor, 1), 'c\n');
    expect(editor.apply()).toBe('cat <<A <<B\na\nA\nc\nB\n');
  });
});

describe('nodes inside a body', () => {
  it('replaces an expansion at the start of a body without reaching the delimiter', () => {
    // Body `$x and y\n` starts at index 10; `$x` is [10, 12).
    const editor = createEditor('cat <<EOF\n$x and y\nEOF\n');
    let expansion: Node | undefined;
    walk(editor.ast, (node) => {
      if (node?.Type === 'ParamExp') expansion = node;
      return true;
    });
    if (!expansion) throw new Error('no ParamExp');
    editor.replaceNode(expansion, '$z');
    expect(editor.apply()).toBe('cat <<EOF\n$z and y\nEOF\n');
  });
});

describe('ordinary redirects', () => {
  it('edits a command that has an output redirect and no here-document', () => {
    const editor = createEditor('echo hi >out\n');
    let word: Node | undefined;
    walk(editor.ast, (node) => {
      if (node?.Type === 'Lit' && node.Value === 'hi') word = node;
      return true;
    });
    if (!word) throw new Error('no `hi` literal');
    editor.replaceNode(word, 'HI');
    expect(editor.apply()).toBe('echo HI >out\n');
  });
});
