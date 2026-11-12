# sh-codemod

[![npm version](https://img.shields.io/npm/v/sh-codemod)](https://www.npmjs.com/package/sh-codemod)
[![CI](https://github.com/mike-north/sh-codemod/actions/workflows/ci.yml/badge.svg)](https://github.com/mike-north/sh-codemod/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/sh-codemod)](LICENSE)

Whole-file shell formatting and source-preserving AST edits for JavaScript and TypeScript, built
on the [`sh-ast`](https://github.com/mike-north/sh-ast) shell parser:

- `format` rewrites a whole shell script into the canonical text of mvdan/sh's printer (the
  `shfmt` style).
- `createEditor` makes AST-aware edits (a codemod) that leave every other byte of the file alone.

## When to use it

Use `sh-codemod` when a program needs to **change** shell source. Use
`eslint-sh` when you need to **check** it.

ESLint fixes are text-range replacements that run inside a lint pass. They cannot reformat a
whole file, and they are not available to a script that is not running ESLint. `sh-codemod`
covers those cases: reformatting an entire script, and codemods that rewrite one construct (every
`which` becomes `command -v`, a line is added to the top of every script) without disturbing the
comments, spacing and line endings around it. It does not parse (that is `sh-ast`), lint, or
analyze shell.

## Installation

```sh
npm install sh-codemod
```

Requires Node 24 or later. The package ships ESM and CommonJS builds with TypeScript declarations;
the CommonJS build loads the ESM-only `sh-ast` with `require`, using Node's synchronous ESM loading
support. The package is on the 0.x line, so its surface may change between minor releases.

```js
import { format } from 'sh-codemod'; // or: const { format } = require('sh-codemod');
```

## Quickstart

```js
import { createEditor, format } from 'sh-codemod';

console.log(
  format('if [ -f a ];then\n    echo   hi # greet\nfi\n', { Indent: 2 }),
);
// if [ -f a ]; then
//   echo hi # greet
// fi

const editor = createEditor('which   git  # where?\n');
editor.replaceNode(editor.ast.Stmts[0].Cmd.Args[0], 'command -v');
console.log(JSON.stringify(editor.apply()));
// "command -v   git  # where?\n"
```

`format` re-prints the whole script. `createEditor` changed only the one word, so the extra
spaces and the comment survive. The sections below cover each function in full.

## Documentation

- [API reference](docs/api/index.md), generated from the package's declarations and checked in CI.
- [CHANGELOG](CHANGELOG.md), maintained by Changesets from the changes in each release.
- [Repository tooling](docs/tooling.md), for how the package is built, checked and released.
- [Contributing](CONTRIBUTING.md), for development and pull request guidance.
- [Security policy](SECURITY.md), for reporting vulnerabilities.
- [LICENSE](LICENSE), MIT.

## `format(text, options?)`

```js
import { format } from 'sh-codemod';

format('if true;then\n    echo   hi # greet\nfi');
// 'if true; then\n\techo hi # greet\nfi\n'
```

`format` parses `text` and prints the syntax tree, so the result depends only on the tree:

- Indentation, spacing and runs of blank lines are normalized (a single blank line is kept).
- Comments and here-document bodies are kept verbatim; `\r\n` line endings come out as `\n`.
- The result ends in a newline. An empty input formats to `"\n"`.
- Formatting is idempotent, `format(format(x)) === format(x)`, for every option except the two listed under [Known exceptions](#known-exceptions).

### Options

`FormatOptions` combines the producer-native `dialect` and diagnostic `filename` with `sh-ast`'s
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
| `dialect`          | `LangVariant`      | `LangBash` | Numeric language value imported from `sh-ast`; the parser decides operation validity.        |
| `filename`         | `string`           | none       | Name used in syntax-error messages and on `FormatSyntaxError.filename`.                      |

```js
import { LangPOSIX } from 'sh-ast';
import { format } from 'sh-codemod';

format(script, {
  Indent: 2,
  SwitchCaseIndent: true,
  dialect: LangPOSIX,
  filename: 'deploy.sh',
});
```

`LangVariant` is re-exported directly from `sh-ast`. This extraction deliberately replaces
string grammar labels with producer-native numeric values. Import constants such as
`LangPOSIX` from `sh-ast`; there are no string aliases or local language membership lists.
The type describes known language values, not a promise that every parser operation accepts
each member: the pinned `sh-ast@0.10.0` parser treats zero as legacy Bash and rejects
`LangAuto` with `SH_AST_SYNTAX_INPUT`. Numeric validation remains the parser's responsibility.
Non-numeric dialects, invalid filenames and removed option names retain service-option errors.

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
import { format, FormatSyntaxError } from 'sh-codemod';

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
| `code`       | `'SH_CODEMOD_FORMAT_SYNTAX'`, stable across releases.                                |
| `offset`     | Zero-based UTF-16 index into the string you passed (`text[offset]` is the position). |
| `line`       | One-based line; a `\r\n` pair is one line break.                                     |
| `column`     | One-based UTF-16 column, as ESLint reports it.                                       |
| `byteOffset` | The parser's zero-based UTF-8 offset, for tools that address bytes.                  |
| `filename`   | The `filename` option, if given.                                                     |
| `cause`      | The underlying `sh-ast` `ParseError` or `LangError`.                                 |

Other `sh-ast` failures are thrown as they are: `PrintError` for incompatible printer options
(`Minify` together with `SingleLine`), and `InputError` for text that is not well-formed Unicode
or a rejected upstream printer option. Invalid project options throw `TypeError` with `SH_CODEMOD_SERVICE_OPTION` before parsing. `Variant` and `Filename` are not accepted.

## `createEditor(text, options?)`

`createEditor` parses `text` once and lets you queue edits against the nodes of that parse.
`apply()` splices the edits into the original text. Nothing is reprinted, so everything outside
the edited node ranges (comments, odd spacing, `\r\n` line endings, multibyte characters) comes
back exactly as it went in.

<!-- codemod-example -->

```js
import { createEditor } from 'sh-codemod';
import { walk } from 'sh-ast';

// Codemod: replace the non-portable `which` with `command -v`, and add `set -eu` on top.
const source =
  '#!/bin/sh\n# find 🎉 tools\nwhich   git  # where?\nwhich 你好\n';

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

`options` are `{ dialect?: LangVariant, filename?: string }`, with Bash as the default. Comments are always kept. Removed parser-option spellings are rejected. A parse failure throws the `sh-ast` error unchanged. Numeric variant refusals also pass through unchanged.

### Edit rules

Edits are placed by their position in the _original_ text, not by the order you queued them.

- **Adjacent edits** (one ends exactly where the next begins) are both applied.
- **Insertions at one position** appear in the order `insertBefore` was called.
- **An insertion at the start of a replaced node** comes before the replacement, whichever you
  queued first. An insertion at the _end_ of a replaced node (that is, before the node that
  follows it) comes after the replacement.
- **Overlapping edits throw.** Two replacements of the same node, a node and its ancestor, or an
  insertion strictly inside a replaced node make `apply()` throw `EditOverlapError`, with the
  conflicting pair on `first` and `second` and the stable `code` `'SH_CODEMOD_EDIT_OVERLAP'`. No
  partial text is returned.
- **Foreign nodes are rejected.** `replaceNode` and `insertBefore` throw `ForeignNodeError`
  (`code` `'SH_CODEMOD_EDIT_FOREIGN_NODE'`) for a node that did not come from this editor's own
  parse, including one from another `createEditor` call over the same text, and a
  `structuredClone` of a node. A value that is not a node at all (for example `undefined`) throws `InvalidNodeError` (`'SH_CODEMOD_EDIT_INVALID_NODE'`).

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

| prettier-plugin-sh                                                                                                                                                  | `sh-codemod`                                                                                                                                                                                                                            |
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

Match the service codes documented above or the producer's `SH_AST_*` codes rather than message text.

## Local development

Use Node 24 and native pnpm 12.16.1. Run `pnpm install --frozen-lockfile`, `pnpm build`,
`pnpm check` and `pnpm test`. `pnpm pack` rebuilds both module formats and declarations
from source after cleaning `dist`, so stale outputs cannot enter the package.
The test suite installs an actual tarball into an isolated ESM/CommonJS consumer and checks
both runtime behavior and declaration resolution. Checks cover strict TypeScript and the
inherited API report; the broader tooling/release standards are a separate assignment.

Runtime dependency: `sh-ast@0.10.0` only. The public root `parseSync` and `printSync` own
parsing and printing. This package bundles no Go/WASM, ESLint, analysis or harvesting code.
`createEditor` applies source slices and does not invoke the printer or reparse its result.
