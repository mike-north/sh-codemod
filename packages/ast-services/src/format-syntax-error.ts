/** Stable formatting failures expose caller-facing positions while preserving the underlying cause. */
import type { LangError, ParseError } from 'sh-ast';

/**
 * Thrown by `format` when input is invalid shell or cannot be formatted without losing content.
 *
 * It exists so callers can distinguish input that cannot be safely formatted from other failures and can
 * point at the problem, without depending on how `sh-ast` reports parse failures. Formatting
 * never returns partial output: a syntax error always surfaces as this error, never as text.
 *
 * `offset`, `line` and `column` are measured in the input string the caller passed, using
 * the same UTF-16 units as ESLint locations, so they index that string directly even when it
 * holds multibyte characters. `byteOffset` is the parser's own UTF-8 offset, kept for tools
 * that address the source as bytes.
 *
 * @public
 */
export class FormatSyntaxError extends Error {
  /** Stable machine-readable identity of this error, independent of its message text. */
  readonly code = 'ESLINT_SH_FORMAT_SYNTAX';

  /** Zero-based UTF-16 index into the input string where the error was detected. */
  readonly offset: number;

  /** Zero-based UTF-8 byte offset of the same position. */
  readonly byteOffset: number;

  /** One-based line; `\n` ends a line, so `\r\n` input counts one line per pair. */
  readonly line: number;

  /** One-based UTF-16 column within {@link FormatSyntaxError.line}. */
  readonly column: number;

  /** The project `filename` option, if any. */
  readonly filename: string | undefined;

  /** The underlying parse or content-preservation failure, describing why input was refused. */
  override readonly cause: ParseError | LangError;

  /**
   * Builds the error for a parser failure on `source`; `format` is the intended caller.
   *
   * @param cause - The `sh-ast` failure, which carries the parser's byte position.
   * @param source - The exact string that was parsed, used to translate that position.
   * @param filename - The project `filename` option, if the caller gave one.
   */
  constructor(cause: ParseError | LangError, source: string, filename: string | undefined) {
    super(cause.message, { cause });
    const position = locateByteOffset(source, cause.Pos.Offset);
    this.name = 'FormatSyntaxError';
    this.cause = cause;
    this.offset = position.offset;
    this.byteOffset = position.byteOffset;
    this.line = position.line;
    this.column = position.column;
    this.filename = filename;
  }
}

/** A parser position re-expressed against the caller's string. */
interface SourcePosition {
  readonly offset: number;
  readonly byteOffset: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Converts a parser byte offset into positions within `text`.
 *
 * The parser counts UTF-8 bytes; callers index JavaScript strings. The prefix up to the
 * offset is decoded so the two can never disagree, and line and column are derived from the
 * same prefix rather than taken from the parser, which counts a column in bytes.
 */
function locateByteOffset(text: string, byteOffset: number): SourcePosition {
  const bytes = new TextEncoder().encode(text);
  const clamped = Math.min(Math.max(byteOffset, 0), bytes.length);
  const prefix = new TextDecoder().decode(bytes.subarray(0, clamped));
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return {
    offset: prefix.length,
    byteOffset: clamped,
    line: prefix.split('\n').length,
    column: prefix.length - lineStart + 1,
  };
}
