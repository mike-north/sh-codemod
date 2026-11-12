# Security policy

`sh-codemod` processes shell scripts that may come from untrusted sources, so security reports are
welcome.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub:

1. Go to the repository's [Security tab](https://github.com/mike-north/sh-codemod/security).
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected version, and a minimal script or call that shows it.

You will get a reply in the advisory thread. Once a fix is released, the advisory is published
with credit to you unless you prefer otherwise.

## What counts

Examples of problems worth reporting privately include edits that unexpectedly alter source
outside the intended range, or input that crashes the process, hangs, or exhausts memory instead
of raising a documented error. Parser defects usually belong to
[`sh-ast`](https://github.com/mike-north/sh-ast/security).

## Supported versions

The package is in the 0.x series. Fixes land in the latest release only.
