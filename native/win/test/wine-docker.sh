#!/bin/sh
# Build the Windows helper with mingw-w64 and smoke-test it under Wine, all in Docker.
#   native/win/test/wine-docker.sh            -> build + protocol smoke test + capture test
#   OUT=/abs/dir native/win/test/wine-docker.sh   (where the .exe goes; default: a temp dir)
# Wine is not Windows: this checks the protocol loop and the hook plumbing, not real
# Windows behaviour (see README "Manual test checklist").
set -eu
here=$(cd "$(dirname "$0")" && pwd)
win=$(dirname "$here")
out=${OUT:-$(mktemp -d)}
docker build -q -t clickered-helper-win "$here" >/dev/null
docker run --rm -v "$win:/src:ro" -v "$out:/out" -w /src clickered-helper-win sh -ec '
  make -s -f /src/Makefile OUT=/out/clickered-helper.exe
  x86_64-w64-mingw32-objdump -p /out/clickered-helper.exe | grep "DLL Name"
  export WINEDEBUG=-all WINEPREFIX=/tmp/wineprefix
  xvfb-run -a -s "-screen 0 1280x800x24" sh -ec "
    wineboot -i >/dev/null 2>&1; wineserver -w
    (wine notepad >/dev/null 2>&1 &); sleep 4
    echo == protocol smoke test; python3 -u /src/test/smoke.py wine /out/clickered-helper.exe
    echo == capture test; python3 -u /src/test/capture.py wine /out/clickered-helper.exe
  "'
echo "exe: $out/clickered-helper.exe"
