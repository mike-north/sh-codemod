# sh-codemod

Syntax-aware rewriting of shell scripts on top of sh-ast: whole-script formatting in shfmt style through the parser's own printer, and targeted edits that leave every other byte alone. Extracted from eslint-sh's ast-services package; it is neither lint nor an ESLint fix, so it lives on its own.

Depends on sh-ast only. The printer is sh-ast's; this package wraps it. Command harvesting belongs to sh-analysis, not here.

Docs-first: see docs/ once written. Releases stay in the 0.x series until the owner removes the check.
