/**
 * Behavior of `format` (https://github.com/mike-north/eslint-sh/issues/180).
 *
 * Criterion → test mapping:
 *   - criterion 3 (canonical shfmt-style text; printer options and dialect passed through) → the
 *     "canonical output" and "options" suites.
 *   - criterion 4 (idempotent on heredoc, comment, multibyte and CRLF fixtures) → the
 *     "idempotence" suite, which pins each fixture's exact output and re-formats it.
 *   - criterion 5 (typed error carrying the position, never partial output) → the "syntax errors"
 *     suite.
 *
 * Every expected string is written out by hand from mvdan/sh's documented printer behavior
 * (tab indentation, single spaces between words, one blank line kept at most); none is captured
 * from a previous run.
 */
import { LangPOSIX, PrintError } from 'sh-ast';
import { describe, expect, it } from 'vitest';
import { format, FormatSyntaxError, type FormatOptions } from '../src/index.js';

/** Runs `format` and returns the error it throws, failing the test if it returns text. */
function formatError(text: string, options?: Parameters<typeof format>[1]): unknown {
  try {
    format(text, options);
  } catch (error) {
    return error;
  }
  throw new Error('format returned output for input that should not format');
}

describe('canonical output', () => {
  it('collapses spacing and re-indents with tabs', () => {
    expect(format('if true;then\n    echo   hi\nfi\n')).toBe('if true; then\n\techo hi\nfi\n');
  });

  it('keeps one blank line from a run of several, and adds the final newline', () => {
    expect(format('echo 1\n\n\n\necho 2')).toBe('echo 1\n\necho 2\n');
  });

  it('keeps comments, normalizing the space before a trailing comment', () => {
    expect(format('# top\necho   hi    # trailing\n')).toBe('# top\necho hi # trailing\n');
  });

  it('formats functions and case clauses', () => {
    expect(format('f(){\necho hi\n}\ncase $x in\na) echo a;;\nesac\n')).toBe(
      'f() {\n\techo hi\n}\ncase $x in\na) echo a ;;\nesac\n',
    );
  });

  it('formats an empty input as a single newline, as the printer does for an empty file', () => {
    expect(format('')).toBe('\n');
  });
});

describe('options', () => {
  const script = 'f(){\necho hi\n}\ncase $x in\na) echo a;;\nesac\n';

  it('applies Indent, SwitchCaseIndent and FunctionNextLine', () => {
    expect(format(script, { Indent: 2, SwitchCaseIndent: true, FunctionNextLine: true })).toBe(
      'f()\n{\n  echo hi\n}\ncase $x in\n  a) echo a ;;\nesac\n',
    );
  });

  it('applies BinaryNextLine to a pipeline that spans lines', () => {
    expect(format('a   |\n   b\n', { BinaryNextLine: true })).toBe('a \\\n\t| b\n');
    expect(format('a   |\n   b\n')).toBe('a |\n\tb\n');
  });

  it('applies SpaceRedirects', () => {
    expect(format('echo hi >out\n', { SpaceRedirects: true })).toBe('echo hi > out\n');
    expect(format('echo hi > out\n')).toBe('echo hi >out\n');
  });

  it('minifies, dropping comments, when Minify is set', () => {
    expect(format('echo   hi # gone\n', { Minify: true })).toBe('echo hi\n');
  });

  it('parses with the requested dialect', () => {
    expect(format('echo ${x@Q}\n')).toBe('echo ${x@Q}\n');
    const error = formatError('echo ${x@Q}\n', { Variant: LangPOSIX });
    expect(error).toBeInstanceOf(FormatSyntaxError);
  });

  it('lets a PrintError for incompatible printer options propagate unchanged', () => {
    expect(formatError('echo hi', { Minify: true, SingleLine: true })).toBeInstanceOf(PrintError);
  });
});

describe('idempotence', () => {
  /** Each fixture: source text and the exact text `format` must return for it. */
  const fixtures: readonly { name: string; input: string; output: string }[] = [
    {
      name: 'here-document with a quoted delimiter keeps its body verbatim',
      input: "cat   <<'EOF'\n  keep   $HOME   spacing\n\ttab\nEOF\necho   done\n",
      output: "cat <<'EOF'\n  keep   $HOME   spacing\n\ttab\nEOF\necho done\n",
    },
    {
      name: 'indented here-document (<<-) keeps its body and moves the delimiter to column 0',
      input: 'cat <<-EOT\n\t  indented body\n\tEOT\n# after',
      output: 'cat <<-EOT\n\t  indented body\nEOT\n# after\n',
    },
    {
      name: 'here-document inside a function, followed by a pipe',
      input: 'f() {\ncat <<EOF | tr a b\n  abc\nEOF\n}\n',
      output: 'f() {\n\tcat <<EOF | tr a b\n  abc\nEOF\n}\n',
    },
    {
      name: 'comments: leading, trailing, and between commands',
      input: '#!/usr/bin/env bash\n# header\n\necho   a   # one\n\n# between\necho b\n',
      output: '#!/usr/bin/env bash\n# header\n\necho a # one\n\n# between\necho b\n',
    },
    {
      name: 'multibyte text: CJK, emoji and a combining mark, in code and in comments',
      input: '# héllo 日本語\necho   "😀 é"   # naïve  \n\n\n\necho 日本語\n',
      output: '# héllo 日本語\necho "😀 é" # naïve\n\necho 日本語\n',
    },
    {
      name: 'CRLF line endings become LF',
      input: 'if true;then\r\n  echo   hi # c\r\nfi\r\n',
      output: 'if true; then\n\techo hi # c\nfi\n',
    },
    {
      name: 'CRLF here-document',
      input: 'cat <<EOF\r\n  x  y\r\nEOF\r\necho a\r\n',
      output: 'cat <<EOF\n  x  y\nEOF\necho a\n',
    },
    {
      name: 'CRLF comment as the last line, without a final newline',
      input: 'echo hi\r\n# c',
      output: 'echo hi\n# c\n',
    },
  ];

  it.each(fixtures)('$name', ({ input, output }) => {
    const once = format(input);
    expect(once).toBe(output);
    expect(format(once)).toBe(once);
  });

  it('is idempotent under non-default options too', () => {
    const options = { Indent: 4, SwitchCaseIndent: true, BinaryNextLine: true } as const;
    const once = format('case $x in\na) a   |\n b ;;\nesac\n', options);
    expect(once).toBe('case $x in\n    a) a \\\n        | b ;;\nesac\n');
    expect(format(once, options)).toBe(once);
  });
});

describe('idempotence across printer options', () => {
  /** Inputs spanning heredocs, comments, multibyte text, CRLF, pipelines, functions and loops. */
  const sources = [
    '# top\n\nfoo   # trailing\n\n\n# mid\nbar()   {   # c\n  echo x   # d\n}\n',
    'cat <<-EOF\n\t  a   b\n\tEOF\necho   "日本語"   # 😀\n',
    'x=1 y=2   cmd   >out  2>&1\nfoo |\n  bar |\n baz\nif a;then b;fi\n',
    'cat <<EOF\r\nx\r\nEOF\r\necho a   &&\r\n echo b\r\n',
    'f(){ echo a; }; for i in 1 2; do echo $i; done; while true; do :; done',
    'case $x in\n a)  echo a ;;\n *) echo b\n;;\nesac\n',
  ];

  /** Every printer option on its own, plus combinations. `KeepPadding` is tested separately. */
  const optionSets: readonly FormatOptions[] = [
    {},
    { BinaryNextLine: true },
    { SwitchCaseIndent: true },
    { SpaceRedirects: true },
    { FunctionNextLine: true },
    { Minify: true },
    { SingleLine: true },
    { Indent: 2 },
    { Indent: 4 },
    { Indent: 8 },
    {
      Indent: 2,
      BinaryNextLine: true,
      SwitchCaseIndent: true,
      SpaceRedirects: true,
      FunctionNextLine: true,
    },
    { Indent: 4, SingleLine: true, SwitchCaseIndent: true },
    { Minify: true, SpaceRedirects: true, BinaryNextLine: true },
  ];

  it.each(optionSets)('format(format(x, %o), %o) equals format(x, %o)', (options) => {
    for (const source of sources) {
      const once = format(source, options);
      expect(format(once, options)).toBe(once);
    }
  });

  it('is not idempotent with KeepPadding, which upstream documents as flawed', () => {
    // mvdan/sh's printer keeps `echo x   # d` at two spaces on the first pass and at one on the
    // second. This records the upstream behavior; `format` does not work around it.
    const source = '# top\n\nfoo   # trailing\n\n\n# mid\nbar()   {   # c\n  echo x   # d\n}\n';
    const options = { KeepPadding: true } as const;
    const once = format(source, options);
    expect(once).toBe('# top\n\nfoo   # trailing\n\n# mid\nbar()   {   # c\n\techo x  # d\n}\n');
    expect(format(once, options)).toBe(
      '# top\n\nfoo   # trailing\n\n# mid\nbar()   {   # c\n\techo x # d\n}\n',
    );
  });

  it('KeepPadding settles after a second pass for a case clause', () => {
    const options = { KeepPadding: true } as const;
    const once = format('case $x in\n *) echo b\n;;\nesac\n', options);
    expect(once).toBe('case $x in\n*)\n\techo  b\n\t;;\nesac\n');
    expect(format(once, options)).toBe('case $x in\n*)\n\techo b\n\t;;\nesac\n');
  });

  it('prints SingleLine text that is not valid shell when a case is followed by a statement', () => {
    // Upstream omits the `;` after `esac`, so the output does not re-parse. This records that
    // upstream behavior (and should be revisited when sh-ast's pinned mvdan/sh changes);
    // `format` does not work around it.
    const once = format('case $x in\n a) echo a ;;\nesac\nif a;then b;fi\n', {
      SingleLine: true,
    });
    expect(once).toBe('case $x in a) echo a ;; esac if a; then b; fi\n');
    expect(formatError(once)).toBeInstanceOf(FormatSyntaxError);
  });
});

describe('syntax errors', () => {
  it('throws FormatSyntaxError, with code, cause and filename, instead of returning text', () => {
    const error = formatError('echo (', { Filename: 'build.sh' });
    expect(error).toBeInstanceOf(FormatSyntaxError);
    const syntaxError = error as FormatSyntaxError;
    expect(syntaxError.code).toBe('ESLINT_SH_FORMAT_SYNTAX');
    expect(syntaxError.name).toBe('FormatSyntaxError');
    expect(syntaxError.filename).toBe('build.sh');
    expect(syntaxError.message).toBe('build.sh:1:1: `foo(` must be followed by `)`');
    expect(syntaxError.cause.code).toBe('SH_AST_SYNTAX_PARSE');
  });

  it('reports line and column of an unterminated quote on a later line', () => {
    const error = formatError('echo ok\necho "never closed\n') as FormatSyntaxError;
    expect(error.line).toBe(2);
    expect(error.column).toBe(6);
    expect(error.offset).toBe(13);
    expect(error.byteOffset).toBe(13);
    expect(error.filename).toBeUndefined();
  });

  it('reports UTF-16 positions, not byte positions, after multibyte text', () => {
    // `echo ` (5) + 日本語 (3) + space + 😀 (2 UTF-16 units) + space = 12 code units before the quote.
    const error = formatError('echo 日本語 😀 "unterminated') as FormatSyntaxError;
    expect(error.offset).toBe(12);
    expect(error.column).toBe(13);
    expect(error.line).toBe(1);
    // The same prefix is 5 + 9 + 1 + 4 + 1 = 20 UTF-8 bytes.
    expect(error.byteOffset).toBe(20);
  });

  it('counts a CRLF pair as one line break', () => {
    const error = formatError('echo a\r\necho "b\r\n') as FormatSyntaxError;
    expect(error.line).toBe(2);
    expect(error.column).toBe(6);
    expect(error.offset).toBe(13);
  });

  it('reports a dialect rejection with its position', () => {
    const error = formatError('echo ${x@Q}', { Variant: LangPOSIX }) as FormatSyntaxError;
    expect(error).toBeInstanceOf(FormatSyntaxError);
    expect(error.cause.code).toBe('SH_AST_SYNTAX_LANG');
    expect(error.line).toBe(1);
    expect(error.column).toBe(9);
  });
});
