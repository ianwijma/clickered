#!/usr/bin/env bash
# Release workflow, `plan` job: checks for blockers and writes the release plan
# to the job summary. Exits non-zero (after writing the summary) on a blocker,
# so nothing is pushed or released.
#
# Environment:
#   VERSION, TAG, PRERELEASE   from scripts/next-version.mjs (PRERELEASE: true|false)
#   BUMP, RELEASE_TYPE, DRY_RUN  the workflow inputs
#   GH_TOKEN                   for the gh CLI
#   GITHUB_STEP_SUMMARY, GITHUB_REF_NAME, GITHUB_SHA  set by GitHub Actions
set -euo pipefail

: "${VERSION:?}" "${TAG:?}" "${PRERELEASE:?}" "${BUMP:?}" "${RELEASE_TYPE:?}" "${DRY_RUN:?}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

name="$(node -p "require('./package.json').name")"
current="$(node -p "require('./package.json').version")"
# `gh release view` without a tag is the release marked latest (never a prerelease).
gh_latest="$(gh release view --json tagName --jq .tagName 2>/dev/null || echo none)"
gh_newest="$(gh release list --limit 1 --json tagName --jq '.[0].tagName // "none"' 2>/dev/null || echo none)"
last_tag="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo none)"

# Each check is a blocker: the run stops here and nothing is pushed or released.
blockers=()
if git ls-remote --exit-code --tags origin "refs/tags/${TAG}" >/dev/null; then
  blockers+=("The tag \`${TAG}\` already exists.")
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  blockers+=("A GitHub Release for \`${TAG}\` already exists.")
fi
if [[ "$PRERELEASE" != "true" && "$gh_latest" != "none" ]] \
  && ! node -e 'process.exit(require("semver").gt(process.argv[1], process.argv[2]) ? 0 : 1)' "$VERSION" "${gh_latest#v}"; then
  blockers+=("\`${VERSION}\` is not newer than the latest GitHub Release (\`${gh_latest}\`).")
fi

if [[ "$PRERELEASE" == "true" ]]; then
  latest_after="\`${gh_latest}\` (\`${TAG}\` as a prerelease)"
else
  latest_after="\`${TAG}\`"
fi
if [[ "$last_tag" == none ]]; then range=HEAD; else range="${last_tag}..HEAD"; fi

{
  echo "## Release plan: \`${current}\` → \`${VERSION}\`"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "> **Dry run:** nothing will be pushed or released. The packaged app is kept as a workflow artifact."
  fi
  echo
  echo "| | Now | After this release |"
  echo "|---|---|---|"
  echo "| \`package.json\` on \`${GITHUB_REF_NAME:-HEAD}\` | \`${current}\` | \`${VERSION}\` |"
  echo "| Latest GitHub Release | \`${gh_latest}\` | ${latest_after} |"
  echo "| Newest GitHub Release (incl. prereleases) | \`${gh_newest}\` | \`${TAG}\` |"
  echo "| Git tag | \`${last_tag}\` | \`${TAG}\` |"
  echo
  echo "- **Version bump:** \`${BUMP}\`, **release type:** \`${RELEASE_TYPE}\`"
  echo "- **Commit:** \`$(git rev-parse --short HEAD)\` on \`${GITHUB_REF_NAME:-HEAD}\`"
  echo "- **Attached to the release:**"
  echo "  - \`${name}-${VERSION}-x86_64.AppImage\`"
  echo "  - \`${name}-${VERSION}-amd64.deb\`"
  echo "  - \`${name}-${VERSION}-x64.tar.gz\`"
  echo "  - \`SHA256SUMS.txt\`"
  echo
  echo "### Blockers"
  if (( ${#blockers[@]} )); then
    for b in "${blockers[@]}"; do echo "- ❌ ${b}"; done
  else
    echo "- ✅ None. Approve the \`release\` environment under **Review deployments** to continue, or reject it to stop."
  fi
  echo
  echo "### Changes since \`${last_tag}\`"
  git log --no-merges -n 50 --format='- %s (`%h`)' "$range"
} >> "$summary"

for b in "${blockers[@]}"; do echo "::error::${b//\`/}"; done
(( ${#blockers[@]} == 0 ))
