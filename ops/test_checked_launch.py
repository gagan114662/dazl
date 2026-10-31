import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import importlib.util
spec=importlib.util.spec_from_file_location("checked",Path(__file__).with_name("checked_launch.py")); checked=importlib.util.module_from_spec(spec);spec.loader.exec_module(checked)

SCRIPT = str(Path(__file__).with_name('checked_launch.py'))


class CheckedLaunchTests(unittest.TestCase):
    def test_failed_missing_or_timed_out_preflight_never_reaches_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / 'launched'
            later = Path(tmp) / 'later-preflight'
            launch = [sys.executable, '-c', 'from pathlib import Path; Path(__import__("sys").argv[1]).touch()', str(sentinel)]
            second = [sys.executable, '-c', 'from pathlib import Path; Path(__import__("sys").argv[1]).touch()', str(later)]
            for first in [[sys.executable, '-c', 'raise SystemExit(23)'], ['/nonexistent/preflight'], [sys.executable, '-c', 'import time; time.sleep(5)']]:
                with patch.object(checked, 'require_ci'), patch.object(checked, 'bind_launch'):
                    report, code = checked.run([first,second],launch,timeout=0.2)
                p = subprocess.CompletedProcess([],code,json.dumps(report))
                self.assertEqual(p.returncode, 1, p.stdout)
                self.assertFalse(json.loads(p.stdout)['launch_reached'])
                self.assertFalse(sentinel.exists())
                self.assertFalse(later.exists())

    def test_success_reaches_launch_once_and_failed_launch_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'count'
            launch = [sys.executable, '-c', 'from pathlib import Path; p=Path(__import__("sys").argv[1]); p.write_text(p.read_text()+"x" if p.exists() else "x")', str(target)]
            good = [sys.executable, '-c', 'pass']
            with patch.object(checked,'require_ci'), patch.object(checked,'bind_launch'):
                report,code=checked.run([good,good],launch)
            p=subprocess.CompletedProcess([],code,json.dumps(report))
            self.assertEqual(p.returncode, 0)
            self.assertEqual(target.read_text(), 'x')
            with patch.object(checked,'require_ci'), patch.object(checked,'bind_launch'):
                report,code=checked.run([good],[sys.executable,'-c','raise SystemExit(3)'])
            p=subprocess.CompletedProcess([],code,json.dumps(report))
            self.assertEqual(p.returncode, 1)
            self.assertTrue(json.loads(p.stdout)['launch_reached'])


if __name__ == '__main__':
    unittest.main()
