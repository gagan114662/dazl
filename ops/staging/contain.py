#!/usr/bin/env python3
"""Run the staging build so that NO descendant outlives it (#907).

  contain.py [--grace S] [--kill-wait S] -- COMMAND...

This process becomes a child subreaper (prctl PR_SET_CHILD_SUBREAPER): every descendant of COMMAND that is orphaned,
including one that called setsid()/setpgid() to leave the build's session or process group and whose parent exited,
is re-parented to THIS process instead of init. So the whole build tree stays visible as our descendants in /proc,
whatever its session or group.

When COMMAND exits (success or failure), or this process gets SIGTERM/SIGINT/SIGHUP (operator abort, low-disk watcher,
parent failure), every remaining descendant is sent SIGTERM, given --grace seconds, then SIGKILL, and reaped. Only
descendants are ever signalled (found by walking PPid links down from this pid): never a process by name or port, so the
running staging/production services and unrelated workloads are untouched.

Exit status: COMMAND's own status when the tree is gone (143 when aborted by a signal); 125 if any descendant still
exists after SIGKILL + --kill-wait (blocked cleanup: the caller must NOT delete the release beneath it). Linux only.
"""
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
BLOCKED = 125


def descendants(root):
    kids = {}
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            with open(f'/proc/{d}/stat') as f:
                st = f.read()
            ppid = int(st[st.rindex(')') + 2:].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        kids.setdefault(ppid, []).append(int(d))
    out, todo = [], [root]
    while todo:
        for c in kids.get(todo.pop(), []):
            out.append(c); todo.append(c)
    return out


def alive(pids):
    live = []
    for p in pids:
        try:
            with open(f'/proc/{p}/stat') as f:
                st = f.read()
            if st[st.rindex(')') + 2] != 'Z':
                live.append(p)
        except OSError:
            pass
    return live


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def signal_all(sig):
    for p in descendants(os.getpid()):
        try:
            os.kill(p, sig)
        except ProcessLookupError:
            pass


def contain(grace, kill_wait):
    # TERM, wait, KILL, wait; keep re-walking: a process may fork while we signal.
    signal_all(signal.SIGTERM)
    end = time.monotonic() + grace
    while time.monotonic() < end:
        reap()
        if not alive(descendants(os.getpid())):
            return True
        signal_all(signal.SIGTERM)
        time.sleep(0.05)
    end = time.monotonic() + kill_wait
    while time.monotonic() < end:
        signal_all(signal.SIGKILL)
        reap()
        if not alive(descendants(os.getpid())):
            reap(); return True
        time.sleep(0.05)
    return False


def main(argv):
    grace, kill_wait = 10.0, 10.0
    while argv and argv[0] != '--':
        flag = argv.pop(0)
        if flag == '--grace': grace = float(argv.pop(0))
        elif flag == '--kill-wait': kill_wait = float(argv.pop(0))
        else: print('contain: unknown option', file=sys.stderr); return 2
    if not argv or len(argv) < 2:
        print('usage: contain.py [--grace S] [--kill-wait S] -- COMMAND...', file=sys.stderr); return 2
    cmd = argv[1:]
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        print('contain: cannot become a subreaper; refusing to build uncontained', file=sys.stderr); return BLOCKED
    aborted = []
    class Abort(Exception): pass
    def on_signal(signum, _frame):
        aborted.append(signum)
        raise Abort()   # PEP 475 would otherwise resume waitpid after the handler
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, on_signal)
    try:
        child = subprocess.Popen(cmd)
    except Abort:
        contain(grace, kill_wait); return 128 + aborted[0]
    status = None
    while status is None and not aborted:
        try:
            pid, st = os.waitpid(child.pid, 0)
            status = os.waitstatus_to_exitcode(st)
        except Abort:
            pass
        except ChildProcessError:
            status = 1
    if aborted:
        status = 128 + aborted[0]
    for s_ in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s_, lambda *_: aborted.append(0))   # already cleaning up: a second signal just waits for it
    if not contain(grace, kill_wait):
        print(f'contain: build processes survived SIGKILL: {sorted(alive(descendants(os.getpid())))}; cleanup BLOCKED', file=sys.stderr)
        return BLOCKED
    if status is not None and status < 0:
        status = 128 - status
    return status


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
