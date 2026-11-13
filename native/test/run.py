#!/usr/bin/env python3
"""Integration test for clickered-helper. Run ONLY against a throwaway Xvfb:

    Xvfb :99 -screen 0 1280x800x24 &
    cc -o /tmp/physinput native/test/physinput.c $(pkg-config --libs x11 xi xtst)
    DISPLAY=:99 PHYSINPUT=/tmp/physinput python3 native/test/run.py
"""
import json
import os
import select
import subprocess
import sys
import time

if os.environ.get("DISPLAY") in (None, "", ":0", ":1"):
    sys.exit("refusing to run on a real display; set DISPLAY to an Xvfb")

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.environ.get("HELPER") or os.path.join(HERE, "..", "..", "resources", "clickered-helper")
PHYS = os.environ.get("PHYSINPUT")
fails = 0


def check(cond, what):
    global fails
    print(("PASS " if cond else "FAIL ") + what, flush=True)
    if not cond:
        fails += 1


class Reader:
    def __init__(self, f):
        self.f, self.buf = f, b""

    def lines(self, timeout):
        """All JSON lines that arrive within timeout seconds."""
        out, end = [], time.time() + timeout
        while True:
            left = end - time.time()
            if left <= 0:
                return out
            r, _, _ = select.select([self.f], [], [], left)
            if not r:
                return out
            chunk = os.read(self.f.fileno(), 65536)
            if not chunk:
                return out
            self.buf += chunk
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                out.append(json.loads(line))

    def until(self, pred, timeout=3):
        got, end = [], time.time() + timeout
        while time.time() < end:
            for m in self.lines(0.05):
                got.append(m)
                if pred(m):
                    return got, m
        return got, None


wm = subprocess.Popen([sys.executable, os.path.join(HERE, "fakewm.py")], stdout=subprocess.PIPE)
wmr = Reader(wm.stdout)
_, ids = wmr.until(lambda m: m.get("ready"))
A, B, C = ids["A"], ids["B"], ids["C"]


def start():
    p = subprocess.Popen([HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    return p, Reader(p.stdout)


def send(p, line):
    p.stdin.write((line + "\n").encode())
    p.stdin.flush()


def phys(*a):
    subprocess.run([PHYS] + [str(x) for x in a], check=True)


def buttons_down():
    from Xlib import display
    d = display.Display()
    m = d.screen().root.query_pointer().mask
    d.close()
    return m & 0x1F00


h, hr = start()
got, win = hr.until(lambda m: m["t"] == "windows")
check(got[0] == {"t": "ready", "version": 1}, "ready first")
byid = {w["id"]: w for w in win["list"]}
check((byid[A]["x"], byid[A]["y"], byid[A]["w"], byid[A]["h"]) == (4, 30, 632, 374),
      "A content rect = wine-style child 632x374+4+30: %r" % byid[A])
check((byid[B]["x"], byid[B]["y"], byid[B]["w"], byid[B]["h"]) == (650, 0, 400, 300), "B rect")
check(byid[A]["title"] == "Test A é☃" and byid[B]["title"] == 'Test B "quoted"',
      "utf8 + escaped titles")
check(byid[C]["title"] == "Test C é latin1", "WM_NAME latin-1 fallback")
check(byid[A]["cls"] == "testcls" and byid[A]["pid"] == 4242 and byid[A]["mapped"], "cls/pid/mapped")
check(win["active"] == C, "active")

# --- physical capture (Xvfb mouse device) vs XTEST
if PHYS:
    phys("m", 100, 100); phys("b", 1, 1)
    for i in range(30):
        phys("m", 100 + i, 100 + i)
    phys("b", 1, 0)
    msgs = hr.lines(0.4)
    btns = [m for m in msgs if m["t"] == "btn"]
    mot = [m for m in msgs if m["t"] == "motion"]
    check(len(btns) == 2 and btns[0]["down"] and not btns[1]["down"] and btns[0]["win"] == A,
          "physical press/release reported with gesture win A")
    check(abs(btns[0]["fx"] - (100 - 4) / 632) < 1e-4 and abs(btns[0]["fy"] - (100 - 30) / 374) < 1e-4,
          "fractions relative to content rect")
    ts = [m["time"] for m in mot]
    check(len(mot) > 0 and all(b - a >= 8 for a, b in zip(ts, ts[1:])) and mot[-1]["win"] == A,
          "motion throttled >= 8 ms (%d msgs)" % len(mot))
    # press outside any client, then drag into A: win stays 0
    phys("m", 1200, 700); phys("b", 3, 1); phys("m", 100, 100); phys("b", 3, 0)
    btns = [m for m in hr.lines(0.3) if m["t"] == "btn"]
    check(len(btns) == 2 and all(m["win"] == 0 and m["fx"] == 0 for m in btns), "press over no client: win 0")
    # keys
    phys("k", 38, 1); phys("k", 38, 0)
    check(not [m for m in hr.lines(0.2) if m["t"] == "key"], "keys off by default")
    send(h, "keys 1")
    phys("k", 38, 1); phys("k", 38, 0)
    subprocess.run(["xdotool", "key", "a"])
    keys = [m for m in hr.lines(0.3) if m["t"] == "key"]
    check(len(keys) == 2 and keys[0]["keycode"] == 38 and keys[0]["down"] and keys[0]["win"] == C,
          "physical keys reported after keys 1, XTEST keys not: %r" % keys)
    send(h, "keys 0")
subprocess.run(["xdotool", "mousemove", "300", "200", "click", "1"])
subprocess.run(["xdotool", "mousedown", "1", "mousemove", "310", "210", "mouseup", "1"])
check(not [m for m in hr.lines(0.3) if m["t"] in ("btn", "motion")], "XTEST (xdotool) input not reported")
wmr.lines(0.2)

# --- seq click lands at the right fraction
send(h, "seq 1 m %d 0.5 0.25;d 1;s 30;u 1" % A)
got, done = hr.until(lambda m: m["t"] == "done")
ev = [e for e in wmr.lines(0.3) if e["ev"] in ("press", "release")]
check(done == {"t": "done", "id": 1, "ok": True}, "seq 1 done ok")
check([(e["ev"], e["win"], e["x"], e["y"]) for e in ev] ==
      [("press", "A.child", 316, 93), ("release", "A.child", 316, 93)],
      "click at fraction (0.5,0.25) of A content: %r" % ev)
check(not [m for m in got if m["t"] in ("btn", "motion")], "own injection not reported")

# --- a window the WM refuses to activate gets no input (C covers centre of B)
from Xlib import X as XX, Xatom, display as xdisplay  # noqa: E402

xd = xdisplay.Display()
xroot = xd.screen().root
REFUSE = xd.intern_atom("_FAKEWM_REFUSE")
xroot.change_property(REFUSE, Xatom.WINDOW, 32, [B])
xd.sync()
wmr.lines(0.2)
send(h, "seq 20 m %d 0.5 0.5;d 1;u 1" % B)
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.5)
check(done == {"t": "done", "id": 20, "ok": False} and {"ev": "refuse", "win": "B"} in ev
      and not [e for e in ev if e["ev"] in ("press", "release")],
      "refused activation: no click injected: %r" % ev)
send(h, "seq 21 f %d;kd 38;ku 38" % B)
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.5)
check(done == {"t": "done", "id": 21, "ok": False} and {"ev": "refuse", "win": "B"} in ev
      and not [e for e in ev if e["ev"] in ("kpress", "krelease")],
      "refused activation: no key injected: %r" % ev)
check(buttons_down() == 0, "refused activation: no stuck button")
xroot.delete_property(REFUSE)
# The helper's own XRaiseWindow lifted B; put C back on top for the next test.
xd.create_resource_object("window", C).configure(stack_mode=XX.Above)
xroot.change_property(xd.intern_atom("_NET_ACTIVE_WINDOW"), Xatom.WINDOW, 32, [C])
xd.sync()
wmr.lines(0.2)

# --- covered window gets raised (C covers centre of B)
send(h, "seq 2 m %d 0.5 0.5;d 1;u 1" % B)
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
check(done["ok"] and {"ev": "activate", "win": "B"} in [{k: e[k] for k in ("ev", "win")} for e in ev],
      "covered B activated")
pr = [e for e in ev if e["ev"] == "press"]
check(len(pr) == 1 and pr[0]["win"] == "B" and (pr[0]["x"], pr[0]["y"]) == (200, 150), "click landed on B: %r" % pr)

# --- drag
send(h, "seq 3 m %d 0.1 0.1;d 1;m %d 0.2 0.2;s 10;m %d 0.3 0.3;s 10;m %d 1.2 0.3;u 1" % (A, A, A, A))
_, done = hr.until(lambda m: m["t"] == "done")
ev = [e for e in wmr.lines(0.3) if e["ev"] in ("press", "release", "motion")]
ev = ev[[e["ev"] for e in ev].index("press"):]
kinds = [e["ev"] for e in ev]
check(done["ok"] and kinds[0] == "press" and kinds[-1] == "release" and "motion" in kinds
      and ev[-1]["rx"] == 4 + int(1.2 * 632), "drag press/motion/release incl. outside 0..1: %r" % kinds)

# --- skip mode
t0 = time.time()
send(h, "seq 4 m 12345 0.5 0.5;d 1;s 3000;u 1;f 777")
_, done = hr.until(lambda m: m["t"] == "done")
check(done == {"t": "done", "id": 4, "ok": False} and time.time() - t0 < 1, "all skipped: ok false, sleep skipped")
send(h, "seq 5 f 12345;d 1;u 1;m %d 0.5 0.5;d 1;u 1" % A)
_, done = hr.until(lambda m: m["t"] == "done")
pr = [e for e in wmr.lines(0.3) if e["ev"] == "press"]
check(done["ok"] and len(pr) == 1, "partial skip: only the live target clicked")

# --- abort mid-sleep releases the button
send(h, "seq 6 m %d 0.5 0.5;d 1;s 5000;u 1" % A)
time.sleep(0.3)
check(buttons_down() != 0, "button held during sleep")
t0 = time.time()
send(h, "abort")
_, done = hr.until(lambda m: m["t"] == "done")
check(done == {"t": "done", "id": 6, "ok": False} and time.time() - t0 < 0.2, "abort mid-sleep")
check(buttons_down() == 0, "no stuck button after abort")

# --- commands queued during a seq run afterwards
send(h, "seq 7 s 300")
send(h, "list")
got, _ = hr.until(lambda m: m["t"] == "windows")
order = [m["t"] for m in got if m["t"] in ("done", "windows")]
check(order[:2] == ["done", "windows"], "list queued behind seq: %r" % order)

# --- long line (~100 KB)
ops = ";".join("m %d %.5f %.5f;s 0" % (A, (i % 100) / 100, (i % 50) / 50) for i in range(4000))
send(h, "seq 8 " + ops)
_, done = hr.until(lambda m: m["t"] == "done", timeout=20)
check(done is not None and done["ok"], "100 KB seq line")
wmr.lines(0.2)

# --- errors
send(h, "bogus")
send(h, "seq 9 m 1 2;d 1")
got, _ = hr.until(lambda m: m["t"] == "done")
check([m["t"] for m in got] == ["error", "error", "done"] and not got[-1]["ok"], "bad command / bad op")
send(h, "seq 10 m %d 1e300 0;d 1" % A)
got, _ = hr.until(lambda m: m["t"] == "done")
check([m["t"] for m in got] == ["error", "done"] and not got[-1]["ok"], "out-of-range fraction rejected")
send(h, "seq 11 w 99999 0")
got, _ = hr.until(lambda m: m["t"] == "done")
check([m["t"] for m in got] == ["error", "done"] and not got[-1]["ok"], "out-of-range warp rejected")

# --- windows debounce on _NET_CLIENT_LIST change
def set_clients(ids):
    from Xlib import Xatom, display
    d = display.Display()
    d.screen().root.change_property(d.intern_atom("_NET_CLIENT_LIST"), Xatom.WINDOW, 32, ids)
    d.sync()
    d.close()


set_clients([A])
t0 = time.time()
_, w = hr.until(lambda m: m["t"] == "windows")
check(w is not None and [x["id"] for x in w["list"]] == [A] and time.time() - t0 < 0.4, "windows update debounced")
set_clients([A, B, C])
hr.lines(0.3)

# --- pick (xdotool's core click goes to the grab)
send(h, "pick")
time.sleep(0.1)
subprocess.run(["xdotool", "mousemove", "660", "10", "click", "1"])
_, pk = hr.until(lambda m: m["t"] == "picked")
check(pk == {"t": "picked", "win": B}, "pick left click -> B")
check(not [e for e in wmr.lines(0.2) if e["ev"] == "press"], "pick click swallowed")
send(h, "pick"); time.sleep(0.1)
subprocess.run(["xdotool", "click", "3"])
_, pk = hr.until(lambda m: m["t"] == "picked")
check(pk == {"t": "picked", "win": 0}, "pick right click -> 0")
send(h, "pick"); time.sleep(0.1); send(h, "pickcancel")
_, pk = hr.until(lambda m: m["t"] == "picked")
check(pk == {"t": "picked", "win": 0}, "pickcancel -> 0")
subprocess.run(["xdotool", "mousemove", "300", "200", "click", "1"])
check([e["ev"] for e in wmr.lines(0.3) if e["ev"] == "press"] == ["press"], "grab released after pick")

# --- EOF while holding releases everything
send(h, "seq 10 m %d 0.5 0.5;d 1;kd 50;s 5000" % A)
time.sleep(0.3)
check(buttons_down() != 0, "held before EOF")
h.stdin.close()
rc = h.wait(timeout=2)
ev = [e["ev"] for e in wmr.lines(0.3)]
check(rc == 0 and buttons_down() == 0 and "release" in ev and "krelease" in ev,
      "EOF: exit 0, button+key released (%r)" % ev)

# --- SIGTERM also releases
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
send(h, "seq 11 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
h.terminate()
rc = h.wait(timeout=2)
check(rc == 0 and buttons_down() == 0, "SIGTERM: released, exit 0")

wm.kill()
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
