/** Exposes the non-lint services over the `sh-ast` parser as one package boundary. */
export { format, type FormatOptions } from './format.js';
export { FormatSyntaxError } from './format-syntax-error.js';
export { createEditor, type Editor } from './editor.js';
export {
  EditOverlapError,
  ForeignNodeError,
  InvalidNodeError,
  type TextEdit,
} from './edit-errors.js';
