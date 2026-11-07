# sh-codemod

## 0.1.1

Standalone extraction. `dialect` now imports `LangVariant` from sh-ast and accepts its native numeric values, with Bash as the default. String labels are removed. Parser operation constraints remain authoritative: zero selects legacy Bash, while LangAuto is rejected. Error codes now use SH_CODEMOD. Formatting, source-preserving edits and ESM/CommonJS consumers retain their behavior.
