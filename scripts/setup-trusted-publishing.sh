#!/usr/bin/env bash
# Configure npm trusted publishing (OIDC from GitHub Actions) for this package.
#
# Run once, by the repository owner, from the repository root. It is safe to
# re-run: every step checks before it changes anything.
#
# What it does:
#   1. Preflight: gh is logged in as the owner, npm is logged in, and the
#      package already exists on the registry (npm only lets you attach a
#      trusted publisher to an existing package; the first publish is manual).
#   2. Creates the GitHub Actions environment the release workflow publishes
#      from, restricted to the main branch, so only workflow runs on main can
#      mint the OIDC token npm will accept.
#   3. Prints the exact values npm asks for and opens the package's access
#      settings, where the trusted publisher is added by hand: npm exposes no
#      CLI or API for this step.
#   4. Checks the release workflow is shaped for OIDC (id-token permission
#      present, no NPM_TOKEN secret referenced).
#
# Why trusted publishing: no long-lived npm token exists anywhere, releases
# carry provenance attestations, and a compromised CI secret cannot publish.

set -euo pipefail

OWNER="mike-north"
ENVIRONMENT="npm"
WORKFLOW="release.yml"

root="$(git rev-parse --show-toplevel)"
cd "$root"
REPO="$(basename "$root")"
if [ -f package.json ]; then
  PKG="$(node -p "require('./package.json').name")"
else
  PKG="$REPO"
fi

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# gh must use keyring auth, never an exported token (which pins the account).
GH() { env -u GITHUB_TOKEN gh "$@"; }

say "Preflight"
account="$(GH api user --jq .login 2>/dev/null || true)"
[ "$account" = "$OWNER" ] || fail "gh is logged in as '${account:-nobody}', expected '$OWNER' (gh auth switch --user $OWNER)"
npm_user="$(npm whoami 2>/dev/null || true)"
[ -n "$npm_user" ] || fail "npm is not logged in (npm login)"
status="$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$PKG/latest")"
[ "$status" = "200" ] || fail "package '$PKG' is not on the registry yet; publish the first version manually, then re-run"
printf 'gh: %s   npm: %s   package: %s   repo: %s/%s\n' "$account" "$npm_user" "$PKG" "$OWNER" "$REPO"

say "GitHub environment '$ENVIRONMENT' restricted to main"
GH api -X PUT "repos/$OWNER/$REPO/environments/$ENVIRONMENT" \
  --input - >/dev/null <<'JSON'
{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
JSON
existing="$(GH api "repos/$OWNER/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" --jq '.branch_policies[].name' 2>/dev/null || true)"
if printf '%s\n' "$existing" | grep -qx 'main'; then
  echo "branch policy for main already present"
else
  GH api -X POST "repos/$OWNER/$REPO/environments/$ENVIRONMENT/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null
  echo "added branch policy: main"
fi

say "Trusted publisher values (enter these on npmjs.com)"
cat <<EOF
  Publisher:            GitHub Actions
  Organization or user: $OWNER
  Repository:           $REPO
  Workflow filename:    $WORKFLOW
  Environment name:     $ENVIRONMENT

Then, on the same page under Publishing access, choose the option that
requires two-factor authentication and disallows tokens; trusted publishers
are exempt from that restriction, so CI keeps working and tokens cannot.
EOF
url="https://www.npmjs.com/package/$PKG/access"
if command -v open >/dev/null 2>&1; then open "$url"; else echo "open: $url"; fi
read -r -p "Press Enter once the trusted publisher is saved on npmjs.com... " _

say "Release workflow check (.github/workflows/$WORKFLOW)"
wf=".github/workflows/$WORKFLOW"
if [ ! -f "$wf" ]; then
  echo "not present yet; the scaffold adds it. It must declare 'id-token: write' and must not reference NPM_TOKEN."
else
  grep -q 'id-token: *write' "$wf" || fail "$wf lacks 'id-token: write' under permissions"
  if grep -q 'NPM_TOKEN' "$wf"; then fail "$wf references NPM_TOKEN; trusted publishing needs no token"; fi
  grep -q "environment: *$ENVIRONMENT" "$wf" || echo "warning: $wf does not run in environment '$ENVIRONMENT'; the trusted publisher match will fail until it does"
  echo "workflow is shaped for OIDC publishing"
fi

say "Done. The first CI publish from main will confirm the setup end to end."
