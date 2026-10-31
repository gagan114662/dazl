#!/usr/bin/env python3
"""Run every required preflight successfully before the single launch command.

Commands are JSON argv arrays, never shell prose. Do not put secrets in argv.
Output is limited to stage/index/return code; child output is suppressed.

CI evidence is read from the public GitHub API. The repository is public, so
the default path is tokenless and read-only: no credential is requested,
stored, or sent. A token remains supported for private mirrors through
--ci-token-file / --ci-token-stdin, validated with the same ownership rules.

Duplicate check-runs (push and pull_request tracks, reruns) resolve
deterministically per check name: any run not completed fails closed
(a newer in-flight evaluation can never be overridden by an older success);
among completed runs the one with the newest (completed_at, id) wins, so a
newer failure defeats an older success and a rerun success supersedes the
failure it replaced.
"""
import argparse
import json
import subprocess
import re
import os
import stat
import sys
import math
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


REQUIRED_CI = frozenset({'browser', 'migrations', 'test-sqlite', 'test-postgres', 'fail-closed'})


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
    # Every run must belong to this commit and to GitHub Actions.
    for c in matches:
        if c.get('head_sha') != commit or c.get('app', {}).get('slug') != 'github-actions':
            raise ValueError('ci_not_passed')
    # A newer in-flight evaluation defeats any older completed evidence.
    if any(c.get('status') != 'completed' for c in matches):
        raise ValueError('ci_pending')
    # Among completed runs the newest (completed_at, id) is authoritative:
    # a newer failure overrides an older success, and a rerun success
    # supersedes the failed attempt it replaced. Ties break on run id.
    def key(c):
        return (str(c.get('completed_at') or ''), int(c.get('id') or 0))
    latest = max(matches, key=key)
    if latest.get('conclusion') != 'success':
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


def run(preflights, launch, timeout=120, *, repository=None, commit=None, token_file=None):
    if not math.isfinite(timeout) or timeout <= 0:
        return {'status': 'timeout_invalid', 'launch_reached': False}, 2
    try:
        bind_launch(launch, commit)
        require_ci(repository, commit, token_file)
    except Exception:
        return {'status': 'ci_refused', 'launch_reached': False}, 1
    if not preflights:
        return {'status': 'preflight_missing', 'launch_reached': False}, 2
    for i, argv in enumerate(preflights):
        try:
            result = subprocess.run(argv, check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            code = result.returncode
        except (OSError, subprocess.TimeoutExpired):
            return {'status': 'preflight_error', 'index': i, 'launch_reached': False}, 1
        if code != 0:
            return {'status': 'preflight_failed', 'index': i, 'returncode': code, 'launch_reached': False}, 1
    try:
        require_ci(repository, commit, token_file)
    except Exception:
        return {'status': 'ci_refused', 'launch_reached': False}, 1
    try:
        result = subprocess.run(launch, check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return {'status': 'launch_error', 'launch_reached': True}, 1
    return {'status': 'launched' if result.returncode == 0 else 'launch_failed', 'returncode': result.returncode, 'launch_reached': True}, 0 if result.returncode == 0 else 1


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
        report, code = run(args.preflight, args.launch, args.timeout, repository=args.repository, commit=args.commit, token_file=args.ci_token_file)
    except Exception:
        report, code = {'status': 'ci_refused', 'launch_reached': False}, 1
    finally:
        if credential_fd is not None:
            os.close(credential_fd)
    print(json.dumps(report))
    raise SystemExit(code)
