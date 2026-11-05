/** Whole-file formatting refuses known parser/printer data loss instead of returning changed code. */
import {
  LangError,
  ParseError,
  parseSync,
  printSync,
  type ParseOptions,
  type PrintOptions,
} from 'sh-ast';
import { endOfInputMarkerError } from './end-of-input-guard.js';
import { FormatSyntaxError } from './format-syntax-error.js';

/**
 * Options for `format`: the printer's options and the parse dialect, taken from `sh-ast` so
 * they cannot drift from the pinned mvdan/sh.
 *
 * Only the parse options that cannot change what is printed are exposed. `RecoverErrors`
 * would let malformed input through as a repaired tree, and `StopAt` would silently drop the
 * rest of the file; both break the guarantee that formatting never loses or invents code.
 * `KeepComments` is not exposed either: comments are always kept (except under `Minify`,
 * which omits them by definition).
 *
 * @public
 */
export type FormatOptions = PrintOptions & Pick<ParseOptions, 'Variant' | 'Filename'>;

/** Narrows a caught value to the two `sh-ast` failures that mean "the input is not valid". */
function isSyntaxFailure(error: unknown): error is ParseError | LangError {
  return error instanceof ParseError || error instanceof LangError;
}

/** Separates the options that steer parsing from those that steer printing. */
function splitOptions(options: FormatOptions): { parse: ParseOptions; print: PrintOptions } {
  const { Variant, Filename, ...print } = options;
  return {
    parse: {
      KeepComments: true,
      ...(Variant === undefined ? {} : { Variant }),
      ...(Filename === undefined ? {} : { Filename }),
    },
    print,
  };
}

/** The parser accepts either filename representation; caller-facing errors always expose text. */
function decodeFilename(filename: FormatOptions['Filename']): string | undefined {
  return filename instanceof Uint8Array ? new TextDecoder().decode(filename) : filename;
}

/**
 * Refuses literal VT/FF anywhere in source: the printer treats them as layout even inside quotes.
 * A conservative file refusal avoids duplicating shell lexing to decide where each byte is data.
 */
// ShellSourceCode.getPrintedReplacement in shell-source-code.ts independently guards edited syntax.
function refusePrinterControlCharacters(text: string, filename: ParseOptions['Filename']): void {
  const index = text.search(/[\v\f]/u);
  if (index === -1) return;
  const before = text.slice(0, index);
  const encoder = new TextEncoder();
  const line = before.split('\n').length;
  const col = encoder.encode(before.slice(before.lastIndexOf('\n') + 1)).length + 1;
  const reason =
    'literal vertical tabs and form feeds are not supported: the printer changes their value';
  const decodedFilename = decodeFilename(filename);
  const prefix = decodedFilename ? `${decodedFilename}:` : '';
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
 * @param options - Printer options, and the `Variant` dialect (Bash when omitted).
 * @returns The formatted source, ending in a newline.
 * @throws {@link FormatSyntaxError} when `text` is not valid in the selected dialect, or
 *   the parser would silently drop text at a U+0080, its internal end-of-input marker, or
 *   source contains a literal vertical tab or form feed that the printer cannot preserve.
 *   A U+0080 the parser reads as an ordinary character (in a quoted-delimiter heredoc body,
 *   after a backslash) formats as any other character.
 *   Other `sh-ast` failures (`PrintError` for incompatible printer options such as
 *   `Minify` with `SingleLine`, `InputError` for text that is not well-formed Unicode)
 *   are thrown as they are.
 *
 * @public
 */
export function format(text: string, options: FormatOptions = {}): string {
  const { parse, print } = splitOptions(options);
  let printed;
  try {
    refusePrinterControlCharacters(text, parse.Filename);
    const unsupported = endOfInputMarkerError(text, parse);
    if (unsupported) throw unsupported;
    printed = printSync(parseSync(text, parse), print);
  } catch (error) {
    if (isSyntaxFailure(error)) {
      const filename = decodeFilename(options.Filename);
      throw new FormatSyntaxError(error, text, filename);
    }
    throw error;
  }
  return typeof printed === 'string' ? printed : new TextDecoder().decode(printed);
}
