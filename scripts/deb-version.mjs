// The version a Clickered .deb carries, worked out from the package.json version.
// scripts/dist.mjs hands it to fpm, and the in-app updater (src/main/update-install.ts)
// compares it with what dpkg reports.
//
//   1.2.3          -> 1.2.3-1
//   1.3.0-rc.2     -> 1.3.0-0.rc.2
//   1.3.0-beta-2   -> 1.3.0-0.beta.2   (a Debian revision cannot contain "-")
//
// electron-builder's own default turns every "-" into "~" (1.3.0~rc.2). dpkg orders that
// correctly, but Eddy, Pop!_OS's default .deb installer, does not use dpkg to compare
// versions: it ignores everything after a "~". It saw 1.3.0~rc.1 and 1.3.0~rc.2 as the
// same version (no Update button), and a "~" version as newer than one without, so
// rc -> final release showed as a downgrade.
//
// Here the prerelease goes into the Debian revision instead, with no "~" at all:
// - dpkg: the revision is only compared when the upstream versions are equal, and
//   "0.rc.N" sorts before "1", so every candidate sorts before its release, and after
//   the release before it.
// - Eddy splits on "." and compares the parts in order; the first part that differs
//   decides. A candidate and its release first differ at "Z-0" vs "Z-1", two candidates
//   at their numbers, two releases at their version numbers.
// scripts/deb-version.test.ts checks a run of versions against both.

/**
 * @param {string} version A package.json version, e.g. "1.2.3" or "1.3.0-rc.2".
 * @returns {{ upstream: string, revision: string }} e.g. { upstream: "1.3.0", revision: "0.rc.2" }.
 */
export function debVersionParts(version) {
  const m = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) throw new Error(`Version "${version}" is not X.Y.Z or X.Y.Z-<prerelease>.`);
  const [, upstream, prerelease] = m;
  return { upstream, revision: prerelease ? `0.${prerelease.replace(/-/g, ".")}` : "1" };
}

/**
 * The version dpkg reports for an installed .deb of this app version.
 * @param {string} version e.g. "1.3.0-rc.2".
 * @returns {string} e.g. "1.3.0-0.rc.2".
 */
export function debVersionOf(version) {
  const { upstream, revision } = debVersionParts(version);
  return `${upstream}-${revision}`;
}
