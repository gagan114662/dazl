"""ops/session-worker (#1037, F-go step 1): the session worker runs on the box as its own unprivileged user, on 127.0.0.1, from a
reviewed copy of session-worker/ at one commit, with a token the app shares.

install.sh runs here against a temporary root. systemd is replaced by a stub that starts the worker the way the unit does (the
installed copy, the instance's env file, the same node flags), so the health check, the token and the loopback binding are
checked against the real worker code at the commit under test. No network beyond 127.0.0.1.
"""
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
INSTALL = HERE / 'install.sh'
UNIT = HERE / 'dazl-session-worker@.service'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def outside_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))  # no packet is sent: this only picks the outgoing interface
        a = s.getsockname()[0]
        s.close()
        return None if a.startswith('127.') else a
    except OSError:
        return None


def unit_exec(unit_text):
    return re.search(r'(?m)^ExecStart=(.+)$', unit_text).group(1).split()


# The systemctl stub: `restart dazl-session-worker@<env>.service` starts the worker as the unit would (WorkingDirectory, the
# EnvironmentFile's lines, ExecStart's command), recording the pid; everything else is logged only.
STUB = r'''#!/usr/bin/env bash
echo "$*" >> "$SW_LOG"
if [ "$1" = restart ]; then
  inst=${2#dazl-session-worker@}; inst=${inst%.service}
  [ -f "$SW_PIDS/$inst" ] && kill "$(cat "$SW_PIDS/$inst")" 2>/dev/null && sleep 0.3
  ( cd "$SW_ROOT/$inst" && set -a && . "$SW_ETC/$inst.env" && set +a && exec $SW_EXEC ) > "$SW_PIDS/$inst.log" 2>&1 &
  echo $! > "$SW_PIDS/$inst"
fi
if [ "$1" = is-active ]; then
  inst=${3#dazl-session-worker@}; inst=${inst%.service}
  [ -f "$SW_PIDS/$inst" ] && kill -0 "$(cat "$SW_PIDS/$inst")" 2>/dev/null
fi
'''


class InstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sha = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.root, self.etc, self.units, self.pids = (self.tmp / d for d in ('opt', 'etc', 'units', 'pids'))
        for d in (self.units, self.pids):
            d.mkdir()
        stub = self.tmp / 'systemctl'
        stub.write_text(STUB)
        stub.chmod(0o755)
        self.port = free_port()
        exec_cmd = unit_exec(UNIT.read_text())
        self.env = {**os.environ, 'SW_ROOT': str(self.root), 'SW_ETC': str(self.etc), 'SW_UNIT_DIR': str(self.units),
                    'SW_SYSTEMCTL': str(stub), 'SW_USER': os.environ.get('USER') or subprocess.check_output(['id', '-un'], text=True).strip(),
                    'SW_USERADD': 'false', 'SW_CHOWN': 'true', 'SW_ALLOW_NONROOT': '1', 'SW_PORT': str(self.port),
                    'SW_LOG': str(self.tmp / 'systemctl.log'), 'SW_PIDS': str(self.pids), 'SW_SETTLE_S': '0.5',
                    'SW_EXEC': ' '.join([shutil.which('node') if exec_cmd[0] == '/usr/bin/node' and not Path('/usr/bin/node').exists() else exec_cmd[0], *exec_cmd[1:]])}

    def tearDown(self):
        for f in self.pids.glob('*'):
            if f.suffix == '':
                try:
                    os.kill(int(f.read_text()), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
        time.sleep(0.2)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def install(self, *args, env=None):
        return subprocess.run(['bash', str(INSTALL), *args], env=env or self.env, capture_output=True, text=True, timeout=60)

    def get(self, path, token=None, host='127.0.0.1', body=None):
        req = urllib.request.Request(f'http://{host}:{self.port}{path}', data=body, method='POST' if body else 'GET',
                                     headers={'authorization': f'Bearer {token}'} if token else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def test_install_runs_the_worker_from_the_reviewed_copy_on_loopback_with_a_shared_token(self):
        r = self.install('staging', str(REPO), self.sha)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn(f'healthy on 127.0.0.1:{self.port}', r.stdout)
        # the code is exactly session-worker/ at that commit, and the instance points at it
        rel = self.root / 'releases' / self.sha / 'session-worker'
        self.assertEqual((self.root / 'staging').resolve(), rel.resolve())
        self.assertEqual((rel / 'src' / 'server.ts').read_bytes(), subprocess.check_output(['git', '-C', str(REPO), 'show', f'{self.sha}:session-worker/src/server.ts']))
        # readable by the worker's own user when root installs it: directories 0755, files 0644 (mktemp makes 0700)
        tree = self.root / 'releases' / self.sha
        for d in [tree, *[x for x in tree.rglob('*') if x.is_dir()]]:
            self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o755, d)
        for f in [x for x in tree.rglob('*') if x.is_file()]:
            self.assertEqual(stat.S_IMODE(f.stat().st_mode) & 0o777, 0o644, f)
        # the env file: loopback, the port, a 64-hex token; never world-readable; the token is never printed
        envf = (self.etc / 'staging.env').read_text()
        tok = re.search(r'(?m)^ADVANCED_WORKER_TOKEN=([0-9a-f]{64})$', envf).group(1)
        self.assertRegex(envf, r'(?m)^WORKER_HOST=127\.0\.0\.1$')
        self.assertEqual(stat.S_IMODE((self.etc / 'staging.env').stat().st_mode), 0o640)
        self.assertNotIn(tok, r.stdout + r.stderr)
        # the app's two lines carry the same token and the loopback URL, root-only
        app = (self.etc / 'staging.app-env').read_text().splitlines()
        self.assertEqual(app, [f'ADVANCED_WORKER_URL=http://127.0.0.1:{self.port}', f'ADVANCED_WORKER_TOKEN={tok}'])
        self.assertEqual(stat.S_IMODE((self.etc / 'staging.app-env').stat().st_mode), 0o600)
        # the running worker: healthy, refuses without the token, answers with it
        self.assertEqual(self.get('/health')[0], 200)
        body = b'{"platform":"facebook","query":"hiring sales","session":"ssssssssssssssssssss"}'
        self.assertEqual(self.get('/fetch', body=body)[0], 401)
        self.assertEqual(self.get('/fetch', token='wrong', body=body)[0], 401)
        st, txt = self.get('/fetch', token=tok, body=body)
        self.assertEqual(st, 200, txt)
        self.assertIn('unsupported', txt)
        # ... and only on loopback
        out = outside_address()
        if out:
            with self.assertRaises(OSError):
                socket.create_connection((out, self.port), timeout=2).close()
        # the unit was installed, enabled and restarted
        self.assertTrue((self.units / 'dazl-session-worker@.service').exists())
        log = (self.tmp / 'systemctl.log').read_text()
        self.assertIn('enable dazl-session-worker@staging.service', log)
        self.assertIn('restart dazl-session-worker@staging.service', log)

    def test_rerun_keeps_the_token_and_switches_the_code(self):
        self.assertEqual(self.install('prod', str(REPO), self.sha).returncode, 0)
        first = (self.etc / 'prod.env').read_text()
        r = self.install('prod', str(REPO), self.sha)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.etc / 'prod.env').read_text(), first, 'a re-run never rotates the token under a running app')
        self.assertEqual(self.get('/health')[0], 200)

    def test_the_apps_existing_token_is_reused(self):
        appenv = self.tmp / 'app.env'
        appenv.write_text("DATABASE=x\nADVANCED_WORKER_TOKEN='Abc123_existing-app-token'\nOTHER=y\n")
        r = self.install('staging', str(REPO), self.sha, '--token-from', str(appenv))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('ADVANCED_WORKER_TOKEN=Abc123_existing-app-token\n', (self.etc / 'staging.env').read_text())
        self.assertEqual(self.get('/fetch', token='Abc123_existing-app-token', body=b'{"platform":"facebook","query":"q","session":"ssssssssssssssssssss"}')[0], 200)
        self.assertNotIn('DATABASE', (self.etc / 'staging.env').read_text(), 'nothing else is copied from the app env')
        # a re-run naming an app env whose token differs is refused (the operator would otherwise trust a mismatch), and prints neither token
        other = self.tmp / 'app2.env'
        other.write_text('export ADVANCED_WORKER_TOKEN="Different_app_token_123"   \n')
        r = self.install('staging', str(REPO), self.sha, '--token-from', str(other))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('differs', r.stderr)
        self.assertNotIn('Different_app_token_123', r.stdout + r.stderr); self.assertNotIn('Abc123_existing', r.stdout + r.stderr)
        # ... and the same token in another spelling (export, double quotes, trailing spaces) is the same token
        other.write_text('export ADVANCED_WORKER_TOKEN="Abc123_existing-app-token"   \n')
        self.assertEqual(self.install('staging', str(REPO), self.sha, '--token-from', str(other)).returncode, 0)
        # a missing file or a symlink is refused with a message
        for src in [self.tmp / 'missing.env', self.tmp / 'link.env']:
            if src.name == 'link.env':
                src.symlink_to(appenv)
            r = self.install('staging', str(REPO), self.sha, '--token-from', str(src))
            self.assertNotEqual(r.returncode, 0, src)
            self.assertIn('not a readable regular file', r.stderr, src)
        # an app env without a usable token is refused before anything is written
        shutil.rmtree(self.etc)
        appenv.write_text('ADVANCED_WORKER_TOKEN=\n')
        r = self.install('staging', str(REPO), self.sha, '--token-from', str(appenv))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('no usable ADVANCED_WORKER_TOKEN', r.stderr)
        self.assertFalse((self.etc / 'staging.env').exists())

    def test_refusals_change_nothing(self):
        for args, why in [(('dev', str(REPO), self.sha), 'usage'), (('staging', str(REPO), self.sha[:12]), '40-character'),
                          (('staging', str(REPO), 'f' * 40), 'has no commit'), (('staging', str(self.tmp), self.sha), 'has no commit')]:
            r = self.install(*args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn(why, r.stderr)
        self.assertFalse(self.root.exists() or self.etc.exists(), 'nothing was created')
        if os.geteuid() != 0:
            env = {k: v for k, v in self.env.items() if k != 'SW_ALLOW_NONROOT'}
            r = self.install('staging', str(REPO), self.sha, env=env)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('run as root', r.stderr)

    def test_an_env_file_that_opens_the_worker_to_the_network_is_refused(self):
        self.etc.mkdir()
        tok = 'a' * 64
        for body in [f'PORT={self.port}\nWORKER_HOST=0.0.0.0\nADVANCED_WORKER_TOKEN={tok}\n',
                     # systemd keeps the LAST assignment: a loopback line followed by another address is the other address
                     f'PORT={self.port}\nWORKER_HOST=127.0.0.1\nADVANCED_WORKER_TOKEN={tok}\nWORKER_HOST=0.0.0.0\n',
                     f'PORT={self.port}\nWORKER_HOST=127.0.0.1\nADVANCED_WORKER_TOKEN={tok}\nexport WORKER_HOST=0.0.0.0\n',
                     f'PORT={self.port}\nWORKER_HOST=127.0.0.1\nHOST=0.0.0.0\nADVANCED_WORKER_TOKEN={tok}\n',
                     f'PORT={self.port}\nADVANCED_WORKER_TOKEN={tok}\n']:
            (self.etc / 'staging.env').write_text(body)
            r = self.install('staging', str(REPO), self.sha)
            self.assertNotEqual(r.returncode, 0, body)
            self.assertIn('WORKER_HOST=127.0.0.1', r.stderr, body)
        self.assertNotIn('restart', (self.tmp / 'systemctl.log').read_text() if (self.tmp / 'systemctl.log').exists() else '')

    def test_an_answer_from_another_process_on_the_port_is_not_this_unit(self):
        # something else (an older worker started by hand) answers /health on the port; the unit itself never comes up
        squatter = subprocess.Popen(['python3', '-c', f"""
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{{"ok":true}}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', {self.port}), H).serve_forever()
"""])
        try:
            time.sleep(0.5)
            r = self.install('staging', str(REPO), self.sha, env={**self.env, 'SW_EXEC': 'false'})
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('another process holds the port', r.stderr)
            self.assertFalse((self.etc / 'staging.app-env').exists())
        finally:
            squatter.kill(); squatter.wait()

    def test_a_worker_that_does_not_come_up_fails_the_install(self):
        env = {**self.env, 'SW_EXEC': 'false', 'SW_HEALTH_TRIES': '2'}
        r = self.install('staging', str(REPO), self.sha, env=env)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('did not answer', r.stderr)
        self.assertFalse((self.etc / 'staging.app-env').exists(), 'no app lines for a worker that is not running')


class UnitTest(unittest.TestCase):
    unit = UNIT.read_text()

    def directive(self, key):
        return re.findall(rf'(?m)^{key}=(.*)$', self.unit)

    def test_unprivileged_confined_and_small(self):
        self.assertEqual(self.directive('User'), ['dazl-session'])
        self.assertEqual(self.directive('Group'), ['dazl-session'])
        for k, v in [('NoNewPrivileges', 'yes'), ('ProtectSystem', 'strict'), ('ProtectHome', 'yes'), ('PrivateTmp', 'yes'), ('CapabilityBoundingSet', '')]:
            self.assertEqual(self.directive(k), [v], k)
        mx = self.directive('MemoryMax')[0]
        self.assertRegex(mx, r'^\d+M$')
        self.assertLessEqual(int(mx[:-1]), 192, 'the box has 1.8 GB for prod, staging and its scan worker')

    def test_reads_only_its_own_env_file_and_runs_the_reviewed_copy(self):
        self.assertEqual(self.directive('EnvironmentFile'), ['/etc/dazl-session-worker/%i.env'], 'never the app env (it holds the app secrets)')
        self.assertEqual(self.directive('WorkingDirectory'), ['/opt/dazl-session-worker/%i'])
        cmd = unit_exec(self.unit)
        self.assertEqual(cmd[0], '/usr/bin/node')
        self.assertEqual(cmd[-1], 'src/server.ts')
        self.assertNotIn('0.0.0.0', self.unit)

    def test_ports_do_not_collide_with_the_apps(self):
        text = INSTALL.read_text()
        ports = {int(p) for p in re.findall(r'(?:staging|prod)\) PORT=(\d+)', text)}
        self.assertEqual(len(ports), 2)
        self.assertFalse(ports & {3200, 3104, 3105}, 'the staging app and both production releases')


if __name__ == '__main__':
    unittest.main()
