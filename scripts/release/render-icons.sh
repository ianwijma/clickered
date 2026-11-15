#!/usr/bin/env bash
# Renders the packaging icons from assets/icon.svg into build/ (electron-builder's
# buildResources). Needs rsvg-convert (Debian/Ubuntu: librsvg2-bin; macOS: brew
# install librsvg). The Release workflow runs it once, in the `plan` job, and hands
# the result to every `package` job.
#
#   build/icons/512x512.png  Linux (.deb icon)
#   build/icon.png           macOS (.icns) and Windows (.ico): electron-builder converts
#                            it; 1024×1024 covers the largest .icns size (512@2x) and
#                            the .ico needs at least 256×256.
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p build/icons
rsvg-convert --width 512 --height 512 assets/icon.svg --output build/icons/512x512.png
rsvg-convert --width 1024 --height 1024 assets/icon.svg --output build/icon.png
ls -l build/icons/512x512.png build/icon.png
