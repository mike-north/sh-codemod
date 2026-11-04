/**
 * U+0080 in the input. mvdan/sh's reader uses that code point as its internal end-of-input
 * marker. Where the parser reads it as an ordinary character (the body of a heredoc with a
 * quoted delimiter, after a backslash) the tree is complete and the input is accepted. Where
 * the parser stops at it (a comment, an unquoted word, the start of the input) it returns a
 * tree for only the text before it, with no error. `format` promises never to lose code or
 * return partial output (the `FormatOptions` and `FormatSyntaxError` TSDoc), and an editor's
 * tree must cover the text it edits, so both reject such input as a syntax error at the first
 * U+0080 that loses text. Each position was run against the real parser (sh-ast 0.7.0).
 *
 * Positions are counted by hand. `offset` and `column` are UTF-16 units in the input string;
 * `byteOffset` and the parser's `Col` count UTF-8 bytes, where `é` is two bytes.
 *
 * @see https://pkg.go.dev/unicode/utf8#RuneSelf — the value mvdan/sh's reader treats as end of input
 */
import { ParseError } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { createEditor, format, FormatSyntaxError } from '../src/index.js';

/** Runs `fn` and returns what it throws, failing the test if it returns normally. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

const U = '\u0080';

describe('format: U+0080', () => {
  it('throws instead of dropping the code after an unquoted U+0080', () => {
    const error = thrown(() => format('echo a\u0080b\nrm -rf x\n'));
    expect(error).toBeInstanceOf(FormatSyntaxError);
    const syntax = error as FormatSyntaxError;
    expect(syntax.offset).toBe(6);
    expect(syntax.byteOffset).toBe(6);
    expect(syntax.line).toBe(1);
    expect(syntax.column).toBe(7);
    expect(syntax.message).toBe(
      '1:7: the character U+0080 is not supported: the parser reads it as end of input',
    );
  });

  it('throws for U+0080 inside a comment, which would otherwise end the file there', () => {
    const error = thrown(() => format('# note \u0080\nrm -rf x\n')) as FormatSyntaxError;
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect([error.line, error.column]).toEqual([1, 8]);
  });

  it('reports the first U+0080 in UTF-16 units and bytes after multibyte text on a later line', () => {
    // Line 2 is `é \u0080`: `é` is 1 UTF-16 unit and 2 bytes, so U+0080 sits at UTF-16
    // column 3, line-1 length 8 + `é ` = offset 10, bytes 8 + 3 = 11.
    const error = thrown(() => format('echo hi\né \u0080\u0080\n')) as FormatSyntaxError;
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect(error.offset).toBe(10);
    expect(error.byteOffset).toBe(11);
    expect(error.line).toBe(2);
    expect(error.column).toBe(3);
    expect(error.message.startsWith('2:4: ')).toBe(true);
  });

  it('names the Filename option in the message', () => {
    const error = thrown(() => format('\u0080', { Filename: 'a.sh' })) as FormatSyntaxError;
    expect(error.filename).toBe('a.sh');
    expect(error.message.startsWith('a.sh:1:1: ')).toBe(true);
  });

  it('still formats U+0081, the next code point, as ordinary text', () => {
    expect(format('echo a\u0081b\nrm x\n')).toBe('echo a\u0081b\nrm x\n');
  });
});

describe('format: U+0080 the parser reads as an ordinary character', () => {
  // Regression: a guard that refused every U+0080 made these valid inputs throw. The expected
  // output is the input itself, which is already in the printer's canonical form.
  it.each([
    ['a quoted-delimiter heredoc body', `cat <<'EOF'\nabc${U}def\nEOF\neval "$x"\n`],
    ['a double-quoted-delimiter heredoc body', `cat <<"EOF"\nabc${U}def\nEOF\neval "$x"\n`],
    [
      'a heredoc body followed by a comment',
      `cat <<'EOF'\nabc${U}def\nEOF\n# trailing\neval "$x"\n`,
    ],
    ['an escaped character', `echo \\${U}x\neval "$x"\n`],
  ])('formats U+0080 in %s unchanged', (_name, text) => {
    expect(format(text)).toBe(text);
  });

  it('formats a quoted-delimiter heredoc body with CRLF line endings', () => {
    const text = `cat <<'EOF'\r\nabc${U}def\r\nEOF\r\neval "$x"\r\n`;
    expect(format(text)).toBe(`cat <<'EOF'\nabc${U}def\nEOF\neval "$x"\n`);
  });
});

describe('format: U+0080 where the parser drops text', () => {
  it('names the first dropping U+0080, not an earlier one in a heredoc body', () => {
    // Line 2's U+0080 is ordinary text in the quoted heredoc body; line 4's truncates.
    const error = thrown(() =>
      format(`cat <<'EOF'\nabc${U}def\nEOF\necho a${U}b\neval "$x"\n`),
    ) as FormatSyntaxError;
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect([error.line, error.column, error.offset]).toEqual([4, 7, 30]); // 12 + 8 + 4 + `echo a` = UTF-16 index 30
  });

  it.each([
    ['an unquoted heredoc delimiter', `cat <<E${U}F\nabc\nE${U}F\neval "$x"\n`],
    ['the first character', `${U}eval "$x"\n`],
    ['a line of its own at the end', `eval "$x"\n${U}`],
  ])('throws for U+0080 in %s', (_name, text) => {
    expect(thrown(() => format(text))).toBeInstanceOf(FormatSyntaxError);
  });

  it.each([
    ['single quotes', `echo '${U}'\neval "$x"\n`],
    ['double quotes', `echo "${U}"\neval "$x"\n`],
    ['$(...)', `echo $(echo ${U})\neval "$x"\n`],
  ])('keeps the parser own error for U+0080 in %s', (_name, text) => {
    const error = thrown(() => format(text)) as FormatSyntaxError;
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect(error.message).toContain('reached EOF');
  });
});

describe('createEditor: U+0080 the parser reads as an ordinary character', () => {
  it('returns a session whose tree reaches the code after a quoted-delimiter heredoc body', () => {
    const text = `cat <<'EOF'\nabc${U}def\nEOF\neval "$x"\n`;
    const editor = createEditor(text);
    // The tree holds both statements, so the `eval` after the heredoc can be replaced.
    expect(editor.ast.Stmts).toHaveLength(2);
    editor.replaceNode(editor.ast.Stmts[1], 'true');
    expect(editor.apply()).toBe(`cat <<'EOF'\nabc${U}def\nEOF\ntrue\n`);
  });
});

describe('createEditor: U+0080', () => {
  it('throws a ParseError instead of returning a tree that stops at U+0080', () => {
    const error = thrown(() => createEditor('echo a\u0080b\nrm -rf x\n'));
    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).Pos).toEqual({
      Offset: 6,
      Line: 1,
      Col: 7,
      IsValid: true,
      IsRecovered: false,
      OffsetOverflow: false,
    });
  });
});
