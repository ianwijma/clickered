#!/usr/bin/env bash
# Entry point of the e2e container: start a private Xvfb, then run
#   1. native/test/run.py  - the helper's own protocol/integration test
#   2. vitest e2e suites   - engine + Electron app against the real helper
# Extra arguments are passed to vitest (e.g. a file filter or `-t name`).
set -euo pipefail

if [[ "${CLICKERED_E2E:-}" != "1" || "${DISPLAY:-}" != ":99" || ! -f /.dockerenv ]]; then
  echo "refusing to run outside the e2e container (use: npm run test:e2e)" >&2
  exit 2
fi

# Our own Xvfb must own the display: if :99 is somehow taken, Xvfb exits and we stop
# rather than inject input into whatever server answers there.
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
xvfb=$!
for _ in $(seq 50); do
  kill -0 "$xvfb" 2>/dev/null || { echo "Xvfb exited:" >&2; cat /tmp/xvfb.log >&2; exit 1; }
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done
sleep 0.2
kill -0 "$xvfb" 2>/dev/null && xdpyinfo >/dev/null 2>&1 || { echo "Xvfb did not start:" >&2; cat /tmp/xvfb.log >&2; exit 1; }

status=0
if [[ "${SKIP_NATIVE:-}" != "1" ]]; then
  echo "=== native helper integration test ==="
  python3 native/test/run.py || status=1
fi

echo "=== vitest e2e ==="
npx vitest run -c vitest.e2e.config.mjs "$@" || status=1

exit $status
