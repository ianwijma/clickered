#!/usr/bin/env bash
# Release workflow, `package` job: creates the GitHub Release for TAG with the
# files from scripts/release/collect-files.sh attached. On a re-run, when the
# release already exists, it replaces its files instead.
#
# Environment:
#   TAG         the release tag (already pushed)
#   PRERELEASE  true|false
#   GH_TOKEN    for the gh CLI, with contents: write
set -euo pipefail

: "${TAG:?}" "${PRERELEASE:?}"
cd "$(dirname "$0")/../.."

files=(dist/*.AppImage dist/*.deb dist/*.tar.gz dist/SHA256SUMS.txt)

if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "${files[@]}" --clobber
  exit 0
fi

args=(--verify-tag --generate-notes --title "$TAG")
if [[ "$PRERELEASE" == "true" ]]; then args+=(--prerelease); else args+=(--latest); fi
gh release create "$TAG" "${files[@]}" "${args[@]}"
