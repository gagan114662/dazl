"""NEVER-AGAIN #1 (docs/NEVER-AGAIN.md): the dazl box never builds.

Prod went down twice (2026-11-12 20:25, 2026-11-13 ~09:12) because a deploy ran `npm ci` / `next build` on the 1.8 GB
box and it ran out of memory. Production deploys from a prebuilt build (ops/prod, covered by
ops/prod/test_prod_prebuilt.py). This file covers the rest:

- behaviour: ops/staging/deploy.sh, run the way dazl-staging-deploy.timer or a hand run would (no STAGING_BUILD, so its
  default on-box `npm ci && next build`), refuses before it fetches, builds or changes anything; the throwaway-machine
  override is refused too wherever a dazl box marker exists;
- static: no deploy script in the repo (ops/**/deploy*, ops/**/pull*, scripts/deploy*, systemd units) contains a build
  command outside that one guarded default.
Run in CI by release-preflight.yml ("Ops tests (ops/test_*.py)") and never-again-gates.yml.
"""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

OPS = Path(__file__).resolve().parent
REPO = OPS.parent
DEPLOY = OPS / 'staging' / 'deploy.sh'
BUILD_RE = re.compile(r'next build|npm ci\b|npm install|npm run build|\byarn build|\bpnpm build|\btsc\b')
# the one place a build command may appear: deploy.sh's default BUILD, which the guard refuses on the box
ALLOWED = {('ops/staging/deploy.sh', 'BUILD=${STAGING_BUILD:-')}


class DeployRefusesOnBoxBuild(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp())
        # any build, install or fetch that runs leaves a trace here
        self.bin = self.t / 'bin'; self.bin.mkdir()
        self.trace = self.t / 'trace'
        for tool in ('npm', 'npx', 'node', 'git', 'runuser', 'systemctl'):
            f = self.bin / tool
            f.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{self.trace}"\nexit 0\n'); f.chmod(0o755)
        self.root = self.t / 'root'; self.root.mkdir()

    def run_deploy(self, **extra):
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'HOME': str(self.t),
               'STAGING_ROOT': str(self.root), 'STAGING_RELEASES': str(self.t / 'rels'),
               'STAGING_ENV_FILE': str(self.t / 'env'), 'STAGING_STATE_ROOT': str(self.t / 'state'),
               'STAGING_RECOVERY_ROOT': str(self.t / 'rec'), 'PROD_DB_PATH': str(self.t / 'prod' / 'app.db'),
               'DAZL_BOX_MARKERS': str(self.t / 'no-such-marker')}
        env.update(extra)
        return subprocess.run(['bash', str(DEPLOY)], env=env, capture_output=True, text=True, timeout=60)

    def assert_untouched(self):
        self.assertFalse(self.trace.exists(), self.trace.read_text() if self.trace.exists() else '')
        self.assertEqual(list(self.root.iterdir()), [])
        for d in ('rels', 'state', 'rec'):
            self.assertFalse((self.t / d).exists(), d)

    def test_the_default_on_box_build_is_refused_before_anything_runs(self):
        r = self.run_deploy()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('REFUSED: no on-box build', r.stderr)
        self.assertIn('NEVER-AGAIN.md #1', r.stderr)
        self.assert_untouched()

    def test_a_wrong_override_value_is_still_refused(self):
        for v in ('1', 'yes', 'true', 'throwaway', ''):
            r = self.run_deploy(DAZL_ALLOW_HOST_BUILD=v)
            self.assertNotEqual(r.returncode, 0, v); self.assertIn('REFUSED: no on-box build', r.stderr, v)
        self.assert_untouched()

    def test_the_override_is_refused_on_the_dazl_box(self):
        marker = self.t / 'usr-local-lib-dazl-prod'; marker.mkdir()
        r = self.run_deploy(DAZL_ALLOW_HOST_BUILD='throwaway-machine',
                            DAZL_BOX_MARKERS=f'{self.t}/absent {marker}')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(f'REFUSED: {marker} exists', r.stderr)
        self.assert_untouched()

    def test_an_empty_build_setting_is_refused_like_an_unset_one(self):
        # Hermes review 1: STAGING_BUILD='' used to skip the guard and select the default npm ci + next build
        for extra in ({}, {'DAZL_ALLOW_HOST_BUILD': 'throwaway-machine', 'DAZL_BOX_MARKERS': str(self.marker())}):
            r = self.run_deploy(STAGING_BUILD='', **extra)
            self.assertNotEqual(r.returncode, 0, extra); self.assertIn('REFUSED', r.stderr, extra)
            self.assertIn('NEVER-AGAIN.md #1', r.stderr, extra)
        self.assert_untouched()

    def test_on_the_box_only_the_prebuilt_unpack_step_is_accepted_as_the_build_setting(self):
        # Hermes review 1 + independent review R4: a list of known build commands is never complete, so on the box anything
        # that is not pull-prebuilt.sh's own extract step is refused
        for cmd in ('npm ci && npx next build', 'npx next build', 'npm install', 'cd web && npm run build', 'pnpm build', 'NPM  CI',
                    'yarn', 'npm --loglevel=error install', 'npm --prefix . ci', 'npx --yes next@15 build', 'npm run build-prod',
                    'npm run-script build', 'make build', 'N=npm; $N ci', 'sh -c "npm ci"', 'true', '   ', './build.sh',
                    "bash '/usr/local/lib/dazl-staging/pull-prebuilt.sh' --extract '/x'; npm ci",
                    "bash '/usr/local/lib/dazl-staging/pull-prebuilt.sh' --extract '/x' && npx next build",
                    "bash '/tmp/evil.sh' --extract '/x'", "bash '/x/pull-prebuilt.sh' --extract '$(npm ci)'"):
            r = self.run_deploy(STAGING_BUILD=cmd, DAZL_BOX_MARKERS=str(self.marker()))
            self.assertNotEqual(r.returncode, 0, cmd)
            self.assertIn('REFUSED', r.stderr, cmd)
        self.assert_untouched()
        # the exact command pull-prebuilt.sh passes (ops/staging/pull-prebuilt.sh: build="bash '$self' --extract '$DL'") gets
        # past the guard on the box, and fails later on this sandbox's missing env file
        src = (OPS / 'staging' / 'pull-prebuilt.sh').read_text()
        self.assertIn("""build="bash '$self' --extract '$DL'\"""", src)
        r = self.run_deploy(STAGING_BUILD="bash '/usr/local/lib/dazl-staging/pull-prebuilt.sh' --extract '/var/lib/dazl-staging-prebuilt'",
                            DAZL_BOX_MARKERS=str(self.marker()))
        self.assertNotIn('REFUSED', r.stderr); self.assertNotEqual(r.returncode, 0)
        # off the box (tests, CI, the throwaway machine) any command is allowed past the guard
        r = self.run_deploy(STAGING_BUILD='true')
        self.assertNotIn('REFUSED', r.stderr)

    def marker(self):
        m = self.t / 'usr-local-lib-dazl-prod'; m.mkdir(exist_ok=True); return m

    def test_the_default_markers_name_the_box_paths(self):
        src = DEPLOY.read_text()
        for m in ('/usr/local/lib/dazl-prod', '/etc/dazl-staging', '/var/lib/dazl-staging-deploy'):
            self.assertIn(m, src)

    def test_prebuilt_and_throwaway_runs_get_past_the_guard(self):
        # STAGING_BUILD given (pull-prebuilt.sh, the tests) or the throwaway override with no box marker: the guard
        # lets it through, and deploy.sh fails later on its own checks (no env file here), never with REFUSED.
        for extra in ({'STAGING_BUILD': 'true'}, {'DAZL_ALLOW_HOST_BUILD': 'throwaway-machine'}):
            r = self.run_deploy(**extra)
            self.assertNotIn('REFUSED', r.stderr, extra)
            self.assertNotEqual(r.returncode, 0)  # the env file does not exist

    def test_check_env_is_unaffected(self):
        r = subprocess.run(['bash', str(DEPLOY), '--check-env', str(self.t / 'missing')], capture_output=True, text=True,
                           env={'PATH': '/usr/bin:/bin'})
        self.assertNotIn('REFUSED: no on-box build', r.stderr)

    def test_the_guard_runs_before_the_deploy_path(self):
        src = DEPLOY.read_text()
        self.assertLess(src.index('REFUSED: no on-box build'), src.index('check_env "$ENV_FILE"'))
        self.assertLess(src.index('REFUSED: no on-box build'), src.index('fetch -q origin main'))


def deploy_files():
    pats = ['ops/**/deploy*', 'ops/**/pull*', 'ops/**/*.service', 'scripts/**/deploy*', 'ops/**/*deploy*.sh']
    seen = set()
    for p in pats:
        for f in REPO.glob(p):
            if f.is_file() and not f.name.startswith('test_') and f not in seen:
                seen.add(f); yield f


class NoBuildInAnyDeployScript(unittest.TestCase):
    def test_no_deploy_script_runs_a_build_outside_the_guarded_default(self):
        files = list(deploy_files())
        self.assertIn(DEPLOY, files)
        self.assertIn(OPS / 'prod' / 'deploy-prod.sh', files)
        bad = []
        for f in files:
            rel = f.relative_to(REPO).as_posix()
            for n, line in enumerate(f.read_text(errors='replace').splitlines(), 1):
                code = line.lstrip()
                if code.startswith('#') or not BUILD_RE.search(code):
                    continue
                if any(rel == a and code.startswith(prefix) for a, prefix in ALLOWED):
                    continue
                bad.append(f'{rel}:{n}: {code[:120]}')
        self.assertEqual(bad, [], 'a deploy script runs a build: the box never builds (docs/NEVER-AGAIN.md #1)')

    def test_deploy_scripts_parse(self):
        for f in deploy_files():
            if f.suffix == '.sh':
                r = subprocess.run(['bash', '-n', str(f)], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f'{f}: {r.stderr}')


if __name__ == '__main__':
    unittest.main()
