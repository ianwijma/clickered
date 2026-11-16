import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { debVersionOf, debVersionParts } from "./deb-version.mjs";

// Eddy's version comparison (pop-os/eddy src/Package.vala, compare_versions), the copy
// Pop!_OS ships. Returns -1 when `b` is newer (Eddy offers Update), 1 when older
// (Downgrade), 0 when it thinks they are the same (no button). Vala compares strings
// with g_strcmp0, where a missing part (NULL) sorts first.
function eddyCompare(a: string, b: string): number {
  if (a === b) return 0;
  const atok = a.split("~");
  const btok = b.split("~");
  if (atok.length < 2 && btok.length >= 2) return -1;
  if (atok.length >= 2 && btok.length < 2) return 1;
  const aparts = atok[0]!.split(".");
  const bparts = btok[0]!.split(".");
  const length = Math.max(aparts.length, bparts.length);
  for (let i = 0; i < length; i++) {
    const x = aparts[i];
    const y = bparts[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const hasDpkg = spawnSync("dpkg", ["--version"]).status === 0;
const dpkgLess = (a: string, b: string) => spawnSync("dpkg", ["--compare-versions", a, "lt", b]).status === 0;

// Oldest first: every later one is an upgrade of every earlier one.
const RELEASES = [
  "0.2.0",
  "0.2.1",
  "0.3.0-rc.0",
  "0.3.0-rc.1",
  "0.3.0-rc.2",
  "0.3.0",
  "0.3.1-rc.0",
  "0.3.1",
  "0.4.0-beta.0",
  "0.4.0-rc.0",
  "0.4.0",
  "1.0.0-rc.0",
  "1.0.0",
];
const PAIRS = RELEASES.flatMap((older, i) => RELEASES.slice(i + 1).map((newer) => [older, newer] as const));

describe("debVersionOf", () => {
  test.each([
    ["0.2.0", "0.2.0-1"],
    ["0.3.0-rc.0", "0.3.0-0.rc.0"],
    ["1.0.0-beta-2", "1.0.0-0.beta.2"],
  ])("%s -> %s", (version, deb) => {
    expect(debVersionOf(version)).toBe(deb);
  });

  test("splits into the fpm --version and --iteration", () => {
    expect(debVersionParts("0.3.0-rc.2")).toEqual({ upstream: "0.3.0", revision: "0.rc.2" });
    expect(debVersionParts("0.3.0")).toEqual({ upstream: "0.3.0", revision: "1" });
  });

  test("never contains a ~ (Eddy ignores what follows it)", () => {
    for (const v of RELEASES) expect(debVersionOf(v)).not.toContain("~");
  });

  test.each(["1.2", "v1.2.3", "1.2.3+build.1", "1.2.3-"])("rejects %s", (bad) => {
    expect(() => debVersionOf(bad)).toThrow();
  });

  test.each(PAIRS)("Eddy offers Update from %s to %s", (older, newer) => {
    expect(eddyCompare(debVersionOf(older), debVersionOf(newer))).toBe(-1);
  });

  test.skipIf(!hasDpkg).each(PAIRS)("dpkg sorts %s before %s", (older, newer) => {
    expect(dpkgLess(debVersionOf(older), debVersionOf(newer))).toBe(true);
  });

  // The packages already published used electron-builder's "~" form.
  test.skipIf(!hasDpkg)("dpkg upgrades the old ~ packages to the new form", () => {
    expect(dpkgLess("0.2.0", debVersionOf("0.3.0-rc.3"))).toBe(true);
    expect(dpkgLess("0.3.0~rc.2", debVersionOf("0.3.0-rc.3"))).toBe(true);
    expect(dpkgLess("0.3.0~rc.2", debVersionOf("0.3.0"))).toBe(true);
  });
});
