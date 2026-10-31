#!/usr/bin/env python3
"""Run every required preflight successfully before the single launch command.

Commands are JSON argv arrays, never shell prose. Do not put secrets in argv.
Output is limited to stage/index/return code; child output is suppressed.
"""
import argparse
import json
import subprocess
import re
import urllib.request
from pathlib import Path


def command(value):
    result = json.loads(value)
    if not isinstance(result, list) or not result or any(not isinstance(x, str) or not x or '\0' in x for x in result):
        raise argparse.ArgumentTypeError('expected a nonempty JSON argv array')
    return result


REQUIRED_CI = frozenset({'browser', 'migrations', 'test-sqlite', 'test-postgres', 'fail-closed'})

def require_ci(repository, commit, token_file):
    if repository != 'gagan114662/dazl' or not re.fullmatch(r'[a-f0-9]{40}', commit or ''):
        raise ValueError('ci_identity')
    token = Path(token_file).read_text().strip()
    if not token:
        raise ValueError('ci_credentials')
    def get(path):
        req = urllib.request.Request('https://api.github.com/repos/' + repository + '/' + path,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)
    if get('git/ref/heads/main')['object']['sha'] != commit:
        raise ValueError('ci_main_changed')
    data = get('commits/' + commit + '/check-runs?per_page=100')
    checks = data['check_runs']
    if not isinstance(checks, list) or data['total_count'] != len(checks):
        raise ValueError('ci_incomplete')
    for name in REQUIRED_CI:
        matches = [c for c in checks if c.get('name') == name]
        if len(matches) != 1:
            raise ValueError('ci_missing_or_duplicate')
        c = matches[0]
        if c.get('head_sha') != commit or c.get('status') != 'completed' or c.get('conclusion') != 'success' or c.get('app', {}).get('slug') != 'github-actions':
            raise ValueError('ci_not_passed')
    # Recheck moving main after the checks read, before any launch mutation.
    if get('git/ref/heads/main')['object']['sha'] != commit:
        raise ValueError('ci_main_changed')


def bind_launch(launch, commit):
    # The CI proof is for the commit the only supported mutation command will launch.
    if len(launch) < 3 or Path(launch[1]).resolve() != Path(__file__).with_name('safe_launch.py').resolve():
        raise ValueError('launch_entrypoint')
    if launch.count('--commit') != 1 or launch.count('--execute') != 1:
        raise ValueError('launch_identity')
    at = launch.index('--commit')
    if at + 1 >= len(launch) or launch[at + 1] != commit:
        raise ValueError('launch_commit')


def run(preflights, launch, timeout=120, *, repository=None, commit=None, token_file=None):
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--ci-token-file', required=True)
    parser.add_argument('--preflight', type=command, action='append', required=True)
    parser.add_argument('--launch', type=command, required=True)
    parser.add_argument('--timeout', type=float, default=120)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    report, code = run(args.preflight, args.launch, args.timeout, repository=args.repository, commit=args.commit, token_file=args.ci_token_file)
    print(json.dumps(report))
    raise SystemExit(code)
