# sh-codemod responsibilities

sh-codemod owns whole-file shell formatting and source-preserving AST edits over sh-ast.
It does not own parsing, grammar, lint policy, analysis, harvesting, or the Go/WASM binding.
Preserve producer-native numeric LangVariant, public errors and ESM/CJS export routes.

Write outcome tests first. Document durable semantic intent for modules, types, constants,
functions and classes. Keep progress in work records. Every suppression needs a narrow reason.
Only the maintainer decides stabilization beyond 0.x, merging and publication.
Tooling never commissions npm trust or a first publication.
No implicit merge, registry, tag or release authority exists.

<!-- ecosystem-map:begin -->
# Ecosystem map

Map version: 3. This file is kept verbatim, byte for byte, in every repository of the
ecosystem. It changes only by a decision of the owner (Mike North), with the version number
raised, and the new text is then copied to every repository in one pass. A copy that differs
from the others is a defect in that repository, not a local variant. Nothing in this file names
a branch, a commit, a terminal, a date, or a person other than the owner, so that it never has to
change for operational reasons.

## Purpose of the ecosystem

Agents propose tools (small programs) for their own autonomous use. While proposing, the agent
gets fast feedback on what the tool reaches and whether that fits policy. A human reviews and
approves quickly, on GitHub. Approved tools become eligible for unattended use, and the human is
told when an approved tool changes in a way that warrants another look.

Six layers each own one concern, and one delivery component (sarif-to-comment) carries
results into code review. Work that belongs to another layer goes there, even when
it would be quicker to do it here. When a needed capability sits in another layer and does not
exist yet, add it there, or record the gap in that repository, rather than approximating it here.

## Layers

### sh-ast

Owns: shell syntax. A faithful TypeScript binding, through WebAssembly, of our own maintained
Go fork of mvdan/sh (mike-north/sh): the AST and its types, positions, traversal, printing. The
grammar itself lives in the fork. Any fix the ecosystem needs in the grammar or lexer lands in
the fork and arrives here through the binding; we never wait on an upstream mvdan/sh pull
request being accepted.

Must not: interpret words, resolve commands, track working directories, or express any policy.
Decide shell structure from source text in TypeScript: where a token, word, quoted string, or
heredoc body begins and ends is the parser's answer, read from AST nodes and positions, never
recomputed by scanning the text.

Straying signs: TypeScript that scans shell text to find structure (a lexer, tokenizer, or
heredoc scanner) anywhere in the ecosystem. A guard that derives every position from sh-ast
nodes is consumption of the binding and is allowed; if such a guard exists only because the
binding's positions are imprecise, that imprecision is a sh-ast (or fork) defect to fix in the
fork.

### sh-analysis

Owns: higher-level syntactic constructs over sh-ast, so that common analysis needs are easy to
express: word resolution, command sites and argv0, wrapper chains (sudo, env, command, xargs and
the like), interpreter invocations, working-directory and path facts, each with explicit
uncertainty. Command and dependency harvesting (what a script invokes) lives here. These are
facts about the text, not about what a command means: sh-analysis can say "argv0 resolves to
curl with these arguments"; it never says "this reaches the network".

Must not: parse shell itself, decide what is allowed, format diagnostics, or know about ESLint,
hosts, or agents.

Straying signs: code that returns a verdict, a severity, or advice instead of a fact.

### eslint-sh

Owns: lint policy for shell files on disk. The ESLint language for shell, rules, presets, fixes,
and the projection of sh-analysis facts into diagnostics. Exposes the shell evaluator that
toolprep compiles its policy into.

Must not: intercept commands at run time, reimplement word or command resolution, or approve
tools.

Straying signs: code that reads hook payloads, sockets, or live commands; a rule that resolves
words or enumerates commands itself instead of asking sh-analysis.

### command-steering

Owns: invocation-time steering of an agent's shell commands, on syntax alone. The rule schema
(predicate and action), the engine, host adapters, the daemon and shell shim, decision logs. It
consumes sh-ast and sh-analysis to canonicalize the command it sees. Rule predicates are
authored type-safely with celscript (mike-north/celscript) and evaluated as CEL at runtime;
a predicate may match resolved words and arguments however it likes, regular expressions
included. It owns the externally registrable rule format that other layers register into, and
never knows why a rule exists. An "ask" action may be delivered through allw (mike-north/allw),
the human-in-the-loop primitive, so the human can answer with more than yes or no (for example
"approve and amend the policy"); steering works without allw, and works best with it.

Must not: build, vet, or approve tools; act as a sandbox or permission system; understand what a
command means (secrets, network reach, file effects); reimplement parsing or analysis.

Straying signs: code that stages, hashes, or approves a tool; code that runs regular expressions
over the raw command text to find words or commands instead of asking sh-analysis; a rule
language of its own instead of CEL; any wish to know what a command means rather than what it
looks like. A semantic signal steering needs is a rule another layer registers; it is never
understanding steering grows.

### toolprep

Owns: assessment and readiness of executables a host will run, whoever wrote them (shell
scripts, shebang'd TypeScript modules, hooks, plugin scripts, MCP server launch commands);
agent-authored tools are one subject among many. One semantic reach policy, the user-facing
policy surface: what a program executes, reaches over the network,
reads, writes, and whether it touches credentials, with allow and deny lists, exceptions keyed
by subject and rule with a required reason, and compilation of the policy into per-language
lint presets. A coverage report saying at configuration time which statements a language's
preset cannot express. Findings for two audiences, the author iterating (fast local feedback)
and the human reviewer (SARIF on GitHub), each result carrying provenance (deterministic,
model-backed, or human attestation). Merging SARIF from any evaluator, so a security agent is
just another evaluator; sarif-to-comment carries the merged SARIF into the pull request review.
A readiness record per subject with two parts: the capability summary (what the subject
reaches, in policy terms) and coverage (which policy statements the evaluators could actually
check for this subject's language, so the reviewer knows what was not looked at). Exceptions
are the explicit, reviewer-visible bypasses: a rule the author asked to be waived for this
subject, with the reason, listed in the record rather than hidden. Fingerprints (content
identity plus capability summary) and diffs against per-consumer baselines on re-assessment,
so a byte change with the same reach is quiet and a same-purpose change that adds a host or a
credential path is loud. The analysis unit is a process: an entrypoint plus its in-language
imports, with results attributed over the import graph.

Must not: decide anything. No verdicts, thresholds, gates, or approved states; the human is the
judge, and consumers write their own rules over results. Implement a language's analysis
itself: eslint-sh owns the shell evaluator; ESLint and typescript-eslint own TypeScript, with one
rule that parses spawn and exec strings through sh-ast. Run as a daemon, watcher, or scheduler;
consumers trigger re-assessment. Know about tool lifecycle, registries, or scaffolds. Analyze
across languages: tool-to-tool calls compose over registry capability summaries at process
boundaries.

Straying signs: a verdict, threshold, or "approved" state computed inside toolprep; a lint rule
implemented inside toolprep instead of in the language's lint plugin; a classification corpus or
catalog of commands maintained inside toolprep; a model-backed answer being the only thing that
passes a subject; a check that applies only when the author is an agent.

### toolfab

Owns: the lifecycle of agent-proposed tools, and the agent guidance around it: the skills and
instructions by which an agent identifies a need, authors a tool, and curates its toolbox. The
proposal path an agent walks, staging, the human review and approval handshake, the registry with its pins and capability
summaries, the toolbox scaffold, and curation: deciding whether a need is met by an existing
tool, a native command, an extension, a consolidation, a new tool, or a retirement, and mining
command history for candidates. A toolbox is a scaffolded project (lint, typecheck, tests) with
a default language and an allowed set. A proposal is a branch and a pull request on the toolbox
repository; approval is the merge; the registry pin is a commit; revocation is a revert.
Submit rules over results (for example, a proposal with error-level deterministic results
cannot be submitted) are toolfab's. toolfab calls toolprep at proposal time for results and the
readiness record, attaches the record to the approval, and calls toolprep again on
re-assessment to learn that an approved tool has drifted. toolfab registers rule instances
("when you see this shape, suggest this tool") through command-steering's rule format, as any
power user would; the only difference is that its use results in new command-line tools
appearing. Where allw is present, a steering "ask" may offer "approve for now, and build a tool
for this" as a single answer, which toolfab turns into a proposal.

Must not: assess, fingerprint, or compute readiness itself; grow its own checker; match or
steer commands at invocation time; define its own rule or matcher format.

Straying signs: code that decides what to do with a command an agent is about to run; a lint or
reach check implemented inside toolfab; a capability summary computed anywhere but from
toolprep's readiness record.

### sarif-to-comment (delivery component)

Owns: turning SARIF into a code review: results become review comments on the pull request, at
the lines they concern. It is how toolprep's merged SARIF, and any other SARIF in the
ecosystem, reaches the human reviewer on GitHub.

Must not: evaluate, filter by policy, or decide; it renders what it is given.

## Interfaces

| Consumer | Provider | What crosses the boundary |
|---|---|---|
| sh-analysis | sh-ast | AST nodes, positions, traversal |
| eslint-sh | sh-ast | parsing of shell files for the ESLint language |
| eslint-sh | sh-analysis | facts (word resolution, command sites, wrappers) projected into diagnostics |
| command-steering | sh-ast, sh-analysis | canonical syntactic shape of the invoked command |
| toolprep | eslint-sh | the shell evaluator preset that toolprep's policy compiles into |
| toolprep | ESLint, typescript-eslint, sh-ast | the TypeScript evaluator; sh-ast parses spawn and exec strings |
| toolprep | any evaluator | SARIF to merge, with provenance |
| sarif-to-comment | toolprep, any evaluator | merged SARIF rendered as pull request review comments |
| toolfab | toolprep | results, readiness record, re-assessment and drift against toolfab's baseline |
| toolfab | command-steering | rule instances registered in steering's external rule format |
| command-steering, toolfab | celscript | type-safe authoring of predicates, CEL evaluation at runtime |
| command-steering, toolfab | allw | human-in-the-loop answers for "ask" and approval, optional |
| any consumer | toolprep | results, readiness record, fingerprints; harness audits, lead acceptance of branches, a repository's own scripts |

Every arrow points downward in the list above. A layer never depends on a layer below it in
this table's consumer column, and never on a consumer of itself.

## Glossary

Terms that SARIF already defines keep SARIF's name and meaning (result, rule, level, run,
location); the ecosystem adds names only where SARIF has none or where its word would collide
with a tool in toolfab's sense.

- subject: one executable toolprep assesses, identified by content. (SARIF's own word for a file
  a result points at is too general, so it is not used for this.)
- process: toolprep's analysis unit, an entrypoint plus its in-language imports.
- fact: an observation sh-analysis makes over syntax, with explicit uncertainty, carrying no judgment.
- result: SARIF's word for one statement about a subject, with location, rule, level, and provenance.
- rule (assessment): SARIF's word for the policy statement a result violates; a toolprep policy compiles into rules.
- level: SARIF's word for a result's severity: error, warning, note.
- provenance: how a result was produced: deterministic, model-backed, or human attestation.
- evaluator: what SARIF calls the tool that produced a run; the ecosystem says evaluator because
  "tool" means a toolfab tool. eslint-sh and typescript-eslint presets are the first evaluators, a
  security agent is another.
- policy: toolprep's single semantic reach statement: execute, network, read, write, credentials, each with allow and deny lists.
- exception: an explicit, reviewer-visible bypass of one rule for one subject, with a required reason.
- coverage: which policy statements a language's preset can express, reported at configuration time.
- readiness record: toolprep's per-subject summary: capability summary, coverage, and the exceptions in force.
- capability summary: the reach of a subject in policy terms, part of the readiness record and of the fingerprint.
- fingerprint: content identity plus capability summary; the thing toolprep diffs on re-assessment.
- baseline: a consumer's recorded fingerprint for a subject, against which drift is reported.
- rule (steering): a predicate and an action in command-steering's format; the predicate is CEL, authored with celscript, and matches shape only.
- rule instance: one registered rule, for example toolfab's "suggest this tool for this shape".
- toolbox: a toolfab-scaffolded project holding tools, with a default language and an allowed set.
- proposal, approval, pin, revocation: a pull request on the toolbox, its merge, the merge commit recorded in the registry, and a revert.
- judge: the human. No layer decides; layers inform. allw is the optional primitive that puts the question in front of the judge with richer answers than yes or no.
<!-- ecosystem-map:end -->
