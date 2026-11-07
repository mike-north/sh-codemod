/**
 * Formatting and editing must preserve Unicode source characters and the code
 * following them. Exact expected prints retain literal spelling; editor edits
 * demonstrate that the final statement remains addressable after parsing.
 */
import { ParseError, ShParseMaxDepthError } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { createEditor, format, FormatSyntaxError } from '../src/index.js';

/** Canonically formatted inputs spanning the lexer contexts that can contain Unicode. */
function fixtures(character: string): readonly string[] {
  return [
    `echo a${character}b\nrm -rf x\n`,
    `# note ${character}\nrm -rf x\n`,
    `echo hi\né ${character}${character}\n`,
    `${character}\n`,
    `cat <<'EOF'\nabc${character}def\nEOF\neval "$x"\n`,
    `cat <<"EOF"\nabc${character}def\nEOF\neval "$x"\n`,
    `cat <<'EOF'\nabc${character}def\nEOF\n# trailing\neval "$x"\n`,
    `echo \\${character}x\neval "$x"\n`,
    `cat <<'EOF'\nabc${character}def\nEOF\necho a${character}b\neval "$x"\n`,
    `cat <<E${character}F\nabc\nE${character}F\neval "$x"\n`,
    `${character}eval "$x"\n`,
    `eval "$x"\n${character}\n`,
    `echo '${character}'\neval "$x"\n`,
    `echo "${character}"\neval "$x"\n`,
    `echo $(echo ${character})\neval "$x"\n`,
  ];
}

describe.each(['\u0080', '\u0081'])('Unicode source character %j', (character) => {
  it.each(fixtures(character))('formats all source text unchanged: %j', (text) => {
    expect(format(text, { filename: 'a.sh' })).toBe(text);
  });

  it('normalizes CRLF without dropping a quoted heredoc body or later code', () => {
    const text = `cat <<'EOF'\nabc${character}def\nEOF\neval "$x"\n`;
    expect(format(text.replaceAll('\n', '\r\n'))).toBe(text);
  });

  it.each(fixtures(character))(
    'can edit the final statement without losing earlier text: %j',
    (text) => {
      const editor = createEditor(text);
      const last = editor.ast.Stmts?.at(-1);
      expect(last).toBeDefined();
      if (last === undefined || last === null) {
        throw new Error('fixture must contain a final statement');
      }
      editor.replaceNode(last, 'true');
      const start = text.lastIndexOf('\n', text.length - 2) + 1;
      expect(editor.apply()).toBe(`${text.slice(0, start)}true\n`);
    },
  );
});

it('keeps genuine syntax failures positioned after Unicode text', () => {
  const text = 'echo é😀\necho "\u0080\n';
  try {
    format(text, { filename: 'a.sh' });
    throw new Error('expected an unterminated quote to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect(error).toMatchObject({
      filename: 'a.sh',
      offset: 14,
      byteOffset: 17,
      line: 2,
      column: 6,
    });
  }
  expect(() => createEditor(text)).toThrow(ParseError);
});

it('propagates native nesting refusals without returning partial formatted text or an editor', () => {
  const text = `if a; then b; ${'elif c; then d; '.repeat(600)}fi\n`;
  expect(() => format(text)).toThrow(ShParseMaxDepthError);
  expect(() => createEditor(text)).toThrow(ShParseMaxDepthError);
  expect(format('echo ok\n')).toBe('echo ok\n');
});
