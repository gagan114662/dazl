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
COMMIT = 'a' * 40
NAMES = sorted(checked.REQUIRED_CI)


def run_obj(name, conclusion='success', status='completed', completed_at='2026-10-31T21:00:00Z', rid=1, head_sha=COMMIT, slug='github-actions'):
    return {'name': name, 'status': status, 'conclusion': conclusion,
            'completed_at': completed_at, 'id': rid, 'head_sha': head_sha,
            'app': {'slug': slug}}


def all_green(**overrides):
    checks = [run_obj(n, rid=100 + i, **overrides.get(n, {})) for i, n in enumerate(NAMES)]
    return checks


def stub_get(checks, main_sha=COMMIT, ref_calls_before_change=None):
    """Deterministic API stub. ref_calls_before_change: after this many ref
    reads, main moves (simulating a mid-gate main change)."""
    state = {'ref_reads': 0}
    def get(path):
        if path == 'git/ref/heads/main':
            state['ref_reads'] += 1
            sha = main_sha
            if ref_calls_before_change is not None and state['ref_reads'] > ref_calls_before_change:
                sha = 'b' * 40
            return {'object': {'sha': sha}}
        if path.startswith('commits/') and path.endswith('/check-runs?per_page=100'):
            return {'total_count': len(checks), 'check_runs': checks}
        raise AssertionError('unexpected path ' + path)
    return get


class RequireCiFixtures(unittest.TestCase):
    def expect(self, checks, message, **kwargs):
        with self.assertRaises(ValueError) as ctx:
            checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks, **kwargs))
        self.assertEqual(str(ctx.exception), message)

    def test_all_green_passes(self):
        checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(all_green()))

    def test_missing_name_fails(self):
        checks = all_green()
        checks = [c for c in checks if c['name'] != 'browser']
        self.expect(checks, 'ci_missing')

    def test_duplicate_successes_pass(self):
        # push + pull_request tracks both completed success on the same SHA.
        checks = all_green()
        extra = run_obj('browser', rid=900, completed_at='2026-10-31T21:05:00Z')
        checks.append(extra)
        checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))

    def test_older_success_newer_failure_fails(self):
        checks = all_green()
        checks.append(run_obj('browser', conclusion='failure', rid=901,
                              completed_at='2026-10-31T21:06:00Z'))
        self.expect(checks, 'ci_not_passed')

    def test_older_failure_newer_success_passes(self):
        # rerun supersedes the failed attempt it replaced
        checks = all_green()
        checks.append(run_obj('browser', conclusion='failure', rid=50,
                              completed_at='2026-10-31T20:00:00Z'))
        checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))

    def test_equal_completed_at_tiebreaks_on_id(self):
        checks = all_green()
        # a same-timestamp failure with a LOWER id loses to the newer-id success
        checks.append(run_obj('browser', conclusion='failure', rid=99,
                              completed_at='2026-10-31T21:00:00Z'))
        checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))
        # ...and a same-timestamp failure with a HIGHER id wins -> fail
        checks2 = all_green()
        checks2.append(run_obj('browser', conclusion='failure', rid=1000,
                               completed_at='2026-10-31T21:00:00Z'))
        self.expect(checks2, 'ci_not_passed')

    def test_success_with_pending_run_fails(self):
        checks = all_green()
        checks.append(run_obj('browser', status='in_progress', conclusion=None,
                              completed_at=None, rid=950))
        self.expect(checks, 'ci_pending')

    def test_queued_duplicate_fails_even_with_success(self):
        checks = all_green()
        checks.append(run_obj('migrations', status='queued', conclusion=None,
                              completed_at=None, rid=951))
        self.expect(checks, 'ci_pending')

    def test_cancelled_latest_fails(self):
        checks = all_green()
        checks.append(run_obj('fail-closed', conclusion='cancelled', rid=960,
                              completed_at='2026-10-31T22:00:00Z'))
        self.expect(checks, 'ci_not_passed')

    def test_wrong_head_sha_fails(self):
        checks = all_green()
        checks.append(run_obj('browser', head_sha='c' * 40, rid=970,
                              completed_at='2026-10-31T21:07:00Z'))
        self.expect(checks, 'ci_not_passed')

    def test_non_actions_app_fails(self):
        checks = all_green()
        checks.append(run_obj('browser', slug='some-other-app', rid=971,
                              completed_at='2026-10-31T21:08:00Z'))
        self.expect(checks, 'ci_not_passed')

    def test_main_changed_before_read_fails(self):
        self.expect(all_green(), 'ci_main_changed', main_sha='d' * 40)

    def test_main_moving_between_recheck_fails(self):
        # first ref read matches, the post-read recheck sees main move
        self.expect(all_green(), 'ci_main_changed', ref_calls_before_change=1)

    def test_api_error_fails(self):
        def boom(path):
            raise OSError('http 500')
        with self.assertRaises(OSError):
            checked.require_ci('gagan114662/dazl', COMMIT, get=boom)

    def test_total_count_mismatch_fails(self):
        checks = all_green()
        def get(path):
            if path == 'git/ref/heads/main':
                return {'object': {'sha': COMMIT}}
            return {'total_count': len(checks) + 5, 'check_runs': checks}
        with self.assertRaises(ValueError) as ctx:
            checked.require_ci('gagan114662/dazl', COMMIT, get=get)
        self.assertEqual(str(ctx.exception), 'ci_incomplete')

    def test_identity_guard(self):
        with self.assertRaises(ValueError):
            checked.require_ci('other/repo', COMMIT, get=stub_get(all_green()))
        with self.assertRaises(ValueError):
            checked.require_ci('gagan114662/dazl', 'xyz', get=stub_get(all_green()))


class TokenlessPathTests(unittest.TestCase):
    def test_tokenless_request_sends_no_authorization_header(self):
        sent = {}
        real_github_get = checked.github_get
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return json.dumps({'object': {'sha': COMMIT}}).encode()
        class FakeOpener:
            def open(self, req, timeout=None):
                sent['auth'] = req.get_header('Authorization')
                return FakeResponse()
        with patch('urllib.request.build_opener', return_value=FakeOpener()):
            out = checked.github_get('gagan114662/dazl', 'git/ref/heads/main', None)
        self.assertIsNone(sent['auth'])
        self.assertEqual(out['object']['sha'], COMMIT)

    def test_require_ci_without_token_file_reads_no_credential(self):
        with patch.object(checked, 'read_token', side_effect=AssertionError('must not read credentials')):
            checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(all_green()))


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

    def test_ci_refusal_never_reaches_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / 'launched'
            launch = [sys.executable, '-c', 'from pathlib import Path; Path(__import__("sys").argv[1]).touch()', str(sentinel)]
            good = [sys.executable, '-c', 'pass']
            with patch.object(checked, 'bind_launch'), patch.object(checked, 'require_ci', side_effect=ValueError('ci_pending')):
                report, code = checked.run([good], launch)
            self.assertEqual(code, 1)
            self.assertFalse(report['launch_reached'])
            self.assertFalse(sentinel.exists())

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
