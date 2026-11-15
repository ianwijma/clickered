# Protocol smoke test for clickered-helper.exe (run under Wine by wine-docker.sh).
# usage: python3 smoke.py <command to start the helper...>
import json, subprocess, sys, time, threading, queue
cmd = sys.argv[1:]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
q = queue.Queue()
def rd():
    for line in p.stdout:
        q.put(line)
    q.put(None)
threading.Thread(target=rd, daemon=True).start()
def errrd():
    for line in p.stderr:
        s = line.decode('utf-8', 'replace').rstrip()
        if 'clickered' in s: print('  [stderr]', s)
threading.Thread(target=errrd, daemon=True).start()
fails = 0
def get(timeout=20):
    l = q.get(timeout=timeout)
    if l is None: return None
    s = l.decode('utf-8')  # must be valid UTF-8
    m = json.loads(s)
    print('  <-', s.rstrip()[:300])
    return m
def send(s):
    print('  ->', s)
    p.stdin.write((s + '\n').encode()); p.stdin.flush()
def check(cond, what):
    global fails
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails += 1
m = get(60); check(m == {"t": "ready", "version": 3}, 'ready version 3')
m = get(); check(m['t'] == 'windows' and isinstance(m['list'], list), 'windows after ready')
send('list'); m = get(); check(m['t'] == 'windows', 'list -> windows')
send('keys 1'); m = get(); check(m['t'] == 'error' and 'unknown command' in m['msg'], 'keys is an unknown command')
send('bogus'); m = get(); check(m['t'] == 'error', 'unknown command -> error')
send('seq 7 d 1;kd 38;ku 38;u 1'); a = get(); b = get()
check(a['t'] == 'error' and b == {"t": "done", "id": 7, "ok": False}, 'kd op rejected: error + done ok:false')
send('seq 8 m 123 nan 0.5'); a = get(); b = get()
check(a['t'] == 'error' and b == {"t": "done", "id": 8, "ok": False}, 'nan fraction rejected')
send('seq 9 w 40000 1'); a = get(); b = get()
check(a['t'] == 'error' and b == {"t": "done", "id": 9, "ok": False}, 'out-of-range w rejected')
send('seq 10 f 0'); a = get(); b = get()
check(a['t'] == 'error' and b['ok'] is False, 'f 0 rejected')
t0 = time.time(); send('seq 11 w 10 10;s 120;w 20 20'); m = get(); dt = time.time() - t0
check(m == {"t": "done", "id": 11, "ok": True} and dt >= 0.11, 'w/s seq ok, slept (%.0f ms)' % (dt * 1000))
send('seq 12 f 305419896;d 1;s 50;u 1'); m = get()
check(m == {"t": "done", "id": 12, "ok": False}, 'missing window -> skip -> ok:false')
t0 = time.time(); send('seq 13 s 5000'); time.sleep(0.2); send('abort'); m = get(); dt = time.time() - t0
check(m == {"t": "done", "id": 13, "ok": False} and dt < 1.5, 'abort during sleep (%.0f ms)' % (dt * 1000))
t0 = time.time(); send('seq 14 s 3000'); send('abort'); m = get(); dt = time.time() - t0
check(m['id'] == 14 and m['ok'] is False and dt < 1.5, 'abort sent right behind seq (%.0f ms)' % (dt * 1000))
send('list'); m = get()
np = [w for w in m['list'] if 'otepad' in w['title']]
print('INFO notepad entries:', np)
if np:
    wid = np[0]['id']
    send('seq 20 f %d' % wid); print('INFO f on notepad ->', get())
    send('seq 21 m %d 0.5 0.5;d 1;u 1' % wid); print('INFO m+click on notepad ->', get())
    send('seq 22 m %d 0.5 0.5;d 1;m %d 0.6 0.6;u 1' % (wid, wid)); print('INFO drag on notepad ->', get())
send('pickcancel'); send('list'); m = get(); check(m['t'] == 'windows', 'pickcancel when idle is a no-op')
send('pick'); send('pickcancel'); m = get(); check(m == {"t": "picked", "win": 0}, 'pick + pickcancel -> picked 0')
send('seq 15 s 3000'); time.sleep(0.3); t0 = time.time(); p.stdin.close()
m = get(); dt = time.time() - t0
check(m == {"t": "done", "id": 15, "ok": False}, 'stdin EOF during seq -> done ok:false (%.0f ms)' % (dt * 1000))
try:
    rc = p.wait(10)
except subprocess.TimeoutExpired:
    rc = 'timeout'
check(rc == 0, 'exit code 0 after EOF (got %r)' % (rc,))
print('FAILURES:', fails)
sys.exit(1 if fails else 0)
