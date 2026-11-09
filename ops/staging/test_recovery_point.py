"""#908: recovery_point.py on scratch databases only."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

RP = str(Path(__file__).with_name('recovery_point.py'))


def run(*a, env=None):
    return subprocess.run([sys.executable, RP, *a], capture_output=True, text=True, env={**os.environ, **(env or {})})


def load():
    spec = importlib.util.spec_from_file_location('recovery_point_under_test', RP)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def rows(db):
    c = sqlite3.connect(db)
    try: return [r[0] for r in c.execute('SELECT v FROM t ORDER BY v')]
    finally: c.close()


class RecoveryPointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = Path(self.tmp.name)
        self.db = str(self.d / 'app.db'); self.rp = str(self.d / 'rp')

    def tearDown(self):
        for p in self.d.rglob('*'):   # read-only recovery points: make them removable
            if p.is_dir() and not p.is_symlink(): p.chmod(0o700)
        self.d.chmod(0o700)
        self.tmp.cleanup()

    def make_db(self, *vals, wal=False):
        c = sqlite3.connect(self.db)
        if wal: c.execute('PRAGMA journal_mode=WAL')
        c.execute('CREATE TABLE IF NOT EXISTS t(v)')
        for v in vals: c.execute('INSERT INTO t VALUES (?)', (v,))
        c.commit(); c.close()

    def create(self, rp=None, db=None):
        r = run('create', '--db', db or self.db, '--dir', rp or self.rp, '--commit', 'old')
        self.assertEqual(r.returncode, 0, r.stderr)
        sha = r.stdout.strip(); self.assertRegex(sha, r'^[0-9a-f]{64}$', 'create prints the manifest sha256 and nothing else')
        return sha

    def restore(self, sha=None, env=None, rp=None):
        return run('restore', '--db', self.db, '--dir', rp or self.rp, *(['--expect-manifest', sha] if sha else []), env=env)

    def leftovers(self):
        return sorted(p for p in os.listdir(self.d) if p.startswith('.app.db') or p.startswith('app.db-') or p.startswith('app.db.'))

    # --- the original behavior ---------------------------------------------------------------------------------------
    def test_wal_rows_are_captured_and_restored_after_a_migration(self):
        live = sqlite3.connect(self.db); live.execute('PRAGMA journal_mode=WAL'); live.execute('CREATE TABLE t(v)'); live.execute("INSERT INTO t VALUES ('a')"); live.commit()
        live.execute("INSERT INTO t VALUES ('b')"); live.commit()   # only in the -wal file: a raw copy of app.db would miss it
        sha = self.create()
        live.close()
        m = sqlite3.connect(self.db); m.execute('ALTER TABLE t ADD COLUMN x'); m.execute("INSERT INTO t VALUES ('partial', 1)"); m.commit(); m.close()
        r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(rows(self.db), ['a', 'b'])
        c = sqlite3.connect(self.db); self.assertEqual([x[1] for x in c.execute('PRAGMA table_info(t)')], ['v']); c.close()
        self.assertEqual(json.loads((Path(self.rp) / 'manifest.json').read_text())['commit'], 'old')
        for f in ('manifest.json', 'app.db'):
            self.assertEqual(stat.S_IMODE((Path(self.rp) / f).stat().st_mode), 0o400, f'{f} is read-only and private')
        self.assertEqual(stat.S_IMODE(Path(self.rp).stat().st_mode), 0o700)

    def test_absent_database_is_restored_as_absent(self):
        sha = self.create()
        sqlite3.connect(self.db).execute('CREATE TABLE t(v)').connection.close(); Path(self.db + '-wal').write_text('x')
        self.assertEqual(self.restore(sha).returncode, 0)
        self.assertFalse(os.path.exists(self.db)); self.assertFalse(os.path.exists(self.db + '-wal'))
        self.assertEqual(self.leftovers(), [])

    def test_tampered_copy_or_other_database_is_refused(self):
        self.make_db('a')
        sha = self.create()
        other = str(self.d / 'other.db'); sqlite3.connect(other).close()
        r = run('restore', '--db', other, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('another database', r.stderr)
        copy = Path(self.rp) / 'app.db'
        copy.chmod(0o600); c = sqlite3.connect(copy); c.execute("INSERT INTO t VALUES ('evil')"); c.commit(); c.close()
        before = Path(self.db).read_bytes()
        r = self.restore(); self.assertEqual(r.returncode, 1); self.assertIn('modified or replaced', r.stderr, 'a writable copy is refused')
        copy.chmod(0o400)
        r = self.restore(); self.assertEqual(r.returncode, 1); self.assertIn('does not match', r.stderr)
        r = self.restore(sha); self.assertEqual(r.returncode, 1)
        self.assertEqual(Path(self.db).read_bytes(), before, 'a refused restore changes nothing')

    def test_orphaned_wal_shm_and_journal_beside_a_present_database_are_removed_on_restore(self):
        # The live database is in WAL mode; the recovery point is taken, then "the migration" writes post-backup rows into a
        # WAL that is never checkpointed. Its -wal/-shm are captured, the connection closes, and they are put back beside the
        # database as orphans (plus a stale hot -journal). A restore that left them there could replay or roll back pages over
        # the restored copy and silently bring post-backup rows back. They must be gone and the rows must be the backup's.
        sha = self.orphan_fixture()
        r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr)
        for side in ('-wal', '-shm', '-journal'):
            self.assertFalse(os.path.exists(self.db + side), f'stale {side} removed before the restored copy is used')
        self.assertEqual(rows(self.db), ['a'])
        c = sqlite3.connect(self.db); self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok'); c.close()
        self.assertEqual(self.leftovers(), [], 'no quarantined sidecar or temporary left behind')

    def orphan_fixture(self):
        live = sqlite3.connect(self.db); live.execute('PRAGMA journal_mode=WAL'); live.execute('CREATE TABLE t(v)'); live.execute("INSERT INTO t VALUES ('a')"); live.commit(); live.close()
        sha = self.create()
        m = sqlite3.connect(self.db); m.execute('PRAGMA wal_autocheckpoint=0'); m.execute("INSERT INTO t VALUES ('post-backup')"); m.commit()
        wal, shm = Path(self.db + '-wal').read_bytes(), Path(self.db + '-shm').read_bytes()
        self.assertGreater(len(wal), 0, 'the fixture really has WAL frames to orphan')
        m.close()
        Path(self.db + '-wal').write_bytes(wal); Path(self.db + '-shm').write_bytes(shm)
        Path(self.db + '-journal').write_bytes(b'stale hot journal from an interrupted write' * 64)
        self.wal = wal
        return sha

    def test_corrupt_source_and_reused_directory_are_refused(self):
        Path(self.db).write_bytes(b'not a database' * 100)
        self.assertEqual(run('create', '--db', self.db, '--dir', self.rp).returncode, 1)
        r = run('create', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('already exists', r.stderr)
        self.assertEqual(run('create', '--db', 'relative.db', '--dir', str(self.d / 'x')).returncode, 1)

    # --- review: symlinks in the service account's database directory (xhawk 1) ----------------------------------------
    def test_restore_never_writes_through_a_symlink_planted_in_the_database_directory(self):
        victim = self.d / 'victim'; victim.write_text('root-owned file'); victim.chmod(0o640)
        self.make_db('a')
        sha = self.create()
        self.make_db('migrated')
        # the old predictable temporary name, and a symlinked sidecar, both pointing at the victim
        os.symlink(victim, self.db + '.restore'); os.symlink(victim, self.db + '-wal')
        r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(victim.read_text(), 'root-owned file'); self.assertEqual(stat.S_IMODE(victim.stat().st_mode), 0o640)
        self.assertEqual(rows(self.db), ['a']); self.assertFalse(os.path.lexists(self.db + '-wal'))
        # DB_PATH itself swapped for a symlink to the victim after the recovery point: rename replaces the link, never the target
        os.unlink(self.db); os.symlink(victim, self.db)
        r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(victim.read_text(), 'root-owned file')
        self.assertTrue(stat.S_ISREG(os.lstat(self.db).st_mode)); self.assertEqual(rows(self.db), ['a'])

    def test_the_restore_temporary_is_created_exclusively_without_following_a_symlink(self):
        # even if the "unpredictable" name were guessed and pre-planted as a symlink, the root restore must refuse, not follow it
        victim = self.d / 'victim'; victim.write_text('root-owned file')
        self.make_db('a'); sha = self.create(); self.make_db('migrated')
        rp = load()
        with mock.patch.object(rp.secrets, 'token_hex', side_effect=lambda n: 'f' * (2 * n)):
            os.symlink(victim, self.d / ('.app.db.restore-' + 'f' * 16 + '-' + 'f' * 8))
            with self.assertRaises((SystemExit, FileExistsError)):
                rp.restore(self.db, self.rp, sha)
        self.assertEqual(victim.read_text(), 'root-owned file', 'nothing written through the planted link')
        self.assertEqual(sorted(rows(self.db)), ['a', 'migrated'], 'the database is untouched by a refused restore')

    def test_create_refuses_a_symlinked_database(self):
        other = str(self.d / 'elsewhere.db'); c = sqlite3.connect(other); c.execute('CREATE TABLE t(v)'); c.commit(); c.close()
        os.symlink(other, self.db)
        r = run('create', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('not a regular file', r.stderr)

    # --- review: a replaceable recovery point (xhawk 2) ------------------------------------------------------------------
    def test_a_swapped_or_loosened_recovery_point_is_refused(self):
        self.make_db('a'); sha = self.create()
        self.make_db('migrated')
        forged = str(self.d / 'forged'); self.create(rp=forged)            # a valid-looking recovery point of the migrated state
        os.rename(self.rp, str(self.d / 'original')); os.rename(forged, self.rp)
        self.assertEqual(self.restore().returncode, 0, 'without the recorded manifest checksum the forgery would pass')
        self.make_db('migrated-again')
        r = self.restore(sha); self.assertEqual(r.returncode, 1); self.assertIn('was replaced', r.stderr)
        self.assertEqual(sorted(rows(self.db)), ['a', 'migrated', 'migrated-again'], 'nothing restored from a swapped recovery point')
        os.rename(self.rp, forged); os.rename(str(self.d / 'original'), self.rp)
        # a symlink in place of the recovery point directory
        os.rename(self.rp, str(self.d / 'original')); os.symlink(str(self.d / 'original'), self.rp)
        r = self.restore(sha); self.assertEqual(r.returncode, 1); self.assertIn('symlink', r.stderr)
        os.unlink(self.rp); os.rename(str(self.d / 'original'), self.rp)
        # loosened permissions on the recovery point, or on its root
        Path(self.rp).chmod(0o755); r = self.restore(sha); self.assertEqual(r.returncode, 1); self.assertIn('not private', r.stderr)
        Path(self.rp).chmod(0o700)
        self.d.chmod(0o770); r = self.restore(sha); self.assertEqual(r.returncode, 1); self.assertIn('writable by other users', r.stderr)
        self.d.chmod(0o750); r = self.restore(sha); self.assertEqual(r.returncode, 1); self.assertIn('not private', r.stderr)
        self.d.chmod(0o700)
        r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr); self.assertEqual(rows(self.db), ['a'])

    def test_the_recovery_root_must_be_private_and_not_under_a_directory_others_can_write(self):
        pub = self.d / 'pub'; pub.mkdir(); pub.chmod(0o777)              # world-writable, no sticky bit: others could rename
        (pub / 'root').mkdir(mode=0o700)
        self.make_db('a')
        r = run('create', '--db', self.db, '--dir', str(pub / 'root' / 'rp')); self.assertEqual(r.returncode, 1)
        self.assertIn('writable by other users', r.stderr)
        self.assertFalse((pub / 'root' / 'rp').exists(), 'nothing created under an unsafe root')
        pub.chmod(0o755); (pub / 'root').chmod(0o755)
        r = run('check-root', '--dir', str(pub / 'root')); self.assertEqual(r.returncode, 1); self.assertIn('not private', r.stderr)
        (pub / 'root').chmod(0o700)
        self.assertEqual(run('check-root', '--dir', str(pub / 'root')).returncode, 0)

    # --- review: crash durability (xhawk 7) ------------------------------------------------------------------------------
    def test_create_and_restore_fsync_the_files_and_their_directories(self):
        rp = load(); synced = []
        real = os.fsync
        def rec(fd):
            synced.append(os.path.realpath(f'/proc/self/fd/{fd}') if os.path.exists(f'/proc/self/fd/{fd}') else fd); real(fd)
        self.make_db('a')
        with mock.patch.object(rp.os, 'fsync', side_effect=rec), mock.patch('builtins.print'):
            with mock.patch.object(sys, 'stderr'):
                rp.create(self.db, self.rp, 'old')
        root, rpd = str(self.d.resolve()), str(Path(self.rp).resolve())
        for want in (rpd + '/app.db', rpd + '/manifest.json', rpd, root):
            self.assertIn(want, synced, f'create fsyncs {want}')
        sha = __import__('hashlib').sha256((Path(self.rp) / 'manifest.json').read_bytes()).hexdigest()
        self.make_db('migrated'); synced.clear()
        with mock.patch.object(rp.os, 'fsync', side_effect=rec), mock.patch.object(sys, 'stderr'):
            rp.restore(self.db, self.rp, sha)
        self.assertGreaterEqual(synced.count(root), 3, 'the database directory is fsynced after quarantine, install and cleanup')
        self.assertIn(rpd, synced, 'the restore state is durable')
        self.assertEqual(rows(self.db), ['a'])

    # --- review: an interrupted restore (xhawk 8) ------------------------------------------------------------------------
    def test_a_restore_killed_at_any_phase_finishes_on_rerun_and_never_loses_wal_state_first(self):
        for phase in ('quarantined', 'copied', 'installed'):
            with self.subTest(phase=phase):
                self.tearDown(); self.setUp()
                sha = self.orphan_fixture()
                r = self.restore(sha, env={'RECOVERY_POINT_TEST_CRASH_AT': phase})
                self.assertEqual(r.returncode, 86, r.stderr)
                self.assertTrue((Path(self.rp) / 'restore-state.json').exists(), 'the in-progress state is on disk')
                if phase in ('quarantined', 'copied'):
                    q = [p for p in os.listdir(self.d) if p.startswith('.app.db-wal.quarantine-')]
                    self.assertEqual(len(q), 1, 'the WAL was moved aside, not deleted, before the copy was installed')
                    self.assertEqual((self.d / q[0]).read_bytes(), self.wal)
                    self.assertTrue(os.path.exists(self.db), 'the main file is still there until the copy replaces it')
                r = self.restore(sha); self.assertEqual(r.returncode, 0, r.stderr); self.assertIn('finishing an interrupted restore', r.stderr)
                self.assertEqual(rows(self.db), ['a'])
                c = sqlite3.connect(self.db); self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok'); c.close()
                self.assertEqual(self.leftovers(), [], 'no sidecar, quarantine or temporary left')
                self.assertFalse((Path(self.rp) / 'restore-state.json').exists())

    def test_an_interrupted_restore_to_absent_finishes_on_rerun(self):
        sha = self.create()
        self.make_db('created-by-failed-first-release', wal=True); Path(self.db + '-wal').write_bytes(b'x' * 100)
        self.assertEqual(self.restore(sha, env={'RECOVERY_POINT_TEST_CRASH_AT': 'quarantined'}).returncode, 86)
        self.assertEqual(self.restore(sha).returncode, 0)
        self.assertFalse(os.path.exists(self.db)); self.assertEqual(self.leftovers(), [])


if __name__ == '__main__': unittest.main()
