#!/usr/bin/env bash
# Release workflow, `package` job: checks that `npm run dist` made the expected
# packages, writes dist/SHA256SUMS.txt and lists the files in the job summary.
#
# Environment:
#   TAG                  the release tag, for the summary
#   GITHUB_STEP_SUMMARY  set by GitHub Actions
set -euo pipefail

: "${TAG:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
cd "$(dirname "$0")/../../dist"

shopt -s nullglob
files=(*.AppImage *.deb *.tar.gz)
if (( ${#files[@]} != 3 )); then
  echo "::error::Expected an AppImage, a .deb and a .tar.gz in dist/, got: ${files[*]:-nothing}"
  exit 1
fi

sha256sum "${files[@]}" > SHA256SUMS.txt
cat SHA256SUMS.txt

{
  echo "## Packaged ${TAG}"
  echo
  echo '```'
  ls -lh "${files[@]}" SHA256SUMS.txt
  echo '```'
} >> "$summary"
