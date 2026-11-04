#!/usr/bin/env python3
"""Run every required preflight successfully before the single launch command.

Commands are JSON argv arrays, never shell prose. Do not put secrets in argv.
Output is limited to stage/index/return code; child output is suppressed.

CI evidence is read from the public GitHub API. The repository is public, so
the default path is tokenless and read-only: no credential is requested,
stored, or sent. A token remains supported for private mirrors through
--ci-token-file / --ci-token-stdin, validated with the same ownership rules.

Duplicate check-runs resolve deterministically per (check name,
check_suite.id): push and pull_request tracks are independent suites, and a
rerun replaces its attempt inside one suite. Any run not completed fails
closed, and every suite's newest completed run must be a success: an
independent track's failure refuses the launch no matter how green another
track is, while a rerun success supersedes only the failed attempt inside
its own suite. Runs without an intact check_suite identity are refused
rather than grouped.

Every run appends one sanitized JSON line to a bounded private launch log
(--launch-log, default LAUNCH_LOG): timestamp, commit, each gate and preflight
result, launch_reached, the child's return code and safe_launch's own status
file (fixed status/phase vocabulary only). No env content, no argv values and
no child output are ever logged. An unusable log refuses before any gate.
"""
import argparse
import datetime
import fcntl
import importlib.util
import json
import subprocess
import re
import os
import stat
import sys
import math
import time
import urllib.request
from pathlib import Path


def command(value):
    result = json.loads(value)
    if not isinstance(result, list) or not result or any(not isinstance(x, str) or not x or '\0' in x for x in result):
        raise argparse.ArgumentTypeError('expected a nonempty JSON argv array')
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


REQUIRED_CI = frozenset({'browser', 'migrations', 'test-sqlite', 'test-postgres', 'fail-closed', 'static-quality'})

LAUNCH_LOG = '/home/ubuntu/backups/launch-log.jsonl'
LOG_LINES = 200
STATUS_NAME = 'launch-status.json'
CODE = re.compile(r'[a-z][a-z0-9_]{0,63}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}')


def private_file(path, flags):
    # Owned by the executing uid, mode 0600 or tighter, regular, never a symlink.
    fd = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    meta = os.fstat(fd)
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
        os.close(fd)
        raise ValueError('launch_log_refused')
    return fd


class LaunchLog:
    """Bounded private JSONL log; sanitized fields only."""

    def __init__(self, path):
        self.path = Path(path)
        meta = os.lstat(self.path.parent)
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid not in (0, os.geteuid()) or meta.st_mode & 0o022:
            raise ValueError('launch_log_refused')
        os.close(private_file(self.path, os.O_RDONLY | os.O_CREAT))
        self.status_file = self.path.with_name(STATUS_NAME)

    def append(self, entry):
        fd = private_file(self.path, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            with os.fdopen(os.dup(fd), 'rb') as source:
                lines = [x for x in source.read().decode(errors='replace').splitlines() if x.strip()]
            lines = lines[-(LOG_LINES - 1):] + [json.dumps(entry, sort_keys=True)]
            temp = self.path.with_name(self.path.name + '.tmp')
            try:
                os.unlink(temp)
            except FileNotFoundError:
                pass
            out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
            try:
                os.write(out, ('\n'.join(lines) + '\n').encode())
                os.fsync(out)
            finally:
                os.close(out)
            os.replace(temp, self.path)
        finally:
            os.close(fd)


def error_code(error):
    # Our own gates raise fixed codes; anything else is recorded by class name only.
    text = str(error) if isinstance(error, ValueError) else ''
    return text if CODE.fullmatch(text) else type(error).__name__


def preflight_name(argv):
    # Program identity only: executable basename, plus a script basename when the
    # second token is a script path. Never option values, inline code or arguments.
    parts = [Path(argv[0]).name]
    if len(argv) > 1 and re.search(r'\.(py|mjs|js|sh)$', argv[1]) and not argv[1].startswith('-'):
        parts.append(Path(argv[1]).name)
    return ' '.join(p if NAME.fullmatch(p) else 'unnamed' for p in parts)


def safe_launch_vocabulary():
    # The sibling safe_launch defines the only status/phase words a log may carry.
    spec = importlib.util.spec_from_file_location('safe_launch_vocabulary', Path(__file__).with_name('safe_launch.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return frozenset(module.STATUS_CODES), frozenset(module.PHASES), frozenset(module.CAUSE_STEPS), frozenset(module.EXCEPTION_NAMES)


def read_cause(cause, steps, names):
    # Kept only when every field is from safe_launch's fixed vocabulary.
    if not isinstance(cause, dict) or set(cause) != {'step', 'exception', 'errno'}:
        return None
    step, exception, number = cause['step'], cause['exception'], cause['errno']
    # Type before membership: a list/dict word is unhashable and must not raise.
    if not isinstance(step, str) or not isinstance(exception, str):
        return None
    if step not in steps or exception not in names | {'unrecognised'}:
        return None
    if number is not None and not (type(number) is int and 0 <= number < 4096):
        return None
    return {'step': cause['step'], 'exception': cause['exception'], 'errno': number}


def read_status(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return {'state': 'missing'}
    except OSError:
        return {'state': 'refused'}
    try:
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.geteuid() or meta.st_mode & 0o077:
            return {'state': 'refused'}
        with os.fdopen(os.dup(fd), 'rb') as source:
            raw = source.read(4097)
    finally:
        os.close(fd)
    try:
        data = json.loads(raw.decode()) if len(raw) <= 4096 else None
        codes, phases, steps, names = safe_launch_vocabulary()
    except Exception:
        return {'state': 'invalid'}
    if not isinstance(data, dict):
        return {'state': 'invalid'}
    status, phase = data.get('status'), data.get('phase')
    result = {'state': 'read',
              'status': status if isinstance(status, str) and status in codes else 'unrecognised',
              'phase': phase if isinstance(phase, str) and phase in phases else 'unrecognised'}
    # Identity, not equality: 1, 0 and 1.0 are not the booleans safe_launch writes.
    changed = data.get('service_changed')
    if changed is True or changed is False or changed == 'unknown':
        result['service_changed'] = changed
    if isinstance(data.get('commit'), str) and re.fullmatch(r'[a-f0-9]{40}', data['commit']):
        result['commit'] = data['commit']
    cause = read_cause(data.get('cause'), steps, names)
    if cause is not None:
        result['cause'] = cause
    return result


def read_token(token_file):
    path = Path(token_file)
    # Anonymous descriptors are allowed only for an owned, private regular file.
    # They let an encrypted stdin transport avoid persisting a host credential.
    anonymous = re.fullmatch(r'/proc/self/fd/[0-9]+', str(path))
    if not anonymous and any(x.is_symlink() for x in [path, *path.parents]):
        raise ValueError('ci_credentials')
    with path.open() as source:
        meta = os.fstat(source.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077 or (anonymous and meta.st_nlink != 0):
            raise ValueError('ci_credentials')
        token = source.read(16385).strip()
    if len(token) > 16384 or any(c.isspace() for c in token):
        raise ValueError('ci_credentials')
    if not token:
        raise ValueError('ci_credentials')
    return token


def github_get(repository, path, token=None):
    headers = {'Accept': 'application/vnd.github+json'}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request('https://api.github.com/repos/' + repository + '/' + path, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=20) as response:
        return json.load(response)


def effective_run(matches, commit):
    # Fail-closed resolution of duplicate and rerun check-runs for one name.
    # Every run must belong to this commit, to GitHub Actions, and to an
    # intact check suite: without suite identity, rerun and independent-track
    # semantics cannot be told apart, so the evidence is refused.
    for c in matches:
        if c.get('head_sha') != commit or c.get('app', {}).get('slug') != 'github-actions':
            raise ValueError('ci_not_passed')
        suite = c.get('check_suite')
        if not isinstance(suite, dict) or not isinstance(suite.get('id'), int):
            raise ValueError('ci_suite_identity')
    # A newer in-flight evaluation defeats any older completed evidence.
    if any(c.get('status') != 'completed' for c in matches):
        raise ValueError('ci_pending')
    # Each suite is an independent track of truth: its newest completed run
    # must be a success. A rerun supersedes only the attempt inside its own
    # suite; another suite's newer success never masks this suite's failure.
    def key(c):
        return (str(c.get('completed_at') or ''), int(c.get('id') or 0))
    suites = {}
    for c in matches:
        suites.setdefault(c['check_suite']['id'], []).append(c)
    for suite_runs in suites.values():
        if max(suite_runs, key=key).get('conclusion') != 'success':
            raise ValueError('ci_not_passed')


def require_ci(repository, commit, token_file=None, *, get=None):
    if repository != 'gagan114662/dazl' or not re.fullmatch(r'[a-f0-9]{40}', commit or ''):
        raise ValueError('ci_identity')
    token = read_token(token_file) if token_file else None
    if get is None:
        def get(path):
            return github_get(repository, path, token)
    if get('git/ref/heads/main')['object']['sha'] != commit:
        raise ValueError('ci_main_changed')
    data = get('commits/' + commit + '/check-runs?per_page=100')
    checks = data['check_runs']
    if not isinstance(checks, list) or data['total_count'] != len(checks):
        raise ValueError('ci_incomplete')
    for name in REQUIRED_CI:
        matches = [c for c in checks if c.get('name') == name]
        if not matches:
            raise ValueError('ci_missing')
        effective_run(matches, commit)
    # Recheck moving main after the checks read, before any launch mutation.
    if get('git/ref/heads/main')['object']['sha'] != commit:
        raise ValueError('ci_main_changed')


def bind_launch(launch, commit):
    # The CI proof is for the commit the only supported mutation command will launch.
    if len(launch) < 3 or Path(launch[0]).resolve() != Path(sys.executable).resolve() or Path(launch[1]).resolve() != Path(__file__).with_name('safe_launch.py').resolve():
        raise ValueError('launch_entrypoint')
    values = {'--stage', '--commit', '--rollback-stage', '--rollback-commit', '--env-file', '--pid', '--port', '--backup', '--backup-db'}
    switches = {'--execute', '--backup-verified'}
    parsed = {}
    i = 2
    while i < len(launch):
        flag = launch[i]
        if flag in parsed or flag not in values | switches:
            raise ValueError('launch_options')
        if flag in switches:
            parsed[flag] = True
            i += 1
        else:
            if i + 1 >= len(launch) or launch[i + 1].startswith('--'):
                raise ValueError('launch_options')
            parsed[flag] = launch[i + 1]
            i += 2
    if parsed.get('--commit') != commit or parsed.get('--execute') is not True:
        raise ValueError('launch_commit')


def bind_target(launch, commit):
    # Called only after strict argv validation. Not a boundary against an
    # operator who can run immutable older scripts or edit code with sudo.
    if launch.count('--stage') != 1:
        raise ValueError('target_stage_missing')
    stage_input = Path(launch[launch.index('--stage') + 1]).absolute()
    if any(p.is_symlink() for p in [stage_input, *stage_input.parents]):
        raise ValueError('target_stage_symlink')
    stage = stage_input.resolve(strict=True)
    if stage.name != 'web':
        raise ValueError('target_stage_layout')
    root = stage.parent
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args],
            stderr=subprocess.DEVNULL, timeout=15)
    if git('rev-parse', '--show-toplevel').decode().strip() != str(root):
        raise ValueError('target_git_root')
    if git('rev-parse', 'HEAD').decode().strip() != commit:
        raise ValueError('target_head_mismatch')
    # Untracked bytecode and build artifacts are normal. They are not sources
    # of launcher identity. The explicitly used helper paths are checked below.
    if git('status', '--porcelain', '--untracked-files=no').strip():
        raise ValueError('target_tracked_dirty')
    marker = stage / '.build-commit'
    if marker.is_symlink() or not marker.is_file() or marker.read_text().strip() != commit:
        raise ValueError('target_build_mismatch')
    for name, actual in [('checked_launch.py', Path(__file__)),
                         ('safe_launch.py', Path(launch[1]))]:
        expected_path = root / 'ops' / name
        if actual.absolute() != expected_path or any(p.is_symlink() for p in [actual, *actual.parents]):
            raise ValueError('target_helper_path')
        if not actual.is_file() or not stat.S_ISREG(actual.stat().st_mode) or actual.stat().st_mode & 0o022:
            raise ValueError('target_helper_permissions')
        if actual.read_bytes() != git('show', commit + ':ops/' + name):
            raise ValueError('target_helper_bytes')


def run(preflights, launch, timeout=120, *, repository=None, commit=None, token_file=None, log_path=None):
    started = time.monotonic()
    try:
        log = LaunchLog(log_path or LAUNCH_LOG)
    except Exception:
        # Without a diagnosable record nothing runs: refuse before any gate.
        return {'status': 'launch_log_unavailable', 'launch_reached': False}, 2
    entry = {'ts': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
             'commit': commit if isinstance(commit, str) and re.fullmatch(r'[a-f0-9]{40}', commit) else 'invalid',
             'gates': [], 'preflights': [], 'launch_reached': False}

    def finish(report, code):
        entry.update(status=report['status'], wrapper_returncode=code, wall_s=round(time.monotonic() - started, 3))
        try:
            log.append(entry)
        except Exception:
            report = dict(report, log='append_failed')
        return report, code

    def gates(round_name):
        for name, gate in [('bind_launch', lambda: bind_launch(launch, commit)),
                           ('bind_target', lambda: bind_target(launch, commit)),
                           ('require_ci', lambda: require_ci(repository, commit, token_file))]:
            try:
                gate()
            except Exception as error:
                entry['gates'].append({'round': round_name, 'gate': name, 'result': 'fail', 'code': error_code(error)})
                return False
            entry['gates'].append({'round': round_name, 'gate': name, 'result': 'pass'})
        return True

    if not math.isfinite(timeout) or timeout <= 0:
        return finish({'status': 'timeout_invalid', 'launch_reached': False}, 2)
    if not gates('initial'):
        return finish({'status': 'ci_refused', 'launch_reached': False}, 1)
    if not preflights:
        return finish({'status': 'preflight_missing', 'launch_reached': False}, 2)
    for i, argv in enumerate(preflights):
        record = {'index': i, 'name': preflight_name(argv)}
        entry['preflights'].append(record)
        began = time.monotonic()
        try:
            result = subprocess.run(argv, check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            code = result.returncode
        except subprocess.TimeoutExpired:
            record.update(result='timeout', wall_s=round(time.monotonic() - began, 3))
            return finish({'status': 'preflight_error', 'index': i, 'launch_reached': False}, 1)
        except OSError:
            record.update(result='os_error', wall_s=round(time.monotonic() - began, 3))
            return finish({'status': 'preflight_error', 'index': i, 'launch_reached': False}, 1)
        record.update(result='exit', returncode=code, wall_s=round(time.monotonic() - began, 3))
        if code != 0:
            return finish({'status': 'preflight_failed', 'index': i, 'returncode': code, 'launch_reached': False}, 1)
    if not gates('final'):
        return finish({'status': 'ci_refused', 'launch_reached': False}, 1)
    # safe_launch reports its own fixed-vocabulary status through a fresh private
    # file; application output stays on /dev/null. The operator argv is unchanged
    # and still may not carry --status-file itself (bind_launch refuses it).
    try:
        os.unlink(log.status_file)
    except FileNotFoundError:
        pass
    except OSError:
        return finish({'status': 'launch_log_unavailable', 'launch_reached': False}, 2)
    child = {'status_file': str(log.status_file)}
    entry['launch'] = child
    entry['launch_reached'] = True
    began = time.monotonic()
    try:
        result = subprocess.run([*launch, '--status-file', str(log.status_file)], check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        child.update(result='timeout', wall_s=round(time.monotonic() - began, 3), status=read_status(log.status_file))
        return finish({'status': 'launch_error', 'launch_reached': True}, 1)
    except OSError:
        child.update(result='os_error', wall_s=round(time.monotonic() - began, 3), status=read_status(log.status_file))
        return finish({'status': 'launch_error', 'launch_reached': True}, 1)
    child.update(result='exit', returncode=result.returncode, wall_s=round(time.monotonic() - began, 3), status=read_status(log.status_file))
    return finish({'status': 'launched' if result.returncode == 0 else 'launch_failed', 'returncode': result.returncode, 'launch_reached': True}, 0 if result.returncode == 0 else 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--commit', required=True)
    credentials = parser.add_mutually_exclusive_group(required=False)
    credentials.add_argument('--ci-token-file')
    credentials.add_argument('--ci-token-stdin', action='store_true')
    parser.add_argument('--preflight', type=command, action='append', required=True)
    parser.add_argument('--launch', type=command, required=True)
    parser.add_argument('--timeout', type=float, default=120)
    parser.add_argument('--launch-log', default=LAUNCH_LOG)
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('timeout must be finite and positive')
    credential_fd = None
    try:
        if args.ci_token_stdin:
            token = sys.stdin.buffer.read(16385)
            if not token or len(token) > 16384:
                raise ValueError('ci_credentials')
            credential_fd = os.memfd_create('release-ci', os.MFD_CLOEXEC)
            os.fchmod(credential_fd, 0o600)
            os.write(credential_fd, token)
            del token
            args.ci_token_file = '/proc/self/fd/' + str(credential_fd)
        report, code = run(args.preflight, args.launch, args.timeout, repository=args.repository, commit=args.commit, token_file=args.ci_token_file, log_path=args.launch_log)
    except Exception:
        report, code = {'status': 'ci_refused', 'launch_reached': False}, 1
    finally:
        if credential_fd is not None:
            os.close(credential_fd)
    print(json.dumps(report))
    raise SystemExit(code)
