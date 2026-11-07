/** Service-owned edit failures expose conflicting or unowned source ranges without partial output. */
import type { Node } from 'sh-ast';

/**
 * One text replacement: the half-open UTF-16 `range` of the original text that `text` takes
 * the place of. An insertion is a replacement whose range is empty.
 *
 * @public
 */
export interface TextEdit {
  /** Half-open `[start, end)` indices into the string passed to `createEditor`. */
  range: [number, number];
  /** The text that replaces that range. */
  text: string;
}

/**
 * Thrown by `apply()` when two accumulated edits claim the same text, so no output could honor
 * both.
 *
 * It exists so a caller can tell "my edits conflict" from every other failure, and can see
 * which edits conflict. An edit set that conflicts never yields output: silently choosing a
 * winner would corrupt the file in a way no later check could attribute.
 *
 * @public
 */
export class EditOverlapError extends Error {
  /** Stable machine-readable identity of this error, independent of its message text. */
  readonly code = 'SH_CODEMOD_EDIT_OVERLAP';

  /** The earlier of the two conflicting edits, in position order. */
  readonly first: TextEdit;

  /** The later of the two conflicting edits; it begins before `first` ends. */
  readonly second: TextEdit;

  /**
   * Builds the error for a conflicting pair; `createEditor`'s `apply` is the intended caller.
   *
   * @param first - The earlier edit in position order.
   * @param second - The later edit, which starts inside `first`.
   */
  constructor(first: TextEdit, second: TextEdit) {
    super(
      `Edits overlap: [${String(first.range[0])}, ${String(first.range[1])}) and ` +
        `[${String(second.range[0])}, ${String(second.range[1])}) both claim the same text`,
    );
    this.name = 'EditOverlapError';
    this.first = first;
    this.second = second;
  }
}

/**
 * Thrown by an editor's `replaceNode` and `insertBefore` when the node did not come from that
 * editor's own parse.
 *
 * A node's position is only meaningful against the text it was parsed from. Applying a node
 * from another parse (or a `structuredClone` of one, which keeps its stale offsets) would edit
 * whatever happens to sit at those offsets in this text, so it is refused up front.
 *
 * @public
 */
export class ForeignNodeError extends Error {
  /** Stable machine-readable identity of this error, independent of its message text. */
  readonly code = 'SH_CODEMOD_EDIT_FOREIGN_NODE';

  /** The node that was rejected. */
  readonly node: Node;

  /**
   * Builds the error for a rejected node.
   *
   * @param node - The node that this editor's parse did not produce.
   */
  constructor(node: Node) {
    super(
      `Cannot edit a ${node.Type} node that does not belong to this editor's parse`,
    );
    this.name = 'ForeignNodeError';
    this.node = node;
  }
}

/**
 * Thrown by an editor's `replaceNode` and `insertBefore` when the argument is not a syntax node
 * at all (for example `undefined` from a failed lookup).
 *
 * TypeScript callers cannot reach it; it exists so a JavaScript caller gets a named, actionable
 * failure rather than an incidental `TypeError` from inside the editor.
 *
 * @public
 */
export class InvalidNodeError extends Error {
  /** Stable machine-readable identity of this error, independent of its message text. */
  readonly code = 'SH_CODEMOD_EDIT_INVALID_NODE';

  /** What was passed in place of a node. */
  readonly received: unknown;

  /**
   * Builds the error for a non-node argument.
   *
   * @param received - The value that was passed where a node was required.
   */
  constructor(received: unknown) {
    super(
      `Expected a syntax node from this editor's \`ast\`, received ${describe(received)}`,
    );
    this.name = 'InvalidNodeError';
    this.received = received;
  }
}

/** Names a rejected value for an error message without printing its contents. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object without a string `Type`';
  return typeof value;
}
