#!/usr/bin/env python3
"""Run every required preflight successfully before the single launch command.

Commands are JSON argv arrays, never shell prose. Do not put secrets in argv.
Output is limited to stage/index/return code; child output is suppressed.
"""
import argparse
import json
import subprocess


def command(value):
    result = json.loads(value)
    if not isinstance(result, list) or not result or any(not isinstance(x, str) or not x or '\0' in x for x in result):
        raise argparse.ArgumentTypeError('expected a nonempty JSON argv array')
    return result


def run(preflights, launch, timeout=120):
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
        result = subprocess.run(launch, check=False, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return {'status': 'launch_error', 'launch_reached': True}, 1
    return {'status': 'launched' if result.returncode == 0 else 'launch_failed', 'returncode': result.returncode, 'launch_reached': True}, 0 if result.returncode == 0 else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--preflight', type=command, action='append', required=True)
    parser.add_argument('--launch', type=command, required=True)
    parser.add_argument('--timeout', type=float, default=120)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('timeout must be positive')
    report, code = run(args.preflight, args.launch, args.timeout)
    print(json.dumps(report))
    raise SystemExit(code)
