# sh-codemod

## 0.1.3

### Patch Changes

- [#9](https://github.com/mike-north/sh-codemod/pull/9) [`cb6ec62`](https://github.com/mike-north/sh-codemod/commit/cb6ec625f83aafc6d315f1370dc94d5f2913970b) Thanks [@mike-north](https://github.com/mike-north)! - Point the README at eslint-sh by name rather than by a repository link.

## 0.1.2

### Patch Changes

- [#3](https://github.com/mike-north/sh-codemod/pull/3) [`34b2c90`](https://github.com/mike-north/sh-codemod/commit/34b2c90039dc0973be56af42455267b763392e8f) Thanks [@mike-north](https://github.com/mike-north)! - Rewrite the README for users: what the package does, installation, a quickstart with real output, and the format and createEditor APIs.

## 0.1.1

### Patch Changes

- Standalone extraction. `dialect` now imports `LangVariant` from sh-ast and accepts its native numeric values, with Bash as the default. String labels are removed. Parser operation constraints remain authoritative: zero selects legacy Bash, while LangAuto is rejected. Error codes now use SH_CODEMOD. Formatting, source-preserving edits and ESM/CommonJS consumers retain their behavior.
