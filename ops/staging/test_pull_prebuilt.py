"""Staging auto-deploy from a prebuilt build (ops/staging/pull-prebuilt.sh).

Runs the real script against stand-ins for git (main's head), curl (the release download URL, served from a local
directory) and deploy.sh (the same interface: it writes .build-commit in the new release's web/ and runs STAGING_BUILD
there, hard-linking node_modules when the lockfile is unchanged, then records current-sha). The database backup uses the
real sqlite3. Nothing touches the network.
"""
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

SCRIPT = str(Path(__file__).with_name('pull-prebuilt.sh'))
A, B, C = 'a' * 40, 'b' * 40, 'c' * 40
LOCK1, LOCK2 = b'{"lockfileVersion":3,"v":1}\n', b'{"lockfileVersion":3,"v":2}\n'

FAKE_GIT = r'''#!/usr/bin/env bash
[ "$1" = ls-remote ] || exit 2
printf '%s\trefs/heads/main\n' "$(cat "$FAKE_T/main")"
'''
FAKE_CURL = r'''#!/usr/bin/env bash
# Models two real curl call shapes the script uses: the manifest fetch (no -f, reads -w '%{http_code}' from stdout -
# round 2, #1061/#907: the old -f call conflated a true 404 with 403/429/5xx) and the asset downloads (still -fsSL,
# which exits 22 on any HTTP error >= 400, 404 included).
out=; url=; has_f=0; has_w=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2;;
    -w) has_w=1; shift 2;;
    --max-time) echo "max-time $2" >> "$FAKE_T/curl-maxtime.log"; shift 2;;
    --max-filesize|--proto|--retry) shift 2;;
    -*) [[ "$1" == *f* ]] && has_f=1; shift;;
    *) url=$1; shift;;
  esac
done
echo "$url" >> "$FAKE_T/curl.log"
# force-status lets a test simulate a specific HTTP status (403/429/5xx) for the manifest fetch, which the real file-
# exists/missing split below can't produce - a status other than 404 must be a real failure, never "nothing to do".
if [ -f "$FAKE_T/force-status" ]; then
  code=$(cat "$FAKE_T/force-status")
  [ -n "$out" ] && printf 'error body' > "$out"
  if [ $has_f = 1 ] && [ "$code" -ge 400 ]; then echo "curl: (22) The requested URL returned error: $code" >&2; exit 22; fi
  [ $has_w = 1 ] && printf '%s' "$code"
  exit 0
fi
f="$FAKE_T/assets/${url##*/}"
if [ -f "$f" ]; then
  [ -n "$out" ] && cp "$f" "$out"
  [ $has_w = 1 ] && printf '200'
  exit 0
fi
if [ $has_f = 1 ]; then echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
[ $has_w = 1 ] && printf '404'
exit 0
'''
FAKE_LOG = r'''#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_T/migrate.log"
'''
# deploy.sh's interface (the #908 layout, main's ops/staging/deploy.sh): migrate is its own step (STAGING_MIGRATE), the
# live commit is recorded in $STAGING_STATE_ROOT/current-sha (root-owned, outside the service account's home), and
# --check-env FILE validates the env file (here: refuses a non-staging env or a DB path under /prod/). MARKER is replaced
# by "STAGING_MIGRATE" for the current deploy.sh, or by an old comment for a deploy.sh from before #908.
FAKE_DEPLOY = r'''#!/usr/bin/env bash
# MARKER
set -euo pipefail
T=$FAKE_T
if [ "${1:-}" = --check-env ]; then
  grep -q '^DAZL_ENV=staging$' "$2" && ! grep -q '^DB_PATH=.*/prod/' "$2" || { echo "fake deploy: env refused" >&2; exit 1; }
  echo "env ok"; exit 0
fi
printf '%s' "$STAGING_BUILD" > "$T/build-cmd"
echo run >> "$T/deploy-runs"
[ ! -e "$T/deploy-fail" ] || exit 3
[ ! -e "$T/deploy-hang" ] || sleep 600
STATE=${STAGING_STATE_ROOT:-/var/lib/dazl-staging-deploy}
new=$(cat "$T/deploy-main" 2>/dev/null || cat "$T/main")
cur=$(cat "$STATE/current-sha" 2>/dev/null || true)
[ "$new" != "$cur" ] || exit 0
rel="$T/root/releases/$new"; rm -rf "$rel"; mkdir -p "$rel/web"
cp "$T/lockfile" "$rel/web/package-lock.json"
live=; [ -L "$T/root/current" ] && live=$(readlink -f "$T/root/current")
if [ -n "$live" ] && [ -d "$live/web/node_modules" ] && cmp -s "$live/web/package-lock.json" "$T/lockfile"; then cp -al "$live/web/node_modules" "$rel/web/node_modules"; fi
if ! bash -c "cd '$rel/web' && echo '$new' > .build-commit && $STAGING_BUILD"; then rm -rf "$rel"; echo "fake deploy: build of $new failed" >&2; exit 1; fi
ln -sfn "$rel" "$T/root/current"; mkdir -p "$STATE"; echo "$new" > "$STATE/current-sha"
[ ! -e "$T/deploy-hang-after" ] || sleep 600
echo "fake deploy: live: $new"
'''


def tgz(path, files):
    with tarfile.open(path, 'w:gz') as t:
        for name, data in files.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
            t.addfile(info, io.BytesIO(data))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class PullPrebuiltTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.t = T = Path(self.tmp.name)
        for d in ('bin', 'assets', 'root/releases', 'data', 'lib', 'state'): (T / d).mkdir(parents=True)
        (T / 'lib').chmod(0o755)  # the deploy script's directory: writable by its owner only (whatever the umask)
        for name, body in (('git', FAKE_GIT), ('curl', FAKE_CURL), ('npm', FAKE_LOG), ('node', FAKE_LOG)):
            (T / 'bin' / name).write_text(body); (T / 'bin' / name).chmod(0o755)
        self.deploy(new_style=True)
        # the live release: commit A, lockfile LOCK1, its node_modules
        live = T / 'root/releases' / A / 'web'
        (live / 'node_modules/next').mkdir(parents=True)
        (live / 'node_modules/next/package.json').write_text('{}')
        (live / 'package-lock.json').write_bytes(LOCK1)
        os.symlink(T / 'root/releases' / A, T / 'root/current')
        (T / 'state/current-sha').write_text(A + '\n')
        (T / 'lockfile').write_bytes(LOCK1)
        self.db = T / 'data/app.db'
        con = sqlite3.connect(self.db); con.execute('pragma journal_mode=wal')
        con.execute('create table t (v text)'); con.execute("insert into t values ('kept')"); con.commit(); con.close()
        (T / 'env').write_text(f'DAZL_ENV=staging\nDB_PATH={self.db}\n')
        (T / 'main').write_text(B)

    def tearDown(self):
        self.tmp.cleanup()

    def deploy(self, new_style):
        body = FAKE_DEPLOY.replace('MARKER', 'STAGING_MIGRATE' if new_style else 'deploy.sh from before #908')
        d = self.t / 'lib/deploy.sh'
        d.write_text(body); d.chmod(0o755)

    def publish(self, commit=B, inner=None, lock=LOCK1, edit=None):
        """The workflow's three assets for commit, with an optional edit of the manifest dict."""
        a = self.t / 'assets'
        nxt, mods = a / f'staging-next-{commit}.tgz', a / f'staging-modules-{commit}.tgz'
        tgz(nxt, {'.next/BUILD_ID': b'build-id\n', '.build-commit': ((inner or commit) + '\n').encode()})
        tgz(mods, {'node_modules/next/package.json': b'{"name":"next"}'})
        m = {'commit': commit, 'arch': 'arm64', 'node_abi': '127', 'node': 'v22.0.0',
             'lock_sha256': hashlib.sha256(lock).hexdigest(),
             'next': {'file': nxt.name, 'sha256': sha(nxt), 'bytes': nxt.stat().st_size},
             'modules': {'file': mods.name, 'sha256': sha(mods), 'bytes': mods.stat().st_size}}
        if edit: m = edit(m)
        (a / f'staging-prebuilt-{commit}.json').write_text(m if isinstance(m, str) else json.dumps(m))
        return nxt, mods

    def run_pull(self, *args, **env):
        T = self.t
        e = {'PATH': f"{T / 'bin'}:{os.environ['PATH']}", 'FAKE_T': str(T), 'HOME': str(T),
             'STAGING_REPO_URL': 'https://example.test/dazl.git', 'STAGING_PREBUILT_BASE_URL': 'https://example.test/rel',
             'STAGING_ROOT': str(T / 'root'), 'STAGING_ENV_FILE': str(T / 'env'), 'STAGING_DEPLOY_SH': str(T / 'lib/deploy.sh'),
             'STAGING_PREBUILT_DIR': str(T / 'dl'), 'STAGING_PREBUILT_STATE': str(T / 'pstate'),
             'STAGING_BACKUP_DIR': str(T / 'backups'), 'STAGING_STATE_ROOT': str(T / 'state'),
             # the deploy script must be owned by root; here the test user stands in for root (the unit never sets this)
             'STAGING_TRUSTED_UID': str(os.getuid()),
             'MIN_FREE_BYTES': '0', 'DISK_RESERVE_BYTES': '0', 'STAGING_NODE_ARCH': 'arm64', 'STAGING_NODE_ABI': '127'}
        e.update({k: str(v) for k, v in env.items()})
        return subprocess.run(['bash', SCRIPT, *args], env=e, capture_output=True, text=True, timeout=60)

    def curl_log(self):
        p = self.t / 'curl.log'
        return p.read_text() if p.exists() else ''

    def live(self):
        return (self.t / 'state/current-sha').read_text().strip()

    def deployed(self):
        return (self.t / 'build-cmd').exists()

    # --- no-ops -------------------------------------------------------------------------------------------------------
    def test_already_live_is_a_no_op(self):
        (self.t / 'main').write_text(A); self.publish(A)
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.curl_log(), ''); self.assertFalse(self.deployed())

    def test_main_not_built_yet_waits(self):
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('no prebuilt build published for main ' + B, r.stdout)
        self.assertFalse(self.deployed()); self.assertEqual(self.live(), A)

    def test_manifest_fetch_real_error_is_not_treated_as_not_built_yet(self):
        # #1061/#907 round 2: curl -f's exit 22 meant ANY HTTP error >= 400 read the same as a benign true 404 - a
        # real 403/429/5xx must alert instead of silently waiting for a build that is never coming.
        for code in ('403', '429', '500', '503'):
            with self.subTest(code=code):
                (self.t / 'force-status').write_text(code)
                r = self.run_pull()
                self.assertNotEqual(r.returncode, 0, r.stdout)
                self.assertIn(f'HTTP {code}', r.stdout + r.stderr)
                self.assertNotIn('nothing to do', r.stdout)
                self.assertFalse(self.deployed()); self.assertEqual(self.live(), A)

    # --- the deploy ---------------------------------------------------------------------------------------------------
    def test_deploys_main_from_the_verified_build_lockfile_unchanged(self):
        self.publish()
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('live: ' + B, r.stdout)
        self.assertEqual(self.live(), B)
        rel = self.t / 'root/releases' / B / 'web'
        self.assertEqual((rel / '.build-commit').read_text().strip(), B)
        self.assertEqual((rel / '.next/BUILD_ID').read_text(), 'build-id\n')
        self.assertTrue((rel / 'node_modules/next/package.json').exists())
        log = self.curl_log()
        self.assertIn(f'staging-next-{B}.tgz', log)
        self.assertNotIn('staging-modules', log, 'node_modules is reused when the lockfile is unchanged')
        build = (self.t / 'build-cmd').read_text()
        self.assertIn('--extract', build); self.assertNotIn('db:migrate', build, 'the current deploy.sh migrates itself')
        # a verified backup of the staging database, root-only
        backups = list((self.t / 'backups').glob(f'app-pre-{B[:8]}-*.db'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(sqlite3.connect(backups[0]).execute('select v from t').fetchall(), [('kept',)])
        self.assertEqual(oct(backups[0].stat().st_mode & 0o777), '0o600')
        self.assertEqual(oct((self.t / 'backups').stat().st_mode & 0o777), '0o700')
        # downloads cleared once live; the next run is a no-op
        self.assertEqual([p.name for p in (self.t / 'dl').iterdir()], [])
        before = self.curl_log()
        r2 = self.run_pull()
        self.assertEqual(r2.returncode, 0, r2.stderr); self.assertEqual(self.curl_log(), before)

    def test_lockfile_changed_ships_node_modules(self):
        (self.t / 'lockfile').write_bytes(LOCK2); self.publish(lock=LOCK2)
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.live(), B)
        self.assertIn(f'staging-modules-{B}.tgz', self.curl_log())
        self.assertEqual((self.t / 'root/releases' / B / 'web/node_modules/next/package.json').read_text(), '{"name":"next"}')
        self.assertNotIn('db:migrate', (self.t / 'build-cmd').read_text(), 'deploy.sh migrates in its own step')

    def test_backups_keep_the_newest(self):
        self.publish(B)
        self.assertEqual(self.run_pull(STAGING_KEEP_BACKUPS=1).returncode, 0)
        (self.t / 'main').write_text(C); self.publish(C)
        r = self.run_pull(STAGING_KEEP_BACKUPS=1)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([p.name[:16] for p in (self.t / 'backups').iterdir()], [f'app-pre-{C[:8]}'])

    def test_first_deploy_without_a_database_yet(self):
        self.db.unlink(); Path(str(self.db) + '-wal').unlink(missing_ok=True); Path(str(self.db) + '-shm').unlink(missing_ok=True)
        self.publish()
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('nothing to back up', r.stdout); self.assertEqual(self.live(), B)

    # --- refusals: nothing deployed, the live release unchanged -------------------------------------------------------
    def assert_refused(self, r, why):
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout + r.stderr, why)
        self.assertFalse(self.deployed(), 'deploy.sh must not run'); self.assertEqual(self.live(), A)

    # --- #1061 Hermes review (a8425d09): findings 1-7 ----------------------------------------------------------------
    def test_untrusted_deploy_script_is_refused_before_anything(self):
        # finding 1: root runs DEPLOY; a file or directory a non-root account can replace must never be run
        self.publish()
        d = self.t / 'lib/deploy.sh'
        cases = {
            'group-writable script': lambda: d.chmod(0o775),
            'world-writable script': lambda: d.chmod(0o757),
            'group-writable parent directory': lambda: (self.t / 'lib').chmod(0o775),
            'symlinked script': lambda: (d.rename(self.t / 'lib/real.sh'), d.symlink_to(self.t / 'lib/real.sh')),
            'symlinked parent directory': lambda: ((self.t / 'lib').rename(self.t / 'lib2'), (self.t / 'lib').symlink_to(self.t / 'lib2')),
        }
        for why, mutate in cases.items():
            with self.subTest(why):
                self.setUp_deploy_fresh()
                mutate()
                (self.t / 'curl.log').unlink(missing_ok=True)
                r = self.run_pull()
                self.assert_refused(r, 'deploy script .* not trusted')
                self.assertEqual(self.curl_log(), '', 'refused before any download')
                self.assertFalse((self.t / 'backups').exists(), 'refused before any backup')
        # owned by someone other than the trusted user (root)
        self.setUp_deploy_fresh()
        self.assert_refused(self.run_pull(STAGING_TRUSTED_UID=os.getuid() + 1), 'deploy script .* not trusted')

    def setUp_deploy_fresh(self):
        lib = self.t / 'lib'
        if lib.is_symlink(): lib.unlink()
        if (self.t / 'lib2').exists(): (self.t / 'lib2').rename(lib)
        lib.chmod(0o755)
        for f in ('deploy.sh', 'real.sh'):
            p = lib / f
            if p.is_symlink() or p.exists(): p.unlink()
        self.deploy(new_style=True)

    def test_deploy_script_from_before_908_is_refused(self):
        # finding 1/2: the prerequisite is the #908 layout (root-owned deploy.sh outside the service home, current-sha in
        # its root-owned state directory); a deploy.sh without the STAGING_MIGRATE step is refused, nothing done
        self.deploy(new_style=False); self.publish()
        r = self.run_pull()
        self.assert_refused(r, 'from before #908')
        self.assertEqual(self.curl_log(), '')

    def test_documented_defaults_second_tick_is_a_no_op(self):
        # finding 2: with the documented env (no override of where current-sha is read), tick 2 after a deploy must
        # neither back up nor run deploy.sh again
        self.publish()
        r1 = self.run_pull()
        self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr); self.assertIn('live: ' + B, r1.stdout)
        backups1 = sorted(p.name for p in (self.t / 'backups').iterdir())
        runs1 = (self.t / 'deploy-runs').read_text()
        r2 = self.run_pull()
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertEqual(sorted(p.name for p in (self.t / 'backups').iterdir()), backups1, 'tick 2 takes no backup')
        self.assertEqual((self.t / 'deploy-runs').read_text(), runs1, 'tick 2 does not run deploy.sh')

    def test_keep_backups_must_be_a_whole_number_of_at_least_one(self):
        # finding 3: 0 would delete the just-verified backup before deploy.sh runs
        self.publish()
        for bad in ('0', '-1', 'x', '', '1.5'):
            with self.subTest(bad=bad):
                (self.t / 'curl.log').unlink(missing_ok=True)
                self.assert_refused(self.run_pull(STAGING_KEEP_BACKUPS=bad), 'STAGING_KEEP_BACKUPS')
                self.assertEqual(self.curl_log(), ''); self.assertFalse((self.t / 'backups').exists())

    def test_download_or_verify_failure_is_throttled_like_a_deploy_failure(self):
        # finding 4: a bad asset must not be downloaded again every tick
        nxt, _ = self.publish()
        data = bytearray(nxt.read_bytes()); data[len(data) // 2] ^= 0xFF; nxt.write_bytes(bytes(data))
        self.assert_refused(self.run_pull(), "does not match the manifest's sha256")
        self.assertTrue((self.t / 'pstate' / f'failed-{B}').exists(), 'a verification failure writes the retry stamp')
        downloads = self.curl_log().count('.tgz')
        r2 = self.run_pull()
        self.assertEqual(r2.returncode, 0, r2.stderr); self.assertIn('failed less than', r2.stdout)
        self.assertEqual(self.curl_log().count('.tgz'), downloads, 'tick 2 downloads nothing')
        # a failed backup is throttled too; a not-yet-published build and low disk are not failures
        self.assertFalse((self.t / 'pstate' / f'failed-{C}').exists())

    def test_backup_failure_is_throttled(self):
        self.db.unlink(); Path(str(self.db) + '-wal').unlink(missing_ok=True); Path(str(self.db) + '-shm').unlink(missing_ok=True)
        self.db.write_bytes(b'this is not a database' * 100)
        self.publish()
        self.assert_refused(self.run_pull(), 'backup failed')
        self.assertTrue((self.t / 'pstate' / f'failed-{B}').exists())

    def test_not_published_and_low_disk_write_no_stamp(self):
        r = self.run_pull()
        self.assertEqual(r.returncode, 0); self.assertFalse((self.t / 'pstate' / f'failed-{B}').exists())
        self.publish()
        r = self.run_pull(MIN_FREE_BYTES=10 ** 15)
        self.assertEqual(r.returncode, 0); self.assertIn('ALERT low_disk', r.stdout)
        self.assertFalse((self.t / 'pstate' / f'failed-{B}').exists())

    def test_cached_modules_archive_that_is_not_needed_is_not_counted_as_free_space(self):
        # finding 5: lockfile unchanged (need_mods=0) - a cached modules archive is not reused, so it is no credit;
        # here it is a 1 GB sparse file: with the old credit the floor check passed although real free space is short
        import shutil
        nxt, _ = self.publish()
        dl = self.t / 'dl'; dl.mkdir()
        big = dl / f'staging-modules-{B}.tgz'
        with open(big, 'wb') as f: f.truncate(10 ** 9)
        free = shutil.disk_usage(dl).free
        need = nxt.stat().st_size + self.db.stat().st_size
        r = self.run_pull(MIN_FREE_BYTES=free - need + 5 * 10 ** 8)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('ALERT low_disk', r.stdout)
        self.assertFalse(self.deployed())

    def test_env_is_checked_by_deploy_sh_before_the_database_is_touched(self):
        # finding 6: the root-run backup must never read a production database: deploy.sh --check-env runs first
        self.publish()
        (self.t / 'env').write_text(f'DAZL_ENV=production\nDB_PATH={self.db}\n')
        self.assert_refused(self.run_pull(), 'env')
        self.assertFalse((self.t / 'backups').exists(), 'no backup of a database the env check refused')

    def test_symlinked_or_hard_linked_database_is_refused(self):
        self.publish()
        link = self.t / 'data/link.db'; link.symlink_to(self.db)
        (self.t / 'env').write_text(f'DAZL_ENV=staging\nDB_PATH={link}\n')
        self.assert_refused(self.run_pull(), 'symlink')
        self.assertFalse((self.t / 'backups').exists())
        link.unlink(); os.link(self.db, link)
        self.assert_refused(self.run_pull(STAGING_RETRY_AFTER_S=0), 'hard link')
        self.assertFalse((self.t / 'backups').exists())

    def test_downloads_share_one_time_budget_below_the_unit_timeout(self):
        # finding 7: every download is bounded by what is left of one budget; an exhausted budget fails (and is throttled)
        (self.t / 'lockfile').write_bytes(LOCK2); self.publish(lock=LOCK2)
        r = self.run_pull(STAGING_DOWNLOAD_BUDGET_S=600)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        times = [int(l.split()[1]) for l in (self.t / 'curl-maxtime.log').read_text().splitlines()]
        self.assertTrue(all(t <= 600 for t in times), times)
        (self.t / 'main').write_text(C); self.publish(C)
        self.assert_refused_at(self.run_pull(STAGING_DOWNLOAD_BUDGET_S=0), 'time budget', B)
        unit = Path(SCRIPT).with_name('dazl-staging-prebuilt.service').read_text()
        import re
        tmo = int(re.search(r'^TimeoutStartSec=(\d+)min$', unit, re.M).group(1)) * 60
        src = Path(SCRIPT).read_text()
        budget = int(re.search(r'DOWNLOAD_BUDGET_S=\$\{STAGING_DOWNLOAD_BUDGET_S:-(\d+)\}', src).group(1))
        deploy_allow = int(re.search(r'DEPLOY_ALLOWANCE_S=\$\{STAGING_DEPLOY_ALLOWANCE_S:-(\d+)\}', src).group(1))
        self.assertLess(budget + deploy_allow, tmo, 'the downloads plus deploy.sh fit inside the unit timeout')

    def test_deploy_sh_is_stopped_inside_its_allowance(self):
        # #1061 review (XHawk at c51687fd): DEPLOY_ALLOWANCE_S was declared but never enforced, so a deploy.sh that ran
        # long was only ever killed by systemd mid-step. Now it runs under `timeout` and the run says why it stopped.
        import time
        (self.t / 'deploy-hang').write_text(''); self.publish()
        t0 = time.monotonic(); r = self.run_pull(STAGING_DEPLOY_ALLOWANCE_S=2); took = time.monotonic() - t0
        self.assertNotEqual(r.returncode, 0); self.assertLess(took, 30, f'took {took:.0f}s')
        self.assertIn('ran past its 2s allowance', r.stdout + r.stderr)
        self.assertNotEqual(self.run_pull(STAGING_DEPLOY_ALLOWANCE_S='0').returncode, 0, 'a zero allowance is refused')
        r = self.run_pull(STAGING_DEPLOY_ALLOWANCE_S=4000)
        self.assertNotEqual(r.returncode, 0); self.assertIn("inside the unit's timeout", r.stdout + r.stderr)

    def test_deploy_sh_stopped_after_the_switch_reports_the_commit_live(self):
        (self.t / 'deploy-hang-after').write_text(''); self.publish()
        r = self.run_pull(STAGING_DEPLOY_ALLOWANCE_S=2)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('stopped by its allowance after', r.stdout + r.stderr); self.assertEqual(self.live(), B)

    def assert_refused_at(self, r, why, live):
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout + r.stderr, why)
        self.assertEqual(self.live(), live)

    def test_download_that_does_not_match_the_manifest_is_refused(self):
        nxt, _ = self.publish()
        data = bytearray(nxt.read_bytes()); data[len(data) // 2] ^= 0xFF; nxt.write_bytes(bytes(data))  # same size, other bytes
        self.assert_refused(self.run_pull(), "does not match the manifest's sha256")
        self.assertFalse(any(p.name.endswith('.part') for p in (self.t / 'dl').iterdir()))
        nxt.write_bytes(nxt.read_bytes() + b'x')  # other size (the first failure is throttled: retry now)
        self.assert_refused(self.run_pull(STAGING_RETRY_AFTER_S=0), 'is not the .* bytes the manifest records')

    def test_build_from_another_commit_is_refused(self):
        self.publish(inner=C)
        self.assert_refused(self.run_pull(), f'from {C}, not {B}')
        self.assertFalse((self.t / 'dl' / f'staging-next-{B}.tgz').exists())

    def test_malformed_manifests_are_refused_before_any_download(self):
        cases = {
            'not json': lambda m: '{not json',
            'a list': lambda m: '[]',
            'null': lambda m: 'null',
            'another commit': lambda m: {**m, 'commit': C},
            'commit missing': lambda m: {k: v for k, v in m.items() if k != 'commit'},
            'other arch': lambda m: {**m, 'arch': 'x64'},
            'abi as number': lambda m: {**m, 'node_abi': 127},
            'other abi': lambda m: {**m, 'node_abi': '115'},
            'lock missing': lambda m: {k: v for k, v in m.items() if k != 'lock_sha256'},
            'modules missing': lambda m: {k: v for k, v in m.items() if k != 'modules'},
            'next a string': lambda m: {**m, 'next': 'x'},
            'path in file name': lambda m: {**m, 'next': {**m['next'], 'file': '../../etc/passwd'}},
            'uppercase sha256': lambda m: {**m, 'next': {**m['next'], 'sha256': m['next']['sha256'].upper()}},
            'bytes bool': lambda m: {**m, 'next': {**m['next'], 'bytes': True}},
            'bytes string': lambda m: {**m, 'next': {**m['next'], 'bytes': '10'}},
            'bytes negative': lambda m: {**m, 'next': {**m['next'], 'bytes': -1}},
            'bytes huge': lambda m: {**m, 'modules': {**m['modules'], 'bytes': 10 ** 12}},
        }
        for why, edit in cases.items():
            with self.subTest(why):
                (self.t / 'curl.log').unlink(missing_ok=True)
                self.publish(edit=edit)
                self.assert_refused(self.run_pull(), 'manifest')
                self.assertNotIn('.tgz', self.curl_log(), 'nothing downloaded')

    def test_low_disk_skips_before_downloading(self):
        self.publish()
        r = self.run_pull(MIN_FREE_BYTES=10 ** 15)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('ALERT low_disk', r.stdout)
        self.assertNotIn('.tgz', self.curl_log()); self.assertFalse(self.deployed()); self.assertEqual(self.live(), A)

    def test_failed_backup_blocks_the_deploy(self):
        self.db.unlink(); Path(str(self.db) + '-wal').unlink(missing_ok=True); Path(str(self.db) + '-shm').unlink(missing_ok=True)
        self.db.write_bytes(b'this is not a database' * 100)
        self.publish()
        self.assert_refused(self.run_pull(), 'backup failed')
        self.assertEqual(list((self.t / 'backups').glob('*.tmp')), [])

    def test_unreadable_main_head_fails(self):
        (self.t / 'main').write_text('not-a-sha')
        self.assert_refused(self.run_pull(), "could not read main's head")

    def test_main_moved_after_the_check_fails_closed_then_backs_off(self):
        self.publish()
        (self.t / 'deploy-main').write_text(C)  # deploy.sh's own fetch sees a newer main, which has no verified build
        r = self.run_pull()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(f'no verified prebuilt build of {C}', r.stderr)
        self.assertEqual(self.live(), A); self.assertFalse((self.t / 'root/releases' / C).exists())
        self.assertTrue((self.t / 'pstate' / f'failed-{B}').exists())
        (self.t / 'build-cmd').unlink()
        r2 = self.run_pull()
        self.assertEqual(r2.returncode, 0); self.assertIn('failed less than', r2.stdout); self.assertFalse(self.deployed())
        (self.t / 'deploy-main').unlink()
        r3 = self.run_pull(STAGING_RETRY_AFTER_S=0)
        self.assertEqual(r3.returncode, 0, r3.stderr); self.assertEqual(self.live(), B)
        self.assertEqual(list((self.t / 'pstate').glob('failed-*')), [])

    def test_extract_without_a_verified_build_refuses(self):
        web = self.t / 'rel/web'; web.mkdir(parents=True); (web / '.build-commit').write_text(B + '\n')
        (self.t / 'dl').mkdir()
        r = subprocess.run(['bash', SCRIPT, '--extract', str(self.t / 'dl')], cwd=web, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('no verified prebuilt build', r.stderr)
        (web / '.build-commit').write_text('../../x\n')
        r = subprocess.run(['bash', SCRIPT, '--extract', str(self.t / 'dl')], cwd=web, capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('does not name a commit', r.stderr)
        self.assertFalse((web / '.next').exists())

    # --- dry run ------------------------------------------------------------------------------------------------------
    def test_dry_run_changes_nothing(self):
        self.publish()
        r = self.run_pull('--dry-run')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('dry run: main is ' + B, r.stdout)
        self.assertIn('node_modules reused', r.stdout)
        self.assertNotIn('.tgz', self.curl_log())
        for d in ('dl', 'pstate', 'backups'): self.assertFalse((self.t / d).exists(), d)
        self.assertFalse(self.deployed()); self.assertEqual(self.live(), A)

    def test_unknown_argument_refused(self):
        r = self.run_pull('--deploy-now')
        self.assertNotEqual(r.returncode, 0); self.assertIn('usage', r.stderr)


if __name__ == '__main__':
    unittest.main()
