# Capture/pick/Escape test under Wine + Xvfb, driving input with xdotool (wine-docker.sh).
# Expects a Notepad window to be open. usage: python3 capture.py <command to start the helper...>
import json, subprocess, sys, time, threading, queue
p = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
q = queue.Queue()
threading.Thread(target=lambda: [q.put(l) for l in p.stdout] and q.put(None), daemon=True).start()
def drain(t=1.0):
    out = []; end = time.time() + t
    while True:
        try: l = q.get(timeout=max(0.01, end - time.time()))
        except queue.Empty: break
        if l is None: break
        m = json.loads(l.decode('utf-8')); out.append(m)
        if m['t'] != 'windows': print('  <-', l.decode().rstrip()[:200])
        if time.time() > end: break
    return out
def send(s): print('  ->', s); p.stdin.write((s + '\n').encode())
def xdo(*a): print('  xdotool', *a); subprocess.run(['xdotool', *a])
fails = 0
def check(c, w):
    global fails; print(('PASS ' if c else 'FAIL ') + w); fails += 0 if c else 1
ms = drain(3); win = [w for m in ms if m['t'] == 'windows' for w in m['list'] if 'otepad' in w['title']][-1]
wid, cx, cy = win['id'], win['x'] + win['w'] // 2, win['y'] + win['h'] // 2
xdo('mousemove', str(cx), str(cy)); time.sleep(0.3); drain(0.3)
xdo('mousedown', '1'); time.sleep(0.05); xdo('mousemove', str(cx + 40), str(cy + 20)); time.sleep(0.05); xdo('mouseup', '1')
ms = drain(1)
btns = [m for m in ms if m['t'] == 'btn']; mot = [m for m in ms if m['t'] == 'motion']
check(len(btns) == 2 and btns[0]['down'] and not btns[1]['down'] and all(b['win'] == wid and b['button'] == 1 for b in btns), 'physical press/release reported with gesture win')
check(btns and abs(btns[0]['fx'] - 0.5) < 0.01 and abs(btns[0]['fy'] - 0.5) < 0.01, 'press fractions ~0.5')
check(len(mot) >= 1 and mot[-1]['win'] == wid, 'motion while held')
xdo('click', '4'); ms = drain(0.5); b = [m['button'] for m in ms if m['t'] == 'btn']
check(b == [4, 4], 'wheel up -> button 4 press+release (got %r)' % b)
xdo('click', '3'); ms = drain(0.5); check([m['button'] for m in ms if m['t'] == 'btn'] == [3, 3], 'right click -> button 3')
xdo('mousemove', str(cx), str(cy)); time.sleep(0.2); drain(0.2)
send('seq 1 m %d 0.25 0.25;d 1;s 30;u 1' % wid); ms = drain(1)
check([m for m in ms if m['t'] == 'done'] == [{'t': 'done', 'id': 1, 'ok': True}] and not [m for m in ms if m['t'] in ('btn', 'motion')], 'own injected click not reported')
loc = subprocess.run(['xdotool', 'getmouselocation'], capture_output=True, text=True).stdout
print('  pointer after m 0.25 0.25:', loc.strip(), 'expected x=%d y=%d' % (win['x'] + win['w'] // 4, win['y'] + win['h'] // 4))
time.sleep(0.1)
send('seq 2 s 3000'); time.sleep(0.3); t0 = time.time(); xdo('key', 'Escape'); ms = drain(1)
check(any(m['t'] == 'esc' for m in ms) and {'t': 'done', 'id': 2, 'ok': False} in ms, 'Escape during seq -> esc + abort')
xdo('key', 'Escape'); ms = drain(0.5); check(any(m['t'] == 'esc' for m in ms), 'Escape when idle -> esc')
send('pick'); time.sleep(0.3); xdo('click', '1'); ms = drain(1)
check({'t': 'picked', 'win': wid} in ms and not [m for m in ms if m['t'] == 'btn'], 'pick: left click -> picked notepad, click not reported')
send('pick'); time.sleep(0.3); xdo('click', '3'); ms = drain(1)
check({'t': 'picked', 'win': 0} in ms, 'pick: right click -> picked 0')
xdo('key', 'x'); xdo('mousemove', '300', '300'); time.sleep(0.3); drain(0.3)
send('seq 3 s 3000'); time.sleep(0.3); xdo('key', 'Escape'); ms = drain(1)
check({'t': 'done', 'id': 3, 'ok': False} in ms, 'Escape during seq after a pick')
xdo('key', 'a'); ms = drain(0.5); check(not [m for m in ms if m['t'] not in ('windows',)], 'other keys never reported')
p.stdin.close(); print('exit', p.wait(10)); print('FAILURES:', fails)
sys.exit(1 if fails else 0)
