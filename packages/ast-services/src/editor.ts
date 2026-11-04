import {
  nodeEnd,
  nodePos,
  parseWithPositionsSync,
  walk,
  type Comment,
  type File,
  type Node,
  type ParseOptions,
  type ParsedFile,
  type Redirect,
  type Word,
} from 'sh-ast';
import {
  EditOverlapError,
  ForeignNodeError,
  InvalidNodeError,
  type TextEdit,
} from './edit-errors.js';
import { endOfInputMarkerError } from './end-of-input-guard.js';

/**
 * The editing session over one parse of one text, returned by `createEditor`.
 *
 * @public
 */
export interface Editor {
  /** The parsed file. Nodes taken from it are the only ones the methods below accept. */
  readonly ast: File;

  /**
   * Queues replacing the node's source text with `newText`. The node's extent is the parser's
   * own, so, for example, a `Stmt` does not include its leading comments or its `;`.
   *
   * @throws {@link ForeignNodeError} when `node` is not from this editor's parse.
   * @throws {@link InvalidNodeError} when `node` is not a syntax node.
   */
  replaceNode(node: Node, newText: string): void;

  /**
   * Queues inserting `text` immediately before the node's first character, leaving the node
   * itself untouched.
   *
   * @throws {@link ForeignNodeError} when `node` is not from this editor's parse.
   * @throws {@link InvalidNodeError} when `node` is not a syntax node.
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
    byte += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
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
function trimLineTerminatorCarriageReturn(text: string, start: number, end: number): number {
  return end > start && text[end - 1] === '\r' && text[end] === '\n' ? end - 1 : end;
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
 * The text a here-document delimiter word denotes (quotes and backslashes removed), or
 * `undefined` when the word is not made only of literal and quoted-literal parts.
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
 * Finds where each here-document body really ends, for the nodes whose reported end is wrong.
 *
 * mvdan/sh (v3.13.1) reports the last part of a here-document body, and the body word holding
 * it, as ending after the closing delimiter, so the reported range covers the delimiter line.
 * Replacing that range would delete the delimiter and leave invalid shell. The body proper ends
 * where the delimiter begins (after any `<<-` tab indentation, which `Lit.Value` includes).
 * The result maps each affected node to that UTF-16 end; a node is left out when the text at
 * the end of its range is not the redirect's delimiter, so a range is never shortened on a guess.
 */
function findHeredocBodyEnds(
  parsed: ParsedFile,
  text: string,
  byteToUtf16: Int32Array,
): Map<Node, number> {
  const ends = new Map<Node, number>();
  walk(parsed.File, (node) => {
    if (node?.Type !== 'Redirect') return true;
    const redirect: Redirect = node;
    const body = redirect.Hdoc;
    const bounds = body && parsed.Positions.get(body);
    const delimiter = redirect.Word && delimiterText(redirect.Word);
    if (!body || !bounds || delimiter === undefined || delimiter === null) return true;
    const start = byteToUtf16.at(bounds.Pos.Offset) ?? -1;
    const reportedEnd = byteToUtf16.at(bounds.End.Offset) ?? -1;
    if (start < 0 || reportedEnd < 0) return true;
    const end = trimLineTerminatorCarriageReturn(text, start, reportedEnd);
    const lineStart = text.lastIndexOf('\n', end - 1) + 1;
    if (lineStart <= start) return true;
    let delimiterStart = lineStart;
    while (text[delimiterStart] === '\t') delimiterStart += 1;
    if (text.slice(delimiterStart, end) !== delimiter) return true;
    walk(body, (inner) => {
      if (inner && parsed.Positions.get(inner)?.End.Offset === bounds.End.Offset) {
        ends.set(inner, delimiterStart);
      }
      return true;
    });
    return true;
  });
  return ends;
}

/** Where an attached comment sits in the text, and the text it holds, for matching. */
interface AttachedComment {
  readonly range: [number, number];
  readonly text: string;
}

/**
 * Records the bounds of every comment the parser attached to a statement, keyed by the byte
 * offset of its `#`.
 *
 * Those comments are reachable from the tree but absent from the parse's position snapshot,
 * and `walk` hands out a fresh object for them on every visit, so object identity cannot name
 * them. Their identity is therefore the offset of the `#` together with the comment's text.
 * Their extent comes from the live `nodePos`/`nodeEnd` taken now, before any edit could change
 * the tree. Comments the snapshot knows are left to it.
 */
function findAttachedComments(
  parsed: ParsedFile,
  byteToUtf16: Int32Array,
): Map<number, AttachedComment> {
  const found = new Map<number, AttachedComment>();
  /** Records one comment unless the snapshot already covers it. */
  function record(comment: Comment): void {
    if (parsed.Positions.get(comment) !== undefined) return;
    const start = byteToUtf16.at(nodePos(comment).Offset) ?? -1;
    const end = byteToUtf16.at(nodeEnd(comment).Offset) ?? -1;
    if (start >= 0 && end >= 0) {
      found.set(comment.Hash.Offset, { range: [start, end], text: goText(comment.Text) });
    }
  }
  walk(parsed.File, (node) => {
    if (node?.Type === 'Comment') record(node);
    if (node?.Type === 'Stmt') for (const comment of node.Comments ?? []) record(comment);
    return true;
  });
  return found;
}

/** Drops the queue bookkeeping so errors expose only the public edit shape. */
function plain(edit: QueuedEdit): TextEdit {
  return { range: [edit.range[0], edit.range[1]], text: edit.text };
}

/** Orders edits by position; at one position, empty ranges precede non-empty, then queue order. */
function compareEdits(a: QueuedEdit, b: QueuedEdit): number {
  return a.range[0] - b.range[0] || a.range[1] - b.range[1] || a.sequence - b.sequence;
}

/**
 * Starts an editing session over `text`: parse once, queue edits against nodes, apply them as
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
 * @param options - Parser options passed to `sh-ast`. Comments are kept unless `KeepComments`
 *   says otherwise, so comment nodes can be edited.
 * @returns The editing session.
 * @throws The `sh-ast` `ParseError`, `LangError` or `InputError` when `text` cannot be parsed.
 *   A `ParseError` is also thrown when the parser would silently drop text at a U+0080, its
 *   internal end-of-input marker: a tree that omitted everything after it is never returned.
 *   A U+0080 the parser reads as an ordinary character (in a quoted-delimiter heredoc body,
 *   after a backslash) is accepted.
 *
 * @public
 */
export function createEditor(text: string, options: ParseOptions = {}): Editor {
  const unsupported = endOfInputMarkerError(text, { KeepComments: true, ...options });
  if (unsupported) throw unsupported;
  const parsed = parseWithPositionsSync(text, { KeepComments: true, ...options });
  const byteToUtf16 = buildByteToUtf16(text);
  const heredocBodyEnds = findHeredocBodyEnds(parsed, text, byteToUtf16);
  const attachedComments = findAttachedComments(parsed, byteToUtf16);
  const edits: QueuedEdit[] = [];

  /** The node's UTF-16 range in `text`, or a rejection when the node is not from this parse. */
  function rangeOf(node: Node): [number, number] {
    if (!isNodeLike(node)) throw new InvalidNodeError(node);
    if (node.Type === 'Comment') {
      const attached = attachedComments.get(node.Hash.Offset);
      if (attached?.text === goText(node.Text)) {
        return [attached.range[0], attached.range[1]];
      }
    }
    const positions = parsed.Positions.get(node);
    if (positions === undefined) throw new ForeignNodeError(node);
    const start = byteToUtf16.at(positions.Pos.Offset) ?? -1;
    const end = byteToUtf16.at(positions.End.Offset) ?? -1;
    if (start < 0 || end < 0) {
      throw new RangeError(`${node.Type} bounds do not fall on character boundaries of the text`);
    }
    const bodyEnd = heredocBodyEnds.get(node);
    return [start, bodyEnd ?? trimLineTerminatorCarriageReturn(text, start, end)];
  }

  /** Queues one edit, stamping it so ties at one position resolve in queue order. */
  function queue(range: [number, number], newText: string): void {
    edits.push({ range, text: newText, sequence: edits.length });
  }

  return {
    ast: parsed.File,
    replaceNode(node, newText) {
      queue(rangeOf(node), newText);
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
