"""Production deploys from a prebuilt build (ops/prod/pull-release.sh, ops/prod/deploy-prod.sh), #907.

The production box must never run `npm ci`, tsc or `next build` (2026-11-12: a deploy that built on the 1.8 GB box was
OOM-killed and dazl.ai answered 502). These tests run the REAL scripts end to end against stand-ins: curl (the release
assets and every /api/health), git (clone/checkout of a fixture source tree), ss (listeners), caddy and systemctl, npm and
npx (which record every call: `next start` serves the commit in .build-commit). The live release is a real `sleep` process
whose cwd is the live release's web/ and whose environment the deploy copies. sqlite3 is the real one. Nothing touches the
network or the machine outside a temporary directory (and /var/tmp/dazl-prod-<sha8>.log, as on the box).
"""
import getpass
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
A, B = 'a' * 40, 'b' * 40
LOCK1, LOCK2 = b'{"lockfileVersion":3,"v":1}\n', b'{"lockfileVersion":3,"v":2}\n'

STUBS = {
    'curl': r'''#!/usr/bin/env bash
out=; url=; has_w=0; has_f=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2;;
    -w) has_w=1; shift 2;;
    --max-time|--max-filesize|--proto|--retry) shift 2;;
    -*) [[ "$1" == *f* ]] && has_f=1; shift;;
    *) url=$1; shift;;
  esac
done
echo "$url" >> "$FAKE_T/curl.log"
emit() { if [ -n "$out" ]; then printf '%s' "$1" > "$out"; else printf '%s' "$1"; fi; }
case "$url" in
  http://127.0.0.1:*/api/health)
    p=${url#http://127.0.0.1:}; p=${p%%/*}
    [ -f "$FAKE_T/health/$p" ] || exit 7
    emit "{\"commit\":\"$(cat "$FAKE_T/health/$p")\"}"; exit 0;;
  https://dazl.test/api/health)
    p=$(grep -oE 'reverse_proxy localhost:[0-9]+' "$FAKE_T/Caddyfile" | grep -oE '[0-9]+$')
    emit "{\"commit\":\"$(cat "$FAKE_T/health/$p" 2>/dev/null)\"}"; exit 0;;
esac
f="$FAKE_T/assets/${url##*/}"
if [ -f "$f" ]; then [ -n "$out" ] && cp "$f" "$out"; [ $has_w = 1 ] && printf 200; exit 0; fi
if [ $has_f = 1 ]; then exit 22; fi
[ $has_w = 1 ] && printf 404
exit 0
''',
    'git': r'''#!/usr/bin/env bash
case "$1" in
  clone) dest=${@: -1}; cp -r "$FAKE_T/src" "$dest";;
  -C) [ "$3" = checkout ] || exit 2;;
  *) exit 2;;
esac
''',
    'ss': r'''#!/usr/bin/env bash
# ss -ltnpH ["sport = :PORT"]: one line per fake listener (port file -> pid)
want=; [ $# -ge 2 ] && want=${2##*:}
for f in "$FAKE_T"/listen/*; do
  [ -f "$f" ] || continue; p=${f##*/}
  [ -z "$want" ] || [ "$want" = "$p" ] || continue
  echo "LISTEN 0 511 *:$p *:* users:((\"node\",pid=$(cat "$f"),fd=20))"
done
''',
    'caddy': '#!/usr/bin/env bash\nexit 0\n',
    'systemctl': '#!/usr/bin/env bash\necho "$*" >> "$FAKE_T/systemctl.log"\n',
    'npm': '#!/usr/bin/env bash\necho "$*" >> "$FAKE_T/npm.log"\n[ ! -e "$FAKE_T/migrate-fail" ] || exit 1\n',
    'npx': r'''#!/usr/bin/env bash
echo "$*" >> "$FAKE_T/npx.log"
if [ "$1 $2" = "next start" ]; then
  port=$4
  if [ -e "$FAKE_T/bad-health" ]; then echo deadbeef > "$FAKE_T/health/$port"; else cat .build-commit > "$FAKE_T/health/$port"; fi
  (sleep 600 & echo $! > "$FAKE_T/listen/$port")
  exit 0
fi
exit 0
''',
}


def tgz(path, files):
    with tarfile.open(path, 'w:gz') as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
            t.addfile(info, io.BytesIO(data))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class ProdPrebuiltTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); T = self.t = Path(self.tmp.name)
        for d in ('bin', 'assets', 'rel', 'ops', 'health', 'listen', 'data', 'src/web', 'lib'): (T / d).mkdir(parents=True)
        # the scripts as installed: root-owned in a root-only-writable directory (the test user stands in for root)
        (T / 'lib').chmod(0o755)
        for f in ('pull-release.sh', 'deploy-prod.sh'):
            (T / 'lib' / f).write_bytes((HERE / f).read_bytes()); (T / 'lib' / f).chmod(0o755)
        self.PULL, self.DEPLOY = str(T / 'lib/pull-release.sh'), str(T / 'lib/deploy-prod.sh')
        for name, body in STUBS.items():
            (T / 'bin' / name).write_text(body); (T / 'bin' / name).chmod(0o755)
        # the source tree a checkout of B gives (package.json + lockfile; no build, no node_modules)
        (T / 'src/web/package.json').write_text('{"name":"web"}'); (T / 'src/web/package-lock.json').write_bytes(LOCK1)
        # the live release: A on :3104, its node_modules, a real process running from its web/
        self.live = live = T / 'rel' / f'dazl-{A[:8]}-prod' / 'web'
        (live / 'node_modules/next').mkdir(parents=True); (live / 'node_modules/next/package.json').write_text('{"live":1}')
        (live / 'package-lock.json').write_bytes(LOCK1); (live / '.build-commit').write_text(A + '\n')
        # its environment is what the deploy copies into the new release (PATH and DB_PATH included, as on the box)
        self.db = T / 'data/prod.db'
        self.proc = subprocess.Popen(['sleep', '600'], cwd=live, env={'PATH': f"{T / 'bin'}:{os.environ['PATH']}", 'FAKE_T': str(T), 'DAZL_SECRET_SAMPLE': 'kept', 'DB_PATH': str(T / 'data/prod.db')})
        (T / 'listen/3104').write_text(str(self.proc.pid)); (T / 'health/3104').write_text(A)
        (T / 'Caddyfile').write_text('dazl.ai, www.dazl.ai {\n\treverse_proxy localhost:3104\n}\n')
        # an older release no process runs from: removed after a successful deploy
        (T / 'rel/dazl-0ld0ld00-prod/web').mkdir(parents=True)
        con = sqlite3.connect(self.db); con.execute('create table t (v text)'); con.execute("insert into t values ('kept')"); con.commit(); con.close()
        (T / 'run.env').write_text('DAZL_MAIL=on\n')

    def tearDown(self):
        # only the stand-in listeners this test started (their pids are in listen/), never anything else on the machine
        for f in (self.t / 'listen').iterdir():
            try: os.kill(int(f.read_text()), 9)
            except (ValueError, ProcessLookupError, PermissionError): pass
        self.proc.kill(); self.tmp.cleanup()

    def publish(self, commit=B, lock=LOCK1, edit=None, inner=None):
        a = self.t / 'assets'
        nxt, mods = a / f'prod-next-{commit}.tgz', a / f'prod-modules-{commit}.tgz'
        tgz(nxt, {'.next/BUILD_ID': b'id\n', '.build-commit': ((inner or commit) + '\n').encode()})
        tgz(mods, {'node_modules/next/package.json': b'{"name":"next"}'})
        m = {'commit': commit, 'arch': 'arm64', 'node_abi': '127', 'node': 'v22.0.0', 'lock_sha256': hashlib.sha256(lock).hexdigest(),
             'next': {'file': nxt.name, 'sha256': sha(nxt), 'bytes': nxt.stat().st_size, 'unpacked_bytes': 100},
             'modules': {'file': mods.name, 'sha256': sha(mods), 'bytes': mods.stat().st_size, 'unpacked_bytes': 100}}
        if edit: m = edit(m)
        (a / f'prod-prebuilt-{commit}.json').write_text(json.dumps(m))
        return nxt, mods

    def env(self, **over):
        T = self.t
        e = {'PATH': f"{T / 'bin'}:{os.environ['PATH']}", 'FAKE_T': str(T), 'HOME': str(T),
             'PROD_CADDYFILE': str(T / 'Caddyfile'), 'PROD_OPS_DIR': str(T / 'ops'), 'PROD_DB': str(self.db),
             'PROD_RELEASE_ROOT': str(T / 'rel'), 'PROD_BACKUP_DIR': str(T / 'backups'), 'PROD_APP_USER': getpass.getuser(),
             'PROD_RUN_ENV': str(T / 'run.env'), 'PROD_REPO_URL': 'https://example.test/dazl.git', 'PROD_PUBLIC_URL': 'https://dazl.test',
             'PROD_PREBUILT_BASE_URL': 'https://example.test/rel', 'PROD_PREBUILT_DIR': str(T / 'dl'),
             'PROD_NODE_ARCH': 'arm64', 'PROD_NODE_ABI': '127', 'PROD_MIN_FREE_BYTES': '0',
             'PROD_HEALTH_TRIES': '3', 'PROD_HEALTH_SLEEP': '0', 'PROD_SWITCH_SLEEP': '0', 'PROD_STOP_SLEEP': '0',
             'PROD_TRUSTED_UID': str(os.getuid())}
        e.update({k: str(v) for k, v in over.items()})
        return e

    def deploy(self, *args, **over):
        return subprocess.run(['bash', self.DEPLOY, *args], env=self.env(**over), capture_output=True, text=True, timeout=120)

    def log(self, name):
        p = self.t / name
        return p.read_text() if p.exists() else ''

    def live_port(self):
        return (self.t / 'Caddyfile').read_text().split('localhost:')[1].split()[0]

    def assert_never_built_on_the_box(self):
        npx, npm = self.log('npx.log'), self.log('npm.log')
        for word in ('build', 'tsc'):
            self.assertNotIn(word, npx, f'npx {word} ran on the box')
        self.assertNotRegex(npm, r'\b(ci|install|run -s build|run build)\b', 'npm installed or built on the box')

    # --- the deploy -------------------------------------------------------------------------------------------------
    def test_deploy_uses_the_prebuilt_build_and_never_builds_on_the_box(self):
        self.publish()
        r = self.deploy(B)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(f'DONE: dazl.ai now {B} on :3105', r.stdout)
        self.assertEqual(self.live_port(), '3105')
        self.assert_never_built_on_the_box()
        self.assertEqual(self.log('npx.log').strip(), 'next start -p 3105')
        self.assertEqual(self.log('npm.log').strip(), 'run -s db:migrate')
        rel = self.t / 'rel' / f'dazl-{B[:8]}-prod' / 'web'
        self.assertEqual((rel / '.build-commit').read_text().strip(), B)
        self.assertTrue((rel / '.next/BUILD_ID').exists())
        # same lockfile as the live release: node_modules hard-linked, not unpacked or installed
        self.assertEqual((rel / 'node_modules/next/package.json').stat().st_ino, (self.live / 'node_modules/next/package.json').stat().st_ino)
        # the database backed up before the migration, readable
        bk = list((self.t / 'backups').glob(f'predeploy-{B[:8]}-*.db'))
        self.assertEqual(len(bk), 1); self.assertEqual(sqlite3.connect(bk[0]).execute('select v from t').fetchall(), [('kept',)])
        # the new process got the live process's environment plus the run env, never the old port
        env = (self.t / 'ops/prod.env').read_text()
        self.assertIn('DAZL_SECRET_SAMPLE=kept', env); self.assertIn('DAZL_MAIL=on', env); self.assertNotIn('PORT=', env)
        # rollback state, and disk: the live and previous releases are kept, an older unused one is removed
        self.assertEqual((self.t / 'ops/prod-state').read_text(), f'PREV_PORT=3104\nPREV_SHA={A}\nNEW_SHA={B}\n')
        self.assertTrue(self.live.exists())
        self.assertFalse((self.t / 'rel/dazl-0ld0ld00-prod').exists())

    def test_lockfile_changed_unpacks_the_built_node_modules(self):
        (self.t / 'src/web/package-lock.json').write_bytes(LOCK2); self.publish(lock=LOCK2)
        r = self.deploy(B)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assert_never_built_on_the_box()
        rel = self.t / 'rel' / f'dazl-{B[:8]}-prod' / 'web'
        self.assertEqual((rel / 'node_modules/next/package.json').read_text(), '{"name":"next"}')

    def test_rollback_switches_back_to_the_previous_release(self):
        self.publish()
        self.assertEqual(self.deploy(B).returncode, 0)
        r = self.deploy('--rollback')
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.live_port(), '3104')
        self.assertEqual((self.t / 'ops/prod-state').read_text(), f'PREV_PORT=3105\nPREV_SHA={B}\nNEW_SHA={A}\n')

    def test_rollback_refuses_when_the_previous_release_is_down(self):
        self.publish()
        self.assertEqual(self.deploy(B).returncode, 0)
        (self.t / 'health/3104').unlink()
        r = self.deploy('--rollback')
        self.assertNotEqual(r.returncode, 0); self.assertIn("answers 'nothing', not the recorded", r.stdout)
        self.assertEqual(self.live_port(), '3105')

    # --- refusals: dazl.ai is untouched -----------------------------------------------------------------------------
    def assert_untouched(self, r, why):
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout + r.stderr, why)
        self.assertEqual(self.live_port(), '3104', 'dazl.ai still on the live release')
        self.assertNotIn('next start', self.log('npx.log'))
        self.assert_never_built_on_the_box()

    def test_no_prebuilt_build_published_refuses_and_says_how_to_build_it(self):
        self.assert_untouched(self.deploy(B), 'no prebuilt build is published for .*run the prod-prebuilt workflow')
        self.assertFalse((self.t / 'rel' / f'dazl-{B[:8]}-prod').exists())

    def test_deploy_disk_check_refuses_before_downloading(self):
        self.publish()
        r = self.deploy(B, PROD_MIN_FREE_BYTES=10 ** 15)
        self.assert_untouched(r, 'free')
        self.assertNotIn('.tgz', self.log('curl.log'))

    def test_disk_floor_counts_the_unpacked_build(self):
        # the downloads alone fit, the unpacked build does not: refused before anything is downloaded
        import shutil
        free = shutil.disk_usage(self.t).free
        self.publish(edit=lambda m: {**m, 'modules': {**m['modules'], 'unpacked_bytes': 1_900_000_000}})
        r = self.deploy(B, PROD_MIN_FREE_BYTES=max(0, free - 1_000_000_000))
        self.assert_untouched(r, 'ALERT low_disk')
        self.assertNotIn('.tgz', self.log('curl.log'))

    def test_corrupt_archive_refuses_nothing_checked_out(self):
        nxt, _ = self.publish()
        data = bytearray(nxt.read_bytes()); data[len(data) // 2] ^= 0xFF; nxt.write_bytes(bytes(data))
        self.assert_untouched(self.deploy(B), "does not match the manifest's sha256")
        self.assertFalse((self.t / 'rel' / f'dazl-{B[:8]}-prod').exists())

    def test_build_from_another_commit_refuses(self):
        self.publish(inner=A)
        self.assert_untouched(self.deploy(B), f'from {A}, not {B}')

    def test_bad_manifests_refuse_before_any_download(self):
        cases = {
            'other arch': lambda m: {**m, 'arch': 'x64'},
            'other commit': lambda m: {**m, 'commit': A},
            'other abi': lambda m: {**m, 'node_abi': '115'},
            'no unpacked size': lambda m: {**m, 'next': {k: v for k, v in m['next'].items() if k != 'unpacked_bytes'}},
            'path in name': lambda m: {**m, 'next': {**m['next'], 'file': '../x'}},
        }
        for why, edit in cases.items():
            with self.subTest(why):
                (self.t / 'curl.log').unlink(missing_ok=True)
                self.publish(edit=edit)
                self.assert_untouched(self.deploy(B), 'manifest')
                self.assertNotIn('.tgz', self.log('curl.log'))

    def test_checkout_whose_lockfile_differs_from_the_build_refuses(self):
        self.publish(lock=LOCK2)  # the build says LOCK2, the checkout has LOCK1
        self.assert_untouched(self.deploy(B), 'not the lockfile the build')
        self.assertFalse((self.t / 'rel' / f'dazl-{B[:8]}-prod').exists())

    def test_unhealthy_new_release_is_not_switched_to(self):
        self.publish(); (self.t / 'bad-health').touch()
        r = self.deploy(B)
        self.assertNotEqual(r.returncode, 0); self.assertIn('NOT switching', r.stdout)
        self.assertEqual(self.live_port(), '3104'); self.assert_never_built_on_the_box()

    def test_failed_migration_does_not_switch(self):
        self.publish(); (self.t / 'migrate-fail').touch()
        self.assert_untouched(self.deploy(B), 'migration failed; prod untouched')

    # --- the independent review of c51687fd: root never runs what the app user controls; verified backup; rollback ---
    def test_run_env_is_parsed_as_data_never_executed_by_root(self):
        # R1/R17: a run.env line is data: an unquoted command substitution is refused (never run); a single-quoted one
        # stays literal text; quoted values keep one level of quotes; the app user's file is read, never sourced by root
        self.publish()
        (self.t / 'run.env').write_text('DAZL_X=$(touch "$FAKE_T/pwned")\n')
        self.assert_untouched(self.deploy(B), 'not KEY=value data')
        self.assertFalse((self.t / 'pwned').exists(), 'a command in run.env ran')
        (self.t / 'run.env').write_text("# a comment\nDAZL_X='$(touch pwned)'\nexport DAZL_Y=\"quoted value\"\nDAZL_Z=plain\n")
        r = self.deploy(B)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse((self.t / 'pwned').exists())
        env = (self.t / 'ops/prod.env').read_text()
        self.assertIn("DAZL_X='$(touch pwned)'", env); self.assertIn("DAZL_Y='quoted value'", env); self.assertIn('DAZL_Z=plain', env)

    def test_unparseable_or_missing_run_env_is_refused(self):
        # R17: never guess at a line the old shell format would have read differently, and never run without the file
        self.publish()
        for bad in ('DAZL_A="x" # note', 'DAZL_A=a;b', 'DAZL_A=~/x', 'DAZL_A=a|b', 'DAZL_A=*', 'DAZL_A=a b'):
            with self.subTest(bad=bad):
                (self.t / 'run.env').write_text(bad + '\n')
                self.assert_untouched(self.deploy(B), 'not KEY=value data')
        (self.t / 'run.env').unlink()
        self.assert_untouched(self.deploy(B), 'run env .* is missing')

    def test_root_identity_never_reaches_the_release_env(self):
        # R16: HOME/USER/LOGNAME/SUDO_* of the (root) live process are not carried into the app user's release
        self.proc.kill(); self.proc.wait()
        self.proc = subprocess.Popen(['sleep', '600'], cwd=self.live, env={'PATH': f"{self.t / 'bin'}:{os.environ['PATH']}", 'FAKE_T': str(self.t),
                                     'DB_PATH': str(self.db), 'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'SUDO_USER': 'x', 'DAZL_KEEP': '1'})
        (self.t / 'listen/3104').write_text(str(self.proc.pid))
        self.publish()
        r = self.deploy(B)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        env = (self.t / 'ops/prod.env').read_text()
        for k in ('HOME=', 'USER=', 'LOGNAME=', 'SUDO_USER='): self.assertNotIn('\n' + k, '\n' + env, k)
        self.assertIn('DAZL_KEEP=1', env)

    def test_disk_floor_counts_the_backup_with_the_release(self):
        # R7: downloads + unpacked release + database backup together must leave the floor (same filesystem). Here the
        # deploy's own pre-check (floor + backup) passes and the release (400 MB unpacked) on top of the backup does not;
        # with the floor checked separately for each (before), this deploy went ahead.
        import shutil
        self.publish(edit=lambda m: {**m, 'modules': {**m['modules'], 'unpacked_bytes': 400 * 10 ** 6}})
        with open(self.db, 'ab') as f: f.truncate(600 * 10 ** 6)  # a 600 MB (sparse) database
        free = shutil.disk_usage(self.t).free
        r = self.deploy(B, PROD_MIN_FREE_BYTES=free - 600 * 10 ** 6 - 200 * 10 ** 6)
        self.assert_untouched(r, 'ALERT low_disk')
        self.assertNotIn('.tgz', self.log('curl.log'))

    def test_database_directory_must_be_writable_by_the_app_user(self):
        # R14: WAL files are created beside the database
        self.publish()
        (self.t / 'data').chmod(0o555)
        try: self.assert_untouched(self.deploy(B), 'database directory .* not writable')
        finally: (self.t / 'data').chmod(0o755)
        self.assertFalse((self.t / 'backups').exists())

    def test_node_modules_falls_back_to_the_verified_archive_when_it_cannot_be_hard_linked(self):
        # R13b: a live release the app user cannot hard-link from (e.g. root-owned under protected_hardlinks)
        self.publish()
        (self.live / 'node_modules/next').chmod(0o000)
        try:
            r = self.deploy(B)
        finally: (self.live / 'node_modules/next').chmod(0o755)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('unpacked from the verified build', r.stdout)
        self.assertEqual((self.t / 'rel' / f'dazl-{B[:8]}-prod' / 'web/node_modules/next/package.json').read_text(), '{"name":"next"}')

    def test_an_old_release_that_cannot_be_removed_does_not_fail_a_done_deploy(self):
        # R13a: a stuck prune is logged; the deploy (already switched and recorded) still succeeds
        self.publish()
        stuck = self.t / 'rel/dazl-0ld0ld00-prod/web/cache'; stuck.mkdir(parents=True); (stuck / 'f').write_text('x'); stuck.chmod(0o555)
        try:
            r = self.deploy(B)
        finally: stuck.chmod(0o755)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('could not remove all of', r.stdout); self.assertEqual(self.live_port(), '3105')

    def test_existing_wal_file_must_be_writable_by_the_app_user(self):
        # R20: a root-run app leaves <db>-wal behind; migrate as the app user would fail after the backup
        self.publish()
        wal = Path(str(self.db) + '-wal'); wal.write_bytes(b''); wal.chmod(0o444)
        try: self.assert_untouched(self.deploy(B), '-wal is not writable')
        finally: wal.chmod(0o644)
        self.assertFalse((self.t / 'backups').exists())

    def test_rollback_with_wrong_public_health_switches_back_and_keeps_the_state(self):
        # R21a: after switching, dazl.ai must answer with the rollback target's commit; otherwise switch back
        self.publish()
        self.assertEqual(self.deploy(B).returncode, 0)
        state = (self.t / 'ops/prod-state').read_text()
        # the public endpoint keeps answering B (e.g. Caddy did not really switch)
        (self.t / 'bin/curl').write_text((self.t / 'bin/curl').read_text().replace(
            'https://dazl.test/api/health)\n    p=$(grep', 'https://dazl.test/api/health)\n    emit "{\\"commit\\":\\"%s\\"}"; exit 0\n    p=$(grep' % B))
        r = self.deploy('--rollback')
        self.assertNotEqual(r.returncode, 0, r.stdout); self.assertIn('after the rollback: switched back', r.stdout)
        self.assertEqual(self.live_port(), '3105'); self.assertEqual((self.t / 'ops/prod-state').read_text(), state)

    def test_failed_caddy_reload_restores_the_previous_config(self):
        # R21b: a reload that fails puts back the exact previous Caddyfile
        self.publish()
        before = (self.t / 'Caddyfile').read_bytes()
        (self.t / 'bin/systemctl').write_text('#!/usr/bin/env bash\nexit 1\n')
        r = self.deploy(B)
        self.assertNotEqual(r.returncode, 0); self.assertIn('caddy did not reload; the previous config is restored', r.stdout)
        self.assertEqual((self.t / 'Caddyfile').read_bytes(), before)

    def test_no_live_listener_is_refused_with_its_own_message(self):
        # R25: an empty live pid is named, not reported as a run env problem
        self.publish()
        (self.t / 'listen/3104').unlink()
        self.assert_untouched(self.deploy(B), 'no process is listening on the live port')

    def test_caddy_refusing_the_new_config_switches_nothing(self):
        # R18: the new config is validated before it replaces the live one
        self.publish()
        (self.t / 'bin/caddy').write_text('#!/usr/bin/env bash\nexit 1\n')
        r = self.deploy(B)
        self.assertNotEqual(r.returncode, 0); self.assertIn('caddy refused the new config', r.stdout)
        self.assertEqual(self.live_port(), '3104'); self.assertFalse((self.t / 'Caddyfile.next').exists())

    def test_untrusted_script_location_is_refused(self):
        # R2: root runs deploy-prod.sh and pull-release.sh: refused unless root-owned and root-writable only
        self.publish()
        (self.t / 'lib').chmod(0o775)
        self.assert_untouched(self.deploy(B), 'not trusted')
        (self.t / 'lib').chmod(0o755); (self.t / 'lib/pull-release.sh').chmod(0o775)
        self.assert_untouched(self.deploy(B), 'not trusted')

    def test_missing_or_mismatched_database_is_refused_before_anything(self):
        # R3: never back up (or migrate) a database that is not the one the release uses
        self.publish()
        self.assert_untouched(self.deploy(B, PROD_DB=str(self.t / 'data/missing.db')), 'missing or not a regular file')
        other = self.t / 'data/other.db'; sqlite3.connect(other).execute('create table x (y)').connection.commit()
        self.assert_untouched(self.deploy(B, PROD_DB=str(other)), 'is not .*the database this deploy backs up')
        self.assertFalse((self.t / 'backups').exists())

    def test_corrupt_database_backup_is_refused(self):
        # R3: the backup is verified (integrity_check) before migrate
        self.publish()
        self.db.write_bytes(b'not a database' * 200)
        self.assert_untouched(self.deploy(B), 'backup failed')
        self.assertEqual(self.log('npm.log'), '', 'no migrate without a verified backup')

    def test_rollback_after_a_failed_deploy_is_refused(self):
        # R4: deploy B (A is the rollback target on :3104), then a failed deploy of C stops A on :3104 and leaves no
        # usable target: --rollback must refuse, never switch to whatever answers on the old port
        self.publish()
        self.assertEqual(self.deploy(B).returncode, 0)
        C = 'c' * 40; self.publish(C); (self.t / 'bad-health').touch()
        self.assertNotEqual(self.deploy(C).returncode, 0)
        self.assertEqual(self.live_port(), '3105', 'B still serves')
        r = self.deploy('--rollback')
        self.assertNotEqual(r.returncode, 0, r.stdout); self.assertRegex(r.stdout, 'no rollback target|not the recorded')
        self.assertEqual(self.live_port(), '3105')

    def test_one_deploy_at_a_time(self):
        # R5: a second deploy while one holds the lock does nothing
        import fcntl
        self.publish()
        (self.t / 'ops').mkdir(exist_ok=True)
        with open(self.t / 'ops/deploy.lock', 'w') as lk:
            fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_untouched(self.deploy(B), 'another deploy or rollback is running')

    def test_download_time_budget(self):
        self.publish()
        r = subprocess.run(['bash', self.PULL, 'fetch', B], env=self.env(PROD_DOWNLOAD_BUDGET_S='0'), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('time budget', r.stderr)

    def test_extract_without_a_verified_fetch_refuses(self):
        web = self.t / 'x/web'; web.mkdir(parents=True); (web / 'package-lock.json').write_bytes(LOCK1)
        (self.t / 'dl').mkdir()
        r = subprocess.run(['bash', self.PULL, 'extract', B, str(web)], env=self.env(), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('no verified prebuilt build', r.stderr)
        self.assertFalse((web / '.next').exists())

    def test_the_deploy_script_contains_no_build_step(self):
        # supplement to the behaviour tests above: no command in the deploy path installs or compiles
        for f in (self.DEPLOY, self.PULL):
            code = '\n'.join(l for l in Path(f).read_text().splitlines() if not l.lstrip().startswith('#'))
            self.assertNotRegex(code, r'next build|npm ci|npm install|\btsc\b', f)


if __name__ == '__main__':
    unittest.main()
