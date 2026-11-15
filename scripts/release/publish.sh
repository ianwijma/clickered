#!/usr/bin/env bash
# Release workflow, `package` job: creates the GitHub Release for TAG with the
# files from scripts/release/collect-files.sh attached. On a re-run, when the
# release already exists, it replaces its files instead (and publishes it if a
# failed run left it as a draft).
#
# Environment:
#   TAG         the release tag (already pushed)
#   VERSION     the version being released (file names contain it)
#   PRERELEASE  true|false
#   GH_TOKEN    for the gh CLI, with contents: write
set -euo pipefail

: "${TAG:?}" "${VERSION:?}" "${PRERELEASE:?}"
cd "$(dirname "$0")/../.."

name="$(node -p "require('./package.json').name")"
# The files checked by scripts/release/collect-files.sh.
files=(
  "dist/${name}-${VERSION}-amd64.deb"
  "dist/${name}-${VERSION}-arm64.dmg"
  "dist/${name}-${VERSION}-x64.dmg"
  "dist/${name}-${VERSION}-x64.exe"
  dist/SHA256SUMS.txt
)
if [[ "$PRERELEASE" == "true" ]]; then kind=(--prerelease); else kind=(--latest); fi

# `gh release create` with files makes a draft, uploads to it, then publishes it.
# A run cancelled or failed in between leaves that draft (or a release with
# missing files) behind: finish it instead of creating another one.
if is_draft="$(gh release view "$TAG" --json isDraft --jq .isDraft 2>/dev/null)"; then
  gh release upload "$TAG" "${files[@]}" --clobber
  if [[ "$is_draft" == "true" ]]; then
    gh release edit "$TAG" --draft=false "${kind[@]}"
  fi
  exit 0
fi

gh release create "$TAG" "${files[@]}" --verify-tag --generate-notes --title "$TAG" "${kind[@]}"
