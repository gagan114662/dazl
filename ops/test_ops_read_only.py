"""NEVER-AGAIN #13 (docs/NEVER-AGAIN.md): lanes only READ through the ops door.

2026-11-13 ~22:40 EST: a verifier lane probing the staging ops door called the endpoint that overwrites an env value
with the request body and wiped the staging trial allowlist (DAZL_TRIAL_*). It was restored from the box's pre-probe
backup, but a read-only-intended check had destroyed live staging configuration.

This file runs `ops/ops_read.sh` for real and requires that it:
- refuses every argument that would change the method or send a body (-X, -d/--data*, -F, -T, -I), and
- refuses every env/setting-write path and every environment-changing path, whatever the method,
in both cases before any request is made, and
- still accepts the read paths lanes actually need.

It also scans every script under ops/** statically: none may POST/PUT/PATCH/DELETE an ops-door env-write endpoint.

Run in CI by never-again-gates.yml (its own step) and release-preflight.yml ("Ops tests", pattern test_*.py).
"""
from pathlib import Path
import re
import subprocess
import unittest

OPS = Path(__file__).resolve().parent
REPO = OPS.parent
CLIENT = OPS / 'ops_read.sh'

# a request that is not a GET, on the same command as an ops-door env-write path
WRITE_METHOD = re.compile(r"""-X\s*['"]?(POST|PUT|PATCH|DELETE)|--request[= ]['"]?(POST|PUT|PATCH|DELETE)"""
                          r"""|--data|--upload-file|-T\b""", re.I)
ENV_WRITE_PATH = re.compile(r"""(__ops|\$OPS|\$\{OPS\}|ops)[^\s'"]*/"""
                            r"""(env/(set|unset|update|write|delete)|config/(set|unset|update)"""
                            r"""|settings?/(set|update)|secrets?/set|mail/(enable|disable))""", re.I)


def run_client(*args, **env_extra):
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(OPS), 'OPS_TOKEN': 'not-a-real-token',
           'OPS_BASE': 'http://127.0.0.1:9/__ops'}
    env.update(env_extra)
    return subprocess.run(['bash', str(CLIENT), *args], env=env, capture_output=True, text=True, timeout=30)


class TheClientIsReadOnly(unittest.TestCase):
    def assert_refused(self, r, because):
        self.assertEqual(r.returncode, 3, f'{because}: expected a refusal, got {r.returncode}\n{r.stdout}\n{r.stderr}')
        self.assertIn('REFUSED', r.stderr, because)
        self.assertIn('NEVER-AGAIN.md #13', r.stderr, because)

    def test_the_client_exists_and_is_executable(self):
        self.assertTrue(CLIENT.exists(), CLIENT)
        self.assertTrue(CLIENT.stat().st_mode & 0o111, 'ops_read.sh must be executable')

    def test_it_never_names_a_method_itself(self):
        # no -X / --request anywhere in the client: it cannot issue a non-GET even by its own code
        body = CLIENT.read_text()
        code = '\n'.join(l for l in body.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotRegex(code, r'(^|\s)(-X|--request)(\s|=)', 'ops_read.sh must not set an HTTP method')
        self.assertIn('-G', code, 'ops_read.sh must force a GET with -G')

    def test_a_method_argument_is_refused(self):
        for arg in ('-X', '-XPOST', '--request', '--request=POST'):
            self.assert_refused(run_client('/env?env=staging', arg, 'POST'), arg)

    def test_a_request_body_is_refused(self):
        for arg in ('-d', '--data', '--data-binary', '--data-raw', '--data-urlencode', '--json', '-F', '--form',
                    '-T', '--upload-file'):
            self.assert_refused(run_client('/env?env=staging', arg, 'x'), arg)

    def test_a_head_request_is_refused(self):
        for arg in ('-I', '--head'):
            self.assert_refused(run_client('/env?env=staging', arg), arg)

    def test_every_env_write_path_is_refused_whatever_the_method(self):
        for p in ('/env/set?env=staging&key=DAZL_TRIAL_EMAIL_DOMAINS',
                  '/env/set?env=prod&key=X',
                  '/ENV/SET?env=staging&key=X',
                  '/env/unset?env=staging&key=X',
                  '/env/update?env=prod',
                  '/env/delete?env=prod&key=X',
                  '/config/set?key=X',
                  '/settings/set?key=X',
                  '/secrets/set?key=X',
                  'https://staging.dazl.ai/__ops/env/set?env=staging&key=X'):
            self.assert_refused(run_client(p), p)

    def test_the_unset_parameter_is_refused(self):
        # the ops door removes a key with &unset=1 and no body
        self.assert_refused(run_client('/env?env=staging&key=DAZL_TRIAL_EMAIL_DOMAINS&unset=1'), 'unset=1')

    def test_environment_changing_paths_are_refused(self):
        for p in ('/deploy/staging', '/deploy/prod?sha=' + 'a' * 40, '/rollback/prod', '/restart/staging',
                  '/mail/enable?env=staging', '/stop-port?port=3105'):
            self.assert_refused(run_client(p), p)

    def test_a_path_that_is_not_a_path_is_refused(self):
        self.assert_refused(run_client('env/set'), 'bare relative path')
        r = run_client()
        self.assert_refused(r, 'no argument')

    def test_the_read_paths_lanes_need_are_not_refused(self):
        # the request itself cannot succeed (OPS_BASE points at a closed port) - what matters is that it was not refused
        for p in ('/env?env=staging', '/db?env=staging&q=SELECT%20count(*)%20FROM%20leads%20OFFSET%200',
                  '/logs?env=staging&n=50', '/outbox?env=staging&n=5', '/job?id=123', '/health'):
            r = run_client(p, '--connect-timeout', '1')
            self.assertNotEqual(r.returncode, 3, f'{p} must not be refused:\n{r.stderr}')
            self.assertNotIn('REFUSED', r.stderr, p)
            self.assertIn('ailed to connect', r.stderr + r.stdout, f'{p}: the request should have been attempted')

    def test_a_missing_token_does_not_look_like_a_refusal(self):
        r = run_client('/env?env=staging', OPS_TOKEN='', OPS_TOKEN_FILE=str(OPS / 'no-such-token-file'))
        self.assertEqual(r.returncode, 4, r.stderr)


class NoScriptUnderOpsWritesEnvThroughTheOpsDoor(unittest.TestCase):
    def test_no_ops_script_posts_an_env_write_endpoint(self):
        offenders = []
        for p in sorted(REPO.joinpath('ops').rglob('*')):
            if not p.is_file() or p.suffix not in ('.sh', '.py', '.mjs', '.js', '.ts') or '__pycache__' in p.parts:
                continue
            if p == Path(__file__).resolve():  # this file holds the negative control below
                continue
            for n, line in enumerate(p.read_text(errors='replace').splitlines(), 1):
                if ENV_WRITE_PATH.search(line) and WRITE_METHOD.search(line):
                    offenders.append(f'{p.relative_to(REPO)}:{n}: {line.strip()[:160]}')
        self.assertEqual(offenders, [], 'ops scripts writing env through the ops door: %s' % offenders)

    def test_the_scanner_catches_a_real_offender(self):
        # negative control: the patterns above must actually fire on the call that caused this entry
        bad = """curl -s -X POST --data-binary 'a,b' "$OPS/env/set?env=staging&key=DAZL_TRIAL_EMAIL_DOMAINS" """
        self.assertTrue(ENV_WRITE_PATH.search(bad) and WRITE_METHOD.search(bad), bad)
        good = 'bash ops/ops_read.sh "/env?env=staging"'
        self.assertFalse(ENV_WRITE_PATH.search(good) and WRITE_METHOD.search(good), good)


if __name__ == '__main__':
    unittest.main()
