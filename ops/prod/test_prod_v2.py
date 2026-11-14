"""The production deploy scripts that RUN ON THE BOX (ops/prod/deploy-prod.sh v2, run-release.sh, pull-release.sh), #1140.

These three files are copies of what is installed in /usr/local/lib/dazl-prod/ on the box, taken byte for byte, so that the
installed code is a reviewed file in this repository and a future install is a reviewed diff. This file checks:
- the repo copies are the pinned box copies (change one on purpose: review it, then update the pin here);
- none of them builds or installs anything (NEVER-AGAIN #1);
- ops/prod/check-installed.sh fails when an installed file differs from the repo's, or is missing;
- the refusals v2 makes BEFORE it changes anything, run for real in a sandbox with stand-ins for the host.

WHAT THIS CANNOT RUN, plainly: v2's happy path (blue/green switch). It needs the real host: systemd units, `ss`, /proc
cgroups, Caddy, and its guard that reads the REAL /etc/caddy/Caddyfile (stop_port refuses, by design, when it cannot read it).
An unprivileged sandbox has none of that and the script's bytes must stay as the box has them, so those steps are not
exercised here. The old v1 driver still exercises pull-release.sh end to end (test_prod_prebuilt.py).
"""
import getpass
import hashlib
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_prod_prebuilt import STUBS as V1_STUBS  # noqa: E402  (curl, git and ss stand-ins; imported by name only)

# sha256 of the files installed on the box, copied 2026-11-13 (~/work/verify/guard/box-*.sh)
PINNED = {
    'deploy-prod.sh': 'be319e308ab53797d9e8ebdf3e94ff9e9e129c2a9f34a10a2f404a00b3482713',
    'pull-release.sh': '029301eacd3ab83044e2d6cb58fd8206a8118af6c9cfe236cd0d3ac1e26a88d6',
    'run-release.sh': 'ea5a8de89bfea25de428ab1979b6015f61528894eb90e0f5e90fa6a406e7d14a',
}
A = 'a' * 40
BUILD_RE = re.compile(r'next build|npm ci\b|npm install|npm run build|\byarn\b|\bpnpm\b|\btsc\b')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class RepoCopiesAreTheBoxCopies(unittest.TestCase):
    def test_each_file_is_the_pinned_box_copy(self):
        for name, want in PINNED.items():
            self.assertEqual(sha(HERE / name), want,
                             f'ops/prod/{name} is not the file installed on the box. If this change is on purpose, review it as a '
                             f'diff, install it, copy the installed file back and update PINNED (docs/NEVER-AGAIN.md #2)')

    def test_the_scripts_are_executable_and_parse(self):
        for name in PINNED:
            self.assertTrue(os.access(HERE / name, os.X_OK), name)
            self.assertEqual(subprocess.run(['bash', '-n', str(HERE / name)], capture_output=True, text=True).returncode, 0, name)

    def test_no_script_builds_or_installs_anything(self):
        bad = []
        for name in PINNED:
            for n, line in enumerate((HERE / name).read_text().splitlines(), 1):
                code = line.lstrip()
                if code.startswith('#') or not BUILD_RE.search(code):
                    continue
                bad.append(f'{name}:{n}: {code[:110]}')
        self.assertEqual(bad, [], 'a production deploy script runs a build or install: the box never builds (NEVER-AGAIN #1)')

    def test_the_artifact_comes_from_pull_release_and_the_release_runs_next_directly(self):
        deploy = (HERE / 'deploy-prod.sh').read_text()
        self.assertIn('bash "$PULL" fetch "$SHA"', deploy)
        self.assertIn('bash "$PULL" extract "$SHA"', deploy)
        self.assertIn('no build ran on this box', deploy)
        self.assertIn('Never npm ci / next build', deploy)
        run = (HERE / 'run-release.sh').read_text()
        self.assertIn('exec ./node_modules/.bin/next start', run)
        code = '\n'.join(l for l in run.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotRegex(code, r'\bnpm\b|\bnpx\b')

    def test_the_old_v1_driver_cannot_run_outside_the_tests(self):
        r = subprocess.run(['bash', str(HERE / 'legacy-v1' / 'deploy-prod.sh'), '--status'], capture_output=True, text=True, env={'PATH': os.environ['PATH']})
        self.assertEqual(r.returncode, 64); self.assertIn('test driver', r.stderr)


class CheckInstalled(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = Path(self.tmp.name)
        for name in PINNED:
            (self.d / name).write_bytes((HERE / name).read_bytes())

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, *args):
        return subprocess.run(['bash', str(HERE / 'check-installed.sh'), *args], capture_output=True, text=True, env={'PATH': os.environ['PATH']})

    def test_identical_files_pass(self):
        r = self.check(str(self.d))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for name, want in PINNED.items():
            self.assertIn(f'{name}: installed = repo ({want})', r.stdout)

    def test_a_changed_file_fails_and_names_it(self):
        with open(self.d / 'deploy-prod.sh', 'a') as f:
            f.write('# edited on the box\n')
        r = self.check(str(self.d))
        self.assertEqual(r.returncode, 1)
        self.assertIn('deploy-prod.sh: DIFFERS: installed', r.stdout)
        self.assertIn('pull-release.sh: installed = repo', r.stdout)
        self.assertIn('NOT the reviewed ones', r.stdout)

    def test_a_missing_file_fails(self):
        (self.d / 'run-release.sh').unlink()
        r = self.check(str(self.d))
        self.assertEqual(r.returncode, 1); self.assertIn('run-release.sh: MISSING', r.stdout)

    def test_a_symlink_in_place_of_a_file_fails(self):
        (self.d / 'pull-release.sh').unlink(); (self.d / 'pull-release.sh').symlink_to(HERE / 'pull-release.sh')
        r = self.check(str(self.d))
        self.assertEqual(r.returncode, 1); self.assertIn('pull-release.sh: MISSING', r.stdout)

    def test_a_missing_directory_and_extra_arguments_fail(self):
        self.assertEqual(self.check(str(self.d / 'nope')).returncode, 1)
        self.assertEqual(self.check(str(self.d), 'extra').returncode, 2)

    def test_it_changes_nothing(self):
        before = {n: sha(self.d / n) for n in PINNED}
        self.check(str(self.d))
        self.assertEqual({n: sha(self.d / n) for n in PINNED}, before)
        self.assertEqual(sorted(p.name for p in self.d.iterdir()), sorted(PINNED))


STUBS = {k: V1_STUBS[k] for k in ('curl', 'git')}
STUBS.update({
    # ss -l -t -n -p -H "sport = :PORT" (v2's argument style): one line per fake listener (port file -> pid)
    'ss': '#!/usr/bin/env bash\nwant=; for a in "$@"; do case "$a" in "sport = :"*) want=${a##*:};; esac; done\nfor f in "$FAKE_T"/listen/*; do [ -f "$f" ] || continue; p=${f##*/}; [ -z "$want" ] || [ "$want" = "$p" ] || continue; echo "LISTEN 0 511 *:$p *:* users:((\\"node\\",pid=$(cat "$f"),fd=20))"; done\n',
    # root ownership as the box has it: `stat -c '%u %a'` reports uid FAKE_OWNER (default 0) for any path, every other form is real
    'stat': '#!/usr/bin/env bash\nif [ "${1:-}" = -c ] && [ "${2:-}" = "%u %a" ]; then out=$(/usr/bin/stat "$@") || exit $?; echo "${FAKE_OWNER:-0} ${out#* }"; exit 0; fi\nexec /usr/bin/stat "$@"\n',
    'systemctl': '#!/usr/bin/env bash\necho "$*" >> "$FAKE_T/systemctl.log"\nif [ "$1 $2 $3" = "is-active --quiet dazl-prod@3104.service" ] || [ "$1" = show ]; then exit 0; fi\nexit 0\n',
    'caddy': '#!/usr/bin/env bash\nexit 0\n',
    'sudo': '#!/usr/bin/env bash\necho "$*" >> "$FAKE_T/sudo.log"\nexit 1\n',
})


class V2Refusals(unittest.TestCase):
    """deploy-prod.sh v2 as installed: root-owned scripts in one directory, stand-ins for the host, a live release on :3104."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); T = self.t = Path(self.tmp.name)
        for d in ('bin', 'lib', 'ops', 'portconf', 'rel', 'health', 'listen', 'data'):
            (T / d).mkdir()
        (T / 'lib').chmod(0o755)
        for name in PINNED:
            (T / 'lib' / name).write_bytes((HERE / name).read_bytes()); (T / 'lib' / name).chmod(0o755)
        self.DEPLOY = str(T / 'lib' / 'deploy-prod.sh')
        for name, body in STUBS.items():
            (T / 'bin' / name).write_text(body); (T / 'bin' / name).chmod(0o755)
        (T / 'Caddyfile').write_text('dazl.ai, www.dazl.ai {\n\treverse_proxy localhost:3104\n}\n')
        self.live = T / 'rel' / f'dazl-{A[:8]}-prod' / 'web'; self.live.mkdir(parents=True)
        self.proc = subprocess.Popen(['sleep', '600'], cwd=self.live)   # the live release: a real process running from its web/
        (T / 'listen' / '3104').write_text(str(self.proc.pid)); (T / 'health' / '3104').write_text(A)
        (T / 'run.env').write_text('DAZL_MAIL=on\n')

    def tearDown(self):
        self.proc.kill(); self.proc.wait(); self.tmp.cleanup()

    def env(self, **over):
        T = self.t
        e = {'PATH': f"{T / 'bin'}:{os.environ['PATH']}", 'FAKE_T': str(T), 'HOME': str(T),
             'PROD_CADDYFILE': str(T / 'Caddyfile'), 'PROD_OPS_DIR': str(T / 'ops'), 'PROD_PORTCONF_DIR': str(T / 'portconf'),
             'PROD_DB': str(T / 'data' / 'prod.db'), 'PROD_RELEASE_ROOT': str(T / 'rel'), 'PROD_BACKUP_DIR': str(T / 'backups'),
             'PROD_APP_USER': getpass.getuser(), 'PROD_RUN_ENV': str(T / 'run.env'), 'PROD_PUBLIC_URL': 'https://dazl.test',
             'PROD_STABLE_S': '0', 'PROD_PRUNE': '0', 'PROD_ENABLE_AT_BOOT': '0', 'PROD_MIN_AVAIL_MB': '0',
             'PROD_REPO_URL': 'https://example.test/dazl.git', 'PROD_PREBUILT_BASE_URL': 'https://example.test/rel', 'PROD_PREBUILT_DIR': str(T / 'dl')}
        e.update({k: str(v) for k, v in over.items()})
        return e

    def run_deploy(self, *args, **over):
        return subprocess.run(['bash', self.DEPLOY, *args], env=self.env(**over), capture_output=True, text=True, timeout=120)

    def log(self, name):
        p = self.t / name
        return p.read_text() if p.exists() else ''

    def assert_nothing_changed(self):
        self.assertNotRegex(self.log('systemctl.log'), r'\b(start|stop|enable|disable|reload)\b')
        self.assertFalse((self.t / 'backups').exists(), 'a backup was taken')
        self.assertFalse((self.t / 'dl').exists(), 'something was downloaded')
        self.assertIn('reverse_proxy localhost:3104', (self.t / 'Caddyfile').read_text())
        self.assertEqual(sorted(p.name for p in (self.t / 'rel').iterdir()), [f'dazl-{A[:8]}-prod'])
        self.assertEqual(self.log('sudo.log'), '')

    def test_a_script_not_owned_by_root_is_refused_before_anything(self):
        r = self.run_deploy(A, FAKE_OWNER='1000')
        self.assertEqual(r.returncode, 1); self.assertIn('is not root-owned / root-writable only; nothing done', r.stdout + r.stderr)
        self.assert_nothing_changed()

    def test_a_script_that_others_can_write_is_refused(self):
        (self.t / 'lib' / 'run-release.sh').chmod(0o775)
        r = self.run_deploy(A)
        self.assertEqual(r.returncode, 1); self.assertIn('run-release.sh is not root-owned', r.stdout + r.stderr)
        self.assert_nothing_changed()

    def test_a_missing_run_release_script_is_refused(self):
        (self.t / 'lib' / 'run-release.sh').unlink()
        r = self.run_deploy(A)
        self.assertEqual(r.returncode, 1); self.assertIn('run-release.sh is not root-owned', r.stdout + r.stderr)

    def test_bad_settings_and_arguments_are_refused(self):
        for over, msg in (({'PROD_PORTS': '3104 3104'}, 'PROD_PORTS must be two different 31xx ports'), ({'PROD_PORTS': '8080 8081'}, 'PROD_PORTS must be two different 31xx ports'),
                          ({'PROD_STABLE_S': 'x'}, 'PROD_STABLE_S must be 0-999'), ({'PROD_KEEP_BACKUPS': '0'}, 'PROD_KEEP_BACKUPS must be >= 1'),
                          ({'PROD_HEALTH_MAX_TIME': '0'}, 'PROD_HEALTH_MAX_TIME must be 1-99 seconds')):
            r = self.run_deploy(A, **over)
            self.assertEqual(r.returncode, 1, over); self.assertIn(msg, r.stdout + r.stderr, over)
        for arg in ('abc', 'A' * 40, 'a' * 39, '--bogus'):
            r = self.run_deploy(arg); self.assertEqual(r.returncode, 1, arg); self.assertIn('not a full commit', r.stdout + r.stderr, arg)
        self.assert_nothing_changed()

    def test_a_symlinked_ops_directory_is_refused(self):
        (self.t / 'ops').rmdir(); (self.t / 'ops').symlink_to(self.t / 'data')
        r = self.run_deploy(A)
        self.assertEqual(r.returncode, 1); self.assertIn('is a symlink; nothing done', r.stdout + r.stderr)

    def test_caddy_not_pointing_at_either_port_refuses(self):
        (self.t / 'Caddyfile').write_text('dazl.ai, www.dazl.ai {\n\treverse_proxy localhost:9999\n}\n')
        r = self.run_deploy('b' * 40)
        self.assertEqual(r.returncode, 1); self.assertIn("not 3104/3105; nothing done", r.stdout + r.stderr)

    def test_nothing_listening_on_the_live_port_refuses(self):
        (self.t / 'listen' / '3104').unlink()
        r = self.run_deploy('b' * 40)
        self.assertEqual(r.returncode, 1); self.assertIn('nothing listens on the live port 3104; nothing done', r.stdout + r.stderr)
        self.assert_nothing_changed()

    def test_a_missing_database_refuses_before_any_backup_or_download(self):
        r = self.run_deploy('b' * 40)
        self.assertEqual(r.returncode, 1); self.assertIn('is missing or not a regular file; nothing done', r.stdout + r.stderr)
        self.assert_nothing_changed()

    def test_a_database_with_a_second_hard_link_is_refused(self):
        import sqlite3
        db = self.t / 'data' / 'prod.db'; sqlite3.connect(db).close(); os.link(db, self.t / 'data' / 'other.db')
        r = self.run_deploy('b' * 40)
        self.assertEqual(r.returncode, 1); self.assertIn('has another hard link; nothing done', r.stdout + r.stderr)
        self.assert_nothing_changed()

    def test_stop_port_refuses_the_live_port(self):
        r = self.run_deploy('--stop-port', '3104')
        self.assertEqual(r.returncode, 1)
        self.assertIn('REFUSING to stop :3104: Caddy points dazl.ai at it', r.stdout + r.stderr)
        self.assertNotRegex(self.log('systemctl.log'), r'\bstop\b')

    def test_stop_port_takes_only_the_two_ports(self):
        r = self.run_deploy('--stop-port', '3999')
        self.assertEqual(r.returncode, 1); self.assertIn('--stop-port takes 3104 or 3105', r.stdout + r.stderr)
        r = self.run_deploy('--stop-port')
        self.assertEqual(r.returncode, 1)

    @unittest.skipIf(Path('/etc/caddy/Caddyfile').exists(), 'this machine has a real Caddyfile')
    def test_stop_port_cannot_stop_anything_when_the_real_caddyfile_is_unreadable(self):
        # the absolute guard: even with a Caddyfile override that says :3104 is live, the script also reads the REAL
        # /etc/caddy/Caddyfile and refuses to stop any port when it cannot: a test run or a mis-set override cannot take prod down
        r = self.run_deploy('--stop-port', '3105')
        self.assertEqual(r.returncode, 1)
        self.assertIn('REFUSING to stop :3105: cannot read the real dazl.ai port from /etc/caddy/Caddyfile', r.stdout + r.stderr)
        self.assertIn('did not stop :3105', r.stdout + r.stderr)
        self.assertNotRegex(self.log('systemctl.log'), r'\bstop\b|\breset-failed\b|\bdisable\b')

    def test_rollback_with_no_recorded_deploy_refuses(self):
        r = self.run_deploy('--rollback')
        self.assertEqual(r.returncode, 1); self.assertIn('no previous deploy recorded', r.stdout + r.stderr)

    def test_rollback_refuses_a_previous_port_that_does_not_answer_its_recorded_commit(self):
        (self.t / 'ops' / 'prod-state').write_text(f'PREV_PORT=3105\nPREV_SHA={"c" * 40}\nNEW_SHA={A}\nNEW_PORT=3104\n')
        (self.t / 'health' / '3105').write_text('d' * 40)   # :3105 now serves something else
        r = self.run_deploy('--rollback')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"previous port 3105 answers '{'d' * 40}', not the recorded {'c' * 40}; refusing (nothing changed)", r.stdout + r.stderr)
        self.assertIn('reverse_proxy localhost:3104', (self.t / 'Caddyfile').read_text())
        self.assertNotRegex(self.log('systemctl.log'), r'\breload\b')

    def test_rollback_refuses_when_there_is_no_target_recorded_or_it_is_already_live(self):
        (self.t / 'ops' / 'prod-state').write_text('PREV_PORT=none\nPREV_SHA=\nNEW_SHA=\nNEW_PORT=\n')
        r = self.run_deploy('--rollback'); self.assertIn('no rollback target recorded', r.stdout + r.stderr)
        (self.t / 'ops' / 'prod-state').write_text(f'PREV_PORT=3104\nPREV_SHA={A}\nNEW_SHA={A}\nNEW_PORT=3105\n')
        r = self.run_deploy('--rollback'); self.assertIn('dazl.ai already points at :3104', r.stdout + r.stderr)

    def test_status_is_read_only(self):
        r = self.run_deploy('--status')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('live port (Caddy dazl.ai, www.dazl.ai): 3104', r.stdout)
        self.assertIn(f'health=[{A} -]', r.stdout)
        self.assertNotRegex(self.log('systemctl.log'), r'\b(start|stop|enable|disable|reload)\b')

    def test_a_second_deploy_at_the_same_time_is_refused(self):
        import fcntl
        lock = Path('/run/lock/dazl-prod-deploy.lock')
        try:
            fh = open(lock, 'a')
        except OSError as e:
            self.skipTest(f'cannot open {lock}: {e}')
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            r = self.run_deploy('b' * 40)
            self.assertEqual(r.returncode, 1); self.assertIn('another prod deploy/rollback is running', r.stdout + r.stderr)
            self.assert_nothing_changed()
        finally:
            fh.close()


if __name__ == '__main__':
    unittest.main()
