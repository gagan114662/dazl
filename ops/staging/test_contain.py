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


class StartupAbortStatusTest(unittest.TestCase):
    """#907 review: a signal that lands while the build command is still starting must keep the blocked status when
    cleanup cannot confirm every descendant is gone (deploy.sh only refuses to delete the release for status 125).
    Isolated and deterministic: no process is spawned or signalled, prctl/Popen/contain are replaced in-process."""

    def run_main(self, cleanup_ok):
        import contextlib, importlib.util, io
        from unittest import mock
        spec = importlib.util.spec_from_file_location('contain_under_test', C); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        handlers = {}
        def fake_popen(*_a, **_k):                       # the signal arrives during Popen: run the handler main() installed
            handlers[signal.SIGTERM](signal.SIGTERM, None)
        libc = mock.Mock(); libc.prctl.return_value = 0
        err = io.StringIO()
        with mock.patch.object(mod.ctypes, 'CDLL', return_value=libc), \
             mock.patch.object(mod.signal, 'signal', side_effect=lambda s, h: handlers.__setitem__(s, h)), \
             mock.patch.object(mod.subprocess, 'Popen', side_effect=fake_popen), \
             mock.patch.object(mod, 'contain', return_value=cleanup_ok) as cleanup, \
             mock.patch.object(mod, 'descendants', return_value={4242}), \
             mock.patch.object(mod, 'alive', return_value=[] if cleanup_ok else [4242]), \
             contextlib.redirect_stderr(err):
            status = mod.main(['--grace', '0.1', '--kill-wait', '0.1', '--', 'true'])
        return status, cleanup.call_count, err.getvalue(), mod.BLOCKED

    def test_blocked_cleanup_after_startup_abort_returns_blocked_not_the_signal_status(self):
        status, cleanups, err, blocked = self.run_main(cleanup_ok=False)
        self.assertEqual(cleanups, 1)
        self.assertEqual(status, blocked); self.assertEqual(status, 125, 'deploy.sh treats every other status as cleanup-safe')
        self.assertIn('cleanup BLOCKED', err); self.assertIn('4242', err, 'the surviving descendant is named for the operator')

    def test_confirmed_cleanup_after_startup_abort_keeps_the_signal_status(self):
        status, cleanups, err, _ = self.run_main(cleanup_ok=True)
        self.assertEqual((status, cleanups), (128 + signal.SIGTERM, 1)); self.assertEqual(status, 143)
        self.assertNotIn('BLOCKED', err)


class RepeatedAbortTest(unittest.TestCase):
    """#907 review: once cleanup has started, a second (third...) TERM/INT/HUP must not raise out of it. Cleanup has to reach
    its result - blocked 125 when exit cannot be confirmed - whatever signals keep arriving. Fully mocked: no process is
    spawned and no real signal is sent; the installed handlers are called directly, the way the interpreter would."""

    def run_main(self, cleanup_ok, startup):
        import contextlib, importlib.util, io
        from unittest import mock
        spec = importlib.util.spec_from_file_location('contain_repeat', C); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        handlers, events = {}, []
        def fire(sig):                                   # a signal arriving now: whatever handler is installed right now runs
            handlers[sig](sig, None)
        def fake_signal(sig, handler): handlers[sig] = handler; events.append(('handler', sig))
        def fake_mask(how, sigs): events.append(('mask', how))
        def fake_popen(*_a, **_k):
            fire(signal.SIGTERM)                          # startup abort: raises out of Popen
        def fake_waitpid(*_a, **_k):
            fire(signal.SIGTERM)                          # abort while waiting for a running build: raises out of waitpid
        def fake_contain(grace, kill_wait):
            events.append(('contain', None))
            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
                fire(sig)                                 # repeated signals DURING cleanup must not raise
            return cleanup_ok
        libc = mock.Mock(); libc.prctl.return_value = 0
        child = mock.Mock(pid=4321)
        err = io.StringIO()
        with mock.patch.object(mod.ctypes, 'CDLL', return_value=libc), \
             mock.patch.object(mod.signal, 'signal', side_effect=fake_signal), \
             mock.patch.object(mod.signal, 'pthread_sigmask', side_effect=fake_mask), \
             mock.patch.object(mod.subprocess, 'Popen', side_effect=fake_popen if startup else (lambda *a, **k: child)), \
             mock.patch.object(mod.os, 'waitpid', side_effect=fake_waitpid), \
             mock.patch.object(mod, 'contain', side_effect=fake_contain), \
             mock.patch.object(mod, 'descendants', return_value={4242}), \
             mock.patch.object(mod, 'alive', return_value=[] if cleanup_ok else [4242]), \
             contextlib.redirect_stderr(err):
            status = mod.main(['--grace', '0.1', '--kill-wait', '0.1', '--', 'true'])   # an escaped Abort would fail the test here
        return status, events, err.getvalue()

    def check(self, startup):
        status, events, err = self.run_main(cleanup_ok=False, startup=startup)
        self.assertEqual(status, 125, 'repeated signals during cleanup must not replace the blocked status')
        self.assertIn('cleanup BLOCKED', err); self.assertIn('4242', err)
        kinds = [e[0] for e in events]
        self.assertLess(kinds.index('mask'), kinds.index('contain'), 'abort signals are blocked before cleanup starts')
        status, events, err = self.run_main(cleanup_ok=True, startup=startup)
        self.assertEqual(status, 143, 'with cleanup confirmed, the first signal status is kept despite the repeats')
        self.assertNotIn('BLOCKED', err)

    def test_repeated_abort_during_startup_cleanup_still_returns_blocked_125(self): self.check(startup=True)

    def test_repeated_abort_during_normal_cleanup_still_returns_blocked_125(self): self.check(startup=False)


if __name__ == '__main__': unittest.main()
