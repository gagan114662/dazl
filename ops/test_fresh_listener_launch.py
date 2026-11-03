import dataclasses
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fresh', Path(__file__).with_name('fresh_listener.py'))
m = importlib.util.module_from_spec(spec);sys.modules[spec.name] = m;spec.loader.exec_module(m)
SHA = 'a'*40


class FreshListenerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=5)
            if child.stdout: child.stdout.close()
        self.temp.cleanup()

    def child(self, bind='127.0.0.1', commit=SHA):
        code = '''import http.server,json,sys
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  data=json.dumps({'ok':True,'commit':sys.argv[2]}).encode();self.send_response(200);self.end_headers();self.wfile.write(data)
 def log_message(self,*a):pass
server=http.server.HTTPServer((sys.argv[1],0),Handler)
print(server.server_port,flush=True)
server.serve_forever()
'''
        child = subprocess.Popen([sys.executable, '-u', '-c', code, bind, commit],
                                 cwd=self.temp.name, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, start_new_session=True, text=True)
        self.children.append(child)
        port = int(child.stdout.readline())
        row = m.capture_created(child.pid, self.temp.name)
        return child, port, row

    def test_owned_loopback_candidate_ready_and_only_it_is_stopped(self):
        old, oldport, oldrow = self.child()
        candidate, port, row = self.child()
        report = m.candidate_ready(row, port, SHA)
        self.assertEqual(report['status'], 'candidate_ready_only')
        self.assertFalse(report['public_upstream_changed'])
        self.assertEqual(m.cleanup_created(row)['status'], 'candidate_leader_stopped')
        candidate.wait(timeout=5)
        self.assertIsNone(old.poll())
        self.assertTrue(m.readiness(oldport, SHA))
        m.require_same(oldrow)

    def test_occupied_port_and_non_loopback_refuse(self):
        child, port, row = self.child()
        with self.assertRaisesRegex(m.CandidateRefused, 'port_not_empty'):m.require_empty(port)
        broad, port2, row2 = self.child('0.0.0.0')
        with self.assertRaisesRegex(m.CandidateRefused, 'not_loopback'):m.candidate_ready(row2, port2, SHA)

    def test_wrong_commit_and_unowned_socket_refuse_without_signals(self):
        a, port, row = self.child()
        b, otherport, other = self.child()
        with patch.object(m.os, 'killpg') as kill:
            with self.assertRaisesRegex(m.CandidateRefused, 'not_ready'):m.candidate_ready(row, port, 'b'*40)
            with self.assertRaisesRegex(m.CandidateRefused, 'not_owned'):m.candidate_ready(row, otherport, SHA)
            kill.assert_not_called()

    def test_identity_reuse_changed_cwd_and_foreign_session_refuse_cleanup(self):
        child, port, row = self.child()
        for bad in [dataclasses.replace(row, start_ticks=row.start_ticks+1),
                    dataclasses.replace(row, cwd='/different'),
                    dataclasses.replace(row, pgid=row.pgid+1)]:
            with patch.object(m.os, 'killpg') as kill:
                with self.assertRaises(m.CandidateRefused):m.cleanup_created(bad)
                kill.assert_not_called()
        self.assertIsNone(child.poll())

    def test_exited_leader_refuses_unknown_group_cleanup(self):
        child, port, row = self.child()
        child.terminate();child.wait(timeout=5)
        with patch.object(m.os, 'killpg') as kill:
            with self.assertRaises(m.CandidateRefused):m.cleanup_created(row)
            kill.assert_not_called()

    def test_port_stolen_after_empty_check_is_not_treated_as_owned(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
        m.require_empty(port)
        candidate, otherport, row = self.child()
        with socket.socket() as thief:
            thief.bind(('127.0.0.1', port)); thief.listen()
            with patch.object(m.os, 'killpg') as kill:
                with self.assertRaisesRegex(m.CandidateRefused, 'not_owned'):
                    m.require_owned_listener(row, port)
                kill.assert_not_called()

    def test_ipv6_occupied_port_refuses(self):
        try:
            listener = socket.socket(socket.AF_INET6)
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            listener.bind(('::1', 0)); listener.listen()
        except OSError:
            self.skipTest('IPv6 unavailable; not counted as IPv6 proof')
        with listener:
            with self.assertRaisesRegex(m.CandidateRefused, 'port_not_empty'):
                m.require_empty(listener.getsockname()[1])

    def test_cleanup_timeout_is_failure_not_candidate_stop_receipt(self):
        child, port, row = self.child()
        with patch.object(m.os, 'killpg') as kill:
            with self.assertRaisesRegex(m.CandidateRefused, 'cleanup_timeout'):
                m.cleanup_created(row, seconds=.03)
            kill.assert_called_once_with(row.pgid, signal.SIGTERM)
        self.assertIsNone(child.poll())

    def test_receipt_records_wall_and_monotonic_observation_not_expiry(self):
        child, port, row = self.child()
        with patch.object(m.time, 'time_ns', return_value=123456789), patch.object(m.time, 'monotonic_ns', return_value=987654321):
            report = m.candidate_ready(row, port, SHA)
        self.assertEqual(report['observed_wall_unix_ns'], 123456789)
        self.assertEqual(report['observed_monotonic_ns'], 987654321)
        self.assertEqual(report['clock_scope'], 'monotonic_same_host_boot_only')
        self.assertNotIn('expires_at', report)

    def test_every_listen_inode_must_have_a_resolved_owner(self):
        child, port, row = self.child()
        real_read = Path.read_text
        def read(path, *args, **kwargs):
            text = real_read(path, *args, **kwargs)
            if str(path) == '/proc/net/tcp':
                # Extra same-port LISTEN socket with an inode no PID owns.
                text += f' 99: 0100007F:{port:04X} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 999999999999\n'
            return text
        with patch.object(Path, 'read_text', read), patch.object(m.os, 'killpg') as kill:
            with self.assertRaisesRegex(m.CandidateRefused, 'socket_owner_unknown'):
                m.require_owned_listener(row, port)
            kill.assert_not_called()

    def test_no_execute_cli_or_caddy_capability(self):
        result = subprocess.run([sys.executable, str(Path(m.__file__)), '--execute'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['same_db_admission'], 'unverified')

    def test_no_redirect(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://example.invalid'))
