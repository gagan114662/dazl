"""#1463: the production scan worker is gated OFF. With PROD_SCAN_WORKER unset, deploy-prod.sh behaves byte for byte as
the installed a562aa3a: every added line sits in a `# >>> scan-worker` ... `# <<< scan-worker` block, and removing the
blocks gives exactly that file. Each block is also run for real in a sandbox (systemctl and the env file stand-ins):
flag off -> no command and no env change; flag on -> the release env gets DAZL_SCAN_SHARED_QUEUE=1 and
SCAN_MAX_CONCURRENT=0, the new port's worker starts and the old one stops, and --rollback swaps them back."""
import hashlib
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSTALLED_SHA = 'a562aa3ad8613a01227c58927a4ab08fd1cafb37415710938ec0e95ca0a6a467'
BLOCK = re.compile(r'[ ]*# >>> scan-worker.*?# <<< scan-worker\n', re.S)
SRC = (HERE / 'deploy-prod.sh').read_text()


def blocks():
    return [m.group(0) for m in BLOCK.finditer(SRC)]


def block(marker):
    (b,) = [x for x in blocks() if marker in x]
    return b


def run(flag, body):
    with tempfile.TemporaryDirectory() as d:
        dp = Path(d)
        (dp / 'bin').mkdir()
        (dp / 'bin' / 'systemctl').write_text('#!/bin/sh\necho "systemctl $*" >> "$CALLS"\n')
        os.chmod(dp / 'bin' / 'systemctl', 0o755)
        (dp / 'prod.env.next').write_text("A='1'\nSCAN_MAX_CONCURRENT=3\n")
        script = 'set -euo pipefail\nlog() { echo "LOG $*" >> "$CALLS"; }\nOPS=%s\nNEW=3105; LIVE=3104; PREV_PORT=3104; cur=3105\n' % d
        script += block('worker_swap() {') + body
        env = {**os.environ, 'PATH': f'{d}/bin:' + os.environ['PATH'], 'CALLS': f'{d}/calls'}
        env.pop('PROD_SCAN_WORKER', None)
        if flag:
            env['PROD_SCAN_WORKER'] = '1'
        subprocess.run(['bash', '-c', script], env=env, check=True)
        calls = (dp / 'calls').read_text() if (dp / 'calls').exists() else ''
        return calls, (dp / 'prod.env.next').read_text()


class ScanWorkerGatedOff(unittest.TestCase):
    def test_without_the_blocks_the_script_is_the_installed_one(self):
        self.assertEqual(hashlib.sha256(BLOCK.sub('', SRC).encode()).hexdigest(), INSTALLED_SHA)
        self.assertEqual(len(blocks()), 4, 'definition, release env, post-stability swap, rollback swap')

    def test_flag_off_every_block_does_nothing(self):
        for b in [x for x in blocks() if 'worker_swap() {' not in x]:
            calls, envf = run(False, b)
            self.assertEqual(calls, '', b)
            self.assertEqual(envf, "A='1'\nSCAN_MAX_CONCURRENT=3\n", b)

    def test_flag_on_env_and_swap(self):
        _, envf = run(True, block('prod.env.next.w'))
        self.assertEqual(envf, "A='1'\nDAZL_SCAN_SHARED_QUEUE=1\nSCAN_MAX_CONCURRENT=0\n")
        calls, _ = run(True, block('worker_swap "$NEW" "$LIVE"'))
        self.assertIn('systemctl start dazl-prod-worker@3105.service', calls)
        self.assertIn('systemctl stop dazl-prod-worker@3104.service', calls)
        self.assertLess(calls.index('start dazl-prod-worker@3105'), calls.index('stop dazl-prod-worker@3104'))
        calls, _ = run(True, block('worker_swap "$PREV_PORT" "$cur"'))
        self.assertIn('systemctl start dazl-prod-worker@3104.service', calls)
        self.assertIn('systemctl stop dazl-prod-worker@3105.service', calls)

    def test_worker_swap_runs_only_after_the_stability_window(self):
        i = SRC.index('worker_swap "$NEW" "$LIVE"')
        self.assertGreater(i, SRC.index('9/10 public smoke'))
        self.assertGreater(i, SRC.index('set_boot "$NEW"'))

    def test_unit_and_runner(self):
        unit = (HERE / 'dazl-prod-worker@.service').read_text()
        self.assertIn('EnvironmentFile=/etc/dazl-prod/ports/%i.conf', unit)
        self.assertIn('PartOf=dazl-prod@%i.service', unit)
        self.assertIn('ExecStart=/usr/local/lib/dazl-prod/run-worker.sh %i', unit)
        self.assertIn('KNOWN BLOCKER', unit)
        subprocess.run(['bash', '-n', str(HERE / 'run-worker.sh')], check=True)
        r = subprocess.run(['bash', str(HERE / 'run-worker.sh'), '3105'], env={**os.environ, 'DAZL_RELEASE': '/nope'}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


if __name__ == '__main__':
    unittest.main()
