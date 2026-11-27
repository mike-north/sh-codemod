---
'sh-codemod': minor
---

Require the original AST objects when editing comments on statements, case items, and array elements. Read those objects from their owner's `Comments` array. Comments copied by `sh-ast`'s `walk` now throw `ForeignNodeError` when passed to the editor.

Preserve statement terminators, including when replacement text supplies the same terminator. Refuse here-document body replacements when the closing delimiter cannot be located safely, and count a leading BOM when reporting UTF-16 syntax-error positions.
