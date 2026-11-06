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

    def test_corrupt_source_and_reused_directory_are_refused(self):
        Path(self.db).write_bytes(b'not a database' * 100)
        self.assertEqual(run('create', '--db', self.db, '--dir', self.rp).returncode, 1)
        r = run('create', '--db', self.db, '--dir', self.rp); self.assertEqual(r.returncode, 1); self.assertIn('already exists', r.stderr)
        self.assertEqual(run('create', '--db', 'relative.db', '--dir', str(self.d / 'x')).returncode, 1)


if __name__ == '__main__': unittest.main()
