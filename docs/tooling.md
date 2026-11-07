# Repository tooling

Use Node 24.14.0, native pnpm 12.16.1 and TypeScript 6.0.3. Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check`, then `pnpm test`. Tests cap Vitest at two workers. Strict checking covers source, tests, authored type fixtures, build helpers and configuration. Suppressions require individual durable reasons; unused suppressions fail.

`pnpm build` emits ESM/CJS runtime files and matching `.d.ts`/`.d.cts` rollups. `pnpm check:api-report` checks the reviewed root signature and the complete generated page set. `pnpm build:docs` explicitly accepts report/documentation updates. Input `dist/index.d.ts` is separate from the published rollup. Real packed consumers verify both module and declaration routes.

Independent `check:changesets` (G1) rejects parsed major intent. `check:versions` (G2) checks valid full 0.x SemVer in nonprivate source manifests and every actual planned release, including private/inferred/type-none/prerelease releases. Private source metadata alone is exempt. Only Mike removes the stability policy; there is no override. The pinned Changesets CLI 3.0.3 and matching planner APIs work from present inputs without Git eligibility. `version:packages` is an explicit local version preparation command with a lock-only refresh; ordinary checks never repair inputs.

CI runs on every push/PR with read-only authority, independent visible G1/G2/map steps and build/check/test. `test:ecosystem-map` pins the owner's exact canonical v3 bytes. Formatting deliberately excludes AGENTS.md so those bytes cannot be rewritten.

The Release workflow runs only by owner dispatch on main in mike-north/sh-codemod, actor mike-north, environment npm, on a hosted runner. Runtime wrappers repeat the authority/OIDC guards. Native npm >=11.5.1 on Node 24 handles OIDC; pnpm packs real archives. [Official npm documentation](https://docs.npmjs.com/trusted-publishers/) distinguishes authentication from provenance: this private repository makes no provenance claim. No token fallback or automatic publication is configured.

`release:plan` uses the actual installed CLI publish-plan for registry-aware eligibility. `release:publish` validates the entire plan, current public source identity, 0.x versions, access/tags and uniqueness before packing all archives. It inspects actual archive manifests and dependency specifier values before native npm receives exact archive paths. Source and archive publication configuration reject registry, credential and provenance overrides. Temporary archives are cleaned on success and failure. An already-published plan is an explicit no-op. The singleton public root participates in both planners.

Trust registration, first publication and owner commissioning remain external and unverified. Existing setup helpers are not part of validation. Tests use only local fake registry/upload clients; real packing and empty-cache consumers establish packaging behavior, not working external OIDC.
