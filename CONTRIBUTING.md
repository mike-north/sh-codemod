# Contributing to sh-codemod

Bug reports, test cases from real scripts, and fixes are welcome.

## Before you start

- Search the [issues](https://github.com/mike-north/sh-codemod/issues) first.
- For anything larger than a small fix, open an issue to agree on the approach.
- Report security problems privately as described in [SECURITY.md](SECURITY.md).
- Read the responsibilities in [AGENTS.md](AGENTS.md). This package formats whole files and
  preserves source around AST edits; parsing and shell analysis belong elsewhere.

## Set up

Use Node 24.14.0 and pnpm 12.16.1, as described in [repository tooling](docs/tooling.md).

```sh
git clone https://github.com/mike-north/sh-codemod.git
cd sh-codemod
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

All four commands after cloning must pass before opening a pull request. `pnpm check` runs the
static, formatting, API, release and ecosystem-map checks. `pnpm test` runs product and tooling
tests, including packed consumers. `pnpm fix:format` fixes formatting.

## Writing tests and code

- Write outcome tests first, based on the specification or intended behavior, and watch them fail.
- Add a regression test for a bug fix and cover inputs that must be rejected.
- Explain durable meaning and guarantees in comments. Each lint suppression needs a narrow reason.
- Preserve the parser's numeric language values, public errors, and ESM and CommonJS export routes.

## Public API changes

After an intentional API change, run `pnpm build` and `pnpm build:docs`; review and commit the
updated API report and generated documentation. CI checks the committed API surface.

## Changesets and versions

The package stays in the 0.x series. A change that ships in the npm package needs a changeset:

```sh
pnpm exec changeset
```

Use `patch` for fixes and `minor` for new or breaking API. Major releases are rejected. Tooling-only
changes need no changeset.

## Pull requests

- Keep each pull request focused and describe what changed, why, and how it was verified.
- CI must pass. Pull requests need an approving maintainer review before merge.
- Releases follow the reviewed Changesets flow described in [repository tooling](docs/tooling.md).
