"""#907: contain.py stops every descendant, including ones that left the session, on normal exit, failure and abort."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

C = str(Path(__file__).with_name('contain.py'))
# a writer that leaves the session (setsid), ignores TERM, and whose parent exits at once
ESCAPE = 'setsid bash -c "trap \'\' TERM; while true; do echo x >> {out}; sleep 0.05; done" & sleep 0.3; {tail}'


def growing(out):
    try: a = Path(out).stat().st_size
    except FileNotFoundError: return False
    time.sleep(0.4)
    return Path(out).stat().st_size != a


class ContainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.out = os.path.join(self.tmp.name, 'out')

    def tearDown(self):
        subprocess.run(['pkill', '-KILL', '-f', self.out]); self.tmp.cleanup()

    def run_c(self, tail, **kw):
        return subprocess.run([sys.executable, C, '--grace', '0.5', '--kill-wait', '2', '--', 'bash', '-c', ESCAPE.format(out=self.out, tail=tail)], **kw)

    def test_normal_exit_and_failure_leave_no_descendant(self):
        for tail, code in [('exit 0', 0), ('exit 3', 3)]:
            r = self.run_c(tail); self.assertEqual(r.returncode, code)
            self.assertFalse(growing(self.out), tail)

    def test_abort_stops_the_whole_tree_and_reports_the_signal(self):
        p = subprocess.Popen([sys.executable, C, '--grace', '0.5', '--kill-wait', '2', '--', 'bash', '-c', ESCAPE.format(out=self.out, tail='sleep 30')])
        time.sleep(0.8); self.assertTrue(growing(self.out))
        p.send_signal(signal.SIGTERM); self.assertEqual(p.wait(10), 143)
        self.assertFalse(growing(self.out))

    def test_usage(self):
        self.assertEqual(subprocess.run([sys.executable, C, '--nope']).returncode, 2)
        self.assertEqual(subprocess.run([sys.executable, C]).returncode, 2)


if __name__ == '__main__': unittest.main()
