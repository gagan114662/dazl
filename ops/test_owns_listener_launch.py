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
                    '--backup-db', '/db', '--drill-report', '/drill', '--backup-max-age-s', '3600', '--execute', '--status-file', str(status)]
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


MALFORMED_WORDS = [[], ['fd_enumeration'], {}, {'step': 'tcp_table'}, None, 0, 1, True, 1.5, '', 'x' * 300,
                   'FD_ENUMERATION', 'fd_enumeration\u0000', '\udcff', 'SYNTHETIC_SECRET_621']
MALFORMED_ERRNOS = [[], {}, '2', 'SYNTHETIC_SECRET_621', True, False, -1, 4096, 2 ** 70, 1.5, float('nan')]
VALID_CAUSE = {'step': 'tcp_table', 'exception': 'IndexError', 'errno': None}
FIXED = {'status': 'listener_identity_unverifiable', 'phase': 'preflight', 'service_changed': False}


def malformed_causes():
    """Every cause field fed wrong types, bad words, missing and extra keys, nesting."""
    for field in ['step', 'exception']:
        for value in MALFORMED_WORDS:
            yield '%s=%r' % (field, value), {**VALID_CAUSE, field: value}
    for value in MALFORMED_ERRNOS:
        yield 'errno=%r' % (value,), {**VALID_CAUSE, 'errno': value}
    for key in VALID_CAUSE:
        yield 'missing %s' % key, {k: v for k, v in VALID_CAUSE.items() if k != key}
    yield 'extra key', {**VALID_CAUSE, 'detail': 'SYNTHETIC_SECRET_621'}
    yield 'nested cause', {**VALID_CAUSE, 'step': {'step': 'tcp_table', 'exception': [], 'errno': {}}}
    for value in [[], [VALID_CAUSE], 'SYNTHETIC_SECRET_621', 7, None, True, {}]:
        yield 'cause=%r' % (value,), value


def status_bytes(document):
    # allow_nan: NaN/Infinity are valid input to json.loads, so a forger can send them.
    return json.dumps(document).encode()


class MalformedCauseTests(unittest.TestCase):
    """#622 review: malformed causes are dropped; the fixed fields and the launch result are still recorded."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.count = 0

    def status_file(self, raw):
        self.count += 1
        path = self.root / ('status-%d.json' % self.count)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, raw); os.close(fd)
        return path

    def assert_sanitized(self, result):
        # Only fixed-vocabulary words, booleans/'unknown', 40-hex, or a fully valid cause survive.
        codes, phases, steps, names = checked.safe_launch_vocabulary()
        self.assertIn(result['state'], {'read', 'invalid', 'missing', 'refused'})
        self.assertLessEqual(set(result), {'state', 'status', 'phase', 'service_changed', 'commit', 'cause'})
        if 'status' in result: self.assertIn(result['status'], codes | {'unrecognised'})
        if 'phase' in result: self.assertIn(result['phase'], phases | {'unrecognised'})
        if 'service_changed' in result: self.assertTrue(result['service_changed'] in (True, False) and type(result['service_changed']) is bool or result['service_changed'] == 'unknown')
        if 'cause' in result: self.assertEqual(checked.read_cause(result['cause'], steps, names), result['cause'])
        self.assertNotIn('SYNTHETIC_SECRET_621', json.dumps(result))

    def test_read_status_drops_every_malformed_cause_and_keeps_fixed_fields(self):
        for name, cause in malformed_causes():
            with self.subTest(case=name):
                result = checked.read_status(self.status_file(status_bytes({**FIXED, 'cause': cause})))
                self.assertEqual(result, {'state': 'read', **FIXED})
                self.assert_sanitized(result)

    def test_instinct_cases_array_object_null_for_step_and_exception(self):
        _, _, steps, names = checked.safe_launch_vocabulary()
        for field in ['step', 'exception']:
            for value in [[], {}, None]:
                with self.subTest(field=field, value=value):
                    self.assertIsNone(checked.read_cause({**VALID_CAUSE, field: value}, steps, names))

    def test_malformed_status_fields_and_files_never_raise(self):
        documents = [
            {**FIXED, 'status': [], 'phase': {}, 'service_changed': 1},
            {**FIXED, 'status': {'a': 1}, 'phase': ['preflight'], 'service_changed': 1.0},
            {**FIXED, 'status': None, 'phase': None, 'service_changed': [], 'commit': ['a' * 40]},
            {**FIXED, 'service_changed': 0, 'commit': 'A' * 40},
            {**FIXED, 'service_changed': 'yes', 'commit': {'commit': 'a' * 40}},
            {}, [], [FIXED], 'listener_identity_unverifiable', 3, None,
        ]
        raws = [status_bytes(doc) for doc in documents] + [
            b'\xff\xfe\x00 not utf-8', b'{"status": "\xff"}', b'', b'{', b'x' * 5000,
            json.dumps({**FIXED, 'cause': {**VALID_CAUSE, 'step': 'x' * 5000}}).encode(),
            b'[' * 2000 + b']' * 2000, b'{"a":' * 800 + b'1' + b'}' * 800,
            b'{"status": "listener_identity_unverifiable", "errno": NaN, "cause": {"step": "tcp_table", "exception": "IndexError", "errno": Infinity}}',
            b'{"status": "deployed", "status": "listener_identity_unverifiable", "cause": {"step": "tcp_table", "step": [], "exception": "IndexError", "errno": null}}',
            ('{"commit": 1%s}' % ('0' * 4000)).encode(),
        ]
        for index, raw in enumerate(raws):
            with self.subTest(index=index):
                result = checked.read_status(self.status_file(raw))
                self.assert_sanitized(result)
                self.assertNotIn('cause', result)

    def test_safe_launch_cause_for_exceptions_without_or_with_bad_errno(self):
        class NoErrno(Exception): pass
        class BadErrno(OSError):
            @property
            def errno(self): return 'SYNTHETIC_SECRET_621'
        cases = [(OSError(), 'OSError', None), (Exception('x'), 'Exception', None), (NoErrno(), 'unrecognised', None),
                 (BadErrno(), 'unrecognised', None), (OSError(99999, 'big'), 'OSError', None), (OSError(-1, 'neg'), 'OSError', None),
                 (IndexError('SYNTHETIC_SECRET_621'), 'IndexError', None), (PermissionError(13, 'x'), 'PermissionError', 13)]
        _, _, steps, names = checked.safe_launch_vocabulary()
        for error, exception, number in cases:
            with self.subTest(error=type(error).__name__):
                cause = m.failure_cause('fd_enumeration', error)
                self.assertEqual(cause, {'step': 'fd_enumeration', 'exception': exception, 'errno': number})
                self.assertEqual(checked.read_cause(json.loads(json.dumps(cause)), steps, names), cause)


class MalformedCauseWrapperTests(unittest.TestCase):
    """The actual checked_launch.run path: a forged status file never stops the launch result being logged."""

    WRITER = ('import os,sys\n'
              'fd=os.open(sys.argv[-1], os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)\n'
              'os.write(fd, bytes.fromhex(sys.argv[1])); os.close(fd)\n'
              'raise SystemExit(int(sys.argv[2]))')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        (root / 'logs').mkdir(mode=0o700)
        self.log = root / 'logs' / 'launch-log.jsonl'

    def run_wrapper(self, raw, returncode=1):
        launch = [sys.executable, '-c', self.WRITER, raw.hex(), str(returncode)]
        with patch.object(checked, 'bind_launch'), patch.object(checked, 'bind_target'), patch.object(checked, 'require_ci'):
            return checked.run([[sys.executable, '-c', 'pass']], launch, repository='gagan114662/dazl', commit='a' * 40, log_path=str(self.log))

    def test_malformed_causes_through_the_wrapper_still_record_the_launch_result(self):
        cases = [(name, status_bytes({**FIXED, 'cause': cause})) for name, cause in malformed_causes()]
        cases += [('non-utf8', b'\xff\xfe junk'), ('huge', b'{' + b' ' * 6000 + b'}'), ('deep', b'[' * 2000 + b']' * 2000),
                  ('wrong field types', status_bytes({'status': [], 'phase': {}, 'service_changed': 1, 'commit': 7, 'cause': {'step': [], 'exception': {}, 'errno': []}}))]
        for index, (name, raw) in enumerate(cases):
            with self.subTest(case=name):
                report, code = self.run_wrapper(raw)
                self.assertEqual((code, report), (1, {'status': 'launch_failed', 'returncode': 1, 'launch_reached': True}))
                line = json.loads(self.log.read_text().splitlines()[-1])
                self.assertEqual((line['status'], line['wrapper_returncode'], line['launch_reached']), ('launch_failed', 1, True))
                self.assertEqual((line['launch']['result'], line['launch']['returncode']), ('exit', 1))
                status = line['launch']['status']
                self.assertNotIn('cause', status)
                if status['state'] == 'read' and name not in ('wrong field types',):
                    self.assertEqual(status, {'state': 'read', **FIXED})
                self.assertNotIn('SYNTHETIC_SECRET_621', self.log.read_text())
        self.assertEqual(len(self.log.read_text().splitlines()), len(cases))

    def test_valid_cause_reaches_the_log_through_the_wrapper(self):
        report, code = self.run_wrapper(status_bytes({**FIXED, 'cause': {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': 2}}))
        self.assertEqual((code, report['status']), (1, 'launch_failed'))
        line = json.loads(self.log.read_text().splitlines()[-1])
        self.assertEqual(line['launch']['status'], {'state': 'read', **FIXED, 'cause': {'step': 'fd_enumeration', 'exception': 'FileNotFoundError', 'errno': 2}})


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
