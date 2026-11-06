/** Whole-file formatting refuses known parser/printer data loss instead of returning changed code. */
import { LangError, ParseError, parseSync, printSync, type PrintOptions } from 'sh-ast';
import { serviceParseOptions } from './service-options.js';
import type { ShellDialect } from './shell-dialect.js';
import { FormatSyntaxError } from './format-syntax-error.js';

/**
 * Options for `format`: project dialect/filename vocabulary and the pinned
 * parser's printer knobs. Numeric parser variants are private to the adapter.
 *
 * Only the parse options that cannot change what is printed are exposed. `RecoverErrors`
 * would let malformed input through as a repaired tree, and `StopAt` would silently drop the
 * rest of the file; both break the guarantee that formatting never loses or invents code.
 * `KeepComments` is not exposed either: comments are always kept (except under `Minify`,
 * which omits them by definition).
 *
 * @public
 */
export interface FormatOptions extends PrintOptions {
  /** Project grammar label; Bash when omitted. */
  readonly dialect?: ShellDialect;
  /** Source name used in diagnostics; no filesystem lookup is performed. */
  readonly filename?: string;
}

/** Narrows a caught value to the two `sh-ast` failures that mean "the input is not valid". */
function isSyntaxFailure(error: unknown): error is ParseError | LangError {
  return error instanceof ParseError || error instanceof LangError;
}

/**
 * Refuses literal VT/FF anywhere in source: the printer treats them as layout even inside quotes.
 * A conservative file refusal avoids duplicating shell lexing to decide where each byte is data.
 */
// ShellSourceCode.getPrintedReplacement in shell-source-code.ts independently guards edited syntax.
function refusePrinterControlCharacters(text: string, filename: string | undefined): void {
  const index = text.search(/[\v\f]/u);
  if (index === -1) return;
  const before = text.slice(0, index);
  const encoder = new TextEncoder();
  const line = before.split('\n').length;
  const col = encoder.encode(before.slice(before.lastIndexOf('\n') + 1)).length + 1;
  const reason =
    'literal vertical tabs and form feeds are not supported: the printer changes their value';
  const prefix = filename ? `${filename}:` : '';
  throw new ParseError(
    `${prefix}${String(line)}:${String(col)}: ${reason}`,
    filename ?? '',
    {
      Offset: encoder.encode(before).length,
      Line: line,
      Col: col,
      IsValid: true,
      IsRecovered: false,
      OffsetOverflow: false,
    },
    reason,
    false,
    null,
  );
}

/**
 * Formats shell source into the canonical text of mvdan/sh's printer (the `shfmt` style).
 *
 * The text is parsed and printed through `sh-ast`, so the result is determined by the AST
 * alone: layout, blank-line runs and `\r\n` line endings in the input do not survive, while
 * comments and here-document bodies do. Formatting is idempotent.
 *
 * @param text - Shell source.
 * @param options - Printer options, and the project `dialect` (Bash when omitted).
 * @returns The formatted source, ending in a newline.
 * @throws TypeError with `ESLINT_SH_SERVICE_OPTION` for invalid project options or removed names.
 * @throws {@link FormatSyntaxError} when `text` is not valid in the selected dialect, or
 *   source contains a literal vertical tab or form feed that the printer cannot preserve.
 *   Unicode source characters are preserved by the parser and printer.
 *   Native nesting refusals (`ShParseMaxDepthError`, `SH_AST_PARSE_MAX_DEPTH`) propagate unchanged.
 *   Other `sh-ast` failures (`PrintError` for incompatible printer options such as
 *   `Minify` with `SingleLine`, code `SH_AST_SYNTAX_PRINT`; `PrintPanicError`,
 *   code `SH_AST_SYNTAX_PRINT_PANIC`; `InputError`, code `SH_AST_SYNTAX_INPUT`, for
 *   malformed Unicode source/filename or rejected upstream printer knobs; and
 *   bridge failures with `SH_AST_INTERNAL`)
 *   are thrown as they are.
 *
 * @public
 */
export function format(text: string, options: FormatOptions = {}): string {
  const parse = serviceParseOptions('format', options);
  const { dialect: _dialect, filename: _filename, ...print } = options;
  let printed;
  try {
    refusePrinterControlCharacters(text, options.filename);
    printed = printSync(parseSync(text, parse), print);
  } catch (error) {
    if (isSyntaxFailure(error)) {
      const filename = options.filename;
      throw new FormatSyntaxError(error, text, filename);
    }
    throw error;
  }
  return typeof printed === 'string' ? printed : new TextDecoder().decode(printed);
}
