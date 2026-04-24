#!/usr/bin/env bash
# Usage: check-version-bump.sh <file> [base-ref] [head-ref]
#
# Checks that if <file> was modified between base-ref and head-ref,
# the VERSION constant was also updated.
#
# Defaults:
#   base-ref  — upstream tracking branch (origin/<current-branch>), falls back to origin/main
#   head-ref  — HEAD
#
# Examples:
#   ./scripts/check-version-bump.sh contracts/contracts/CollateralVault.sol          # git hook
#   ./scripts/check-version-bump.sh contracts/contracts/CollateralVault.sol $BASE $HEAD  # CI

set -euo pipefail

FILE="${1:?Usage: $0 <file> [base-ref] [head-ref]}"

# Resolve base/head refs
if [[ -n "${2:-}" ]]; then
  BASE="$2"
else
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  BASE=$(git rev-parse --verify "origin/$BRANCH" 2>/dev/null \
    || git rev-parse --verify "origin/main" 2>/dev/null \
    || { echo "error: cannot find a remote base ref to compare against" >&2; exit 1; })
fi
HEAD="${3:-HEAD}"

# If the file wasn't touched, nothing to check
if ! git diff --name-only "$BASE" "$HEAD" -- "$FILE" | grep -q .; then
  echo "  $FILE — unchanged, skipping."
  exit 0
fi

# File was modified — VERSION must appear in the diff
if git diff "$BASE" "$HEAD" -- "$FILE" | grep -qE '^\+.*\bVERSION\b'; then
  echo "  $FILE — VERSION bumped. ✓"
  exit 0
fi

echo "error: $FILE was modified but VERSION was not updated." >&2
echo "  Bump the VERSION constant before merging." >&2
exit 1
