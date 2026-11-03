#!/usr/bin/env python3
"""Fresh-listener preparation primitives. NOT a production launcher.

No CLI start, Caddy write, arbitrary command execution, DB access, provider call,
or existing-listener stop. Candidate startup authorization and same-DB overlap
are intentionally unresolved. These primitives bind a caller-created process
and may clean ONLY that process group while its leader identity is intact.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import signal
import socket
import time
import urllib.request


class CandidateRefused(Exception):
    pass


@dataclass(frozen=True)
class Identity:
    pid: int
    start_ticks: int
    uid: int
    pgid: int
    session: int
    cwd: str
    cgroup: str


def identity(pid):
    try:
        base = Path('/proc') / str(pid)
        # comm may contain spaces or parentheses; fields after the final ')'
        # begin with state (field3), starttime is field22 / index19 below.
        fields = (base / 'stat').read_text().rsplit(')', 1)[1].split()
        if fields[0] == 'Z':
            raise CandidateRefused('candidate_exited')
        return Identity(pid, int(fields[19]), base.stat().st_uid,
                        os.getpgid(pid), os.getsid(pid),
                        str((base / 'cwd').resolve(strict=True)),
                        (base / 'cgroup').read_text())
    except CandidateRefused:
        raise
    except Exception:
        raise CandidateRefused('candidate_identity_unavailable') from None


def capture_created(pid, cwd):
    row = identity(pid)
    if pid <= 1 or pid == os.getpid() or row.uid != os.getuid():
        raise CandidateRefused('candidate_owner')
    if row.pgid != pid or row.session != pid or row.cwd != str(Path(cwd).resolve()):
        raise CandidateRefused('candidate_not_owned_session')
    return row


def require_same(expected):
    if identity(expected.pid) != expected:
        raise CandidateRefused('candidate_identity_changed')


def require_empty(port):
    if not 1024 <= port <= 65535:
        raise CandidateRefused('candidate_port')
    # Fail on any occupied IPv4 or IPv6 endpoint, even non-loopback bindings.
    for family, address in [(socket.AF_INET, ('0.0.0.0', port)),
                            (socket.AF_INET6, ('::', port))]:
        try:
            with socket.socket(family) as s:
                if family == socket.AF_INET6:
                    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                s.bind(address)
        except OSError:
            raise CandidateRefused('candidate_port_not_empty') from None
    # This is an observation, not a port reservation. Verify socket owner after
    # starting; never signal an occupant which raced this empty-port check.


def listener_owners(port):
    sockets = set()
    for table, loopback in [('tcp', '0100007F'), ('tcp6', '00000000000000000000000001000000')]:
        for row in Path('/proc/net/' + table).read_text().splitlines()[1:]:
            cols = row.split()
            address, number = cols[1].split(':')
            if cols[3] == '0A' and int(number, 16) == port:
                if address != loopback:
                    raise CandidateRefused('candidate_not_loopback')
                sockets.add(cols[9])
    if not sockets:
        raise CandidateRefused('candidate_listener_missing')
    inode_owners = {inode: set() for inode in sockets}
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / 'fd').iterdir():
                target = os.readlink(fd)
                if target.startswith('socket:[') and target.endswith(']'):
                    inode = target[8:-1]
                    if inode in inode_owners:
                        inode_owners[inode].add(int(proc.name))
        except (OSError, PermissionError):
            continue
    if any(not owners for owners in inode_owners.values()):
        raise CandidateRefused('candidate_socket_owner_unknown')
    return set().union(*inode_owners.values())


def require_owned_listener(expected, port):
    require_same(expected)
    owners = listener_owners(port)
    for pid in owners:
        row = identity(pid)
        if row.uid != expected.uid or row.pgid != expected.pgid or row.session != expected.session or row.cwd != expected.cwd or row.cgroup != expected.cgroup:
            raise CandidateRefused('candidate_socket_not_owned')
    require_same(expected)
    return owners


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def readiness(port, commit):
    try:
        with urllib.request.build_opener(NoRedirect()).open(f'http://127.0.0.1:{port}/api/ready', timeout=2) as response:
            body = json.load(response)
        return body.get('ok') is True and body.get('commit') == commit
    except Exception:
        return False


def candidate_ready(expected, port, commit):
    require_owned_listener(expected, port)
    if not readiness(port, commit):
        raise CandidateRefused('candidate_not_ready')
    require_owned_listener(expected, port)
    return {'status': 'candidate_ready_only', 'commit': commit, 'port': port,
            'pid': expected.pid, 'start_ticks': expected.start_ticks,
            'observed_wall_unix_ns': time.time_ns(),
            'observed_monotonic_ns': time.monotonic_ns(),
            'clock_scope': 'monotonic_same_host_boot_only',
            'public_upstream_changed': False}


def cleanup_created(expected, seconds=5):
    # If the session leader exited/reused/changed, do not guess who owns a PGID.
    # Return a manual-recovery blocker rather than signal an unbound group.
    require_same(expected)
    if expected.pgid != expected.pid or expected.session != expected.pid:
        raise CandidateRefused('candidate_not_owned_session')
    os.killpg(expected.pgid, signal.SIGTERM)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            identity(expected.pid)
        except CandidateRefused:
            # Missing /proc or a confirmed zombie means the leader stopped.
            # A permissions/read failure is not evidence of successful cleanup.
            proc = Path('/proc') / str(expected.pid)
            stopped = not proc.exists()
            if not stopped:
                try:
                    stopped = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z'
                except OSError:
                    raise CandidateRefused('candidate_cleanup_unverifiable') from None
            if not stopped:
                time.sleep(.02)
                continue
            return {'status': 'candidate_leader_stopped', 'public_upstream_changed': False,
                    'group_drained_verified': False}
        time.sleep(.02)
    raise CandidateRefused('candidate_cleanup_timeout')


if __name__ == '__main__':
    print(json.dumps({'status': 'preparation_only_no_production_launcher',
                      'same_db_admission': 'unverified', 'caddy_cutover': 'not_implemented'}))
    raise SystemExit(1)
