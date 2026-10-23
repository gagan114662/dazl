#!/usr/bin/env python3
"""Local-reviewed same-port launch helper. Dry-run by default. Never dumps env.

No shell expansion, command substitution, tracing, credential argv, or inherited
app output. Requires known exact PID/cwd and build markers before execution.
Application stdout/stderr intentionally go to /dev/null to avoid secret logging.
This does not rotate credentials or repair an incompatible env file.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import signal
import shutil
import stat
import socket
import sqlite3
import subprocess
import time
import urllib.request


class LaunchError(Exception):
    pass


def parse_env(text):
    result = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].strip()
        name, sep, raw = line.partition('=')
        if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
            raise LaunchError('env_format_unsupported')
        if name in result:
            raise LaunchError('env_duplicate_name')
        # Reject shell-like interpolation rather than guessing what source meant.
        if any(c in raw for c in ['`', '$', '\\', '\x00']):
            raise LaunchError('env_expansion_unsupported')
        try:
            words = shlex.split(raw, comments=False, posix=True)
        except ValueError:
            raise LaunchError('env_format_unsupported') from None
        if len(words) > 1:
            raise LaunchError('env_format_unsupported')
        result[name] = words[0] if words else ''
    return result


def read_env(path):
    try:
        p = Path(path)
        if any(x.is_symlink() for x in [p, *p.parents]) or p.stat().st_uid != os.getuid() or not stat.S_ISREG(p.stat().st_mode) or (p.stat().st_mode & 0o077):
            raise LaunchError('env_permissions_refused')
        return parse_env(p.read_text())
    except LaunchError:
        raise
    except Exception:
        raise LaunchError('env_read_failed') from None


def stage_path(path, commit):
    p = Path(path).resolve()
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise LaunchError('invalid_commit')
    try:
        if (p / '.build-commit').read_text().strip() != commit:
            raise LaunchError('build_commit_mismatch')
        if not (p / '.next/BUILD_ID').is_file() or not (p / 'package.json').is_file():
            raise LaunchError('build_missing')
    except LaunchError:
        raise
    except Exception:
        raise LaunchError('build_unreadable') from None
    return p


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def health(port):
    try:
        with urllib.request.build_opener(NoRedirect()).open(f'http://127.0.0.1:{port}/api/health', timeout=2) as r:
            data = json.load(r)
        return data.get('commit') if data.get('ok') is True else None
    except Exception:
        return None


def pid_cwd(pid):
    try:
        return Path(f'/proc/{pid}/cwd').resolve(strict=True)
    except Exception:
        raise LaunchError('pid_unavailable') from None


def owns_listener(pid, port):
    try:
        sockets = {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}
        for table in ['/proc/net/tcp', '/proc/net/tcp6']:
            for row in Path(table).read_text().splitlines()[1:]:
                cols = row.split()
                if cols[3] == '0A' and int(cols[1].split(':')[1], 16) == port:
                    if f'socket:[{cols[9]}]' in sockets:
                        return True
        return False
    except Exception:
        raise LaunchError('listener_identity_unverifiable') from None


def port_free(port):
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


def await_state(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(.25)
    return False


def check_process(pid):
    try:
        # Only a direct orphan process tree is supported. Any supervisor or
        # unrecognised npm/sh chain requires separate grounded coordination.
        status = Path(f'/proc/{pid}/status').read_text()
        ppid = int(re.search(r'^PPid:\s+(\d+)', status, re.M)[1])
        cgroup = Path(f'/proc/{pid}/cgroup').read_text()
        if ppid != 1 or any(x in cgroup for x in ['.service', 'supervisor', 'docker', 'container']):
            raise LaunchError('supervised_process_refused')
    except LaunchError:
        raise
    except Exception:
        raise LaunchError('supervisor_unverifiable') from None


def pin_executables():
    # Ignore env-file and inherited PATH. Resolve before stopping anything.
    paths = []
    for name in ['node', 'npm']:
        found = shutil.which(name, path='/usr/local/bin:/usr/bin:/bin')
        if not found:
            raise LaunchError('runtime_missing')
        p = Path(found).resolve()
        mode = p.stat().st_mode
        if p.stat().st_uid != 0 or mode & 0o022:
            raise LaunchError('runtime_untrusted')
        paths.append(str(p))
    return paths


def launch(stage, env, port):
    child_env = dict(env)
    child_env.update({'PORT': str(port), 'NODE_ENV': 'production'})
    # Only operational PATH is inherited; no arbitrary parent credentials copied.
    child_env['PATH'] = '/usr/local/bin:/usr/bin:/bin'
    child_env.setdefault('HOME', str(Path.home()))
    return subprocess.Popen([*RUNTIME, 'start'], cwd=stage, env=child_env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, start_new_session=True)


def check_database_backup(env, args):
    try:
        dbpath = Path(env['DB_PATH'])
        backup = Path(args.backup)
        if not dbpath.is_absolute() or not dbpath.is_file() or dbpath.stat().st_size == 0:
            raise LaunchError('existing_database_required')
        if backup.resolve() == dbpath.resolve() or not backup.is_file() or backup.stat().st_size == 0:
            raise LaunchError('verified_backup_required')
        with sqlite3.connect(f'file:{backup.resolve()}?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise LaunchError('backup_integrity_failed')
        if args.backup_db != str(dbpath.resolve()) or not args.backup_verified:
            raise LaunchError('backup_verification_required')
    except LaunchError:
        raise
    except Exception:
        raise LaunchError('database_or_backup_unverifiable') from None


RUNTIME = []

def run(args):
    global RUNTIME
    if args.pid <= 1 or args.pid == os.getpid() or not 1024 <= args.port <= 65535:
        raise LaunchError('invalid_process_or_port')
    stage = stage_path(args.stage, args.commit)
    rollback = stage_path(args.rollback_stage, args.rollback_commit)
    if stage == rollback:
        raise LaunchError('same_stage_refused')
    env = read_env(args.env_file)
    for name in ['DB_PATH', 'DAZL_MASTER_KEY', 'PUBLIC_BASE_URL']:
        if not env.get(name, '').strip():
            raise LaunchError('required_env_missing_' + name)
    if any(name in env for name in ['PATH','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','npm_config_prefix','npm_config_script_shell']):
        raise LaunchError('runtime_env_override_refused')
    check_database_backup(env, args)
    RUNTIME = pin_executables()
    check_process(args.pid)
    if env.get('PORT', str(args.port)) != str(args.port):
        raise LaunchError('env_port_mismatch')
    if pid_cwd(args.pid) != rollback:
        raise LaunchError('pid_stage_mismatch')
    if not owns_listener(args.pid, args.port):
        raise LaunchError('pid_listener_mismatch')
    if health(args.port) != args.rollback_commit:
        raise LaunchError('live_commit_mismatch')
    if not args.execute:
        return {'status': 'preflight_only', 'service_changed': False}
    # Recheck immediately before the one authorized signal, never kill by name.
    if pid_cwd(args.pid) != rollback or not owns_listener(args.pid, args.port):
        raise LaunchError('pid_changed')
    check_process(args.pid)
    os.kill(args.pid, signal.SIGTERM)
    if not await_state(lambda: port_free(args.port), 15):
        return {'status': 'old_listener_did_not_stop', 'service_changed': True}
    try:
        child = launch(stage, env, args.port)
    except Exception:
        child = None
    if child and await_state(lambda: health(args.port) == args.commit, 30):
        return {'status': 'deployed', 'service_changed': True, 'commit': args.commit,
                'launcher_pid': child.pid}
    if child:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if not await_state(lambda: port_free(args.port), 15):
        return {'status': 'new_listener_stuck_manual_recovery_required', 'service_changed': True}
    try:
        old = launch(rollback, env, args.port)
    except Exception:
        return {'status': 'rollback_launch_failed', 'service_changed': True}
    if await_state(lambda: health(args.port) == args.rollback_commit, 30):
        return {'status': 'rolled_back', 'service_changed': True,
                'commit': args.rollback_commit, 'launcher_pid': old.pid}
    return {'status': 'rollback_unhealthy_manual_recovery_required', 'service_changed': True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for flag in ['stage', 'commit', 'rollback-stage', 'rollback-commit', 'env-file']:
        p.add_argument('--' + flag, required=True)
    p.add_argument('--pid', required=True, type=int)
    p.add_argument('--port', type=int, default=3100)
    p.add_argument('--backup', required=True)
    p.add_argument('--backup-db', required=True)
    p.add_argument('--backup-verified', action='store_true')
    p.add_argument('--execute', action='store_true')
    args = p.parse_args()
    try:
        result = run(args)
    except LaunchError as e:
        result = {'status': str(e), 'service_changed': False}
    except Exception:
        # Never print repr/traceback: parsers and subprocesses can carry secrets.
        result = {'status': 'operation_failed', 'service_changed': 'unknown'}
    print(json.dumps(result))
    return 0 if result['status'] in ['preflight_only', 'deployed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
