"""Owned Linux crash/PTY controller. No process-group/broad signals.
Fresh CLI hosts receive real terminal input; proofs are captured from fresh
segments, not matching an earlier frame. Not a visual or power-loss test.
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
if len(sys.argv) > 2 and sys.argv[2] == "--driver":
    # Outer fixture owns a tsx compiler too. Reap it before returning to the
    # public safety supervisor, so leaks cannot be hidden by root deletion.
    assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
    driver = subprocess.Popen(sys.argv[3:], cwd=root + "/work")
    code = driver.wait(timeout=165)
    reaped = []
    end = time.monotonic() + 4
    while time.monotonic() < end:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            reaped.append({"pid": pid, "exit": os.waitstatus_to_exitcode(status)})
        else:
            time.sleep(0.02)
    else:
        raise Exception("outer compiler did not naturally close")
    with open(root + "/evidence/driver-supervision.json", "w") as f:
        json.dump(
            {"ok": code == 0, "driverPid": driver.pid, "exit": code, "reaped": reaped},
            f,
        )
    sys.exit(code)
config = json.load(open(root + "/evidence/config.json"))
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0
assert hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")
mode = config["mode"]
start = time.monotonic()
stop = False
proc = None
master = None
seen = {}
report = {
    "ok": False,
    "mode": mode,
    "keys": [],
    "captures": {},
    "seen": [],
    "remaining": [],
}
raw = bytearray()
ansi = re.compile(
    r"\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]"
)


def load(name):
    try:
        return json.load(open(root + "/evidence/" + name))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def put(name, value):
    with open(root + "/evidence/" + name, "w") as f:
        json.dump(value, f, indent=2)


def stat(pid):
    try:
        fields = open("/proc/" + str(pid) + "/stat").read().rsplit(")", 1)[1].split()
        try:
            exe = os.readlink("/proc/" + str(pid) + "/exe")
        except PermissionError:
            exe = ""
        except FileNotFoundError:
            exe = ""
        return {
            "pid": pid,
            "ppid": int(fields[1]),
            "birth": fields[19],
            "state": fields[0],
            "exe": exe,
        }
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def owned():
    # Traverse only this subreaper's kernel child lists, including child lists
    # of threads in already-owned processes. No global PID scan/name matching.
    result = {}
    queue = [os.getpid()]
    visited = set(queue)
    while queue:
        parent = queue.pop()
        try:
            threads = os.listdir("/proc/" + str(parent) + "/task")
        except (FileNotFoundError, ProcessLookupError):
            continue
        assert len(threads) <= 128, "owned thread ceiling"
        for thread in threads:
            try:
                children = (
                    open("/proc/" + str(parent) + "/task/" + thread + "/children")
                    .read()
                    .split()
                )
            except (FileNotFoundError, ProcessLookupError):
                continue
            for child in children:
                pid = int(child)
                if pid in visited:
                    continue
                value = stat(pid)
                if not value or value["ppid"] != parent:
                    continue
                result[pid] = value
                visited.add(pid)
                queue.append(pid)
                assert len(result) <= 64, "descendant ceiling"
    for pid, value in result.items():
        seen[(pid, value["birth"])] = value
    return result


def send(value, sig):
    # Recheck lineage + start ticks *after* opening pidfd; never signal an
    # unowned or reused PID (not even if a fixture metadata file names it).
    try:
        fd = os.pidfd_open(value["pid"])
        try:
            now = stat(value["pid"])
            if now and now["birth"] == value["birth"] and value["pid"] in owned():
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except ProcessLookupError:
        pass


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if not pid:
            return


def stopped(_s, _f):
    global stop
    stop = True


signal.signal(signal.SIGTERM, stopped)
signal.signal(signal.SIGINT, stopped)


def pump(wait=0.03):
    if master is not None:
        if select.select([master], [], [], wait)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO:
                    return
                raise
            raw.extend(data)
            assert len(raw) <= 2 * 1024 * 1024, "terminal byte ceiling"
            if b"\x1b[6n" in data:
                os.write(master, b"\x1b[1;1R")
            if b"\x1b[c" in data:
                os.write(master, b"\x1b[?1;2c")
            if b"\x1b[>c" in data:
                os.write(master, b"\x1b[>0;0;0c")
    elif proc is not None:
        for stream in [proc.stdout, proc.stderr]:
            if stream and select.select([stream], [], [], wait)[0]:
                data = os.read(stream.fileno(), 65536)
                raw.extend(data)
                assert len(raw) <= 2 * 1024 * 1024
    owned()


def until(check, label, allow_exit=False):
    deadline = min(start + 140, time.monotonic() + 45)
    while time.monotonic() < deadline and not stop:
        pump()
        if check():
            return
        if load("failure.json"):
            raise Exception("host failure " + str(load("failure.json")))
        if proc is not None and proc.poll() is not None and not allow_exit:
            if check():
                return
            raise Exception("process exit " + label + "\n" + text()[-5000:])
    raise Exception("deadline " + label + "\n" + text()[-5000:])


def text(offset=0):
    return ansi.sub("", bytes(raw[offset:]).decode("utf-8", "replace"))


def emitted(value, offset=0):
    return re.sub(r"\s+", "", value) in re.sub(r"\s+", "", text(offset))


def pause(seconds=0.2):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump()


def mark(name):
    report["captures"][name] = len(raw)
    return len(raw)


def key(value, label):
    os.write(master, value)
    report["keys"].append(label)
    pause()


def resize(cols, rows):
    # Changing dimensions forces real fresh bytes even if the prior render
    # happened between phase-file observation and capture marking.
    for c, r in [(cols - 1, rows - 1), (cols, rows)]:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        if proc is not None and proc.poll() is None:
            send(owned()[proc.pid], signal.SIGWINCH)
        pause(0.2)


def launch(phase):
    global proc, master, raw
    raw = bytearray()
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": root + "/home",
        "TMPDIR": root + "/tmp",
        "LANG": "C.UTF-8",
        "XDG_CONFIG_HOME": root + "/xdg",
        "XDG_CACHE_HOME": root + "/xdg",
        "XDG_DATA_HOME": root + "/xdg",
        "PI_CODING_AGENT_DIR": root + "/agent",
        "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
        "WORKFLOW_RECOVERY_ROOT": root,
        "WORKFLOW_RECOVERY_PHASE": phase,
        "WORKFLOW_RECOVERY_SDK": config["sdk"],
    }
    args = [
        config["node"],
        "--import",
        config["loader"],
        "--import",
        root + "/preload.mjs",
    ]
    if mode == "sdk":
        args += [config["fixture"], "--sdk"]
        proc = subprocess.Popen(
            args,
            cwd=root + "/work",
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    else:
        master, slave = pty.openpty()
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 55, 180, 0, 0))
        env["TERM"] = "xterm-256color"
        args += [
            config["cli"],
            "--offline",
            "--no-session",
            "--no-approve",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-tools",
            "--model",
            "fixture/writer",
            "--thinking",
            "off",
            "--tui-mode",
            mode,
            "-e",
            config["fixture"],
        ]
        proc = subprocess.Popen(
            args, cwd=root + "/work", env=env, stdin=slave, stdout=slave, stderr=slave
        )
        os.close(slave)
    owned()


def drain_compilers():
    # Compiler service is the only subprocess possible before old kill or after
    # normal fresh shutdown. Real checks have their own durable supervisor and
    # must have naturally closed before application gate.
    end = time.monotonic() + 3
    while time.monotonic() < end:
        reap()
        members = owned()
        if not members:
            return
        for value in members.values():
            assert value["exe"].endswith("/esbuild") or value["state"] == "Z", (
                "unexpected remaining native/check worker"
            )
        time.sleep(0.03)
    raise Exception("compiler did not naturally settle")


try:
    launch("old")
    until(lambda: bool(load("old.json")), "actual old stagewrite held provider stream")
    old = load("old.json")
    identity = old["identity"]
    value = owned()[proc.pid]
    assert identity["pid"] == proc.pid and identity["startTicks"] == value["birth"]
    assert identity["bootId"] == open("/proc/sys/kernel/random/boot_id").read().strip()
    old_members = list(owned().values())
    fd = os.pidfd_open(proc.pid)
    try:
        after_open = stat(proc.pid)
        assert (
            after_open
            and after_open["birth"] == identity["startTicks"]
            and proc.pid in owned()
        )
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        assert proc.wait(timeout=5) == -9
        assert select.select([fd], [], [], 1)[0], "kernel pidfd exit not observed"
        kernel = {
            "pidfdSignalled": True,
            "pidfdExitReadable": True,
            "postOpenStartTicks": after_open["birth"],
            "waitExit": proc.returncode,
        }
    finally:
        os.close(fd)
    pump(0)
    with open(root + "/evidence/old-terminal.ansi", "wb") as f:
        f.write(raw)
    if master is not None:
        os.close(master)
        master = None
    drain_compilers()
    put(
        "old-closed.json",
        {
            "identity": identity,
            "processExit": proc.returncode,
            "kernel": kernel,
            "owned": old_members,
            "remaining": list(owned().values()),
        },
    )
    until(
        lambda: bool(load("launch-fresh.json")),
        "independent server proof after all old HTTP closed",
        True,
    )
    launch("fresh")
    until(lambda: bool(load("ready.json")), "inert fresh snapshot inspection")
    if mode != "sdk":
        ready = load("ready.json")
        source = ready["runId"]
        until(lambda: emitted(source), "exact recovered monitor source")
        first = mark("first-inspect")
        key(b"i", "inspect read-only")
        until(lambda: emitted("Inspect recovery", first), "real inspect pane")
        key(b"q", "back without cancel")
        key(b"\r", "drill stage")
        key(b"q", "back stage navigation")
        key(b"\x03", "close UI only, no run cancel")
        until(
            lambda: bool(load("closed-first.json")), "close preserves recovered source"
        )
        assert load("closed-first.json") == {"count": 1, "sessions": 0}
        second = mark("second-monitor")
        resize(180, 55)
        until(lambda: emitted(source, second), "fresh reopened monitor capture")
        recommended = mark("recommendation")
        key(b"n", "prepare without selections is recommendation ONLY")
        until(
            lambda: emitted("RECOMMENDATION ONLY", recommended),
            "read-only recommendation displayed",
        )
        new = mark("explicit-selection")
        key(b"s", "explicit resubmit ALL recommended selections")
        exact = ready["request"]
        until(
            lambda: (
                emitted("Exact fingerprint: " + exact["assessmentFingerprint"], new)
                and all(
                    emitted(address, new)
                    for address in exact["selections"]["rerunUnitIds"]
                )
            ),
            "NEW exact fingerprint and complete selections displayed",
        )
        armed = mark("arm")
        key(b"a", "arm only, not authorize")
        resize(180, 55)
        until(
            lambda: (
                emitted("CONFIRM source", armed)
                and emitted(exact["assessmentFingerprint"], armed)
            ),
            "fresh confirmation displayed",
        )
        assert not load("selected.json"), "arm never authorizes"
        key(b"\x1b[B", "navigation invalidates armed confirmation")
        invalid = mark("invalidated")
        resize(180, 55)
        until(
            lambda: emitted("Navigation invalidated recovery confirmation", invalid),
            "navigation stale proof rejection",
        )
        key(b"\x1b[H", "Home restore unscrolled full proof")
        key(b"s", "reprepare explicit selections after invalidation")
        rearm = mark("rearm")
        resize(180, 55)
        until(
            lambda: emitted(exact["assessmentFingerprint"], rearm),
            "fresh proof recaptured",
        )
        key(b"a", "arm separately again")
        confirm = mark("confirm-render")
        resize(180, 55)
        until(
            lambda: (
                emitted("CONFIRM source", confirm)
                and emitted(exact["assessmentFingerprint"], confirm)
            ),
            "exact armed evidence fresh display",
        )
        key(b"\r", "HOST Enter separately confirms NEW child")
        until(lambda: bool(load("selected.json")), "trusted UI selected child")
        key(b"\x03", "close selected child UI without cancellation")
        until(lambda: bool(load("implementation.json")), "fresh implementation gate")
        impl = load("implementation.json")
        capture = mark("implementation")
        resize(180, 55)
        until(
            lambda: (
                emitted("NEW implementation approval", capture)
                and emitted(impl["requestHash"], capture)
            ),
            "fresh implementation exact dialog",
        )
        key(b"\r", "HOST separate implementation approval")
        until(
            lambda: bool(load("application.json")),
            "real check and fresh read-only SDK review",
        )
        app = load("application.json")["app"]
        capture = mark("application")
        resize(180, 55)
        until(
            lambda: (
                emitted("SEPARATE NEW application approval", capture)
                and emitted(app["requestHash"], capture)
            ),
            "fresh application exact dialog",
        )
        assert open(root + "/work/src/bug.js").read() == "export const value = 1;\n"
        key(b"\r", "HOST separate application approval only now")
    until(
        lambda: bool(load("result.json")),
        "actual fresh writer/check/review/apply completed",
    )
    until(lambda: proc.poll() is not None, "fresh natural shutdown")
    assert proc.returncode == 0
    if master is not None:
        os.close(master)
        master = None
    drain_compilers()
    report["ok"] = True
except BaseException as error:
    report["error"] = str(error)[-18000:]
finally:
    report["freshExit"] = proc.poll() if proc else None
    report["terminalBytes"] = len(raw)
    with open(root + "/evidence/fresh-terminal.ansi", "wb") as f:
        f.write(raw)
    if master is not None:
        os.close(master)
    end = time.monotonic() + 8
    while time.monotonic() < end:
        members = owned()
        if not members:
            break
        report["forcedCleanup"] = True
        for value in members.values():
            send(
                value, signal.SIGTERM if time.monotonic() < end - 4 else signal.SIGKILL
            )
        if proc:
            proc.poll()
        reap()
        time.sleep(0.03)
    reap()
    report["remaining"] = list(owned().values())
    report["seen"] = list(seen.values())
    report["ok"] = (
        report["ok"]
        and not report["remaining"]
        and not report.get("forcedCleanup")
        and not stop
    )
    put("pty-result.json", report)
sys.exit(0 if report["ok"] else 1)
