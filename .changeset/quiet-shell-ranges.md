---
'sh-codemod': patch
---

Preserve statement terminators and refuse here-document body replacements when the closing delimiter cannot be located safely. Require attached comments to belong to the editor's parse, and count a leading BOM when reporting UTF-16 syntax-error positions.
