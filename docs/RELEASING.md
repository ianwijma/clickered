# Releasing

The [Release workflow](../.github/workflows/release.yml) tests the app, bumps the
version, tags it, builds the production app and attaches it to a GitHub Release.
Nothing is published to npm (the package is `private`).

Each release has these files:

| File | What it is |
|---|---|
| `clickered-X.Y.Z-amd64.deb` | Linux x64 (X11), Debian/Ubuntu package: `sudo apt install ./clickered-X.Y.Z-amd64.deb`. Installs to `/opt/Clickered`, runs as `clickered`. |
| `clickered-X.Y.Z-arm64.dmg` | macOS 11+ on Apple silicon. |
| `clickered-X.Y.Z-x64.dmg` | macOS 11+ on Intel. |
| `clickered-X.Y.Z-x64.exe` | Windows 10/11 x64, NSIS one-click installer (per user, no admin rights). |
| `SHA256SUMS.txt` | Checksums of the files above. |

**Installed apps depend on these names.** The in-app updater (`src/main/update*.ts`,
README.md "Updates") reads the latest stable release (or, for users who opted in, the newest release including prereleases) from the GitHub API and downloads
exactly `clickered-<version>-amd64.deb` / `-arm64.dmg` / `-x64.dmg` / `-x64.exe`
plus `SHA256SUMS.txt` (in `sha256sum` format, one `<hex>  <name>` line per file) from
`github.com/ianwijma/clickered/releases/download/<tag>/`. Every copy already out there
does, so do not rename the files, drop `SHA256SUMS.txt`, change its format, rename the
repository or use tags other than `vX.Y.Z`: older apps would silently stop seeing
updates. Other things they rely on: the bundle id `ma.wij.clickered` and the app name
`Clickered.app` in the dmg, the .deb package name `clickered` installed to
`/opt/Clickered`, and the NSIS one-click per-user installer (its uninstaller name
`Uninstall Clickered.exe`), and on Linux the install script
`native/linux/clickered-install-update`, shipped as
`/opt/Clickered/resources/clickered-install-update` (electron-builder.yml
`linux.extraResources`). Keep that script executable in git (mode 100755): the .deb then
installs it as root:root 0755, and the app refuses to run it under any other path,
owner or mode, which would make every Linux update fail. Check a built package with
`dpkg-deb -c dist/clickered-*-amd64.deb | grep install-update`; its arguments and exit
codes (64 bad arguments, 65 checksum mismatch) are what installed apps of this and later
versions call, so change them only compatibly. Prereleases are offered only to users who turned on
"Pre-release updates" (the app then reads `releases?per_page=30` instead of
`releases/latest`). The prerelease flag on GitHub must agree with the tag:
`v1.3.0-rc.1` must be marked prerelease and `v1.3.0` must not, because a release where
they disagree is never offered. Marking a stable release as **latest** offers it to
everyone on their next start.

Each one includes the native helper for its OS. Both dmgs contain the same universal
macOS helper. Until signing certificates are set up (see "Code signing" below) the
macOS app is only ad-hoc signed and the Windows installer is unsigned; README.md says
what users have to click through.

## Run a release

1. Open **Actions → Release → Run workflow**.
2. Leave the branch on `main`.
3. Pick a **Version bump** (default `patch`):
   - `patch`: `1.2.3` → `1.2.4`, for bug fixes.
   - `minor`: `1.2.3` → `1.3.0`, for new features that don't break anything.
   - `major`: `1.2.3` → `2.0.0`, for breaking changes.
4. Pick a **Release type** (default `prerelease`, so you never release a stable
   version by accident):
   - `prerelease`: a release candidate, marked as a prerelease on GitHub.
     `1.2.3` + `minor` → `1.3.0-rc.0`.
   - `release`: a stable version, marked as the latest release.
     `1.2.3` + `minor` → `1.3.0`.
5. **Dry run** is ticked by default: it checks and builds everything without
   pushing or releasing. Untick it to release for real.
6. **Prerelease identifier** (default `rc`) is only used for prereleases; `beta`
   gives `1.3.0-beta.0`.
7. Click **Run workflow**.
8. Wait for **Plan release** to finish, then open the run's summary. It shows the
   current and new version, the latest GitHub Release and git tag, the files that
   will be attached, any blockers, and the changes since the last release.
9. If everything is correct, click **Review deployments**, tick `release` and
   **Approve and deploy**. To stop, click **Reject** instead.
10. Wait for **Build and release** to go green and check the new GitHub Release.

Release candidates, step by step (keep the same **Version bump** each time):

- `minor` + `prerelease`: `1.2.3` → `1.3.0-rc.0`.
- `minor` + `prerelease` again: `1.3.0-rc.0` → `1.3.0-rc.1`, `1.3.0-rc.2`, ...
- `minor` + `release`: `1.3.0-rc.2` → `1.3.0`.
- A bigger bump on a candidate starts a new one: `major` + `prerelease` on
  `1.3.0-rc.2` → `2.0.0-rc.0`.

### What the workflow does

- **Plan:** runs the tests, typecheck and build, works out the new version
  (`scripts/next-version.mjs`) and writes the summary. It stops on a blocker: the
  tag or GitHub Release already exists, or a stable version isn't newer than the
  latest stable GitHub Release.
- **Version:** waits for your approval on the `release` environment, then commits
  the new version to `main` and pushes a `vX.Y.Z` tag. If `main` moved since the
  plan, it stops instead.
- **Build (Linux / macOS / Windows):** three jobs in parallel, one per OS. Each checks
  out the tag, builds the native helper and the app, and packages it with
  electron-builder (`npm run dist`: `scripts/dist.mjs` + `electron-builder.yml`). The
  icons are rendered once in the plan job (`scripts/release/render-icons.sh`) and
  shared. The macOS job also verifies the code signatures. One OS failing does not
  cancel the others.
- **Release:** collects the files of all three, checks that every expected file is
  there, writes `SHA256SUMS.txt`, uploads everything as one workflow artifact, and
  creates the GitHub Release with generated notes and the files attached.

The longer steps live in `scripts/release/` (`plan.sh`, `render-icons.sh`,
`collect-files.sh`, `publish.sh`); each documents the environment variables it reads at
the top.

A dry run still builds the packages: download them from the run's **Artifacts**
to try a build before releasing it.

### If it fails

- **A Build job or Release failed:** click **Re-run failed jobs**. It builds the tag
  that was already pushed, without bumping again (the packages of the OSes that
  succeeded are kept for 7 days and reused). If the release was already created, its files are replaced,
  and a release left as a draft is published. Nothing is released unless all three
  OSes built.
- **Plan failed with "Could not look up" or "Could not check":** GitHub or the
  remote couldn't be queried, so the blockers weren't checked. Run it again later.
- **"may not run releases":** only the repository owner can release, unless the
  `RELEASE_ACTORS` repository variable lists your GitHub login.

## Build locally

```sh
npm run dist     # packages for the OS you run it on
```

It needs the helper toolchain of that OS (README.md, "Run from source"). The packages
land in `dist/`: the .deb on Linux, both dmgs on macOS, the installer on Windows.
Building for another OS is not supported. `node scripts/dist.mjs --dir` (after
`npm run build`) only makes the unpacked app, which is quicker for a test.

CI renders the icons from `assets/icon.svg` first; locally, without them, the default
Electron icon is used. With `rsvg-convert` installed (Debian/Ubuntu `librsvg2-bin`,
macOS `brew install librsvg`):

```sh
scripts/release/render-icons.sh   # build/icons/512x512.png (Linux), build/icon.png (macOS, Windows)
```

## Code signing

There are no certificates yet, so releases are unsigned:

- **macOS:** `scripts/dist.mjs` ad-hoc signs the app (every binary in it, the helper
  included), because an unsigned arm64 binary does not run at all. Gatekeeper still
  warns on first start, and the Accessibility grant is tied to the exact build, so
  users may have to grant it again after an update.
- **Windows:** the installer and the exe are unsigned; SmartScreen warns.

To sign, add these repository secrets (**Settings → Secrets and variables → Actions**).
The workflow passes them to electron-builder under its standard names; nothing else
needs to change:

| Secret | For |
|---|---|
| `MAC_CSC_LINK` | macOS: a "Developer ID Application" certificate as a base64 `.p12` (becomes `CSC_LINK`). With it, the app is signed with the hardened runtime instead of ad hoc. |
| `MAC_CSC_KEY_PASSWORD` | macOS: the `.p12` password (`CSC_KEY_PASSWORD`). |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization (an Apple ID with an app-specific password). Without them a signed app is not notarized, and Gatekeeper still warns. |
| `WIN_CSC_LINK` | Windows: an Authenticode certificate as a base64 `.pfx`. |
| `WIN_CSC_KEY_PASSWORD` | Windows: its password. |

Locally, set the unprefixed electron-builder variables (`CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_*`, `WIN_CSC_LINK`, ...) before `npm run dist`. Certificates kept in a cloud HSM
(most new Windows certificates) need electron-builder's `win.azureSignOptions` or a
custom `win.signtoolOptions` instead; see the electron-builder docs.

Changing the macOS signing identity (ad hoc → Developer ID) resets users'
Accessibility grant once.

## One-time setup

1. **Merge the workflow into `main`.** GitHub only shows a manually started
   workflow once its file is on the default branch.
2. **Create the `release` environment** (the approval gate): **Settings →
   Environments → New environment**, name it `release`.
   - Tick **Required reviewers** and add yourself.
   - Leave **Prevent self-review** unticked, or you can't approve your own releases.
   - Under **Deployment branches and tags**, choose **Selected branches and tags**
     and add `main`.

   Without required reviewers the workflow doesn't wait for approval.
3. **Check the Actions settings:** under **Settings → Actions → General**, check
   that Actions are allowed. The workflow sets its own permissions, so the
   **Workflow permissions** default can stay on "Read repository contents".
4. **Optional, allow other people to release:** add a repository variable under
   **Settings → Secrets and variables → Actions → Variables**: name
   `RELEASE_ACTORS`, value a list of GitHub logins (`ianwijma otheruser`). They also
   need write access to the repository.
5. **Try it:** run a dry run with the defaults, approve it, and download the
   build from the run's artifacts. Then run it again with **Dry run** unticked.

If you later protect `main` with a rule that blocks direct pushes, add **GitHub
Actions** to its bypass list. Otherwise the workflow can't push the release commit.
