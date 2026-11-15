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
check(got[0] == {"t": "ready", "version": 3}, "ready first")
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
    # keys: only the panic key (Escape) is ever reported, and only physical presses of it
    ESC = 9  # Xvfb's default keymap
    phys("k", 38, 1); phys("k", 38, 0)
    got = hr.lines(0.2)
    check(not got, "ordinary physical keys never reported: %r" % got)
    send(h, "keys 1")  # removed in protocol v2
    got = hr.lines(0.2)
    check([m["t"] for m in got] == ["error"], "keys command rejected: %r" % got)
    phys("k", ESC, 1); phys("k", ESC, 0)
    subprocess.run(["xdotool", "key", "Escape"])
    got = hr.lines(0.3)
    check([m["t"] for m in got] == ["esc"], "physical Escape -> one esc, XTEST Escape ignored: %r" % got)
    # Escape aborts a running seq
    send(h, "seq 30 m %d 0.5 0.5;d 1;s 5000;u 1" % A)
    time.sleep(0.3)
    t0 = time.time()
    phys("k", ESC, 1); phys("k", ESC, 0)
    got, done = hr.until(lambda m: m["t"] == "done")
    check([m["t"] for m in got] == ["esc", "done"] and done == {"t": "done", "id": 30, "ok": False}
          and time.time() - t0 < 0.5, "Escape aborts a running seq: %r" % got)
    check(buttons_down() == 0, "no stuck button after Escape")
    wmr.lines(0.3)
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
send(h, "seq 21 f %d;d 1;u 1" % B)
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.5)
check(done == {"t": "done", "id": 21, "ok": False} and {"ev": "refuse", "win": "B"} in ev
      and not [e for e in ev if e["ev"] in ("press", "release")],
      "refused activation (f): no click injected: %r" % ev)
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
send(h, "seq 12 m %d 0.5 0.5;kd 38;ku 38" % A)  # key ops were removed in protocol v2
got, _ = hr.until(lambda m: m["t"] == "done")
check([m["t"] for m in got] == ["error", "done"] and not got[-1]["ok"], "kd/ku ops rejected")
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
send(h, "seq 10 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
check(buttons_down() != 0, "held before EOF")
h.stdin.close()
rc = h.wait(timeout=2)
ev = [e["ev"] for e in wmr.lines(0.3)]
check(rc == 0 and buttons_down() == 0 and "release" in ev,
      "EOF: exit 0, button released (%r)" % ev)

# --- SIGTERM also releases
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
send(h, "seq 11 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
h.terminate()
rc = h.wait(timeout=2)
check(rc == 0 and buttons_down() == 0, "SIGTERM: released, exit 0")

# =========================================================================
# Background mode (protocol v3): a second master pointer, the user's pointer untouched
# =========================================================================
def masters():
    out = subprocess.run(["xinput", "list", "--name-only"], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if l.startswith("clickered-bg")]


def primary_pos():
    from Xlib import display
    d = display.Display()
    q = d.screen().root.query_pointer()
    d.close()
    return (q.root_x, q.root_y)


def bg_button_down():
    out = subprocess.run(["xinput", "query-state", "clickered-bg XTEST pointer"],
                         capture_output=True, text=True).stdout
    return "=down" in out


def bgenv(*a):
    env = dict(os.environ, PHYS_DEV="clickered-bg XTEST pointer")
    subprocess.run([PHYS] + [str(x) for x in a], check=True, env=env)


def presses(evs):
    return [e for e in evs if e["ev"] in ("press", "release")]


subprocess.run(["xdotool", "mousemove", "900", "600"])
# C on top of B again (the foreground tests above left B raised)
xd.create_resource_object("window", C).configure(stack_mode=XX.Above)
xroot.change_property(xd.intern_atom("_NET_ACTIVE_WINDOW"), Xatom.WINDOW, 32, [C])
xd.sync()
wmr.lines(0.2)
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
check(not masters(), "no background master before bg 1")
send(h, "bg 1")
got = hr.lines(0.4)
check(got == [], "bg 1: no reply: %r" % got)
check(sorted(masters()) == ["clickered-bg XTEST keyboard", "clickered-bg XTEST pointer",
                            "clickered-bg keyboard", "clickered-bg pointer"], "bg 1 creates the master: %r" % masters())
send(h, "bg 1")  # idempotent
check(hr.lines(0.2) == [] and masters().count("clickered-bg pointer") == 1, "bg 1 twice: still one master")

# click lands at the right place, primary pointer unchanged, nothing reported
before = primary_pos()
check(before == (900, 600), "primary pointer parked at 900,600: %r" % (before,))
send(h, "seq 100 m %d 0.5 0.25;d 1;s 30;u 1" % A)
got, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
check(done == {"t": "done", "id": 100, "ok": True}, "bg click: done ok")
check([(e["ev"], e["win"], e["x"], e["y"]) for e in presses(ev)] ==
      [("press", "A.child", 316, 93), ("release", "A.child", 316, 93)],
      "bg click at fraction (0.5,0.25) of A content: %r" % presses(ev))
check(primary_pos() == before, "bg click: primary pointer did not move: %r" % (primary_pos(),))
check(not [e for e in ev if e["ev"] in ("activate", "refuse")], "bg click: nothing activated")
check(buttons_down() == 0 and not bg_button_down(), "bg click: no stuck button")
check(not [m for m in got + hr.lines(0.2) if m["t"] in ("btn", "motion")], "bg click not reported as btn/motion")

# click on B at a point not covered by C
send(h, "seq 101 m %d 0.1 0.1;d 3;u 3" % B)
_, done = hr.until(lambda m: m["t"] == "done")
pr = presses(wmr.lines(0.3))
check(done["ok"] and [(e["ev"], e["win"], e["x"], e["y"], e["detail"]) for e in pr] ==
      [("press", "B", 40, 30, 3), ("release", "B", 40, 30, 3)], "bg right-click on B: %r" % pr)
check(primary_pos() == before, "primary still unchanged")

# drag, including leaving the window
send(h, "seq 102 m %d 0.1 0.1;d 1;m %d 0.2 0.2;s 10;m %d 0.3 0.3;s 10;m %d 1.2 0.3;u 1" % (A, A, A, A))
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
ev = [e for e in ev if e["ev"] in ("press", "release", "motion")]
ev = ev[[e["ev"] for e in ev].index("press"):]  # drop hover motion before the press
kinds = [e["ev"] for e in ev]
check(done["ok"] and kinds[:1] == ["press"] and kinds[-1:] == ["release"] and "motion" in kinds
      and ev[-1]["rx"] == 4 + int(1.2 * 632) and ev[0]["x"] == int(0.1 * 632) and ev[0]["y"] == int(0.1 * 374),
      "bg drag press/motion/release with correct coordinates: %r" % kinds)
check(primary_pos() == before and not bg_button_down(), "bg drag: primary pointer unchanged, no stuck button")

# wheel
send(h, "seq 103 m %d 0.5 0.5;d 4;u 4" % A)
_, done = hr.until(lambda m: m["t"] == "done")
pr = presses(wmr.lines(0.3))
check(done["ok"] and [(e["ev"], e["detail"]) for e in pr] == [("press", 4), ("release", 4)], "bg wheel: %r" % pr)

# no mouse lock: a physical move during the seq moves the real pointer
if PHYS:
    send(h, "seq 104 m %d 0.5 0.5;d 1;s 600;u 1" % A)
    time.sleep(0.2)
    phys("m", 950, 650)
    check(primary_pos() == (950, 650), "bg: no mouse lock, physical move works during the seq: %r" % (primary_pos(),))
    _, done = hr.until(lambda m: m["t"] == "done")
    pr = presses(wmr.lines(0.3))
    check(done["ok"] and [e["ev"] for e in pr] == ["press", "release"] and pr[0]["win"] == "A.child"
          and pr[1]["win"] == "A.child", "bg: seq completed despite the physical move: %r" % pr)
    subprocess.run(["xdotool", "mousemove", "900", "600"])
    wmr.lines(0.1)
    before = primary_pos()

# covered point (C covers the centre of B): skipped, nothing clicked, nothing raised
send(h, "seq 105 m %d 0.5 0.5;d 1;s 2000;u 1" % B)
t0 = time.time()
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
check(done == {"t": "done", "id": 105, "ok": False} and time.time() - t0 < 1, "bg covered point: done ok false")
check(not presses(ev) and not [e for e in ev if e["ev"] in ("activate", "refuse")],
      "bg covered point: no click on B or C, no activation: %r" % ev)
check(primary_pos() == before and not bg_button_down(), "bg covered point: primary unchanged")

# missing window / partial skip
send(h, "seq 106 m 12345 0.5 0.5;d 1;s 2000;u 1;f 777")
_, done = hr.until(lambda m: m["t"] == "done")
check(done == {"t": "done", "id": 106, "ok": False}, "bg missing window: done ok false")
send(h, "seq 107 f 12345;d 1;u 1;m %d 0.5 0.5;d 1;u 1;m %d 0.5 0.5;d 1;u 1" % (A, B))
_, done = hr.until(lambda m: m["t"] == "done")
pr = presses(wmr.lines(0.3))
check(done["ok"] and [(e["ev"], e["win"]) for e in pr] == [("press", "A.child"), ("release", "A.child")],
      "bg partial skip: only A clicked, covered B skipped: %r" % pr)
send(h, "seq 108 f %d;d 1;u 1" % A)  # f only checks existence; w only ends skip
_, done = hr.until(lambda m: m["t"] == "done")
check(done["ok"] and not presses(wmr.lines(0.2)), "bg f: existence only, no click without m")
send(h, "seq 109 m 12345 0.5 0.5;w 5 5;d 1;u 1")
_, done = hr.until(lambda m: m["t"] == "done")
check(not done["ok"] and primary_pos() == before, "bg w: no warp, ends skip only")
wmr.lines(0.2)

# the user's own pointer inside the target: skipped
subprocess.run(["xdotool", "mousemove", "300", "200"])
wmr.lines(0.2)
send(h, "seq 110 m %d 0.1 0.1;d 1;u 1" % A)
_, done = hr.until(lambda m: m["t"] == "done")
check(done == {"t": "done", "id": 110, "ok": False} and not presses(wmr.lines(0.3)),
      "bg: user's pointer inside the target -> skipped")
subprocess.run(["xdotool", "mousemove", "900", "600"])
wmr.lines(0.1)
before = primary_pos()

# the helper's own background pointer is never reported (outside a seq, after the suppress window)
if PHYS:
    time.sleep(0.1)
    bgenv("m", 100, 100); bgenv("b", 1, 1); bgenv("m", 120, 120); bgenv("b", 1, 0)
    got = hr.lines(0.4)
    check([m for m in got if m["t"] in ("btn", "motion")] == [],
          "events of the bg XTEST pointer are not reported: %r" % got)
    wmr.lines(0.1)
    phys("m", 100, 100); phys("b", 1, 1); phys("b", 1, 0)
    got = [m for m in hr.lines(0.3) if m["t"] == "btn"]
    check(len(got) == 2, "control: a physical click is still reported in bg mode")
    subprocess.run(["xdotool", "mousemove", "900", "600"])
    wmr.lines(0.1)

# abort mid-drag releases the button on the virtual pointer
send(h, "seq 111 m %d 0.5 0.5;d 1;s 5000;u 1" % A)
time.sleep(0.3)
check(bg_button_down(), "bg: button held on the virtual pointer during the sleep")
check(buttons_down() == 0, "bg: ... and not on the user's pointer")
send(h, "abort")
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
check(done == {"t": "done", "id": 111, "ok": False}, "bg abort: done ok false")
check(not bg_button_down() and [e["ev"] for e in presses(ev)] == ["press", "release"],
      "bg abort mid-drag released the virtual button: %r" % presses(ev))

# bad argument
send(h, "bg 2")
got = hr.lines(0.3)
check([m["t"] for m in got] == ["error"], "bg 2 -> error: %r" % got)
send(h, "bg")
got = hr.lines(0.3)
check([m["t"] for m in got] == ["error"], "bare bg -> error: %r" % got)
check("clickered-bg pointer" in masters(), "bad bg leaves the mode unchanged")

# a bg queued behind a seq applies to the next seq
send(h, "seq 112 s 300")
send(h, "bg 0")
send(h, "seq 113 m %d 0.5 0.25;d 1;u 1" % A)
got, d2 = hr.until(lambda m: m["t"] == "done" and m["id"] == 113)
check(not masters(), "bg 0 removes the master (queued behind a seq)")
pr = presses(wmr.lines(0.3))
check(d2["ok"] and primary_pos() == (320, 123),
      "foreground seq after bg 0 warps the real pointer: %r" % (primary_pos(),))
check([e["ev"] for e in pr] == ["press", "release"], "foreground click after bg 0: %r" % pr)

# foreground still raises covered windows after bg 1 / bg 0
send(h, "bg 1"); send(h, "bg 0")
hr.lines(0.2)
send(h, "seq 114 m %d 0.5 0.5;d 1;u 1" % B)
_, done = hr.until(lambda m: m["t"] == "done")
ev = wmr.lines(0.3)
pr = presses(ev)
check(done["ok"] and {"ev": "activate", "win": "B"} in [{k: e[k] for k in ("ev", "win")} for e in ev]
      and len(pr) == 2 and pr[0]["win"] == "B", "foreground raise+click still works after bg 0")
xd.create_resource_object("window", C).configure(stack_mode=XX.Above)
xroot.change_property(xd.intern_atom("_NET_ACTIVE_WINDOW"), Xatom.WINDOW, 32, [C])
xd.sync()
wmr.lines(0.2)

# stdin EOF while in bg mode with a button held: master removed, button released
send(h, "bg 1")
hr.lines(0.2)
send(h, "seq 115 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
check(bg_button_down(), "bg: held before EOF")
h.stdin.close()
rc = h.wait(timeout=3)
ev = [e["ev"] for e in wmr.lines(0.3)]
check(rc == 0 and not masters() and "release" in ev, "EOF in bg mode: exit 0, master removed, button released (%r)" % ev)

# SIGTERM in bg mode
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
send(h, "bg 1"); hr.lines(0.2)
check(bool(masters()), "master back")
send(h, "seq 116 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
h.terminate()
rc = h.wait(timeout=3)
check(rc == 0 and not masters(), "SIGTERM in bg mode: master removed")
wmr.lines(0.2)

# kill -9 leaves the master (and its held button); the next start removes it
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
send(h, "bg 1"); hr.lines(0.2)
send(h, "seq 117 m %d 0.5 0.5;d 1;s 5000" % A)
time.sleep(0.3)
h.kill(); h.wait()
check("clickered-bg pointer" in masters() and bg_button_down(), "kill -9 leaves the stale master with a held button")
wmr.lines(0.2)
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
ev = [e["ev"] for e in wmr.lines(0.3)]
check(not masters() and "release" in ev, "next start removes the stale master and its held button (%r)" % ev)
h.stdin.close(); h.wait(timeout=3)

# foreground-only run: bg never requested -> no master is ever created
h, hr = start()
hr.until(lambda m: m["t"] == "windows")
send(h, "seq 118 m %d 0.5 0.25;d 1;u 1" % A)
hr.until(lambda m: m["t"] == "done")
check(not masters(), "foreground helper creates no master")
h.stdin.close(); h.wait(timeout=3)

wm.kill()
print("FAILURES:", fails)
sys.exit(1 if fails else 0)
