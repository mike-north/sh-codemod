/** Source-bound text edits preserve untouched bytes and reject ambiguous or unowned ranges. */
import {
  DashHdoc,
  InputError,
  LangError,
  ParseError,
  parseSync,
  parseWithPositionsSync,
  walk,
  type File,
  type Node,
  type NodePositions,
  type ParseOptions,
  type ParsedFile,
  type Redirect,
  type Word,
} from 'sh-ast';
import { serviceParseOptions } from './service-options.js';
import type { LangVariant } from 'sh-ast';
import {
  EditOverlapError,
  ForeignNodeError,
  InvalidNodeError,
  type TextEdit,
} from './edit-errors.js';

/** Grammar and diagnostic source name for one editing session. @public */
export interface EditorOptions {
  /** Producer language value; Bash when omitted. Parser operation constraints still apply. */
  readonly dialect?: LangVariant;
  /** Source name for diagnostics, never a filesystem lookup. */
  readonly filename?: string;
}

/**
 * The editing session over one parse of one text, returned by `createEditor`.
 *
 * @public
 */
export interface Editor {
  /** The parsed file. For comments copied by `sh-ast`'s `walk`, use the stored AST objects. */
  readonly ast: File;

  /**
   * Queues replacing the node's source text with `newText`. A `Stmt` replacement starts after
   * its leading comments and preserves its terminator (`;`, `&`, or the dialect equivalent).
   * If `newText` ends in the same parsed terminator, it supplies that terminator once.
   * Here-document bodies deferred past the original terminator are outside the replaced range.
   *
   * @throws {@link ForeignNodeError} when `node` is not from this editor's parse.
   * @throws {@link InvalidNodeError} when `node` is not a syntax node.
   * @throws RangeError with `SH_CODEMOD_EDIT_RANGE` for invalid character bounds, an ambiguous
   * here-document body end, or an unverifiable statement terminator in `newText`.
   */
  replaceNode(node: Node, newText: string): void;

  /**
   * Queues inserting `text` immediately before the node's first character, leaving the node
   * itself untouched.
   *
   * @throws {@link ForeignNodeError} when `node` is not from this editor's parse.
   * @throws {@link InvalidNodeError} when `node` is not a syntax node.
   * @throws RangeError with `SH_CODEMOD_EDIT_RANGE` when parser bounds do not name character boundaries.
   */
  insertBefore(node: Node, text: string): void;

  /**
   * Applies every queued edit to the original text and returns the result. Text outside the
   * edited ranges is returned exactly. It does not consume the queue, so more edits may be
   * queued and `apply()` called again; the original text is never modified.
   *
   * @throws {@link EditOverlapError} when two edits claim the same text.
   */
  apply(): string;
}

/** An edit with the order it was queued in, which breaks ties between edits at one position. */
interface QueuedEdit extends TextEdit {
  readonly sequence: number;
}

/**
 * Maps every UTF-8 byte offset of `text` that falls on a code-point boundary to the UTF-16
 * index of the same position, and every other offset to -1.
 *
 * The parser reports bytes; callers index JavaScript strings. The two disagree on every
 * non-ASCII character, so each node range is converted through this table rather than assumed
 * equal. `text` is well-formed here: the parser rejects lone surrogates before any range exists.
 */
function buildByteToUtf16(text: string): Int32Array {
  const table = new Int32Array(Buffer.byteLength(text) + 1).fill(-1);
  let byte = 0;
  let index = 0;
  while (index < text.length) {
    table[byte] = index;
    const codePoint = text.codePointAt(index) ?? 0;
    byte +=
      codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;
    index += codePoint >= 0x10000 ? 2 : 1;
  }
  table[byte] = index;
  return table;
}

/**
 * Pulls `end` back over a `\r` that belongs to a `\r\n` line ending rather than to the node.
 *
 * mvdan/sh drops that `\r` from a word's value but still counts it in the word's end offset, so
 * the reported range of a word that ends a CRLF line reaches one character too far. Replacing
 * that range would delete the line ending's `\r`. A node never legitimately ends between the
 * `\r` and `\n` of one line ending, so the `\r` is always safe to leave out.
 */
function trimLineTerminatorCarriageReturn(
  text: string,
  start: number,
  end: number,
): number {
  return end > start && text[end - 1] === '\r' && text[end] === '\n'
    ? end - 1
    : end;
}

/** Whether `value` has the shape of a syntax record: a non-array object with a string `Type`. */
function isNodeLike(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { Type?: unknown }).Type === 'string'
  );
}

/** Reads a `GoString` field as text; the parser hands back bytes only for non-UTF-8 content. */
function goText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

/**
 * A candidate delimiter from literal and quoted-literal AST parts. The caller must verify it
 * against the reported end before using it as a bound.
 */
function delimiterText(word: Word): string | undefined {
  let result = '';
  for (const part of word.Parts ?? []) {
    if (part?.Type === 'Lit') result += goText(part.Value).replaceAll('\\', '');
    else if (part?.Type === 'SglQuoted') result += goText(part.Value);
    else if (part?.Type === 'DblQuoted') {
      for (const inner of part.Parts ?? []) {
        if (inner?.Type !== 'Lit') return undefined;
        result += goText(inner.Value);
      }
    } else return undefined;
  }
  return result;
}

/**
 * Checks the closing line identified by the parser's end coordinates. If the candidate matches,
 * the body ends before the delimiter word, including any `<<-` indentation as in `Lit.Value`.
 * The pinned parser includes the delimiter in the reported body range. Until it supplies separate
 * bounds, an unverified end has no safe replacement range.
 */
function checkedHeredocBodyEnd(
  redirect: Redirect,
  bounds: NodePositions,
  text: string,
  byteToUtf16: Int32Array,
): number | null {
  const delimiter = redirect.Word && delimiterText(redirect.Word);
  // A delimiter that starts with a literal tab needs bounds that distinguish it from indentation.
  if (delimiter == null || delimiter.startsWith('\t')) return null;
  const { Pos, End } = bounds;
  const start = byteToUtf16[Pos.Offset] ?? -1;
  const reportedEnd = byteToUtf16[End.Offset] ?? -1;
  const lineStart = byteToUtf16[End.Offset - End.Col + 1] ?? -1;
  if (start < 0 || reportedEnd < 0 || End.Col === 0 || lineStart <= start)
    return null;
  const end = trimLineTerminatorCarriageReturn(text, start, reportedEnd);
  const delimiterStart = end - delimiter.length;
  if (
    delimiterStart < lineStart ||
    text.slice(delimiterStart, end) !== delimiter
  )
    return null;
  const indent = text.slice(lineStart, delimiterStart);
  if (indent !== '' && (redirect.Op !== DashHdoc || !/^\t*$/.test(indent)))
    return null;
  return delimiterStart;
}

/** Captures replacement ends that differ from the full parser ranges. `null` marks unsafe ends. */
function findReplacementEnds(
  parsed: ParsedFile,
  text: string,
  byteToUtf16: Int32Array,
): Map<Node, number | null> {
  const ends = new Map<Node, number | null>();
  walk(parsed.File, (node) => {
    if (node?.Type === 'Stmt' && node.Semicolon.IsValid) {
      ends.set(node, byteToUtf16[node.Semicolon.Offset] ?? -1);
    }
    if (node?.Type !== 'Redirect') return true;
    const body = node.Hdoc;
    const bounds = body && parsed.Positions.get(body);
    if (!body || !bounds) return true;
    const end = checkedHeredocBodyEnd(node, bounds, text, byteToUtf16);
    walk(body, (inner) => {
      if (
        inner &&
        parsed.Positions.get(inner)?.End.Offset === bounds.End.Offset
      ) {
        ends.set(inner, end);
      }
      return true;
    });
    return true;
  });
  return ends;
}

/** Identifies an edit whose source extent cannot be used safely. */
function editRangeError(message: string): RangeError {
  return Object.assign(new RangeError(message), {
    code: 'SH_CODEMOD_EDIT_RANGE',
  });
}

/** Uses the replacement's syntax to distinguish a final terminator from a literal suffix. */
function endsInTerminator(
  replacement: string,
  terminator: string,
  options: ParseOptions,
): boolean {
  const trimmed = replacement.trimEnd();
  if (!trimmed.endsWith(terminator)) return false;
  try {
    const final = parseSync(replacement, options).Stmts?.at(-1)?.Semicolon;
    return (
      final?.IsValid === true &&
      final.Offset === Buffer.byteLength(trimmed) - terminator.length
    );
  } catch (error) {
    if (
      error instanceof ParseError ||
      error instanceof LangError ||
      error instanceof InputError
    ) {
      throw editRangeError(
        'Cannot verify the statement terminator in replacement text. Omit the original terminator or supply a complete statement.',
      );
    }
    throw error;
  }
}

/** Drops the queue bookkeeping so errors expose only the public edit shape. */
function plain(edit: QueuedEdit): TextEdit {
  return { range: [edit.range[0], edit.range[1]], text: edit.text };
}

/** Orders edits by position; at one position, empty ranges precede non-empty, then queue order. */
function compareEdits(a: QueuedEdit, b: QueuedEdit): number {
  return (
    a.range[0] - b.range[0] ||
    a.range[1] - b.range[1] ||
    a.sequence - b.sequence
  );
}

/**
 * Starts an editing session over `text`: parse the source once, queue edits against nodes, apply them as
 * plain text patches. Nothing is reprinted, so everything outside the edited node ranges
 * (comments, whitespace, `\r\n`, multibyte characters) comes back byte for byte.
 *
 * Ordering is defined so output never depends on accident:
 * - Edits are placed by position in the original text, not by the order they were queued.
 * - Edits that only touch (one ends where the next begins) are both applied.
 * - Insertions at one position appear in the order `insertBefore` was called.
 * - An insertion at the start of a replaced node comes before the replacement; an insertion
 *   at its end comes after it.
 * - Anything else that shares text, including two replacements of one node or an insertion
 *   strictly inside a replaced node, makes `apply()` throw {@link EditOverlapError}.
 *
 * The result is not re-parsed; a caller who needs to know it is still valid shell can parse it.
 *
 * @param text - Shell source.
 * @param options - Project dialect and filename. Comments are always kept so they can be edited.
 * @returns The editing session.
 * @throws TypeError with `SH_CODEMOD_SERVICE_OPTION` for invalid project options or removed names.
 * @throws The `sh-ast` `ParseError` (`SH_AST_SYNTAX_PARSE`), `LangError` (`SH_AST_SYNTAX_LANG`)
 *   or `InputError` (`SH_AST_SYNTAX_INPUT`) when `text` cannot be parsed. These errors pass through
 *   with their original objects and causes, rather than becoming configuration errors.
 *   Native nesting refusals (`ShParseMaxDepthError`, `SH_AST_PARSE_MAX_DEPTH`) also propagate unchanged;
 *   no editor or partial tree is returned. Unicode source characters are preserved.
 *   Traversal/bridge failures (`SH_AST_WALK_PANIC`, `SH_AST_INTERNAL`) also pass through unchanged.
 *
 * @public
 */
function createEditor(text: string, options: EditorOptions = {}): Editor {
  const parseOptions = serviceParseOptions('createEditor', options);
  const parsed = parseWithPositionsSync(text, parseOptions);
  const byteToUtf16 = buildByteToUtf16(text);
  const replacementEnds = findReplacementEnds(parsed, text, byteToUtf16);
  const edits: QueuedEdit[] = [];

  /** The node's UTF-16 range in `text`, or a rejection when the node is not from this parse. */
  function rangeOf(node: Node, replacement?: string): [number, number] {
    if (!isNodeLike(node)) throw new InvalidNodeError(node);
    const positions = parsed.Positions.get(node);
    if (positions === undefined) throw new ForeignNodeError(node);
    const replacementEnd =
      replacement === undefined ? undefined : replacementEnds.get(node);
    if (replacementEnd === null) {
      throw editRangeError(
        'Cannot replace this here-document body without a verified closing delimiter range',
      );
    }
    const start = byteToUtf16[positions.Pos.Offset] ?? -1;
    const reportedEnd = byteToUtf16[positions.End.Offset] ?? -1;
    const end = replacementEnd ?? reportedEnd;
    if (start < 0 || end < start || reportedEnd < end) {
      throw editRangeError(
        `${node.Type} bounds do not fall on character boundaries of the text`,
      );
    }
    if (
      replacement !== undefined &&
      node.Type === 'Stmt' &&
      end < reportedEnd &&
      endsInTerminator(replacement, text.slice(end, reportedEnd), parseOptions)
    ) {
      return [start, reportedEnd];
    }
    return [start, trimLineTerminatorCarriageReturn(text, start, end)];
  }

  /** Queues one edit, stamping it so ties at one position resolve in queue order. */
  function queue(range: [number, number], newText: string): void {
    edits.push({ range, text: newText, sequence: edits.length });
  }

  return {
    ast: parsed.File,
    replaceNode(node, newText) {
      queue(rangeOf(node, newText), newText);
    },
    insertBefore(node, insertion) {
      const [start] = rangeOf(node);
      queue([start, start], insertion);
    },
    apply() {
      const ordered = [...edits].sort(compareEdits);
      let output = '';
      let cursor = 0;
      let previous: QueuedEdit | undefined;
      for (const edit of ordered) {
        if (previous !== undefined && edit.range[0] < cursor) {
          throw new EditOverlapError(plain(previous), plain(edit));
        }
        output += text.slice(cursor, edit.range[0]) + edit.text;
        cursor = edit.range[1];
        previous = edit;
      }
      return output + text.slice(cursor);
    },
  };
}

export { createEditor };
