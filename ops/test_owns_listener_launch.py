"""#621: owns_listener skips fds that vanish mid-enumeration, still refuses on
genuine unreadability, and keeps the original failure's step/class/errno."""
import contextlib
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import safe_launch as m

spec = importlib.util.spec_from_file_location('checked_621', Path(__file__).with_name('checked_launch.py'))
checked = importlib.util.module_from_spec(spec); spec.loader.exec_module(checked)

LINUX_PROC = Path('/proc/self/fd').is_dir() and Path('/proc/net/tcp').is_file()
INODE = 4242
TCP = ('  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
       '   0: 0100007F:0C1C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 %d\n' % INODE)

# Listens on an ephemeral loopback port and, when asked, churns many fds
# (open/close) as fast as it can, like a serving process draining connections.
CHILD = ('import os,socket,sys\n'
         's=socket.socket(); s.bind(("127.0.0.1",0)); s.listen()\n'
         'print(s.getsockname()[1], flush=True)\n'
         'if sys.argv[1]=="churn":\n'
         '    while True:\n'
         '        fds=[os.open("/dev/null",os.O_RDONLY) for _ in range(128)]\n'
         '        for fd in fds: os.close(fd)\n'
         'else:\n'
         '    sys.stdin.read()\n')


def fake_proc(links, listing=None, tables=None):
    """Patch /proc reads: links maps fd name -> link text or an exception."""
    listing = listing if listing is not None else [list(links)]
    calls = {'listdir': 0}

    def listdir(path):
        assert path.startswith('/proc/') and path.endswith('/fd'), path
        result = listing[min(calls['listdir'], len(listing) - 1)]
        calls['listdir'] += 1
        if isinstance(result, BaseException):
            raise result
        return list(result)

    def readlink(path):
        value = links[path.rsplit('/', 1)[1]]
        if isinstance(value, BaseException):
            raise value
        return value

    def read_text(self, *args, **kwargs):
        value = (tables or {}).get(str(self), TCP if str(self) == '/proc/net/tcp' else '  sl\n')
        if isinstance(value, BaseException):
            raise value
        return value

    stack = contextlib.ExitStack()
    stack.enter_context(patch.object(m.os, 'listdir', side_effect=listdir))
    stack.enter_context(patch.object(m.os, 'readlink', side_effect=readlink))
    stack.enter_context(patch.object(m.Path, 'read_text', read_text))
    return stack, calls


def vanished():
    return FileNotFoundError(errno.ENOENT, 'No such file or directory', '/proc/1/fd/9')


class OwnsListenerUnitTests(unittest.TestCase):
    """Deterministic /proc stand-ins: run on every host."""

    def refusal(self, **kwargs):
        stack, _ = fake_proc(**kwargs)
        with stack, self.assertRaises(m.LaunchError) as raised:
            m.owns_listener(1234, 3100)
        self.assertEqual(str(raised.exception), 'listener_identity_unverifiable')
        return raised.exception.cause

    def test_vanished_fd_is_skipped_and_listener_still_found(self):
        stack, calls = fake_proc({'0': '/dev/null', '9': vanished(), '17': 'socket:[%d]' % INODE})
        with stack:
            self.assertTrue(m.owns_listener(1234, 3100))
        self.assertEqual(calls['listdir'], 2)  # re-listed after a vanish

    def test_quiet_enumeration_lists_once(self):
        stack, calls = fake_proc({'0': '/dev/null', '17': 'socket:[%d]' % INODE})
        with stack:
            self.assertTrue(m.owns_listener(1234, 3100))
        self.assertEqual(calls['listdir'], 1)

    def test_vanished_fds_never_make_a_foreign_listener_owned(self):
        # Fail-closed unchanged: skipping a vanished fd can only remove candidates.
        stack, _ = fake_proc({'9': vanished(), '17': 'socket:[999]'})
        with stack:
            self.assertFalse(m.owns_listener(1234, 3100))

    def test_process_gone_at_listing_refuses_with_cause(self):
        cause = self.refusal(links={}, listing=[FileNotFoundError(errno.ENOENT, 'gone', '/proc/1234/fd')])
        self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': errno.ENOENT})

    def test_process_gone_during_enumeration_refuses(self):
        # Every readlink vanished and the fd directory is gone afterwards.
        cause = self.refusal(links={'0': vanished(), '17': vanished()},
                             listing=[['0', '17'], FileNotFoundError(errno.ENOENT, 'gone', '/proc/1234/fd')])
        self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': errno.ENOENT})

    def test_permission_denied_still_refuses(self):
        cause = self.refusal(links={}, listing=[PermissionError(errno.EACCES, 'denied', '/proc/1/fd')])
        self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': 'PermissionError', 'errno': errno.EACCES})
        cause = self.refusal(links={'3': PermissionError(errno.EACCES, 'denied', '/proc/1/fd/3')})
        self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': 'PermissionError', 'errno': errno.EACCES})

    def test_other_readlink_errors_are_not_skipped(self):
        cause = self.refusal(links={'3': OSError(errno.ESRCH, 'no such process')})
        self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': 'ProcessLookupError', 'errno': errno.ESRCH})

    def test_tcp_table_failures_name_their_step(self):
        cause = self.refusal(links={'17': 'socket:[%d]' % INODE}, tables={'/proc/net/tcp': PermissionError(errno.EACCES, 'denied')})
        self.assertEqual(cause, {'step': 'tcp_table', 'exception': 'PermissionError', 'errno': errno.EACCES})
        cause = self.refusal(links={'17': 'socket:[%d]' % INODE}, tables={'/proc/net/tcp': 'header\nshort row\n'})
        self.assertEqual(cause, {'step': 'tcp_table', 'exception': 'IndexError', 'errno': None})

    def test_cause_never_carries_message_or_path(self):
        cause = m.failure_cause('tcp_table', PermissionError(errno.EACCES, 'SYNTHETIC_SECRET_621', '/secret/path'))
        self.assertNotIn('SYNTHETIC_SECRET_621', json.dumps(cause)); self.assertNotIn('/secret', json.dumps(cause))
        class Custom(Exception):
            errno = 'SYNTHETIC_SECRET_621'
        self.assertEqual(m.failure_cause('tcp_table', Custom()), {'step': 'tcp_table', 'exception': 'unrecognised', 'errno': None})


class CauseRecordTests(unittest.TestCase):
    """The cause reaches safe_launch's status file and checked_launch's log entry."""

    def test_status_file_carries_cause_and_keeps_the_status_code(self):
        cause = m.failure_cause('fd_enumeration', PermissionError(errno.EACCES, 'SYNTHETIC_SECRET_621'))
        with tempfile.TemporaryDirectory() as d:
            status = Path(d) / 'status.json'
            argv = ['safe_launch.py', '--stage', '/new', '--commit', 'a' * 40, '--rollback-stage', '/old',
                    '--rollback-commit', 'b' * 40, '--env-file', '/env', '--pid', '4321', '--backup', '/b',
                    '--backup-db', '/db', '--backup-verified', '--execute', '--status-file', str(status)]
            out = io.StringIO()
            with patch('sys.argv', argv), patch.object(m, 'run', side_effect=m.LaunchError('listener_identity_unverifiable', cause)), \
                    patch.object(m.os, 'kill') as kill, contextlib.redirect_stdout(out):
                self.assertEqual(m.main(), 1)
            written = json.loads(status.read_text())
            self.assertEqual(written, json.loads(out.getvalue()))
            self.assertEqual(written, {'status': 'listener_identity_unverifiable', 'service_changed': False, 'phase': 'preflight',
                                       'cause': {'step': 'fd_enumeration', 'exception': 'PermissionError', 'errno': errno.EACCES}})
            self.assertNotIn('SYNTHETIC_SECRET_621', status.read_text())
            kill.assert_not_called()

    def test_log_keeps_a_valid_cause_and_drops_forged_ones(self):
        good = {'step': 'tcp_table', 'exception': 'IndexError', 'errno': None}
        cases = [
            (good, good),
            ({'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': 2}, {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': 2}),
            ({**good, 'detail': 'SYNTHETIC_SECRET_621'}, None),
            ({**good, 'step': 'SYNTHETIC_SECRET_621'}, None),
            ({**good, 'exception': 'SYNTHETIC_SECRET_621'}, None),
            ({**good, 'errno': 'SYNTHETIC_SECRET_621'}, None),
            ({**good, 'errno': True}, None),
            ('SYNTHETIC_SECRET_621', None),
        ]
        with tempfile.TemporaryDirectory() as d:
            for index, (cause, expected) in enumerate(cases):
                with self.subTest(index=index):
                    path = Path(d) / ('status-%d.json' % index)
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    os.write(fd, json.dumps({'status': 'listener_identity_unverifiable', 'phase': 'preflight',
                                             'service_changed': False, 'cause': cause}).encode()); os.close(fd)
                    result = checked.read_status(path)
                    self.assertEqual(result['status'], 'listener_identity_unverifiable')
                    self.assertEqual(result.get('cause'), expected)
                    self.assertNotIn('SYNTHETIC_SECRET_621', json.dumps(result))


@unittest.skipUnless(LINUX_PROC, 'needs Linux /proc; runs in CI fail-closed (ubuntu-latest)')
class RealProcessTests(unittest.TestCase):
    """Real children: fd-churning vs quiet. Offline, loopback only, no signals to anything but the test's own child."""

    def child(self, mode):
        proc = subprocess.Popen([sys.executable, '-c', CHILD, mode], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (proc.kill(), proc.wait(), proc.stdin.close(), proc.stdout.close()))
        return proc, int(proc.stdout.readline())

    @staticmethod
    def legacy_enumeration(pid):
        # The pre-#621 expression (ops/safe_launch.py before this change).
        return {os.readlink(fd) for fd in Path(f'/proc/{pid}/fd').iterdir()}

    def test_churning_child_never_raises_and_its_listener_is_always_owned(self):
        proc, port = self.child('churn')
        skipped = {'n': 0}
        real = os.readlink
        def counting(path, *args, **kwargs):
            try:
                return real(path, *args, **kwargs)
            except FileNotFoundError:
                skipped['n'] += 1
                raise
        legacy_raised = 0
        deadline = time.monotonic() + 20
        iterations = 0
        with patch.object(m.os, 'readlink', side_effect=counting):
            while iterations < 3000 or (skipped['n'] == 0 and time.monotonic() < deadline):
                iterations += 1
                self.assertTrue(m.owns_listener(proc.pid, port))
        for _ in range(3000):
            try:
                self.legacy_enumeration(proc.pid)
            except FileNotFoundError:
                legacy_raised += 1
        self.assertIsNone(proc.poll())
        # The race was actually exercised: fds vanished mid-enumeration and were skipped.
        self.assertGreater(skipped['n'], 0, 'churn child produced no vanished fd in %d enumerations' % iterations)
        print('\n#621 churn: %d enumerations, %d vanished fds skipped; legacy expression raised %d/3000'
              % (iterations, skipped['n'], legacy_raised), file=sys.stderr)

    def test_quiet_child_is_owned_every_time_and_never_raises(self):
        proc, port = self.child('quiet')
        for _ in range(3000):
            self.assertTrue(m.owns_listener(proc.pid, port))
        for _ in range(300):
            self.legacy_enumeration(proc.pid)  # quiet child: even the old expression never raises

    def test_wrong_port_on_churning_child_is_not_owned(self):
        proc, port = self.child('churn')
        with socket.socket() as other:
            other.bind(('127.0.0.1', 0)); other.listen()
            for _ in range(200):
                self.assertFalse(m.owns_listener(proc.pid, other.getsockname()[1]))

    def test_reaped_pid_refuses_with_fd_enumeration_cause(self):
        proc, port = self.child('quiet')
        proc.kill(); proc.wait()
        with self.assertRaises(m.LaunchError) as raised:
            m.owns_listener(proc.pid, port)
        self.assertEqual(str(raised.exception), 'listener_identity_unverifiable')
        self.assertEqual(raised.exception.cause, {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': errno.ENOENT})

    @unittest.skipIf(os.geteuid() == 0, 'root can read every /proc/<pid>/fd')
    def test_unreadable_foreign_pid_refuses_with_permission_cause(self):
        with self.assertRaises(m.LaunchError) as raised:
            m.owns_listener(1, 3100)
        self.assertEqual(str(raised.exception), 'listener_identity_unverifiable')
        self.assertEqual(raised.exception.cause, {'step': 'fd_enumeration', 'exception': 'PermissionError', 'errno': errno.EACCES})


if __name__ == '__main__':
    unittest.main()
