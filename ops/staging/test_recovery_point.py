"""#908: recovery_point.py on scratch databases only."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

RP = str(Path(__file__).with_name('recovery_point.py'))


def run(*a):
    return subprocess.run([sys.executable, RP, *a], capture_output=True, text=True)


def rows(db):
    c = sqlite3.connect(db)
    try: return [r[0] for r in c.execute('SELECT v FROM t ORDER BY v')]
    finally: c.close()


class RecoveryPointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.d = Path(self.tmp.name)
        self.db = str(self.d / 'app.db'); self.rp = str(self.d / 'rp')

    def tearDown(self): self.tmp.cleanup()

    def test_wal_rows_are_captured_and_restored_after_a_migration(self):
        live = sqlite3.connect(self.db); live.execute('PRAGMA journal_mode=WAL'); live.execute('CREATE TABLE t(v)'); live.execute("INSERT INTO t VALUES ('a')"); live.commit()
        live.execute("INSERT INTO t VALUES ('b')"); live.commit()   # only in the -wal file: a raw copy of app.db would miss it
        r = run('create', '--db', self.db, '--dir', self.rp, '--commit', 'old'); self.assertEqual(r.returncode, 0, r.stderr)
        live.close()
        m = sqlite3.connect(self.db); m.execute('ALTER TABLE t ADD COLUMN x'); m.execute("INSERT INTO t VALUES ('partial', 1)"); m.commit(); m.close()
        r = run('restore', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(rows(self.db), ['a', 'b'])
        c = sqlite3.connect(self.db); self.assertEqual([x[1] for x in c.execute('PRAGMA table_info(t)')], ['v']); c.close()
        self.assertEqual(json.loads((Path(self.rp) / 'manifest.json').read_text())['commit'], 'old')

    def test_absent_database_is_restored_as_absent(self):
        self.assertEqual(run('create', '--db', self.db, '--dir', self.rp).returncode, 0)
        sqlite3.connect(self.db).execute('CREATE TABLE t(v)').connection.close(); Path(self.db + '-wal').write_text('x')
        self.assertEqual(run('restore', '--db', self.db, '--dir', self.rp).returncode, 0)
        self.assertFalse(os.path.exists(self.db)); self.assertFalse(os.path.exists(self.db + '-wal'))

    def test_tampered_copy_or_other_database_is_refused(self):
        c = sqlite3.connect(self.db); c.execute('CREATE TABLE t(v)'); c.execute("INSERT INTO t VALUES ('a')"); c.commit(); c.close()
        self.assertEqual(run('create', '--db', self.db, '--dir', self.rp).returncode, 0)
        other = str(self.d / 'other.db'); sqlite3.connect(other).close()
        r = run('restore', '--db', other, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('another database', r.stderr)
        c = sqlite3.connect(Path(self.rp) / 'app.db'); c.execute("INSERT INTO t VALUES ('evil')"); c.commit(); c.close()
        before = Path(self.db).read_bytes()
        r = run('restore', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('does not match', r.stderr)
        self.assertEqual(Path(self.db).read_bytes(), before, 'a refused restore changes nothing')

    def test_orphaned_wal_shm_and_journal_beside_a_present_database_are_removed_on_restore(self):
        # The live database is in WAL mode; the recovery point is taken, then "the migration" writes post-backup rows into a
        # WAL that is never checkpointed. Its -wal/-shm are captured, the connection closes, and they are put back beside the
        # database as orphans (plus a stale hot -journal). A restore that left them there could replay or roll back pages over
        # the restored copy and silently bring post-backup rows back. They must be gone and the rows must be the backup's.
        live = sqlite3.connect(self.db); live.execute('PRAGMA journal_mode=WAL'); live.execute('CREATE TABLE t(v)'); live.execute("INSERT INTO t VALUES ('a')"); live.commit(); live.close()
        r = run('create', '--db', self.db, '--dir', self.rp, '--commit', 'old'); self.assertEqual(r.returncode, 0, r.stderr)
        m = sqlite3.connect(self.db); m.execute('PRAGMA wal_autocheckpoint=0'); m.execute("INSERT INTO t VALUES ('post-backup')"); m.commit()
        wal, shm = Path(self.db + '-wal').read_bytes(), Path(self.db + '-shm').read_bytes()
        self.assertGreater(len(wal), 0, 'the fixture really has WAL frames to orphan')
        m.close()
        Path(self.db + '-wal').write_bytes(wal); Path(self.db + '-shm').write_bytes(shm)
        Path(self.db + '-journal').write_bytes(b'stale hot journal from an interrupted write' * 64)
        r = run('restore', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 0, r.stderr)
        for side in ('-wal', '-shm', '-journal'):
            self.assertFalse(os.path.exists(self.db + side), f'stale {side} removed before the restored copy is used')
        self.assertEqual(rows(self.db), ['a'])
        c = sqlite3.connect(self.db); self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok'); c.close()

    def test_corrupt_source_and_reused_directory_are_refused(self):
        Path(self.db).write_bytes(b'not a database' * 100)
        self.assertEqual(run('create', '--db', self.db, '--dir', self.rp).returncode, 1)
        r = run('create', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('already exists', r.stderr)
        self.assertEqual(run('create', '--db', 'relative.db', '--dir', str(self.d / 'x')).returncode, 1)


if __name__ == '__main__': unittest.main()
