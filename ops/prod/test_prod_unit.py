#!/usr/bin/env python3
"""#1083: the production app runs under a supervised, unprivileged systemd unit (ops/prod/dazl-prod@.service).

No systemd here: the unit file is read as text and checked against what deploy-prod.sh and run-release.sh expect of it,
and check-installed.sh is run against copies in a temporary directory.

  python3 -m unittest discover -s ops/prod -p 'test_prod_unit.py'
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
UNIT = HERE / 'dazl-prod@.service'
SCRIPTS = ('deploy-prod.sh', 'pull-release.sh', 'run-release.sh', 'check-pages.py', 'check-hydration.mjs')


def unit_settings():
    """{section: {key: [values]}} of the unit file (comments and blank lines dropped)."""
    out, section = {}, None
    for line in UNIT.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.fullmatch(r'\[(\w+)\]', line)
        if m:
            section = out.setdefault(m.group(1), {})
            continue
        key, _, value = line.partition('=')
        section.setdefault(key.strip(), []).append(value.strip())
    return out


class TheUnitTemplate(unittest.TestCase):
    def setUp(self):
        self.u = unit_settings()
        self.deploy = (HERE / 'deploy-prod.sh').read_text()

    def test_it_runs_as_the_unprivileged_app_user_the_deploy_uses(self):
        user = self.u['Service']['User']
        self.assertEqual(len(user), 1)
        self.assertNotIn(user[0], ('root', '0', ''))
        self.assertIn('APP_USER=${PROD_APP_USER:-%s}' % user[0], self.deploy)
        self.assertEqual(self.u['Service']['NoNewPrivileges'], ['yes'])

    def test_it_restarts_on_failure_and_can_be_enabled_at_boot(self):
        self.assertEqual(self.u['Service']['Restart'], ['on-failure'])
        self.assertTrue(self.u['Service']['RestartSec'][0].isdigit())
        self.assertEqual(self.u['Install']['WantedBy'], ['multi-user.target'])
        # the deploy is what enables the live port's instance at boot and disables the other one
        self.assertIn('systemctl enable --quiet "dazl-prod@$1.service"', self.deploy)

    def test_it_starts_the_reviewed_runner_with_the_port_and_the_release_the_deploy_wrote(self):
        self.assertEqual(self.u['Service']['ExecStart'], ['/usr/local/lib/dazl-prod/run-release.sh %i'])
        self.assertEqual(self.u['Service']['EnvironmentFile'], ['/etc/dazl-prod/ports/%i.conf'])
        self.assertIn('PORTCONF=${PROD_PORTCONF_DIR:-/etc/dazl-prod/ports}', self.deploy)
        self.assertIn('DAZL_RELEASE', (HERE / 'run-release.sh').read_text())
        # the deploy checks that the listener's process is the unit's MainPID: no wrapper may sit in between
        self.assertNotIn('Type', self.u['Service'])
        self.assertTrue(self.u['Service']['MemoryMax'][0].endswith('M'))

    def test_the_readme_gives_the_install_and_the_move_from_a_hand_started_process(self):
        readme = (HERE / 'README.md').read_text()
        section = readme[readme.index('## Supervised process (#1083)'):]
        for needle in ("'ops/prod/dazl-prod@.service' /etc/systemd/system/", 'systemctl daemon-reload', 'deploy-prod.sh --status',
                       '--stop-port', 'check-installed.sh'):
            self.assertIn(needle, section, needle)


@unittest.skipUnless(shutil.which('sha256sum'), 'needs sha256sum')
class CheckInstalledKnowsTheUnit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lib, self.units = Path(self.tmp.name) / 'lib', Path(self.tmp.name) / 'units'
        self.lib.mkdir(); self.units.mkdir()
        for name in SCRIPTS:
            (self.lib / name).write_bytes((HERE / name).read_bytes())
        (self.units / UNIT.name).write_bytes(UNIT.read_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, unit_dir=None):
        env = {'PATH': os.environ['PATH']}
        if unit_dir is not None:
            env['PROD_UNIT_DIR'] = str(unit_dir)
        return subprocess.run(['bash', str(HERE / 'check-installed.sh'), str(self.lib)], capture_output=True, text=True, env=env)

    def test_the_installed_unit_is_the_repo_copy(self):
        r = self.check(self.units)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('dazl-prod@.service: installed = repo', r.stdout)
        self.assertIn('and the unit template', r.stdout)

    def test_an_edited_or_missing_unit_fails_and_is_named(self):
        with open(self.units / UNIT.name, 'a') as f:
            f.write('User=root\n')
        r = self.check(self.units)
        self.assertEqual(r.returncode, 1)
        self.assertIn('dazl-prod@.service: DIFFERS', r.stdout)
        (self.units / UNIT.name).unlink()
        r = self.check(self.units)
        self.assertEqual(r.returncode, 1)
        self.assertIn('dazl-prod@.service: MISSING', r.stdout)

    def test_a_directory_argument_alone_checks_the_scripts_only(self):
        r = self.check()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn('dazl-prod@.service', r.stdout)


if __name__ == '__main__':
    unittest.main()
