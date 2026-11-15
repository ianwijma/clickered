#!/usr/bin/env bash
# Release workflow, `release` job: checks that the `package` jobs made every expected
# package (downloaded into dist/), writes dist/SHA256SUMS.txt and lists the files in
# the job summary.
#
# Environment:
#   VERSION              the version being released (file names contain it)
#   TAG                  the release tag, for the summary
#   GITHUB_STEP_SUMMARY  set by GitHub Actions
set -euo pipefail

: "${VERSION:?}" "${TAG:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
cd "$(dirname "$0")/../../dist"

name="$(node -p "require('../package.json').name")"
# Keep in sync with scripts/release/plan.sh and electron-builder.yml (artifactName).
expected=(
  "${name}-${VERSION}-amd64.deb"   # Linux x64
  "${name}-${VERSION}-arm64.dmg"   # macOS Apple silicon
  "${name}-${VERSION}-x64.dmg"     # macOS Intel
  "${name}-${VERSION}-x64.exe"     # Windows x64 (NSIS installer)
)

missing=()
for f in "${expected[@]}"; do [[ -f "$f" ]] || missing+=("$f"); done
if (( ${#missing[@]} )); then
  echo "::error::Missing in dist/: ${missing[*]} (found: $(ls -A | tr '\n' ' '))"
  exit 1
fi

sha256sum "${expected[@]}" > SHA256SUMS.txt
cat SHA256SUMS.txt

{
  echo "## Packaged ${TAG}"
  echo
  echo '```'
  ls -lh "${expected[@]}" SHA256SUMS.txt
  echo '```'
} >> "$summary"
