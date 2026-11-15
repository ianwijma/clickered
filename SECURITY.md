# Security policy

Clickered injects mouse and keyboard input into other windows, so bugs that make input
land in the wrong window, or that let another process drive the helper, count as security
issues.

The in-app updater (README.md, "Updates") downloads and installs code, so anything that
gets it to fetch from somewhere other than GitHub's release servers, to install a file
whose SHA-256 does not match the release's `SHA256SUMS.txt` and GitHub's digest, or to
run a command other than the platform installer, counts too. So does anything that lets
another local user, or another process of the same user, change the package between
the checks and the install: on Linux the root-owned
`/opt/Clickered/resources/clickered-install-update` copies the file into a root-only
folder and re-checks its SHA-256 there before `apt-get` sees it, and the app only runs
that script when it and its folders are owned by root and not writable by anyone else. A compromised GitHub
account or repository is out of scope: releases are not signed with a separate key.

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/ianwijma/clickered/security/advisories/new).

Please include the steps to reproduce, the impact, and your Clickered version, desktop
environment / window manager and distribution. I'll acknowledge the report as soon as I can
and keep you posted while a fix is prepared.
