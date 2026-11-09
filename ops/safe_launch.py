#!/usr/bin/env python3
"""Local-reviewed same-port launch helper. Dry-run by default. Never dumps env.

No shell expansion, command substitution, tracing, credential argv, or inherited
app output. Requires known exact PID/cwd and build markers before execution.
Application stdout/stderr intentionally go to /dev/null to avoid secret logging.
This does not rotate credentials or repair an incompatible env file.

--status-file PATH writes this helper's own result JSON (fixed status code,
service_changed, phase) to a fresh private file. It is created exclusively
(never a symlink, never reused) before any gate runs; it never contains env
values or command output, only the STATUS_CODES/PHASES vocabulary below, plus
for listener_identity_unverifiable a `cause` (CAUSE_STEPS step, built-in
exception class name, errno) so the refused step stays diagnosable.
"""
import argparse
import builtins
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
    # cause: optional failure_cause() record for a refusal whose original
    # exception is otherwise discarded (fixed step word, class name, errno only).
    def __init__(self, code, cause=None):
        super().__init__(code)
        self.cause = cause


# The complete fixed vocabulary this helper may report. Anything else becomes
# operation_failed, so a status file can never carry free text.
STATUS_CODES = frozenset({
    'env_format_unsupported', 'env_duplicate_name', 'env_expansion_unsupported',
    'env_permissions_refused', 'env_read_failed', 'invalid_commit',
    'build_commit_mismatch', 'build_missing', 'build_unreadable', 'pid_unavailable',
    'listener_identity_unverifiable', 'supervisor_unverifiable',
    'unexpected_process_ancestry', 'process_identity_mismatch',
    'supervised_process_refused', 'runtime_missing', 'runtime_untrusted',
    'existing_database_required', 'verified_backup_required', 'backup_integrity_failed',
    'backup_verification_required', 'database_or_backup_unverifiable',
    'backup_policy_required', 'backup_manifest_required', 'backup_manifest_mismatch',
    'backup_stale', 'backup_drill_required', 'backup_drill_mismatch', 'backup_changed',
    'invalid_process_or_port', 'same_stage_refused', 'required_env_missing_DB_PATH',
    'required_env_missing_DAZL_MASTER_KEY', 'required_env_missing_PUBLIC_BASE_URL',
    'runtime_env_override_refused', 'env_port_mismatch', 'pid_stage_mismatch',
    'pid_listener_mismatch', 'live_commit_mismatch', 'pid_changed', 'preflight_only',
    'old_listener_did_not_stop', 'deployed', 'new_listener_stuck_manual_recovery_required',
    'rollback_launch_failed', 'rolled_back', 'rollback_unhealthy_manual_recovery_required',
    'operation_failed', 'status_file_unavailable',
})
# preflight: no signal sent yet. Every later phase means the old listener was signalled.
PHASES = frozenset({'preflight', 'old_signalled', 'new_start', 'rollback_start'})
PHASE = 'preflight'
# Steps a listener_identity_unverifiable `cause` may name (#621).
CAUSE_STEPS = frozenset({'fd_enumeration', 'tcp_table'})
# Built-in exception class names: the only `cause.exception` words, never free text.
EXCEPTION_NAMES = frozenset(n for n, v in vars(builtins).items() if isinstance(v, type) and issubclass(v, BaseException))


def failure_cause(step, error):
    # Class name and errno only: never the message or filename.
    name = type(error).__name__
    number = getattr(error, 'errno', None)
    return {'step': step, 'exception': name if name in EXCEPTION_NAMES else 'unrecognised',
            'errno': number if type(number) is int and 0 <= number < 4096 else None}


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
        # Legacy Python launcher assigned unquoted multiword values literally.
        # No shell expansion is ever applied; quoted values remain strict.
        if '"' not in raw and "'" not in raw:
            result[name] = raw
            continue
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


# Readiness (/api/ready): 200 with ok and the commit the new process serves. /api/health is narrower (database reachability).
def health(port):
    try:
        with urllib.request.build_opener(NoRedirect()).open(f'http://127.0.0.1:{port}/api/ready', timeout=2) as r:
            data = json.load(r)
        return data.get('commit') if data.get('ok') is True else None
    except Exception:
        return None


def pid_cwd(pid):
    try:
        return Path(f'/proc/{pid}/cwd').resolve(strict=True)
    except Exception:
        raise LaunchError('pid_unavailable') from None


def fd_links(pid):
    # An fd closed between the listing and its readlink (normal churn on a
    # serving process) cannot be the persisting listening socket: skip it.
    # A listing failure or any other readlink failure (process gone,
    # permission denied) still raises and refuses.
    fd_dir = f'/proc/{pid}/fd'
    links, vanished = set(), False
    for name in os.listdir(fd_dir):
        try:
            links.add(os.readlink(f'{fd_dir}/{name}'))
        except FileNotFoundError:
            vanished = True
    if vanished:
        # Every fd vanishing is also what an exiting process looks like: the
        # fd directory must still be listable afterwards, or the pid refuses.
        os.listdir(fd_dir)
    return links


def owns_listener(pid, port):
    step = 'fd_enumeration'
    try:
        sockets = fd_links(pid)
        step = 'tcp_table'
        for table in ['/proc/net/tcp', '/proc/net/tcp6']:
            for row in Path(table).read_text().splitlines()[1:]:
                cols = row.split()
                if cols[3] == '0A' and int(cols[1].split(':')[1], 16) == port:
                    if f'socket:[{cols[9]}]' in sockets:
                        return True
        return False
    except Exception as error:
        raise LaunchError('listener_identity_unverifiable', failure_cause(step, error)) from None


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


def process_identity(pid):
    try:
        base = Path('/proc') / str(pid)
        status = (base / 'status').read_text()
        return {'pid': pid, 'ppid': int(re.search(r'^PPid:\s+(\d+)', status, re.M)[1]),
                'uid': base.stat().st_uid, 'comm': (base / 'comm').read_text().strip(),
                'cwd': (base / 'cwd').resolve(strict=True),
                'cgroup': (base / 'cgroup').read_text()}
    except Exception:
        raise LaunchError('supervisor_unverifiable') from None


def check_process(pid):
    listener = process_identity(pid)
    chain = [listener]
    for expected in ['sh', 'npm start']:
        parent = process_identity(chain[-1]['ppid'])
        if parent['comm'] != expected:
            raise LaunchError('unexpected_process_ancestry')
        chain.append(parent)
    if not listener['comm'].startswith('next-server') or chain[-1]['ppid'] != 1:
        raise LaunchError('unexpected_process_ancestry')
    for row in chain:
        if row['uid'] != os.getuid() or row['cwd'] != listener['cwd'] or row['cgroup'] != listener['cgroup']:
            raise LaunchError('process_identity_mismatch')
        if any(x in row['cgroup'] for x in ['.service', 'supervisor', 'docker', 'container', 'kubepods']):
            raise LaunchError('supervised_process_refused')
    # cgroup scope is expected for the observed orphan npm tree, not a service.
    # Never signal sh/npm parents; only exact socket-owning listener is eligible.


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


MAX_BACKUP_AGE_CAP_S = 7 * 24 * 3600
# The recovery window is a stated policy (#911): there is no default; --backup-max-age-s must be passed.
CLOCK_SKEW_S = 120


def _iso_epoch(value):
    from datetime import datetime
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('timestamp')
    return datetime.fromisoformat(value[:-1] + '+00:00').timestamp()


def _read_json(path):
    # Manifest/report are small JSON documents; refuse symlinks and anything oversized.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        if os.fstat(f.fileno()).st_size > 1 << 20:
            raise ValueError('too_large')
        return json.loads(f.read().decode('utf-8'))


def _pin_backup(backup):
    # Hash through ONE open descriptor and record its identity, so the bytes hashed are the bytes later re-checked.
    import hashlib
    fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise LaunchError('verified_backup_required')
        h = hashlib.sha256()
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
        after = os.fstat(f.fileno())
    if (after.st_size, after.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
        raise LaunchError('backup_changed')
    return {'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size, 'mtime_ns': st.st_mtime_ns, 'sha256': h.hexdigest()}


def check_database_backup(env, args, now=None):
    """#911: the backup must be bound to evidence from the supported online-backup + restore-drill path.

    Policy: --backup-max-age-s seconds (1..7 days), required, no default; a missing or bad value are refused. Required evidence:
      * the create-backup sidecar manifest (default <backup>.json, tool dazl-create-backup) naming this
        backup file, the live DB_PATH as its source, and the exact bytes/sha256 of the file now;
      * manifest createdAt no older than the policy window (and not in the future);
      * a restore-drill report (tool dazl-restore-drill, ok true) for this backup name AND sha256,
        started at or after the manifest and within the same window.
    A caller-supplied boolean is not evidence. Returns a pin re-checked right before any signal.
    """
    try:
        now = time.time() if now is None else now
        dbpath = Path(env['DB_PATH'])
        backup = Path(args.backup)
        if not dbpath.is_absolute() or not dbpath.is_file() or dbpath.stat().st_size == 0:
            raise LaunchError('existing_database_required')
        if backup.resolve() == dbpath.resolve() or not backup.is_file() or backup.stat().st_size == 0:
            raise LaunchError('verified_backup_required')
        if args.backup_db != str(dbpath.resolve()):
            raise LaunchError('backup_verification_required')
        max_age = getattr(args, 'backup_max_age_s', None)
        if not isinstance(max_age, int) or isinstance(max_age, bool) or not 0 < max_age <= MAX_BACKUP_AGE_CAP_S:
            raise LaunchError('backup_policy_required')
        with sqlite3.connect(f'file:{backup.resolve()}?mode=ro', uri=True) as connection:
            if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise LaunchError('backup_integrity_failed')
        pin = _pin_backup(backup)

        manifest_path = getattr(args, 'backup_manifest', None) or str(backup) + '.json'
        try:
            manifest = _read_json(manifest_path)
        except Exception:
            raise LaunchError('backup_manifest_required') from None
        if not isinstance(manifest, dict) or manifest.get('tool') != 'dazl-create-backup':
            raise LaunchError('backup_manifest_required')
        try:
            same_source = Path(str(manifest.get('sourcePath'))).resolve() == dbpath.resolve()
            same_file = Path(str(manifest.get('backupPath'))).name == backup.name
            created = _iso_epoch(manifest.get('createdAt'))
        except Exception:
            raise LaunchError('backup_manifest_mismatch') from None
        if not same_source or not same_file or manifest.get('sha256') != pin['sha256'] or manifest.get('bytes') != pin['size']:
            raise LaunchError('backup_manifest_mismatch')
        if created > now + CLOCK_SKEW_S or now - created > max_age:
            raise LaunchError('backup_stale')

        drill_path = getattr(args, 'drill_report', None)
        if not drill_path:
            raise LaunchError('backup_drill_required')
        try:
            drill = _read_json(drill_path)
        except Exception:
            raise LaunchError('backup_drill_required') from None
        if not isinstance(drill, dict) or drill.get('tool') != 'dazl-restore-drill':
            raise LaunchError('backup_drill_required')
        try:
            drilled = _iso_epoch(drill.get('started_at'))
        except Exception:
            raise LaunchError('backup_drill_mismatch') from None
        if drill.get('ok') is not True or drill.get('backup') != backup.name or drill.get('backup_sha256') != pin['sha256']:
            raise LaunchError('backup_drill_mismatch')
        if drilled < created - CLOCK_SKEW_S or drilled > now + CLOCK_SKEW_S or now - drilled > max_age:
            raise LaunchError('backup_stale')
        pin['path'] = str(backup)
        return pin
    except LaunchError:
        raise
    except Exception:
        raise LaunchError('database_or_backup_unverifiable') from None


def recheck_backup(pin):
    # Immediately before the signal: the verified file is still the same inode with the same bytes.
    if not pin:
        raise LaunchError('backup_changed')
    try:
        again = _pin_backup(Path(pin['path']))
    except LaunchError:
        raise LaunchError('backup_changed') from None
    except Exception:
        raise LaunchError('backup_changed') from None
    if any(again[k] != pin[k] for k in ('dev', 'ino', 'size', 'mtime_ns', 'sha256')):
        raise LaunchError('backup_changed')


RUNTIME = []

def run(args):
    global RUNTIME, PHASE
    PHASE = 'preflight'
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
    backup_pin = check_database_backup(env, args)
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
    recheck_backup(backup_pin)
    os.kill(args.pid, signal.SIGTERM)
    PHASE = 'old_signalled'
    if not await_state(lambda: port_free(args.port), 15):
        return {'status': 'old_listener_did_not_stop', 'service_changed': True}
    PHASE = 'new_start'
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
    PHASE = 'rollback_start'
    try:
        old = launch(rollback, env, args.port)
    except Exception:
        return {'status': 'rollback_launch_failed', 'service_changed': True}
    if await_state(lambda: health(args.port) == args.rollback_commit, 30):
        return {'status': 'rolled_back', 'service_changed': True,
                'commit': args.rollback_commit, 'launcher_pid': old.pid}
    return {'status': 'rollback_unhealthy_manual_recovery_required', 'service_changed': True}


def main():
    p = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for flag in ['stage', 'commit', 'rollback-stage', 'rollback-commit', 'env-file']:
        p.add_argument('--' + flag, required=True)
    p.add_argument('--pid', required=True, type=int)
    p.add_argument('--port', type=int, default=3100)
    p.add_argument('--backup', required=True)
    p.add_argument('--backup-db', required=True)
    p.add_argument('--backup-manifest')
    p.add_argument('--drill-report')
    p.add_argument('--backup-max-age-s', type=int, default=None)  # required by check_database_backup: no silent default
    p.add_argument('--execute', action='store_true')
    p.add_argument('--status-file')
    args = p.parse_args()
    global PHASE
    PHASE = 'preflight'
    status_fd = None
    if args.status_file is not None:
        try:
            # Exclusive private create before any gate: no symlink, no reuse.
            status_fd = os.open(args.status_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        except Exception:
            print(json.dumps({'status': 'status_file_unavailable', 'service_changed': False, 'phase': PHASE}))
            return 1
    try:
        result = run(args)
    except LaunchError as e:
        result = {'status': str(e), 'service_changed': False}
        if e.cause is not None:
            result['cause'] = e.cause
    except Exception:
        # Never print repr/traceback: parsers and subprocesses can carry secrets.
        result = {'status': 'operation_failed', 'service_changed': 'unknown'}
    if result['status'] not in STATUS_CODES:
        result['status'] = 'operation_failed'
    result['phase'] = PHASE
    text = json.dumps(result)
    if status_fd is not None:
        try:
            os.write(status_fd, (text + '\n').encode())
            os.fsync(status_fd)
        except OSError:
            pass  # checked_launch then records this status file as invalid.
        finally:
            os.close(status_fd)
    print(text)
    return 0 if result['status'] in ['preflight_only', 'deployed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
