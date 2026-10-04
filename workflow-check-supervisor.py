#!/usr/bin/env python3
"""Linux subreaper supervisor for Stage 8B workflow checks.

Trusted host helper, not a sandbox. It runs one approved executable without a
shell, captures bounded stdout/stderr, and reports cleanup certainty as JSON on
fd 3 (or stdout if fd 3 is unavailable for manual debugging).
"""
import ctypes
import errno
import json
import os
import selectors
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
TERM_GRACE = 0.35
KILL_GRACE = 1.0
SETTLE_GRACE = 0.10
HARD_EXTRA = 2.0
MAX_REPORT_BYTES = 1024 * 1024
MAX_ERROR_ITEMS = 128
MAX_ERROR_TEXT = 512
MAX_CLEANUP_ERROR_ITEMS = 64


class BoundedErrors(list):
    def __init__(self, max_items=MAX_ERROR_ITEMS, max_text=MAX_ERROR_TEXT):
        super().__init__()
        self.max_items = max_items
        self.max_text = max_text
        self.dropped = 0
        self._seen = set()

    def append(self, item):
        text = str(item)
        if len(text) > self.max_text:
            text = text[:self.max_text] + f"... [truncated {len(text) - self.max_text} chars]"
        if text in self._seen:
            self.dropped += 1
            return
        if len(self) >= self.max_items:
            self.dropped += 1
            return
        self._seen.add(text)
        super().append(text)

    def extend(self, items):
        for item in items:
            self.append(item)


def now():
    return time.monotonic()


def _plain_errors(errors):
    if isinstance(errors, BoundedErrors):
        return list(errors), errors.dropped
    return list(errors or []), 0


def _finalize_report(report):
    errors, dropped = _plain_errors(report.get("errors", []))
    report["errors"] = errors
    report["errorsDropped"] = int(report.get("errorsDropped", 0) or 0) + dropped
    cleanup_report = report.get("cleanup")
    if isinstance(cleanup_report, dict) and isinstance(cleanup_report.get("errors"), BoundedErrors):
        cleanup_errors, cleanup_dropped = _plain_errors(cleanup_report.get("errors"))
        cleanup_report["errors"] = cleanup_errors
        cleanup_report["errorsDropped"] = int(cleanup_report.get("errorsDropped", 0) or 0) + cleanup_dropped
    return report


def _safe_report(report):
    _finalize_report(report)
    data = (json.dumps(report, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "replace")
    if len(data) <= MAX_REPORT_BYTES:
        return data
    fallback = {
        "supervisorOk": False,
        "exitCode": None,
        "signal": None,
        "timedOut": bool(report.get("timedOut", False)),
        "cancelled": bool(report.get("cancelled", False)),
        "stdout": "",
        "stderr": "",
        "stdoutTruncated": True,
        "stderrTruncated": True,
        "stdoutDroppedBytes": int(report.get("stdoutDroppedBytes", 0) or 0),
        "stderrDroppedBytes": int(report.get("stderrDroppedBytes", 0) or 0),
        "cleanup": {"attempted": True, "outcome": "uncertain", "error": "supervisor report exceeded protocol cap"},
        "errors": ["supervisor report exceeded protocol cap"],
        "errorsDropped": int(report.get("errorsDropped", 0) or 0) + len(report.get("errors", [])),
    }
    data = (json.dumps(fallback, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "replace")
    if len(data) > MAX_REPORT_BYTES:
        minimal = {"supervisorOk": False, "timedOut": False, "cancelled": False, "exitCode": None, "signal": None, "stdout": "", "stderr": "", "stdoutTruncated": True, "stderrTruncated": True, "stdoutDroppedBytes": 0, "stderrDroppedBytes": 0, "cleanup": {"attempted": True, "outcome": "uncertain", "error": "supervisor report serialization failed closed"}, "errors": ["supervisor report serialization failed closed"], "errorsDropped": 1}
        data = (json.dumps(minimal, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "replace")
    return data


def _write_all(fd, data):
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        try:
            written = os.write(fd, view[offset:])
        except InterruptedError:
            continue
        if written <= 0:
            raise OSError("short write to supervisor report fd")
        offset += written


def write_report(report):
    data = _safe_report(report)
    try:
        _write_all(3, data)
    except OSError:
        _write_all(1, data)


def write_ready():
    data = b'{"supervisorReady":true}\n'
    try:
        _write_all(3, data)
    except OSError:
        pass


def read_starttime(pid):
    """Return (starttime, error). ENOENT is a normal exited-process race."""
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="ascii", errors="replace") as handle:
            text = handle.read()
        # comm may contain spaces and is wrapped in the last ')' before fields.
        rest = text.rsplit(")", 1)[1].strip().split()
        return rest[19], None  # proc field 22, after removing pid+comm leaves field 3 at index 0.
    except FileNotFoundError:
        return None, "exited"
    except (IndexError, OSError, ValueError) as exc:
        return None, f"cannot read pid {pid} starttime: {type(exc).__name__}: {exc}"


def live_children():
    """Return (children, errors); /proc ambiguity is an uncertainty, not no children."""
    pids = []
    errors = []
    base = f"/proc/{os.getpid()}/task"
    try:
        tids = os.listdir(base)
    except FileNotFoundError:
        return [], [f"cannot enumerate supervisor tasks: {base} vanished"]
    except PermissionError as exc:
        return [], [f"permission enumerating supervisor tasks: {exc}"]
    except OSError as exc:
        return [], [f"error enumerating supervisor tasks: {exc}"]
    for tid in tids:
        try:
            with open(f"{base}/{tid}/children", "r", encoding="ascii", errors="replace") as handle:
                for item in handle.read().split():
                    try:
                        pids.append(int(item))
                    except ValueError as exc:
                        errors.append(f"invalid child pid {item!r} for tid {tid}: {exc}")
        except FileNotFoundError:
            # Thread exited while enumerating; this supervisor is single-threaded, so keep evidence.
            errors.append(f"children file vanished for supervisor tid {tid}")
        except PermissionError as exc:
            errors.append(f"permission reading children for supervisor tid {tid}: {exc}")
        except OSError as exc:
            errors.append(f"error reading children for supervisor tid {tid}: {exc}")
    return sorted(set(pids)), errors


def reap(statuses, main_pid):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return False
        except OSError:
            return True
        if pid == 0:
            return True
        statuses[pid] = status


def append_limited(state, data, limit):
    remaining = max(0, limit - len(state["data"]))
    if remaining:
        state["data"] += data[:remaining]
    if len(data) > remaining:
        state["dropped"] += len(data) - remaining


def pidfd_supported():
    return hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal")


def open_pidfd(pid):
    try:
        return os.pidfd_open(pid, 0), None
    except ProcessLookupError:
        return None, "exited"
    except PermissionError as exc:
        return None, f"permission opening pidfd for pid {pid}: {exc}"
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            return None, "exited"
        return None, f"error opening pidfd for pid {pid}: {exc}"


def close_identity(identity):
    fd = identity.get("pidfd")
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
        identity["pidfd"] = None


def remember_pid(pid, identities, errors):
    """Record a PID only after both birth time and pidfd identify the same live process."""
    existing = identities.get(pid)
    if existing is not None:
        return existing
    if not pidfd_supported():
        errors.append("pidfd signalling unavailable on this Python/Linux runtime")
        return None
    start, start_error = read_starttime(pid)
    if start is None:
        if start_error != "exited":
            errors.append(start_error)
        return None
    pidfd, pidfd_error = open_pidfd(pid)
    if pidfd is None:
        if pidfd_error != "exited":
            errors.append(pidfd_error)
        return None
    checked, checked_error = read_starttime(pid)
    if checked != start:
        errors.append(f"pid {pid} identity changed while opening pidfd")
        try:
            os.close(pidfd)
        except OSError:
            pass
        return None
    if checked_error and checked_error != "exited":
        errors.append(checked_error)
        try:
            os.close(pidfd)
        except OSError:
            pass
        return None
    identity = {"starttime": start, "pidfd": pidfd}
    identities[pid] = identity
    return identity


def signal_pid(pid, sig, identities, errors):
    identity = identities.get(pid)
    if identity is None or identity.get("pidfd") is None:
        errors.append(f"refusing to signal unverified pid {pid}")
        return False
    actual, actual_error = read_starttime(pid)
    if actual != identity.get("starttime"):
        if actual_error == "exited":
            close_identity(identity)
            return False
        errors.append(actual_error or f"pid {pid} identity changed before signal {sig}")
        return False
    try:
        signal.pidfd_send_signal(identity["pidfd"], sig, None, 0)
        return True
    except ProcessLookupError:
        close_identity(identity)
        return False
    except PermissionError as exc:
        errors.append(f"permission signalling pid {pid}: {exc}")
    except OSError as exc:
        if exc.errno == errno.ESRCH:
            close_identity(identity)
        else:
            errors.append(f"error signalling pid {pid}: {exc}")
    return False


def refresh_children(identities, statuses, errors):
    reap(statuses, None)
    children, child_errors = live_children()
    errors.extend(child_errors)
    verified = []
    for pid in children:
        if pid in statuses:
            continue
        identity = remember_pid(pid, identities, errors)
        if identity is not None:
            verified.append(pid)
    return verified


def signal_verified_tree(sig, identities, statuses, errors):
    """Signal only checked PIDs; repeat discovery to catch subreaper adoptions."""
    children = refresh_children(identities, statuses, errors)
    targets = sorted(set(children + [pid for pid in identities if pid not in statuses]))
    sent = False
    for pid in targets:
        sent = signal_pid(pid, sig, identities, errors) or sent
    return sent


def cleanup(main_pid, identities, statuses, timed_out, cancelled):
    errors = BoundedErrors(MAX_CLEANUP_ERROR_ITEMS)
    attempted = bool(timed_out or cancelled)

    # Give just-exiting checks a short chance to hand orphaned children to us.
    deadline = now() + SETTLE_GRACE
    while now() < deadline:
        children = refresh_children(identities, statuses, errors)
        if not children:
            break
        time.sleep(0.01)

    children = refresh_children(identities, statuses, errors)
    if children:
        attempted = True
        signal_verified_tree(signal.SIGTERM, identities, statuses, errors)
        deadline = now() + TERM_GRACE
        while now() < deadline:
            children = refresh_children(identities, statuses, errors)
            if not children:
                break
            signal_verified_tree(signal.SIGTERM, identities, statuses, errors)
            time.sleep(0.02)

    children = refresh_children(identities, statuses, errors)
    if children:
        attempted = True
        signal_verified_tree(signal.SIGKILL, identities, statuses, errors)
        deadline = now() + KILL_GRACE
        while now() < deadline:
            children = refresh_children(identities, statuses, errors)
            if not children:
                break
            signal_verified_tree(signal.SIGKILL, identities, statuses, errors)
            time.sleep(0.02)

    children = refresh_children(identities, statuses, errors)
    for identity in identities.values():
        close_identity(identity)
    if children:
        errors.append(f"live descendants remain: {children}")
    dropped = errors.dropped
    if children or errors or dropped:
        message = "; ".join(list(errors))
        if dropped:
            message = (message + "; " if message else "") + f"dropped {dropped} cleanup diagnostics"
        result = {"attempted": attempted or bool(children), "outcome": "uncertain", "error": message}
        if dropped:
            result["errorsDropped"] = dropped
        return result
    return {"attempted": attempted, "outcome": "ok"}


CANCEL_REQUESTED = False


def request_cancel(_signum, _frame):
    global CANCEL_REQUESTED
    CANCEL_REQUESTED = True


def main():
    signal.signal(signal.SIGUSR1, request_cancel)
    write_ready()
    report = {
        "supervisorOk": False,
        "exitCode": None,
        "signal": None,
        "timedOut": False,
        "cancelled": False,
        "stdout": "",
        "stderr": "",
        "stdoutTruncated": False,
        "stderrTruncated": False,
        "stdoutDroppedBytes": 0,
        "stderrDroppedBytes": 0,
        "cleanup": {"attempted": False, "outcome": "uncertain", "error": "supervisor did not complete"},
        "errors": BoundedErrors(),
        "errorsDropped": 0,
    }
    identities = {}
    statuses = {}
    proc = None
    try:
        cfg = json.loads(sys.stdin.buffer.read(1024 * 1024).decode("utf-8"))
        executable = cfg["executable"]
        argv = cfg.get("argv", [])
        cwd = cfg["cwd"]
        env = cfg.get("env", {})
        timeout_ms = int(cfg["timeoutMs"])
        output_limit = int(cfg["outputBytes"])
        if not executable.startswith("/") or "\x00" in executable:
            raise ValueError("executable must be absolute without NUL")
        if any((not isinstance(a, str) or "\x00" in a) for a in argv):
            raise ValueError("argv entries must be strings without NUL")
        if not pidfd_supported():
            raise RuntimeError("pidfd signalling unavailable on this Python/Linux runtime")
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err))
        proc = subprocess.Popen([executable] + argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
                                close_fds=True)
        remember_pid(proc.pid, identities, report["errors"])
        if proc.pid not in identities:
            raise RuntimeError(f"cannot verify main check process pid {proc.pid}")
        out = {"data": b"", "dropped": 0}
        err = {"data": b"", "dropped": 0}
        sel = selectors.DefaultSelector()
        if proc.stdout:
            os.set_blocking(proc.stdout.fileno(), False)
            sel.register(proc.stdout, selectors.EVENT_READ, out)
        if proc.stderr:
            os.set_blocking(proc.stderr.fileno(), False)
            sel.register(proc.stderr, selectors.EVENT_READ, err)
        deadline = now() + timeout_ms / 1000.0
        hard_deadline = deadline + HARD_EXTRA + TERM_GRACE + KILL_GRACE
        terminating = False
        term_since = None
        killed = False
        main_status = None
        main_returncode = None
        drain_until = None
        while True:
            reap(statuses, proc.pid)
            refresh_children(identities, statuses, report["errors"])
            if proc.pid in statuses and main_status is None and main_returncode is None:
                main_status = statuses[proc.pid]
                drain_until = now() + 0.05
            if main_status is None and main_returncode is None:
                polled = proc.poll()
                if polled is not None:
                    main_returncode = polled
                    drain_until = now() + 0.05
            t = now()
            main_running = main_status is None and main_returncode is None
            if main_running and CANCEL_REQUESTED and not terminating:
                report["cancelled"] = True
                terminating = True
                term_since = t
                signal_verified_tree(signal.SIGTERM, identities, statuses, report["errors"])
            if main_running and t >= deadline and not terminating:
                report["timedOut"] = True
                terminating = True
                term_since = t
                signal_verified_tree(signal.SIGTERM, identities, statuses, report["errors"])
            if main_running and terminating and not killed and term_since is not None and t >= term_since + TERM_GRACE:
                killed = True
                signal_verified_tree(signal.SIGKILL, identities, statuses, report["errors"])
            if terminating:
                signal_verified_tree(signal.SIGTERM if not killed else signal.SIGKILL, identities, statuses, report["errors"])
            if t >= hard_deadline:
                report["errors"].append("supervisor hard deadline reached")
                break
            if not main_running and (not sel.get_map() or (drain_until is not None and t >= drain_until)):
                break
            timeout = 0.02
            if main_running and not terminating:
                timeout = max(0.0, min(timeout, deadline - t))
            elif drain_until is not None:
                timeout = max(0.0, min(timeout, drain_until - t))
            for key, _ in sel.select(timeout):
                try:
                    data = os.read(key.fileobj.fileno(), 8192)
                except BlockingIOError:
                    continue
                if data:
                    append_limited(key.data, data, output_limit)
                else:
                    try:
                        sel.unregister(key.fileobj)
                    except (KeyError, ValueError):
                        # Selector may already be drained/unregistered on EOF races.
                        pass
        for key in list(sel.get_map().values()):
            try:
                sel.unregister(key.fileobj)
            except (KeyError, ValueError):
                pass
        cleanup_result = cleanup(proc.pid, identities, statuses, report["timedOut"], report["cancelled"])
        if main_status is None:
            main_status = statuses.get(proc.pid)
        if main_status is None and main_returncode is None:
            polled = proc.poll()
            if polled is not None:
                main_returncode = polled
        if main_returncode is not None:
            report["exitCode"] = main_returncode if main_returncode >= 0 else None
            report["signal"] = (-main_returncode) if main_returncode < 0 else None
        elif main_status is not None and os.WIFEXITED(main_status):
            report["exitCode"] = os.WEXITSTATUS(main_status)
        elif main_status is not None and os.WIFSIGNALED(main_status):
            report["signal"] = os.WTERMSIG(main_status)
        report.update({
            "supervisorOk": True,
            "stdout": out["data"].decode("utf-8", "replace"),
            "stderr": err["data"].decode("utf-8", "replace"),
            "stdoutTruncated": out["dropped"] > 0,
            "stderrTruncated": err["dropped"] > 0,
            "stdoutDroppedBytes": out["dropped"],
            "stderrDroppedBytes": err["dropped"],
            "cleanup": cleanup_result,
        })
    except BaseException as exc:
        report["errors"].append(f"{type(exc).__name__}: {exc}")
        if proc is not None:
            try:
                cleanup_result = cleanup(proc.pid, identities, statuses, True, False)
                report["cleanup"] = cleanup_result
            except BaseException as cleanup_exc:
                report["cleanup"] = {"attempted": True, "outcome": "uncertain", "error": f"cleanup failed: {type(cleanup_exc).__name__}: {cleanup_exc}"}
    write_report(report)


if __name__ == "__main__":
    main()
