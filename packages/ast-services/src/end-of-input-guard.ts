/**
 * Detects a source whose U+0080 made the parser silently drop text.
 *
 * mvdan/sh's reader uses U+0080 (`utf8.RuneSelf`) as its internal end-of-input marker. In some
 * positions the parser reads it as an ordinary character and returns the whole tree; in others
 * it stops there and returns a tree for only the text before it, with no error. `format` would
 * then drop that code and an editor's tree would omit it, so those sources are refused while
 * the first kind keeps working.
 *
 * The two are told apart by asking the parser what it does with the same source when U+0080 is
 * an ordinary character: the parse is complete exactly when the printed tree is the same as the
 * printed tree of the source with every U+0080 swapped for `X`. Text the parser dropped is
 * missing from the first print and present in the second. Nothing is inferred from tree
 * extents, so a trailing comment or heredoc body cannot make a truncated file look complete.
 */
import { ParseError, parseSync, printSync, type ParseOptions } from 'sh-ast';

const END_OF_INPUT_MARKER = '\u0080';

/** An ordinary one-UTF-16-unit word character, so offsets are the same in both parses. */
const ORDINARY_CHARACTER = 'X';

/** What the parser makes of a source: the printed tree, or `ERROR` when it does not parse. */
const ERROR = Symbol('parse error');

/**
 * Prints `text` the way the parser sees it. Every U+0080 in the result is swapped for the
 * ordinary character so the print of the original can be compared with the print of the
 * swapped source.
 */
function printed(text: string, options: ParseOptions): string | typeof ERROR {
  try {
    const output = printSync(parseSync(text, options));
    const decoded = typeof output === 'string' ? output : new TextDecoder().decode(output);
    return decoded.replaceAll(END_OF_INPUT_MARKER, ORDINARY_CHARACTER);
  } catch {
    return ERROR;
  }
}

/**
 * The UTF-16 index of the first U+0080 whose presence makes the parser drop text, or
 * `undefined` when `text` holds none or the parser handles every one of them completely.
 *
 * A source the parser rejects with an error is also `undefined`: that is a fatal parse error the
 * caller reports through its normal path, not a silent loss. Every other doubt is a refusal:
 * a source that parses but prints differently from its swapped counterpart is refused, and so is
 * one whose swapped counterpart no longer parses, so an undecidable position is never accepted.
 *
 * @param text - The source about to be parsed.
 * @param options - The parse options the caller will use, so the dialect matches.
 */
function firstDroppedTextIndex(text: string, options: ParseOptions): number | undefined {
  const indices: number[] = [];
  for (
    let at = text.indexOf(END_OF_INPUT_MARKER);
    at !== -1;
    at = text.indexOf(END_OF_INPUT_MARKER, at + 1)
  ) {
    indices.push(at);
  }
  if (indices.length === 0) return undefined;

  const ordinary = text.replaceAll(END_OF_INPUT_MARKER, ORDINARY_CHARACTER);
  const expected = printed(ordinary, options);
  const actual = printed(text, options);
  if (actual === ERROR) return undefined;
  if (expected !== ERROR && actual === expected) return undefined;

  /** Whether keeping only the first `count` U+0080 characters (the rest swapped) still differs. */
  const dropsText = (count: number): boolean => {
    let candidate = '';
    let from = 0;
    for (const index of indices.slice(0, count)) {
      candidate += ordinary.slice(from, index) + END_OF_INPUT_MARKER;
      from = index + 1;
    }
    candidate += ordinary.slice(from);
    const result = printed(candidate, options);
    return result === ERROR || expected === ERROR || result !== expected;
  };

  // The full source differs, so the smallest differing prefix of U+0080 characters exists; the
  // search assumes that keeping more of them never repairs the parse, and only ever lands on a
  // count that was itself observed to differ.
  let low = 1;
  let high = indices.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (dropsText(middle)) high = middle;
    else low = middle + 1;
  }
  return indices[high - 1];
}

/**
 * The syntax error to raise for `text` when the parser would silently drop text at a U+0080,
 * positioned at that character, or `undefined` when nothing is dropped. Callers check before
 * parsing so a silently truncated tree can never reach them. A U+0080 the parser rejects with
 * its own error (inside quotes or an expansion) is left to that error.
 *
 * @param text - The source about to be parsed.
 * @param options - The parse options the caller will use; `Filename` is carried on the error.
 * @internal
 */
export function endOfInputMarkerError(
  text: string,
  options: ParseOptions = {},
): ParseError | undefined {
  const index = firstDroppedTextIndex(text, options);
  if (index === undefined) return undefined;
  const filename = options.Filename ?? '';
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf('\n') + 1;
  const encoder = new TextEncoder();
  const offset = encoder.encode(before).length;
  const line = before.split('\n').length;
  const col = encoder.encode(before.slice(lineStart)).length + 1;
  const reason = 'the character U+0080 is not supported: the parser reads it as end of input';
  const prefix = typeof filename === 'string' && filename !== '' ? `${filename}:` : '';
  return new ParseError(
    `${prefix}${String(line)}:${String(col)}: ${reason}`,
    filename,
    {
      Offset: offset,
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
