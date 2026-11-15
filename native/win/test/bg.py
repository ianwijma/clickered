# Background-mode (bg 1) test for clickered-helper.exe under Wine + Xvfb (wine-docker.sh).
# usage: python3 bg.py <bgtarget.exe> <command to start the helper...>
# Starts bgtarget.exe (logging window with children, see bgtarget.c), an occluding "BG Front"
# window and a minimized "BG Min" window, then drives the helper with `bg 1` seqs and reads
# what the target received from its log. The real pointer is parked far away with xdotool and
# must not move; the foreground window (the helper's `active`) must not change.
# Wine is not Windows: this checks the plumbing, not real Windows behaviour.
import json, os, re, subprocess, sys, time, threading, queue

TARGET_EXE = sys.argv[1]
LOG = '/tmp/bgtarget.log'
if os.path.exists(LOG): os.remove(LOG)
procs = []
def spawn(*a):
    pr = subprocess.Popen(['wine', TARGET_EXE, *a], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs.append(pr); return pr
spawn(LOG)
for _ in range(100):
    if os.path.exists(LOG) and 'READY' in open(LOG).read(): break
    time.sleep(0.2)
else:
    print('FAIL target did not start'); sys.exit(1)
spawn('min'); time.sleep(1.5)
spawn('front'); time.sleep(2)

p = subprocess.Popen(sys.argv[2:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
q = queue.Queue()
threading.Thread(target=lambda: ([q.put(l) for l in p.stdout], q.put(None)), daemon=True).start()
def get(timeout=20):
    l = q.get(timeout=timeout)
    if l is None: return None
    m = json.loads(l.decode('utf-8'))
    if m['t'] != 'windows': print('  <-', l.decode().rstrip()[:200])
    return m
def get_until(pred, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        try: m = get(max(0.05, end - time.time()))
        except queue.Empty: break
        if m is None: break
        if pred(m): return m
    return None
def send(s): print('  ->', s); p.stdin.write((s + '\n').encode()); p.stdin.flush()
def drain(t=0.2):
    out = []; end = time.time() + t
    while time.time() < end:
        try: l = q.get(timeout=max(0.01, end - time.time()))
        except queue.Empty: break
        if l is None: break
        m = json.loads(l.decode()); out.append(m)
        if m['t'] != 'windows': print('  <-', l.decode().rstrip()[:200])
    return out
fails = 0
def check(c, w):
    global fails; print(('PASS ' if c else 'FAIL ') + w); fails += 0 if c else 1
def pointer():
    o = subprocess.run(['xdotool', 'getmouselocation'], capture_output=True, text=True).stdout
    return tuple(int(re.search(k + r':(-?\d+)', o).group(1)) for k in 'xy')
def seq(sid, body, timeout=20):
    send('seq %d %s' % (sid, body))
    m = get_until(lambda m: m['t'] == 'done' and m['id'] == sid, timeout)
    return m
last_active = [0]
def windows():
    send('list'); m = get_until(lambda m: m['t'] == 'windows'); last_active[0] = m['active']; return m['list']
def by_title(ws, t):
    r = [w for w in ws if w['title'] == t]; return r[0] if r else None

# ---- target log ----------------------------------------------------------------------------
mark = [0]
LINE = re.compile(r'MSG win=(\w+) msg=(\w+) x=(-?\d+) y=(-?\d+) wp=(0x[0-9a-f]+) cursor=(-?\d+),(-?\d+)')
def log_new(wait=0.4):
    time.sleep(wait)
    ls = open(LOG).read().splitlines()[mark[0]:]
    mark[0] += len(ls)
    out = []
    for l in ls:
        m = LINE.match(l)
        if m:
            out.append(dict(win=m.group(1), msg=m.group(2), x=int(m.group(3)), y=int(m.group(4)),
                            wp=int(m.group(5), 16), cur=(int(m.group(6)), int(m.group(7)))))
        elif l.startswith('EVT'):
            out.append(dict(win='evt', msg=l))
    return out
MOUSE = {'WM_MOUSEMOVE', 'WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_LBUTTONDBLCLK', 'WM_RBUTTONDOWN', 'WM_RBUTTONUP',
         'WM_MBUTTONDOWN', 'WM_MBUTTONUP', 'WM_MOUSEWHEEL', 'WM_MOUSEHWHEEL', 'WM_SETCURSOR'}
def mouse(ev, win=None):
    return [(e['win'], e['msg'], e['x'], e['y'], e['wp']) for e in ev
            if e['win'] != 'evt' and e['msg'] in MOUSE and (win is None or e['win'] == win)]
def real_msgs(ev):  # everything the target saw except hit tests, focus and activation noise
    return [e for e in ev if e['win'] != 'evt' and e['msg'] in MOUSE]

# ---- start ---------------------------------------------------------------------------------
m = get(60); check(m == {'t': 'ready', 'version': 3}, 'ready announces version 3')
ws = windows()
T, F, MN = by_title(ws, 'BG Target'), by_title(ws, 'BG Front'), by_title(ws, 'BG Min')
print('INFO target', T, '\nINFO front', F, '\nINFO min', MN)
check(T is not None and F is not None, 'test windows listed')
if not (T and F): sys.exit(1)
if MN is not None: check(MN['mapped'] is False, 'minimized window is listed mapped:false')
def fr(cx, cy): return '%.6f %.6f' % ((cx + 0.5) / T['w'], (cy + 0.5) / T['h'])
def scr(cx, cy): return (T['x'] + cx, T['y'] + cy)
inner_scr = scr(300, 100)
check(F['x'] <= inner_scr[0] < F['x'] + F['w'] and F['y'] <= inner_scr[1] < F['y'] + F['h'],
      'BG Front covers the inner panel point (occluded target)')

subprocess.run(['xdotool', 'mousemove', '1000', '700']); time.sleep(0.3); drain(0.3)
P0 = pointer(); check(P0 == (1000, 700), 'pointer parked at 1000,700 (got %r)' % (P0,))
windows(); act0 = last_active[0]
log_new(0.1)
def unchanged(what):
    check(pointer() == P0, what + ': real pointer unchanged')
    windows(); check(last_active[0] == act0, what + ': foreground window unchanged (active=%r)' % act0)

# ---- bg parsing ----------------------------------------------------------------------------
send('bg 2'); m = get(); check(m['t'] == 'error', 'bg 2 is an error (%s)' % m.get('msg'))
send('bg'); m = get(); check(m['t'] == 'error', 'bg without argument is an error')
send('bg 1 1'); m = get(); check(m['t'] == 'error', 'bg 1 1 is an error')
send('bg x'); m = get(); check(m['t'] == 'error', 'bg x is an error')
send('bg 1'); r = drain(0.3); check(not r, 'bg 1 sends no reply')

# ---- click arrives at the deepest child, occluded, pointer/foreground untouched ----------------
m = seq(1, 'm %d %s;d 1;s 30;u 1' % (T['id'], fr(300, 100)))
ev = log_new(); ms = mouse(ev)
check(m == {'t': 'done', 'id': 1, 'ok': True}, 'occluded click: done ok:true')
check([x[:2] for x in ms] == [('inner', 'WM_MOUSEMOVE'), ('inner', 'WM_MOUSEMOVE'), ('inner', 'WM_LBUTTONDOWN'), ('inner', 'WM_LBUTTONUP')],
      'occluded click reaches the inner child: move, move, down, up (got %r)' % (ms,))
check(ms and ms[2][2:4] == (50, 50) and ms[2][4] == 1 and ms[3][4] == 0, 'inner-relative coords 50,50; MK_LBUTTON on down, none on up')
check(all(e['cur'] == P0 for e in ev if e['win'] != 'evt'), 'target saw GetCursorPos unchanged during delivery')
check(not any(e['msg'] == 'WM_SETCURSOR' for e in ev if e['win'] != 'evt'), 'no WM_SETCURSOR sent')
unchanged('click')

# ---- different children --------------------------------------------------------------------
m = seq(2, 'm %d %s;d 1;u 1' % (T['id'], fr(100, 180)))
ev = log_new(); ms = mouse(ev)
check(m['ok'] is True and [x[0] for x in ms if x[1] == 'WM_LBUTTONDOWN'] == ['button'] and ms[0][2:4] == (100, 20), 'button child gets the click at 100,20')
check(any(e['win'] == 'evt' and 'BN_CLICKED' in e['msg'] for e in ev), 'push button reported BN_CLICKED')
m = seq(3, 'm %d %s;d 1;u 1' % (T['id'], fr(100, 75)))
ms = mouse(log_new()); check([x[0] for x in ms if x[1] == 'WM_LBUTTONDOWN'] == ['edit'], 'edit child gets the click')
m = seq(4, 'm %d %s;d 1;u 1' % (T['id'], fr(100, 225)))
ms = mouse(log_new()); check(m['ok'] and [x[0] for x in ms if x[1] == 'WM_LBUTTONDOWN'] == ['top'], 'HTTRANSPARENT label falls through to its parent (top) (got %r)' % (ms,))
m = seq(5, 'm %d %s;d 1;u 1' % (T['id'], fr(250, 180)))
ms = mouse(log_new()); check(m['ok'] and [x[0] for x in ms if x[1] == 'WM_LBUTTONDOWN'] == ['panel'], 'disabled child skipped: click goes to panel')
m = seq(6, 'm %d %s;d 1;u 1' % (T['id'], fr(300, 250)))
ms = mouse(log_new()); check(m['ok'] and [x[0] for x in ms if x[1] == 'WM_LBUTTONDOWN'] == ['panel'], 'hidden child skipped: click goes to panel')
m = seq(7, 'm %d %s;d 3;u 3' % (T['id'], fr(300, 100)))
ms = mouse(log_new()); check(m['ok'] and [x[1] for x in ms if x[1].startswith('WM_R')] == ['WM_RBUTTONDOWN', 'WM_RBUTTONUP'], 'right button posts WM_RBUTTONDOWN/UP')
unchanged('children')

# ---- drag ----------------------------------------------------------------------------------
m = seq(8, 'm %d %s;d 1;s 20;m %d %s;s 20;m %d %s;s 20;m %d %s;s 20;u 1' % (
    T['id'], fr(260, 60), T['id'], fr(300, 100), T['id'], fr(340, 140), T['id'], fr(390, 200)))
ev = log_new(); ms = mouse(ev)
check(m['ok'] is True, 'drag: done ok:true')
check(all(x[0] == 'inner' for x in ms), 'drag: down, every move and the up reach the same child (got %r)' % ([x[0] for x in ms],))
dn = [x for x in ms if x[1] == 'WM_LBUTTONDOWN']; mv = [x for x in ms if x[1] == 'WM_MOUSEMOVE' and x[4] == 1]; up = [x for x in ms if x[1] == 'WM_LBUTTONUP']
check(dn and dn[0][2:4] == (10, 10), 'drag: down at 10,10')
check([x[2:4] for x in mv] == [(50, 50), (90, 90), (140, 150)], 'drag: held moves carry MK_LBUTTON and are re-relativized, even outside the child (got %r)' % ([x[2:4] for x in mv],))
check(up and up[0][2:4] == (140, 150) and up[0][4] == 0, 'drag: up at the last position')
unchanged('drag')

# ---- wheel ---------------------------------------------------------------------------------
m = seq(9, 'm %d %s;d 5;u 5;s 20;d 5;u 5;s 20;d 5;u 5' % (T['id'], fr(100, 75)))
ev = log_new(); wh = [e for e in ev if e['win'] == 'edit' and e['msg'] == 'WM_MOUSEWHEEL']
first = [int(x) for e in ev if e['win'] == 'evt' for x in re.findall(r'WM_MOUSEWHEEL.*firstline=(\d+)', e['msg'])]
es = scr(100, 75)
check(m['ok'] and len(wh) == 3 and all((e['wp'] >> 16) & 0xffff == 0xff88 for e in wh), 'wheel: 3 WM_MOUSEWHEEL (delta -120) to the edit')
check(wh and all((e['x'], e['y']) == es for e in wh), 'wheel: lParam holds SCREEN coordinates %r (got %r)' % (es, [(e['x'], e['y']) for e in wh][:1]))
check(first and max(first) > 0, 'wheel scrolls the background edit control (firstline %r)' % first)
m = seq(10, 'm %d %s;d 7;u 7;d 6;u 6' % (T['id'], fr(100, 75)))
ev = log_new(); h = [(e['msg'], (e['wp'] >> 16) & 0xffff) for e in ev if e['win'] == 'edit' and e['msg'] == 'WM_MOUSEHWHEEL']
check(m['ok'] and h == [('WM_MOUSEHWHEEL', 120), ('WM_MOUSEHWHEEL', 0xff88)], 'horizontal wheel: right +120, left -120 (got %r)' % (h,))
unchanged('wheel')

# ---- double click --------------------------------------------------------------------------
m = seq(11, 'm %d %s;d 1;s 20;u 1;s 60;d 1;s 20;u 1' % (T['id'], fr(300, 100)))
ms = mouse(log_new(), 'inner'); k = [x[1] for x in ms if x[1] != 'WM_MOUSEMOVE']
check(k == ['WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_LBUTTONDBLCLK', 'WM_LBUTTONUP'], 'quick second press becomes WM_LBUTTONDBLCLK (got %r)' % (k,))
m = seq(12, 'm %d %s;d 1;s 20;u 1' % (T['id'], fr(300, 100))); time.sleep(0.1)
m2 = seq(13, 'm %d %s;d 1;s 20;u 1' % (T['id'], fr(300, 100)))
k = [x[1] for x in mouse(log_new(), 'inner') if x[1] != 'WM_MOUSEMOVE']
check(k == ['WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_LBUTTONDBLCLK', 'WM_LBUTTONUP'], 'double click across two seqs (got %r)' % (k,))
m = seq(14, 'm %d %s;d 1;s 20;u 1;s 700;d 1;s 20;u 1' % (T['id'], fr(300, 100)))
k = [x[1] for x in mouse(log_new(), 'inner') if x[1] != 'WM_MOUSEMOVE']
check(k == ['WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_LBUTTONDOWN', 'WM_LBUTTONUP'], 'slow second press stays a plain press (got %r)' % (k,))
m = seq(15, 'm %d %s;d 1;s 20;u 1;s 60;m %d %s;d 1;s 20;u 1' % (T['id'], fr(260, 60), T['id'], fr(340, 140)))
k = [x[1] for x in mouse(log_new(), 'inner') if x[1] != 'WM_MOUSEMOVE']
check(k == ['WM_LBUTTONDOWN', 'WM_LBUTTONUP', 'WM_LBUTTONDOWN', 'WM_LBUTTONUP'], 'second press outside the double-click rectangle stays a plain press (got %r)' % (k,))
m = seq(16, 'm %d %s;d 1;u 1;s 40;d 1;u 1;s 40;d 1;u 1' % (T['id'], fr(300, 100)))
k = [x[1] for x in mouse(log_new(), 'inner') if x[1] != 'WM_MOUSEMOVE']
check(k.count('WM_LBUTTONDBLCLK') == 1 and k.count('WM_LBUTTONDOWN') == 2, 'third quick press is a plain press again (got %r)' % (k,))

# ---- skip mode -----------------------------------------------------------------------------
m = seq(20, 'm %d %.6f %.6f;d 1;s 20;u 1' % (T['id'], 0.5, -9.0 / T['h']))
ev = log_new(); check(m == {'t': 'done', 'id': 20, 'ok': False} and not real_msgs(ev), 'title-bar point is skipped: done ok:false, nothing posted (got %r)' % (mouse(ev),))
m = seq(21, 'm %d 1.5 0.5;d 1;u 1' % T['id'])
check(m == {'t': 'done', 'id': 21, 'ok': False} and not real_msgs(log_new()), 'point outside the window is skipped: ok:false')
m = seq(22, 'm 305419896 0.5 0.5;d 1;u 1')
check(m == {'t': 'done', 'id': 22, 'ok': False}, 'missing window skipped: ok:false')
if MN is not None:
    m = seq(23, 'm %d 0.5 0.5;d 1;u 1' % MN['id'])
    check(m == {'t': 'done', 'id': 23, 'ok': False}, 'minimized window skipped: ok:false')
    check(by_title(windows(), 'BG Min')['mapped'] is False, 'minimized window was not restored')
m = seq(24, 'm 305419896 0.5 0.5;d 1;u 1;m %d %s;d 1;u 1' % (T['id'], fr(100, 75)))
ms = mouse(log_new()); check(m['ok'] is True and 'WM_LBUTTONDOWN' in [x[1] for x in ms], 'a skipped target does not stop the next target; done ok:true')
m = seq(25, 'f 305419896;d 1;u 1')
check(m == {'t': 'done', 'id': 25, 'ok': False}, 'f on a missing window: ok:false')
m = seq(26, 'f %d;m %d %s;d 1;u 1' % (T['id'], T['id'], fr(300, 100)))
ms = mouse(log_new()); check(m['ok'] is True and 'WM_LBUTTONDOWN' in [x[1] for x in ms], 'f only checks existence; then the click is delivered')
m = seq(27, 'w 5 5;d 1;u 1')
check(m['ok'] is True and not real_msgs(log_new()), 'w does nothing in background mode (no click, ok:true)')
unchanged('skips')

# ---- real input during a bg seq: no lock; no btn/motion reports ----------------------------------
send('seq 30 m %d %s;s 700;d 1;u 1' % (T['id'], fr(300, 100)))
time.sleep(0.25); subprocess.run(['xdotool', 'mousemove', '900', '600']); time.sleep(0.1)
moved = pointer(); subprocess.run(['xdotool', 'click', '1']); time.sleep(0.1)
m = get_until(lambda m: m['t'] == 'done' and m['id'] == 30)
others = [e for e in drain(0.3) if e['t'] in ('btn', 'motion')]
check(moved == (900, 600), 'user can move the real pointer during a background seq (mouse not locked): %r' % (moved,))
check(m and m['ok'] is True, 'seq still completes')
check(not others, 'no btn/motion reported for a seq (own background clicks or user input during it)')
log_new(0.2)
P1 = pointer(); subprocess.run(['xdotool', 'mousemove', '1000', '700']); time.sleep(0.2); drain(0.2); log_new(0.1)

# ---- helper reports no btn for its own background clicks (also after the seq) ----------------------
send('seq 31 m %d %s;d 1;s 30;u 1' % (T['id'], fr(100, 180)))
ms = []
t_end = time.time() + 2
while time.time() < t_end:
    try: x = get(0.3)
    except queue.Empty: continue
    if x is None: break
    ms.append(x)
time.sleep(0.2); ms += drain(0.5); log_new()
check([x for x in ms if x['t'] in ('btn', 'motion')] == [] and {'t': 'done', 'id': 31, 'ok': True} in ms, 'helper reports no btn/motion for its own background clicks')

# ---- abort mid drag posts the up -----------------------------------------------------------
send('seq 40 m %d %s;d 1;s 20;m %d %s;s 5000;u 1' % (T['id'], fr(260, 60), T['id'], fr(300, 100)))
time.sleep(0.6); log_new(0.1); send('abort')
m = get_until(lambda m: m['t'] == 'done' and m['id'] == 40, 5)
ms = mouse(log_new())
check(m == {'t': 'done', 'id': 40, 'ok': False}, 'abort mid-drag: done ok:false')
check(ms and ms[-1][:2] == ('inner', 'WM_LBUTTONUP'), 'abort mid-drag posts the pending button-up to the gesture receiver (got %r)' % (ms,))
unchanged('abort')
# release at end: seq finishes while still holding the button
m = seq(41, 'm %d %s;d 1;s 20' % (T['id'], fr(300, 100)))
ms = mouse(log_new()); check(m['ok'] and [x[1] for x in ms][-1] == 'WM_LBUTTONUP', 'release-at-end posts the up for a button still held')
# EOF mid-drag handled at the very end

# ---- foreground mode still works after bg 0 ----------------------------------------------------------
send('bg 0'); r = drain(0.2); check(not r, 'bg 0 sends no reply')
m = seq(50, 'm %d %s;d 1;s 30;u 1' % (T['id'], fr(100, 75)))
ev = log_new(0.6)
check(m['ok'] is True, 'foreground seq after bg 0: done ok:true')
check(any(e['win'] == 'edit' and e['msg'] == 'WM_LBUTTONDOWN' for e in ev), 'foreground click reaches the edit through real input')
cx, cy = scr(100, 75)
down = [e for e in ev if e['win'] == 'edit' and e['msg'] == 'WM_LBUTTONDOWN']
check(down and down[0]['cur'] == (cx, cy), 'foreground mode moves the real cursor to the target (GetCursorPos at the click: %r, want %r)' % (down[0]['cur'] if down else None, (cx, cy)))
windows(); act = last_active[0]
check(T['id'] == act, 'foreground mode activates the (covered or not) target: active=%r' % act)
m = seq(51, 'w 200 200;s 10;w 300 300')
check(m == {'t': 'done', 'id': 51, 'ok': True}, 'foreground w seq ok')

# ---- EOF during a background drag ------------------------------------------------------------------
send('bg 1'); drain(0.1); log_new(0.1)
send('seq 60 m %d %s;d 1;s 20;m %d %s;s 5000' % (T['id'], fr(260, 60), T['id'], fr(300, 100)))
time.sleep(0.6); log_new(0.1); p.stdin.close()
m = get_until(lambda m: m['t'] == 'done' and m['id'] == 60, 5)
ms = mouse(log_new())
check(m == {'t': 'done', 'id': 60, 'ok': False} and ms and ms[-1][:2] == ('inner', 'WM_LBUTTONUP'), 'stdin EOF mid-drag: done ok:false and the up was posted')
try: rc = p.wait(10)
except subprocess.TimeoutExpired: rc = 'timeout'
check(rc == 0, 'exit code 0 after EOF (got %r)' % (rc,))
for pr in procs: pr.kill()
print('FAILURES:', fails)
sys.exit(1 if fails else 0)
