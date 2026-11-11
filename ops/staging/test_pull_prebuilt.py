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
out=; url=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2;; --max-time|--max-filesize|--proto|--retry) shift 2;; -*) shift;; *) url=$1; shift;; esac
done
echo "$url" >> "$FAKE_T/curl.log"
f="$FAKE_T/assets/${url##*/}"
[ -f "$f" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$f" "$out"
'''
FAKE_LOG = r'''#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_T/migrate.log"
'''
# deploy.sh's interface. MARKER is replaced by "STAGING_MIGRATE" for the current deploy.sh (migrate is its own step)
FAKE_DEPLOY = r'''#!/usr/bin/env bash
# MARKER
set -euo pipefail
T=$FAKE_T
printf '%s' "$STAGING_BUILD" > "$T/build-cmd"
[ ! -e "$T/deploy-fail" ] || exit 3
new=$(cat "$T/deploy-main" 2>/dev/null || cat "$T/main")
cur=$(cat "$T/root/current-sha" 2>/dev/null || true)
[ "$new" != "$cur" ] || exit 0
rel="$T/root/releases/$new"; rm -rf "$rel"; mkdir -p "$rel/web"
cp "$T/lockfile" "$rel/web/package-lock.json"
live=; [ -L "$T/root/current" ] && live=$(readlink -f "$T/root/current")
if [ -n "$live" ] && [ -d "$live/web/node_modules" ] && cmp -s "$live/web/package-lock.json" "$T/lockfile"; then cp -al "$live/web/node_modules" "$rel/web/node_modules"; fi
if ! bash -c "cd '$rel/web' && echo '$new' > .build-commit && $STAGING_BUILD"; then rm -rf "$rel"; echo "fake deploy: build of $new failed" >&2; exit 1; fi
ln -sfn "$rel" "$T/root/current"; echo "$new" > "$T/root/current-sha"
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
        for d in ('bin', 'assets', 'root/releases', 'data'): (T / d).mkdir(parents=True)
        for name, body in (('git', FAKE_GIT), ('curl', FAKE_CURL), ('npm', FAKE_LOG), ('node', FAKE_LOG)):
            (T / 'bin' / name).write_text(body); (T / 'bin' / name).chmod(0o755)
        self.deploy(new_style=True)
        # the live release: commit A, lockfile LOCK1, its node_modules
        live = T / 'root/releases' / A / 'web'
        (live / 'node_modules/next').mkdir(parents=True)
        (live / 'node_modules/next/package.json').write_text('{}')
        (live / 'package-lock.json').write_bytes(LOCK1)
        os.symlink(T / 'root/releases' / A, T / 'root/current')
        (T / 'root/current-sha').write_text(A + '\n')
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
        (self.t / 'deploy.sh').write_text(body)

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
             'STAGING_ROOT': str(T / 'root'), 'STAGING_ENV_FILE': str(T / 'env'), 'STAGING_DEPLOY_SH': str(T / 'deploy.sh'),
             'STAGING_PREBUILT_DIR': str(T / 'dl'), 'STAGING_PREBUILT_STATE': str(T / 'pstate'),
             'STAGING_BACKUP_DIR': str(T / 'backups'), 'STAGING_CURRENT_SHA_FILES': str(T / 'root/current-sha'),
             'MIN_FREE_BYTES': '0', 'DISK_RESERVE_BYTES': '0', 'STAGING_NODE_ARCH': 'arm64', 'STAGING_NODE_ABI': '127'}
        e.update({k: str(v) for k, v in env.items()})
        return subprocess.run(['bash', SCRIPT, *args], env=e, capture_output=True, text=True, timeout=60)

    def curl_log(self):
        p = self.t / 'curl.log'
        return p.read_text() if p.exists() else ''

    def live(self):
        return (self.t / 'root/current-sha').read_text().strip()

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

    def test_lockfile_changed_ships_node_modules_and_old_deploy_migrates_in_the_build(self):
        self.deploy(new_style=False)
        (self.t / 'lockfile').write_bytes(LOCK2); self.publish(lock=LOCK2)
        r = self.run_pull()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.live(), B)
        self.assertIn(f'staging-modules-{B}.tgz', self.curl_log())
        self.assertEqual((self.t / 'root/releases' / B / 'web/node_modules/next/package.json').read_text(), '{"name":"next"}')
        self.assertIn('db:migrate', (self.t / 'build-cmd').read_text())
        mig = (self.t / 'migrate.log').read_text()
        self.assertIn('npm run -s db:migrate', mig); self.assertIn('scripts/staging-seed.mts', mig)

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

    def test_download_that_does_not_match_the_manifest_is_refused(self):
        nxt, _ = self.publish()
        data = bytearray(nxt.read_bytes()); data[len(data) // 2] ^= 0xFF; nxt.write_bytes(bytes(data))  # same size, other bytes
        self.assert_refused(self.run_pull(), "does not match the manifest's sha256")
        self.assertFalse(any(p.name.endswith('.part') for p in (self.t / 'dl').iterdir()))
        nxt.write_bytes(nxt.read_bytes() + b'x')  # other size
        self.assert_refused(self.run_pull(), 'is not the .* bytes the manifest records')

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
