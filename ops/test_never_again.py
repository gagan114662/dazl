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
    pats = ['ops/**/deploy*', 'ops/**/pull*', 'ops/**/run-release*', 'ops/**/check-installed*', 'ops/**/*.service', 'scripts/**/deploy*', 'ops/**/*deploy*.sh']
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


# NEVER-AGAIN #12 (docs/NEVER-AGAIN.md): nobody writes to the production database by hand.
# On 2026-11-13 a verifier lane inserted and then deleted a spend row in the prod database with sqlite3 over ssh. That was
# a command typed over ssh: no file in this repo was involved, and NOTHING HERE WOULD HAVE STOPPED IT. What this does is
# narrower: it keeps the repo from growing a script that does the same thing. Every script that uses a SQLite library is
# on one of two lists a person reviewed (read-only, or writable with the reason), so a new one fails here until someone
# classifies it; and no script may run the sqlite3 command line at all. SQLite only: Postgres writes are not scanned.
DB_SCRIPT_DIRS = ('ops', 'web/scripts', '.github/scripts')
DB_SCRIPT_EXT = {'.sh', '.bash', '.py', '.ts', '.mts', '.cts', '.tsx', '.mjs', '.cjs', '.js', ''}
SQLITE_LIB = re.compile(r"""better-sqlite3|node:sqlite|bun:sqlite|^\s*import\s+sqlite3\b|^\s*from\s+sqlite3\b|\bimport\s+sqlite3\b""", re.M)
# The writable list. The kinds are a reviewed allow-list, not a proof; the test checks only the marker named for each:
#   copy:     writes a backup, restore or rehearsal copy; the file also opens a database read-only (mode=ro / readonly: true)
#   new-file: writes a file it creates or a temporary database (it deletes, refuses or makes the path itself)
#   staging:  refuses to run unless DAZL_ENV is staging (the file has the refusal; staging-send-scenarios is also run below)
#   operator: an owner-run tool that changes the named database through the app's code in lib/; running one on prod needs
#             the owner's explicit order (docs/NEVER-AGAIN.md #12)
WRITABLE_DB_OPENS = {
    'ops/prod/deploy-prod.sh': ('copy', 'the pre-deploy backup: source opened mode=ro, the copy is integrity-checked'),
    'ops/prod/legacy-v1/deploy-prod.sh': ('copy', 'the v1 deploy backup, kept as the legacy copy: source opened mode=ro, the copy is integrity-checked'),
    'ops/staging/pull-prebuilt.sh': ('copy', 'the pre-deploy backup of the staging database'),
    'ops/backup_preflight.py': ('copy', 'backup and restore rehearsal copies'),
    'ops/staging/recovery_point.py': ('copy', 'staging recovery point: deploy.sh gives it the staging database; restore replaces that file'),
    'ops/staging/fixture-988/scripts/staging-fixture-988.mts': ('staging', 'staging fixture'),
    'web/scripts/backup/lib.ts': ('copy', 'backup and restore-check copies in a work directory; the source is opened readonly'),
    'web/scripts/backup/recovery-drill.mts': ('copy', 'the restored copy of a backup'),
    'web/scripts/pg-migrate/extract-schema.ts': ('new-file', 'a scratch database it deletes and recreates'),
    'web/scripts/pg-migrate/rehearse-full.ts': ('new-file', 'a synthetic rehearsal database'),
    'web/scripts/pg-migrate/rehearse.ts': ('new-file', 'a synthetic rehearsal database in /tmp'),
    'web/scripts/migration-gate.mts': ('new-file', 'a database in a temporary directory it makes'),
    'web/scripts/offer-rollback-rehearsal.mts': ('new-file', 'a temporary rehearsal database'),
    'web/scripts/pg-cutover.mts': ('new-file', 'a rollback target, which must be a new file'),
    'web/scripts/staging-fixture-988.mts': ('staging', 'staging fixture'),
    'web/scripts/staging-seed.mts': ('staging', 'staging seed'),
    'web/scripts/staging-send-scenarios.mts': ('staging', 'staging send scenarios'),
    'web/scripts/purge-tenant-evidence.mts': ('operator', 'tenant evidence purge through lib/ functions'),
    'web/scripts/rewrap-master-key.mts': ('operator', 'master key rotation'),
    'web/scripts/tenant-lifecycle.mts': ('operator', 'tenant export / delete through lib/ functions'),
}
# Scripts that use a SQLite library and open nothing writable: read-only opens, an in-memory database, or only a mention.
READ_ONLY_DB_SCRIPTS = {
    'ops/safe_launch.py', 'ops/staging/e2e-test.sh', 'ops/staging/fixture-988/fixture-988.sh',
    'ops/staging/fixture-988/scripts/staging-fixture-988-checks.mts', 'web/scripts/backup/send-gate.mts',
    'web/scripts/backup/send-safety.mts', 'web/scripts/scoreboard.mts', 'web/scripts/staging-fixture-988-checks.mts',
}
KIND_MARKER = {
    'copy': r'mode=ro|readonly:\s*true',
    'new-file': r'rmSync|existsSync|mkdtemp|tmpdir\(|/tmp/',
    'staging': r"isStaging\(|DAZL_ENV !== 'staging'",
    'operator': r"from '\.\./lib/|from '\.\./\.\./lib/",
}


def db_script_files():
    for base in DB_SCRIPT_DIRS:
        for f in sorted((REPO / base).rglob('*')):
            if not f.is_file() or 'node_modules' in f.parts or f.name.startswith('test_') or '.test.' in f.name:
                continue
            if f.suffix in DB_SCRIPT_EXT and (f.suffix or f.read_bytes()[:2] == b'#!'):
                yield f


def _code(line):
    """The line without a trailing comment (so a read-only word in a comment does not count)."""
    return re.split(r'\s(?://|#)\s', line, maxsplit=1)[0]


def writable_opens(text):
    """Every place the text opens a SQLite database without saying read-only in the call itself."""
    out = []
    for line in text.splitlines():
        code = _code(line)
        for m in re.finditer(r'(?:sqlite3\.connect|\bconnect)\(([^\n]*)', code) if re.search(r'sqlite3?\b|\bconnect\(', code) else []:
            if 'sqlite' in code and 'mode=ro' not in m.group(1):
                out.append(m.group(0)[:90])
        for m in re.finditer(r'new\s+(?:Database|DatabaseSync)\(([^\n]*)', code):
            arg = m.group(1)
            if re.match(r"""\s*['"]:memory:['"]""", arg) or re.search(r'readonly:\s*true|readOnly:\s*true', arg):
                continue
            out.append(m.group(0)[:90])
    return out


def cli_uses(text):
    """Every use of the sqlite3 COMMAND LINE: in a shell command, a heredoc, a pipe or an ssh string. Python's module
    (import sqlite3, sqlite3.connect, sqlite3.Error) is not the command line."""
    out = []
    for line in text.splitlines():
        code = line.strip()
        if code.startswith(('#', '//', '*')) or re.search(r'\bimport\s+sqlite3\b|\bfrom\s+sqlite3\b', code):
            continue
        # an optional path in front (/usr/bin/sqlite3, ./sqlite3) and an optional .exe: the bare name is not the only way to run it
        if re.search(r"""(?:^|[\s;|&`('"$])(?:[\w.\-/]*/)?sqlite3(?:\.exe)?(?:\s+[-"'$/\w.<]|\s*$)""", code) and not re.search(r'sqlite3\.(?!exe\b)\w', code):
            out.append(code[:120])
    return out


class ScriptsThatOpenADatabaseAreClassified(unittest.TestCase):
    def test_every_script_that_uses_sqlite_is_on_one_of_the_two_lists(self):
        uses, writes = set(), set()
        for f in db_script_files():
            text = f.read_text(errors='replace')
            rel = f.relative_to(REPO).as_posix()
            if writable_opens(text):
                writes.add(rel)
            if SQLITE_LIB.search(text) or writable_opens(text):
                uses.add(rel)
        self.assertEqual(sorted(writes - set(WRITABLE_DB_OPENS)), [],
                         'a script opens a SQLite database for writing and is not classified in WRITABLE_DB_OPENS: '
                         'prod is never written outside the app (docs/NEVER-AGAIN.md #12)')
        self.assertEqual(sorted(set(WRITABLE_DB_OPENS) - writes), [], 'listed as writable, but it no longer opens a database for writing: move or remove it')
        self.assertEqual(sorted(uses - set(WRITABLE_DB_OPENS) - READ_ONLY_DB_SCRIPTS), [],
                         'a script uses a SQLite library and is on neither list: classify it (docs/NEVER-AGAIN.md #12)')
        self.assertEqual(sorted(READ_ONLY_DB_SCRIPTS - uses), [], 'listed as read-only, but it no longer uses SQLite: remove it')
        self.assertEqual(sorted(READ_ONLY_DB_SCRIPTS & writes), [], 'listed as read-only, but it opens a database for writing')

    def test_each_writable_script_still_has_the_marker_of_its_kind(self):
        for rel, (kind, _) in WRITABLE_DB_OPENS.items():
            self.assertRegex((REPO / rel).read_text(errors='replace'), KIND_MARKER[kind], f'{rel}: listed as {kind}')
        self.assertEqual(sorted(r for r, (k, _) in WRITABLE_DB_OPENS.items() if k == 'operator'),
                         ['web/scripts/purge-tenant-evidence.mts', 'web/scripts/rewrap-master-key.mts', 'web/scripts/tenant-lifecycle.mts'],
                         'a new operator tool that writes a live database needs the owner: say so in docs/NEVER-AGAIN.md #12 first')

    def test_the_staging_send_scenarios_refuse_outside_staging_in_every_mode(self):
        # its --child mode opens the database it is given and sends from it: the staging refusal must come first
        src = (REPO / 'web/scripts/staging-send-scenarios.mts').read_text()
        main = src[src.index('if (import.meta.url === `file://${process.argv[1]}`)'):]
        self.assertLess(main.index("process.env.DAZL_ENV !== 'staging'"), main.index("args[0] === '--child'"))

    def test_no_script_runs_the_sqlite3_command_line(self):
        bad = []
        for f in db_script_files():
            for hit in cli_uses(f.read_text(errors='replace')):
                bad.append(f'{f.relative_to(REPO).as_posix()}: {hit}')
        self.assertEqual(bad, [], 'no sqlite3 command line in a script: open the database read-only through a library, '
                                  'and never write by hand (docs/NEVER-AGAIN.md #12)')

    def test_the_scanner_itself(self):
        ro = "db = sqlite3.connect('file:x?mode=ro', uri=True)\nd = new Database(p, { readonly: true })\nm = new Database(':memory:')"
        self.assertEqual(writable_opens(ro), [])
        for w in ("c = sqlite3.connect(path)", "const d = new Database(file)", "const e = new Database(p, { readonly: ro })",
                  "const f = new DatabaseSync(p)", "const g = new Database(p) // readonly: true", "c = sqlite3.connect(p) # mode=ro"):
            self.assertEqual(len(writable_opens(w)), 1, w)
        for c in ('sqlite3 /var/lib/dazl/app.db "INSERT INTO spend VALUES (1)"', 'ssh box sqlite3 app.db "delete from spend_ledger where id=1"',
                  'sqlite3 "$db" <<EOF', 'echo "DELETE FROM a" | sqlite3 db', 'sqlite3 db < fix.sql', 'sqlite3 db ".import x y"',
                  'sqlite3 "$db" "select count(*) from users"', 'x=$(sqlite3 $DB .tables)',
                  # a path in front of the name (Hermes review at d87d03a7): the incident's own shape with an absolute path
                  '/usr/bin/sqlite3 /var/lib/dazl/app.db "INSERT INTO spend VALUES (1)"', 'ssh box /usr/bin/sqlite3 app.db "UPDATE a SET b=1 WHERE id=2"',
                  './sqlite3 app.db "INSERT INTO a VALUES (1)"', 'sqlite3.exe db "INSERT INTO a VALUES (1)"', 'ssh dazl-box "/usr/local/bin/sqlite3 app.db .tables"'):
            self.assertEqual(len(cli_uses(c)), 1, c)
        for c in ('import sqlite3', 'import os, sqlite3, sys', 'from sqlite3 import connect', 'except sqlite3.Error:', "src = sqlite3.connect('file:%s?mode=ro' % p, uri=True)",
                  '# sqlite3 x "DELETE FROM y"', "[ -d \"$REL/web/node_modules/better-sqlite3\" ] || fail",
                  "src = sqlite3.connect('file:%s?mode=ro' % x, uri=True)", 'import sqlite3 as s', 'x = sqlite3.Row'):
            self.assertEqual(cli_uses(c), [], c)


if __name__ == '__main__':
    unittest.main()
