"""Owned Linux SDK/PTY controller. Kernel ancestry + pidfd signals only.
Real terminal input, fresh captures; not pixel/manual visual certification.
"""
import ctypes
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

root = sys.argv[1]
assert sys.platform == 'linux'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
assert hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal')
if len(sys.argv) > 2 and sys.argv[2] == '--driver':
    # Outer public safety supervisor remains alive through timeout or hard kill.
    driver = subprocess.Popen(sys.argv[3:], cwd=root + '/work')
    code = driver.wait(timeout=165)
    reaped = []
    end = time.monotonic() + 4
    while time.monotonic() < end:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            reaped.append({'pid': pid, 'exit': os.waitstatus_to_exitcode(status)})
        else:
            time.sleep(.02)
    else:
        raise Exception('Owned driver descendants did not naturally settle')
    with open(root + '/evidence/driver-supervision.json', 'w') as f:
        json.dump({'ok': code == 0, 'driverPid': driver.pid, 'exit': code, 'reaped': reaped}, f)
    sys.exit(code)

config = json.load(open(root + '/evidence/config.json'))
mode = config['mode']
start = time.monotonic()
stopping = False
proc = None
master = None
seen = {}
raw = bytearray()
report = {'ok': False, 'mode': mode, 'keys': [], 'captures': {}, 'remaining': []}
ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')


def load(name):
    try:
        with open(root + '/evidence/' + name) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def put(name, value):
    with open(root + '/evidence/' + name, 'w') as f:
        json.dump(value, f, indent=2)


def stat(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        return {'pid': pid, 'ppid': int(fields[1]), 'birth': fields[19], 'state': fields[0]}
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned():
    result = {}
    queue = [os.getpid()]
    visited = set(queue)
    while queue:
        parent = queue.pop()
        try:
            threads = os.listdir('/proc/' + str(parent) + '/task')
        except (FileNotFoundError, ProcessLookupError):
            continue
        assert len(threads) <= 128, 'Owned thread ceiling'
        for thread in threads:
            try:
                with open('/proc/' + str(parent) + '/task/' + thread + '/children') as f:
                    children = f.read().split()
            except (FileNotFoundError, ProcessLookupError):
                continue
            for child in children:
                pid = int(child)
                value = stat(pid)
                if pid in visited or not value or value['ppid'] != parent:
                    continue
                result[pid] = value
                visited.add(pid)
                queue.append(pid)
                assert len(result) <= 64, 'Owned descendant ceiling'
    for pid, value in result.items():
        seen[(pid, value['birth'])] = value
    return result


def send(value, sig):
    try:
        fd = os.pidfd_open(value['pid'])
        try:
            now = stat(value['pid'])
            if now and now['birth'] == value['birth'] and value['pid'] in owned():
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass


def reap():
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if not pid:
            return


def stop(_sig, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)


def pump(wait=.03):
    streams = [master] if master is not None else [s for s in [proc.stdout, proc.stderr] if s]
    for stream in select.select(streams, [], [], wait)[0]:
        try:
            data = os.read(stream if isinstance(stream, int) else stream.fileno(), 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                continue
            raise
        raw.extend(data)
        assert len(raw) <= 1024 * 1024, 'Terminal/stdout byte ceiling'
        if master is not None:
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in data:
                os.write(master, b'\x1b[?1;2c')
            if b'\x1b[>c' in data:
                os.write(master, b'\x1b[>0;0;0c')
    owned()


def text(offset=0):
    return ansi.sub('', bytes(raw[offset:]).decode('utf-8', 'replace'))


def emitted(value, offset=0):
    return re.sub(r'\s+', '', value) in re.sub(r'\s+', '', text(offset))


def until(check, label, allow_exit=False):
    end = min(start + 140, time.monotonic() + 40)
    while not stopping and time.monotonic() < end:
        pump()
        if check():
            return
        if load('failure.json') or load('server-failure.json'):
            raise Exception('Fixture failed: ' + str(load('failure.json') or load('server-failure.json')))
        if proc.poll() is not None and not allow_exit:
            if check():
                return
            raise Exception('Host exited: ' + label + '\n' + text()[-4000:])
    raise Exception('Deadline: ' + label + '\n' + text()[-4000:])


def resize(cols, rows):
    for c, r in [(cols - 1, rows - 1), (cols, rows)]:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        value = owned().get(proc.pid)
        if value:
            send(value, signal.SIGWINCH)
        pump(.15)


def key(value, label):
    os.write(master, value)
    report['keys'].append(label)
    pump(.15)


try:
    env = {'PATH': '/usr/bin:/bin', 'HOME': root + '/home', 'TMPDIR': root + '/tmp',
           'LANG': 'C.UTF-8', 'XDG_CONFIG_HOME': root + '/xdg', 'XDG_CACHE_HOME': root + '/xdg',
           'XDG_DATA_HOME': root + '/xdg', 'PI_CODING_AGENT_DIR': root + '/agent',
           'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0',
           'WORKFLOW_SCRIPT_ROOT': root}
    args = [config['node'], '--max-old-space-size=512', '--import', root + '/preload.mjs']
    if mode == 'sdk':
        args += [root + '/sdk-bootstrap.mjs']
        proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    else:
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 55, 180, 0, 0))
        env['TERM'] = 'xterm-256color'
        args += [config['cli'], '--offline', '--no-session', '--no-approve', '--no-extensions',
                 '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
                 '--no-tools', '--model', 'fixture/reviewer', '--thinking', 'off',
                 '--tui-mode', mode, '-e', config['fixture']]
        proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
    until(lambda: bool(load('live.json')), 'compile/inspect/save then explicit start real streams')
    if mode != 'sdk':
        live = load('live.json')
        offset = len(raw)
        report['captures']['live'] = offset
        resize(180, 55)
        until(lambda: emitted(live['workflowRunId'], offset) and emitted('running', offset), 'fresh exact monitor progress')
        until(lambda: emitted('parallel.workflow.js', offset), 'authored source locations in actual Pi monitor')
        key(b'\r', 'drill actual step')
        key(b'q', 'back without cancel')
        put('ui-live.json', {'ok': True, 'source': 'parallel.workflow.js', 'exactRun': live['workflowRunId']})
        put('release.json', {'actualFreshProgressObserved': True})
        until(lambda: bool(load('finished.json')), 'ordinary run completed without extra start')
        offset = len(raw)
        report['captures']['completed'] = offset
        resize(180, 55)
        until(lambda: emitted('completed', offset), 'fresh terminal completion frame')
        key(b'\x03', 'close monitor only')
        until(lambda: bool(load('monitor-closed.json')), 'monitor close preserves completed run')
    until(lambda: bool(load('result.json')), 'inert frozen-provenance recovery', True)
    until(lambda: proc.poll() is not None, 'natural isolated SDK/CLI shutdown', True)
    assert proc.returncode == 0
    # Compiler children must naturally close. Adopt/reap; leaks fail acceptance.
    end = time.monotonic() + 4
    while time.monotonic() < end:
        reap()
        if not owned():
            break
        time.sleep(.02)
    assert not owned(), 'Owned compiler/native descendants leaked after host exit'
    report['ok'] = True
except Exception as error:
    report['error'] = str(error)[-10000:]
finally:
    leaked = bool(owned())
    end = time.monotonic() + 8
    term_end = time.monotonic() + 3
    while time.monotonic() < end:
        members = owned()
        if not members:
            break
        for value in members.values():
            send(value, signal.SIGTERM if time.monotonic() < term_end else signal.SIGKILL)
        if proc and proc.poll() is not None:
            reap()
        time.sleep(.02)
    if proc:
        proc.poll()
    reap()
    report.update({'remaining': list(owned()), 'seen': list(seen.values()),
                   'hostExit': proc.returncode if proc else None, 'cleanupRequired': leaked})
    if report['remaining'] or leaked:
        report['ok'] = False
    with open(root + '/evidence/terminal.ansi', 'wb') as f:
        f.write(raw)
    if master is not None:
        os.close(master)
    put('pty-result.json', report)
if not report['ok']:
    sys.exit(1)
