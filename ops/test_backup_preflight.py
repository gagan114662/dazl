import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import backup_preflight as m


class BackupTest(unittest.TestCase):
    def setup_files(self,root):
        (root/'protected').mkdir(exist_ok=True)
        source=root/'protected/source.db';env=root/'env'
        with sqlite3.connect(source) as db:
            db.execute('CREATE TABLE synthetic(id INTEGER, value TEXT)')
            db.execute('INSERT INTO synthetic VALUES(1,?)',('SYNTHETIC_SECRET_456',))
        env.write_text(f'DB_PATH={source}\nDAZL_MASTER_KEY=SYNTHETIC_SECRET_456\nPUBLIC_BASE_URL=https://example.invalid\n');env.chmod(0o600)
        return argparse.Namespace(source=str(source),env_file=str(env),backup=str(root/'backup.db'),restore_rehearsal=str(root/'restore.db'),create_backup=False)

    def test_default_never_opens_database_or_creates_backup(self):
        with tempfile.TemporaryDirectory() as d:
            args=self.setup_files(Path(d))
            with patch.object(m,'open_readonly',side_effect=AssertionError('no DB reads in preflight')):
                self.assertEqual(m.run(args)['status'],'env_preflight_ok')
            self.assertFalse(Path(args.backup).exists())

    def test_fresh_backup_restore_private_and_source_unchanged(self):
        with tempfile.TemporaryDirectory() as d:
            args=self.setup_files(Path(d));args.create_backup=True
            before=Path(args.source).read_bytes()
            old_umask=os.umask(0)
            try:result=m.run(args)
            finally:os.umask(old_umask)
            self.assertEqual(result['status'],'backup_restore_verified')
            self.assertEqual(Path(args.source).read_bytes(),before)
            for name in [args.backup,args.restore_rehearsal]:self.assertEqual(Path(name).stat().st_mode & 0o777,0o600)
            self.assertNotIn('SYNTHETIC_SECRET_456',json.dumps(result))
            with self.assertRaises(m.LaunchError):m.run(args) # never overwrite existing files

    def test_wrong_source_and_same_destination_refused(self):
        with tempfile.TemporaryDirectory() as d:
            args=self.setup_files(Path(d));args.source=str(Path(d)/'wrong')
            with self.assertRaisesRegex(m.LaunchError,'database_identity_mismatch'):m.run(args)
        with tempfile.TemporaryDirectory() as d:
            args=self.setup_files(Path(d));args.create_backup=True;args.backup=args.source
            with self.assertRaisesRegex(m.LaunchError,'protected_output_directory_refused'):m.run(args)
            args.backup=str(Path(args.source).parent/'newbackup.db')
            with self.assertRaisesRegex(m.LaunchError,'protected_output_directory_refused'):m.run(args)

    def test_subprocess_no_secret_output_success_or_parse_failure(self):
        with tempfile.TemporaryDirectory() as d:
            args=self.setup_files(Path(d))
            command=[sys.executable,m.__file__,'--source',args.source,'--env-file',args.env_file,'--backup',args.backup,'--restore-rehearsal',args.restore_rehearsal]
            for corrupt in [False,True]:
                if corrupt:Path(args.env_file).write_text('TOKEN="SYNTHETIC_SECRET_456')
                result=subprocess.run(command,capture_output=True,text=True,timeout=10)
                self.assertNotIn('SYNTHETIC_SECRET_456',result.stdout+result.stderr)
                self.assertNotIn('Traceback',result.stdout+result.stderr)
                self.assertEqual(result.returncode,1 if corrupt else 0)


if __name__=='__main__':unittest.main()
