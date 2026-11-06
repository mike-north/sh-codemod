# @eslint-sh/ast-services

Non-lint services over the [`sh-ast`](https://github.com/mike-north/sh-ast) shell parser:

- `format` rewrites a whole shell script into the canonical text of mvdan/sh's printer (the
  `shfmt` style). Whole-file reformatting does not fit ESLint's text-range fix model, so it lives
  here instead of in `@eslint-sh/eslint-plugin`.
- `createEditor` makes AST-aware edits (a codemod) that leave every other byte of the file alone.
  ESLint's fixer only runs inside a lint pass, and a reprint would reformat the whole file.

> **Not on npm yet.** This package is marked `private` until its first publish is set up, so
> `npm install @eslint-sh/ast-services` does not work today. It is versioned with the other
> packages and can be packed from this repository.

The package is on the 0.x line: its surface may change between minor releases.

## Installation

```sh
npm install @eslint-sh/ast-services
```

Requires Node 22.12 or later. It ships ESM and CommonJS builds; the CommonJS build loads the
ESM-only `sh-ast` with `require`, which Node supports from 22.12.

```js
import { format } from '@eslint-sh/ast-services'; // or: const { format } = require('@eslint-sh/ast-services');
```

## `format(text, options?)`

```js
import { format } from '@eslint-sh/ast-services';

format('if true;then\n    echo   hi # greet\nfi');
// 'if true; then\n\techo hi # greet\nfi\n'
```

`format` parses `text` and prints the syntax tree, so the result depends only on the tree:

- Indentation, spacing and runs of blank lines are normalized (a single blank line is kept).
- Comments and here-document bodies are kept verbatim; `\r\n` line endings come out as `\n`.
- The result ends in a newline. An empty input formats to `"\n"`.
- Formatting is idempotent, `format(format(x)) === format(x)`, for every option except the two listed under [Known exceptions](#known-exceptions).

### Options

`FormatOptions` combines the project's `dialect` and `filename` with `sh-ast`'s
`PrintOptions`. Printer knobs retain the pinned mvdan/sh spellings and meanings.

| Option             | Type               | Default    | Effect                                                                                       |
| ------------------ | ------------------ | ---------- | -------------------------------------------------------------------------------------------- |
| `Indent`           | `number \| bigint` | `0` (tabs) | Spaces per indentation level; `0` indents with tabs.                                         |
| `BinaryNextLine`   | `boolean`          | `false`    | Put a multiline binary operator such as `\|` on the next line, after a `\`.                  |
| `SwitchCaseIndent` | `boolean`          | `false`    | Indent `case` alternatives; their bodies go two levels below the `case`.                     |
| `SpaceRedirects`   | `boolean`          | `false`    | Space after redirection operators (`> out`), except `>&`, `<&`, `>(` and `<(`.               |
| `FunctionNextLine` | `boolean`          | `false`    | Put a function's opening brace on the next line.                                             |
| `Minify`           | `boolean`          | `false`    | Drop comments, indentation and optional whitespace. Not allowed with `SingleLine`.           |
| `SingleLine`       | `boolean`          | `false`    | Print on one line where possible (newlines after comments and around here-documents remain). |
| `KeepPadding`      | `boolean`          | `false`    | Best-effort column preservation. Deprecated upstream, which plans to remove it.              |
| `dialect`          | `ShellDialect`     | `"bash"`   | Grammar label: `"bash"`, `"posix"`, `"mksh"`, `"bats"` or `"zsh"`.                           |
| `filename`         | `string`           | none       | Name used in syntax-error messages and on `FormatSyntaxError.filename`.                      |

```js
import { format } from '@eslint-sh/ast-services';

format(script, { Indent: 2, SwitchCaseIndent: true, dialect: 'posix', filename: 'deploy.sh' });
```

Not exposed, on purpose: `RecoverErrors` would let malformed input through as a repaired tree,
and `StopAt` would silently drop the rest of the file. Both would break the rule that `format`
never loses or invents code. `KeepComments` is always on (a `Minify` print omits comments by
definition).

### Known exceptions

Both come from the upstream printer. `format` reports its output as is and does not work around them.

- **`KeepPadding: true` is not idempotent.** The printer keeps padding "best-effort", so a second pass can change spacing the first kept. For example `echo x   # d` inside a function body prints as `echo x  # d`, and formatting that prints `echo x # d`; `echo  b` in a `case` body shrinks the same way. Upstream deprecates the option and plans to remove it.
- **`SingleLine: true` can print invalid shell.** A statement after a `case` is joined without a `;`, so `case $x in a) :;; esac` followed by `if a; then b; fi` prints `case $x in a) : ;; esac if a; then b; fi`, which does not parse. `format` does not re-parse its output, so it returns that text. Check `SingleLine` output on your scripts before relying on it.

Idempotence was checked for every other printer option alone and in combinations (`Indent` 2, 4 and 8, `BinaryNextLine`, `SwitchCaseIndent`, `SpaceRedirects`, `FunctionNextLine`, `Minify`) on sources with here-documents, comments, multibyte text and CRLF.

### Errors

A syntax error, including a construct the selected `dialect` does not allow, throws
`FormatSyntaxError`. `format` never returns partial output.

```js
import { format, FormatSyntaxError } from '@eslint-sh/ast-services';

try {
  format('echo ok\necho "never closed\n', { filename: 'a.sh' });
} catch (error) {
  if (error instanceof FormatSyntaxError) {
    error.message; // 'a.sh:2:6: reached EOF without closing quote `"`'
    error.line; // 2
    error.column; // 6
    error.offset; // 13
  }
}
```

| Property     | Meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `code`       | `'ESLINT_SH_FORMAT_SYNTAX'`, stable across releases.                                 |
| `offset`     | Zero-based UTF-16 index into the string you passed (`text[offset]` is the position). |
| `line`       | One-based line; a `\r\n` pair is one line break.                                     |
| `column`     | One-based UTF-16 column, as ESLint reports it.                                       |
| `byteOffset` | The parser's zero-based UTF-8 offset, for tools that address bytes.                  |
| `filename`   | The `filename` option, if given.                                                     |
| `cause`      | The underlying `sh-ast` `ParseError` or `LangError`.                                 |

Other `sh-ast` failures are thrown as they are: `PrintError` for incompatible printer options
(`Minify` together with `SingleLine`), and `InputError` for text that is not well-formed Unicode
or a rejected upstream printer option. Invalid project options throw `TypeError` with `ESLINT_SH_SERVICE_OPTION` before parsing. `Variant` and `Filename` are not accepted.

## `createEditor(text, options?)`

`createEditor` parses `text` once and lets you queue edits against the nodes of that parse.
`apply()` splices the edits into the original text. Nothing is reprinted, so everything outside
the edited node ranges (comments, odd spacing, `\r\n` line endings, multibyte characters) comes
back exactly as it went in.

<!-- codemod-example -->

```js
import { createEditor } from '@eslint-sh/ast-services';
import { walk } from 'sh-ast';

// Codemod: replace the non-portable `which` with `command -v`, and add `set -eu` on top.
const source = '#!/bin/sh\n# find 🎉 tools\nwhich   git  # where?\nwhich 你好\n';

const editor = createEditor(source);

walk(editor.ast, (node) => {
  if (node?.Type === 'CallExpr') {
    const command = node.Args?.[0];
    const first = command?.Parts?.[0];
    if (command && first?.Type === 'Lit' && first.Value === 'which') {
      editor.replaceNode(command, 'command -v');
    }
  }
  return true;
});

const firstStatement = editor.ast.Stmts?.[0];
if (firstStatement) editor.insertBefore(firstStatement, 'set -eu\n');

export const result = editor.apply();
// '#!/bin/sh\n# find 🎉 tools\nset -eu\ncommand -v   git  # where?\ncommand -v 你好\n'
```

The editor is `{ ast, replaceNode, insertBefore, apply }`:

| Member                       | Meaning                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `ast`                        | The parsed `File`, typed by `sh-ast`. Walk it with `sh-ast`'s `walk` to find nodes.             |
| `replaceNode(node, newText)` | Queue replacing the node's source text.                                                         |
| `insertBefore(node, text)`   | Queue inserting `text` immediately before the node's first character.                           |
| `apply()`                    | Return the original text with all queued edits applied. May be called again after queuing more. |

`options` are `{ dialect?: ShellDialect, filename?: string }`, with Bash as the default. Comments are always kept. Removed parser-option spellings are rejected. A parse failure throws the `sh-ast` error unchanged.

### Edit rules

Edits are placed by their position in the _original_ text, not by the order you queued them.

- **Adjacent edits** (one ends exactly where the next begins) are both applied.
- **Insertions at one position** appear in the order `insertBefore` was called.
- **An insertion at the start of a replaced node** comes before the replacement, whichever you
  queued first. An insertion at the _end_ of a replaced node (that is, before the node that
  follows it) comes after the replacement.
- **Overlapping edits throw.** Two replacements of the same node, a node and its ancestor, or an
  insertion strictly inside a replaced node make `apply()` throw `EditOverlapError`, with the
  conflicting pair on `first` and `second` and the stable `code` `'ESLINT_SH_EDIT_OVERLAP'`. No
  partial text is returned.
- **Foreign nodes are rejected.** `replaceNode` and `insertBefore` throw `ForeignNodeError`
  (`code` `'ESLINT_SH_EDIT_FOREIGN_NODE'`) for a node that did not come from this editor's own
  parse, including one from another `createEditor` call over the same text, and a
  `structuredClone` of a node. A value that is not a node at all (for example `undefined`) throws `InvalidNodeError` (`'ESLINT_SH_EDIT_INVALID_NODE'`).

### Ranges

Ranges are UTF-16 indices into the string you passed, the same units as ESLint ranges and
`String#slice`, so they are correct after emoji, CJK text and combining marks. The node extents
are the parser's: a `Stmt` does not include its leading comments or its terminating `;`, and a
`File` spans from its first to its last token. Two ranges the parser reports too wide are
narrowed so they cannot eat structure: a word that ends a `\r\n` line is edited without its
`\r`, and the body of a here-document (including `<<-` and CRLF forms) is edited without its
closing delimiter, so replacing a body never produces an unterminated here-document. Replacing the
whole `Redirect` or `Stmt` still replaces the delimiter, because it is inside the node.

### Limits

- The result is not re-parsed. If you need to know a codemod produced valid shell, parse the
  output (for example with `createEditor(result)`).
- Comments the parser attaches to a statement (leading, trailing, between statements) are
  edited like any node, but `sh-ast` hands out a fresh object for them on every `walk`, so
  they are recognized by the position of their `#` and their text rather than by object
  identity. A comment copied from another parse that has the same text at the same offset is
  therefore accepted, and edits the same bytes.

## Differences from prettier-plugin-sh

[`prettier-plugin-sh`](https://github.com/un-ts/prettier) formats shell through the same
mvdan/sh printer, behind Prettier. This package calls the printer directly, so there is no
Prettier dependency and the printer options version-lock to the `sh-ast` this package pins.
Compared with its [documented options](https://www.npmjs.com/package/prettier-plugin-sh) (v0.20):

| prettier-plugin-sh                                                                                                                                                  | `@eslint-sh/ast-services`                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs inside Prettier; formats by file type                                                                                                                          | A function on strings: `format(text, options)`. No file discovery, no config files, no CLI.                                                                                                                                             |
| Also formats Dockerfile, `.properties`, `.gitignore`, dotenv, hosts, jvmoptions                                                                                     | Shell only.                                                                                                                                                                                                                             |
| Option names are camelCase (`indent`, `binaryNextLine`, `switchCaseIndent`, `spaceRedirects`, `keepPadding`, `minify`, `singleLine`, `functionNextLine`, `variant`) | The printer's own spellings: `Indent`, `BinaryNextLine`, `SwitchCaseIndent`, `SpaceRedirects`, `KeepPadding`, `Minify`, `SingleLine`, `FunctionNextLine`. Grammar and source names use the project vocabulary `dialect` and `filename`. |
| `binaryNextLine` documented as default `true`                                                                                                                       | `BinaryNextLine` defaults to `false`: every printer option is off unless you set it.                                                                                                                                                    |
| `keepComments` documented as default `true`                                                                                                                         | Comments are always kept (except under `Minify`); there is no option.                                                                                                                                                                   |
| `simplify` option (removes redundant syntax)                                                                                                                        | Not available: `sh-ast` exposes the printer, not mvdan/sh's `Simplify`.                                                                                                                                                                 |
| `stopAt` and `recoverErrors` parser options                                                                                                                         | Not exposed, because they can drop or repair code. See above.                                                                                                                                                                           |
| Indentation also follows Prettier's `useTabs` / `tabWidth`                                                                                                          | Only `Indent`.                                                                                                                                                                                                                          |
| Syntax errors surface as Prettier errors                                                                                                                            | `FormatSyntaxError` with UTF-16 `offset`, `line` and `column`.                                                                                                                                                                          |

The defaults above come from the plugin's published README; if you migrate, set the options
explicitly (for example `BinaryNextLine: true`) to get the output you had before.

The [canonical error-code reference](https://github.com/mike-north/eslint-sh/blob/main/packages/eslint-plugin/docs/error-codes.md) lists service, plugin and dependency failure identities. Match codes rather than message text.
