# @eslint-sh/ast-services

## 0.1.1

### Patch Changes

- [#307](https://github.com/mike-north/eslint-sh/pull/307) [`58c5c98`](https://github.com/mike-north/eslint-sh/commit/58c5c980c2aa1d293694ce9da458991ba6ae649d) Thanks [@mike-north](https://github.com/mike-north)! - Refuse formatting source with literal vertical tabs or form feeds rather than changing string values, and decode byte-valued filenames in formatting errors. Do not credit strict-mode flags from relative env interpreters or space-separated --split-string shebangs; reject that long shebang form when recognizing the interpreter. Report negative hexadecimal, octal, and base-prefixed integer array indices for older Bash targets, while ignoring zero and invalid integer spellings.

  Refuse printed ESLint replacements containing literal vertical tabs or form feeds with TypeError,
  including values introduced by an edited syntax tree. Credit shell flags in GNU env's
  `--split-string=bash -eu` shebang form. The low-level `/syntax` printer remains unchanged.

## 0.1.0

### Minor Changes

- [#191](https://github.com/mike-north/eslint-sh/pull/191) [`41634fe`](https://github.com/mike-north/eslint-sh/commit/41634feb2810a0b28a92e43e62c9aca796515c33) Thanks [@mike-north](https://github.com/mike-north)! - Add `createEditor(text, options?)`, the codemod primitive: it parses once and returns `{ ast, replaceNode, insertBefore, apply }`, applying AST-aware edits as text patches so everything outside the edited node ranges (comments, spacing, CRLF, multibyte characters) is preserved exactly. Ranges are UTF-16. Edits are placed by position: adjacent edits both apply, inserts at one position keep call order, and overlapping edits make `apply()` throw `EditOverlapError`. A node from a different parse is rejected with `ForeignNodeError`, and a non-node argument with `InvalidNodeError`. Here-document bodies are edited without their closing delimiter. The result is not re-parsed.

- [#187](https://github.com/mike-north/eslint-sh/pull/187) [`c22e54e`](https://github.com/mike-north/eslint-sh/commit/c22e54e4e20349a66ae0e21f46a0d4725687fdbe) Thanks [@mike-north](https://github.com/mike-north)! - Add the `@eslint-sh/ast-services` package with `format(text, options?)`, which returns canonical shfmt-style text by parsing and printing through `sh-ast`. Options are the printer's options plus the parse `Variant` and `Filename`, typed from `sh-ast`. Formatting is idempotent for every printer option except `KeepPadding` (and `SingleLine` can print invalid shell for a `case` followed by a statement); both are upstream printer behavior, documented in the README. A syntax error throws `FormatSyntaxError` (carrying UTF-16 `offset`, `line` and `column`) rather than returning partial output. The package ships ESM and CommonJS builds.

- [#281](https://github.com/mike-north/eslint-sh/pull/281) [`91c20e0`](https://github.com/mike-north/eslint-sh/commit/91c20e06f60d36cac04d25ddc34788af36f5964e) Thanks [@mike-north](https://github.com/mike-north)! - A file in which the parser silently drops text at a U+0080 now fails with a fatal parse error at that character instead of being linted only up to it. The parser reads U+0080 as end of input in some positions (a comment, an unquoted word, the start of the file, a word or line of its own at the end of the file, an unquoted heredoc delimiter): it returned a tree for the text before the character with no error, and every rule silently skipped the rest of the file (an `eval` after it went unreported). `format` likewise returned only the code before the character, and now throws `FormatSyntaxError`; `createEditor` now throws a `ParseError` instead of returning the truncated tree. A U+0080 the parser reads as an ordinary character (the body of a heredoc with a quoted delimiter, after a backslash, at the end of a word or comment) loses nothing and keeps linting, formatting and editing as before, and one the parser rejects (inside quotes, `$'...'`, `$(...)`, a case pattern, an unquoted heredoc body) keeps the parser's own error.
