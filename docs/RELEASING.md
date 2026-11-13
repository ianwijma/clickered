# Releasing

The [Release workflow](../.github/workflows/release.yml) tests the app, bumps the
version, tags it, builds the production app and attaches it to a GitHub Release.
Nothing is published to npm (the package is `private`).

Each release has these files:

| File | What it is |
|---|---|
| `clickered-X.Y.Z-amd64.deb` | Debian/Ubuntu package: `sudo apt install ./clickered-X.Y.Z-amd64.deb`. |
| `SHA256SUMS.txt` | Checksum of the file above. |

It is a Linux x64 build with the native X11 helper included.

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
- **Build and release:** checks out the tag, builds the native helper and the app,
  packages it with electron-builder (`electron-builder.yml`), uploads the files as a
  workflow artifact, and creates the GitHub Release with generated notes and the
  files attached.

The longer steps live in `scripts/release/` (`plan.sh`, `collect-files.sh`,
`publish.sh`); each documents the environment variables it reads at the top.

A dry run still builds the packages: download them from the run's **Artifacts**
to try a build before releasing it.

### If it fails

- **Build and release failed:** click **Re-run failed jobs**. It builds the tag
  that was already pushed, without bumping again. If the release was already
  created, its files are replaced, and a release left as a draft is published.
- **Plan failed with "Could not look up" or "Could not check":** GitHub or the
  remote couldn't be queried, so the blockers weren't checked. Run it again later.
- **"may not run releases":** only the repository owner can release, unless the
  `RELEASE_ACTORS` repository variable lists your GitHub login.

## Build locally

```sh
npm run dist     # needs gcc, pkg-config, libx11-dev, libxi-dev, libxtst-dev
```

The packages land in `dist/`. CI renders the icon from `assets/icon.svg` first;
locally, without `build/icons/512x512.png`, the default Electron icon is used:

```sh
mkdir -p build/icons && rsvg-convert -w 512 -h 512 assets/icon.svg -o build/icons/512x512.png
```

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
