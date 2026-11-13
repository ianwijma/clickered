#!/usr/bin/env python3
"""Minimal EWMH stand-in for testing clickered-helper on a bare Xvfb.

Creates test windows, maintains _NET_CLIENT_LIST / _NET_ACTIVE_WINDOW, honours
_NET_ACTIVE_WINDOW client messages (activate + raise) and logs every pointer/key
event the test windows receive as JSON lines on stdout.

  A: 640x408 at (0,0) with one 632x374+4+30 child (Wine-style title bar)
  B: 400x300 at (650,0)
  C: 300x200 at (700,50), initially on top of B

Setting the root property _FAKEWM_REFUSE (WINDOW, 32) to a list of window ids makes the
WM ignore activation requests for those windows, like a WM with focus-stealing prevention.
"""
import json
import sys

from Xlib import X, Xatom, display

d = display.Display()
root = d.screen().root
A = lambda n: d.intern_atom(n)
CL, ACT, NAME, UTF8, PID = (A("_NET_CLIENT_LIST"), A("_NET_ACTIVE_WINDOW"),
                            A("_NET_WM_NAME"), A("UTF8_STRING"), A("_NET_WM_PID"))
REFUSE = A("_FAKEWM_REFUSE")
MASK = (X.ButtonPressMask | X.ButtonReleaseMask | X.PointerMotionMask |
        X.KeyPressMask | X.KeyReleaseMask)


def mk(parent, x, y, w, h, name=None, cls=None, net_name=True):
    win = parent.create_window(x, y, w, h, 0, X.CopyFromParent, X.InputOutput,
                               X.CopyFromParent, background_pixel=0x336699,
                               event_mask=MASK)
    if name:
        if net_name:
            win.change_property(NAME, UTF8, 8, name.encode())
        win.set_wm_name(name.encode("latin-1", "replace").decode("latin-1"))
        win.set_wm_class(cls, cls)
        win.change_property(PID, Xatom.CARDINAL, 32, [4242])
    win.map()
    return win


wa = mk(root, 0, 0, 640, 408, "Test A é☃", "testcls")
wa_child = mk(wa, 4, 30, 632, 374)
wb = mk(root, 650, 0, 400, 300, "Test B \"quoted\"", "testcls")
wc = mk(root, 700, 50, 300, 200, "Test C \u00e9 latin1", "othercls", net_name=False)
clients = [wa, wb, wc]
names = {wa.id: "A", wa_child.id: "A.child", wb.id: "B", wc.id: "C"}
root.change_attributes(event_mask=X.SubstructureNotifyMask)
root.change_property(CL, Xatom.WINDOW, 32, [w.id for w in clients])
root.change_property(ACT, Xatom.WINDOW, 32, [wc.id])
d.sync()
print(json.dumps({"ready": True, **{k: w.id for k, w in
                                     (("A", wa), ("Achild", wa_child), ("B", wb), ("C", wc))}}),
      flush=True)

kinds = {X.ButtonPress: "press", X.ButtonRelease: "release", X.MotionNotify: "motion",
         X.KeyPress: "kpress", X.KeyRelease: "krelease"}
while True:
    e = d.next_event()
    if e.type == X.ClientMessage and e.client_type == ACT:
        refused = root.get_full_property(REFUSE, Xatom.WINDOW)
        if refused and e.window.id in refused.value:
            print(json.dumps({"ev": "refuse", "win": names.get(e.window.id, e.window.id)}), flush=True)
            continue
        w = d.create_resource_object("window", e.window)
        w.configure(stack_mode=X.Above)
        root.change_property(ACT, Xatom.WINDOW, 32, [e.window.id])
        d.sync()
        print(json.dumps({"ev": "activate", "win": names.get(e.window.id, e.window.id)}),
              flush=True)
    elif e.type in kinds:
        print(json.dumps({"ev": kinds[e.type], "win": names.get(e.window.id, e.window.id),
                          "detail": e.detail, "x": e.event_x, "y": e.event_y,
                          "rx": e.root_x, "ry": e.root_y}), flush=True)
