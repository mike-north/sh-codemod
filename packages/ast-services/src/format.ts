import {
  LangError,
  ParseError,
  parseSync,
  printSync,
  type ParseOptions,
  type PrintOptions,
} from 'sh-ast';
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
 * @throws {@link FormatSyntaxError} when `text` is not valid in the selected dialect.
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
    printed = printSync(parseSync(text, parse), print);
  } catch (error) {
    if (isSyntaxFailure(error)) {
      const filename = typeof options.Filename === 'string' ? options.Filename : undefined;
      throw new FormatSyntaxError(error, text, filename);
    }
    throw error;
  }
  return typeof printed === 'string' ? printed : new TextDecoder().decode(printed);
}
