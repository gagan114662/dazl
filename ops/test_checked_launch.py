import contextlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import importlib.util
spec=importlib.util.spec_from_file_location("checked",Path(__file__).with_name("checked_launch.py")); checked=importlib.util.module_from_spec(spec);spec.loader.exec_module(checked)
# Tests that are not about the default log privately here; DefaultLaunchLogTests use the real resolver.
LOGS = tempfile.TemporaryDirectory()
REAL_DEFAULT_LAUNCH_LOG = checked.default_launch_log
checked.default_launch_log = lambda: (Path(LOGS.name) / 'launch-log.jsonl', Path(LOGS.name))

SCRIPT = str(Path(__file__).with_name('checked_launch.py'))
COMMIT = 'a' * 40
NAMES = sorted(checked.REQUIRED_CI)


def run_obj(name, conclusion='success', status='completed', completed_at='2026-10-31T21:00:00Z', rid=1, head_sha=COMMIT, slug='github-actions', suite=1):
    run = {'name': name, 'status': status, 'conclusion': conclusion,
           'completed_at': completed_at, 'id': rid, 'head_sha': head_sha,
           'app': {'slug': slug}}
    if suite is not None:
        run['check_suite'] = {'id': suite}
    return run


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
        extra = run_obj('browser', rid=900, completed_at='2026-10-31T21:05:00Z', suite=2)
        checks.append(extra)
        checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))

    def test_older_success_newer_failure_fails(self):
        checks = all_green()
        checks.append(run_obj('browser', conclusion='failure', rid=901,
                              completed_at='2026-10-31T21:06:00Z'))
        self.expect(checks, 'ci_not_passed')

    def test_independent_track_failure_refused_despite_newer_other_track_success(self):
        # suite 2 failed earlier; suite 1's newer success must not mask it
        checks = all_green()
        checks.append(run_obj('browser', conclusion='failure', rid=50,
                              completed_at='2026-10-31T20:00:00Z', suite=2))
        self.expect(checks, 'ci_not_passed')

    def test_missing_suite_identity_rejected(self):
        checks = all_green()
        checks.append(run_obj('browser', rid=910,
                              completed_at='2026-10-31T21:06:00Z', suite=None))
        self.expect(checks, 'ci_suite_identity')

    def test_malformed_suite_identity_rejected(self):
        checks = all_green()
        bad = run_obj('browser', rid=911, completed_at='2026-10-31T21:06:00Z', suite=2)
        bad['check_suite'] = {'id': 'not-an-int'}
        checks.append(bad)
        self.expect(checks, 'ci_suite_identity')

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


class StaticQualityRolloutTests(unittest.TestCase):
    def test_static_quality_is_required_without_retiring_existing_checks(self):
        self.assertEqual(checked.REQUIRED_CI, frozenset({
            'browser', 'migrations', 'test-sqlite', 'test-postgres',
            'fail-closed', 'static-quality'}))

    def test_static_quality_absence_is_not_success(self):
        checks = [c for c in all_green() if c['name'] != 'static-quality']
        with self.assertRaisesRegex(ValueError, '^ci_missing$'):
            checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))

    def test_static_quality_non_success_states_refuse(self):
        for conclusion in ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', None]:
            with self.subTest(conclusion=conclusion), self.assertRaises(ValueError):
                checked.require_ci('gagan114662/dazl', COMMIT,
                    get=stub_get(all_green(**{'static-quality': {'conclusion': conclusion}})))
        for state in ['queued', 'in_progress']:
            with self.subTest(status=state), self.assertRaises(ValueError):
                checked.require_ci('gagan114662/dazl', COMMIT,
                    get=stub_get(all_green(**{'static-quality': {'status': state, 'conclusion': None, 'completed_at': None}})))

    def test_static_quality_wrong_identity_refuses(self):
        for values in [{'head_sha': 'e'*40}, {'slug': 'not-github-actions'}, {'suite': None}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                checked.require_ci('gagan114662/dazl', COMMIT,
                    get=stub_get(all_green(**{'static-quality': values})))

    def test_static_quality_independent_failure_not_masked(self):
        checks = all_green()
        checks.append(run_obj('static-quality', conclusion='failure', suite=2,
                              rid=1000, completed_at='2026-10-31T20:00:00Z'))
        with self.assertRaisesRegex(ValueError, '^ci_not_passed$'):
            checked.require_ci('gagan114662/dazl', COMMIT, get=stub_get(checks))


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
                with patch.object(checked, 'require_ci'), patch.object(checked, 'bind_launch'), patch.object(checked, 'bind_target'):
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
            with patch.object(checked, 'bind_launch'), patch.object(checked, 'bind_target'), patch.object(checked, 'require_ci', side_effect=ValueError('ci_pending')):
                report, code = checked.run([good], launch)
            self.assertEqual(code, 1)
            self.assertFalse(report['launch_reached'])
            self.assertFalse(sentinel.exists())

    def test_success_reaches_launch_once_and_failed_launch_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'count'
            launch = [sys.executable, '-c', 'from pathlib import Path; p=Path(__import__("sys").argv[1]); p.write_text(p.read_text()+"x" if p.exists() else "x")', str(target)]
            good = [sys.executable, '-c', 'pass']
            with patch.object(checked,'require_ci'), patch.object(checked,'bind_launch'),patch.object(checked,'bind_target'):
                report,code=checked.run([good,good],launch)
            p=subprocess.CompletedProcess([],code,json.dumps(report))
            self.assertEqual(p.returncode, 0)
            self.assertEqual(target.read_text(), 'x')
            with patch.object(checked,'require_ci'), patch.object(checked,'bind_launch'),patch.object(checked,'bind_target'):
                report,code=checked.run([good],[sys.executable,'-c','raise SystemExit(3)'])
            p=subprocess.CompletedProcess([],code,json.dumps(report))
            self.assertEqual(p.returncode, 1)
            self.assertTrue(json.loads(p.stdout)['launch_reached'])


SAFE = str(Path(__file__).with_name('safe_launch.py'))
SECRET = 'sk_live_SYNTHETIC_DO_NOT_LOG_607'
STUB = ('import pathlib,signal,sys,time\n'
        'p=pathlib.Path(sys.argv[1])\n'
        'signal.signal(signal.SIGTERM,lambda *a:(p.write_text("SIGTERM"),sys.exit(0)))\n'
        'print("ready",flush=True)\n'
        'time.sleep(120)\n')


class LaunchLogTests(unittest.TestCase):
    """#607: every run leaves one sanitized line; failures are diagnosable, nothing is weakened."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Resolved so safe_launch's no-symlink-parent env rule holds on any host.
        self.root = Path(self.temp.name).resolve()
        (self.root / 'logs').mkdir(mode=0o700)
        self.log = self.root / 'logs' / 'launch-log.jsonl'
        self.status = self.root / 'logs' / 'launch-status.json'
        self.stub = subprocess.Popen([sys.executable, '-c', STUB, str(self.root / 'stub-signalled')], stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.stub.stdout.readline().strip(), 'ready')

    def tearDown(self):
        self.stub.kill(); self.stub.wait(); self.stub.stdout.close()
        self.temp.cleanup()

    def gated(self, ci=None):
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(checked, 'bind_launch'))
        stack.enter_context(patch.object(checked, 'bind_target'))
        return stack, stack.enter_context(patch.object(checked, 'require_ci', side_effect=ci))

    def run_logged(self, preflights, launch, **kwargs):
        stack, _ = self.gated(kwargs.pop('ci', None))
        with stack:
            return checked.run(preflights, launch, repository='gagan114662/dazl', commit=COMMIT, log_path=str(self.log), **kwargs)

    def lines(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()]

    def assert_stub_untouched(self):
        self.assertIsNone(self.stub.poll())
        self.assertFalse((self.root / 'stub-signalled').exists())

    def test_failing_safe_launch_child_logs_sanitized_status_and_changes_nothing(self):
        for folder, commit in [(self.root / 'new', COMMIT), (self.root / 'old', 'b' * 40)]:
            (folder / '.next').mkdir(parents=True)
            (folder / '.next/BUILD_ID').write_text('synthetic-build')
            (folder / '.build-commit').write_text(commit)
            (folder / 'package.json').write_text('{}')
        db = self.root / 'live.db'; db.write_bytes(b'SENTINEL-DB')
        before = (db.read_bytes(), db.stat().st_mtime_ns)
        env = self.root / 'synthetic.env'
        env.write_text('DB_PATH=' + str(db) + '\nDAZL_MASTER_KEY=' + SECRET + '\nPUBLIC_BASE_URL=https://example.invalid\n'); env.chmod(0o600)
        missing_backup = self.root / 'missing-backup.db'
        launch = [sys.executable, SAFE, '--stage', str(self.root / 'new'), '--commit', COMMIT,
                  '--rollback-stage', str(self.root / 'old'), '--rollback-commit', 'b' * 40,
                  '--env-file', str(env), '--pid', str(self.stub.pid), '--backup', str(missing_backup),
                  '--backup-db', str(db), '--backup-verified', '--execute']
        report, code = self.run_logged([[sys.executable, '-c', 'pass']], launch)
        self.assertEqual(code, 1)
        self.assertEqual(report, {'status': 'launch_failed', 'returncode': 1, 'launch_reached': True})
        [line] = self.lines()
        self.assertEqual(line['status'], 'launch_failed'); self.assertEqual(line['wrapper_returncode'], 1)
        self.assertTrue(line['launch_reached']); self.assertEqual(line['commit'], COMMIT)
        self.assertEqual(line['launch']['result'], 'exit'); self.assertEqual(line['launch']['returncode'], 1)
        self.assertEqual(line['launch']['status_file'], str(self.status))
        self.assertEqual(line['launch']['status'], {'state': 'read', 'status': 'verified_backup_required', 'phase': 'preflight', 'service_changed': False})
        self.assertEqual([(g['round'], g['gate'], g['result']) for g in line['gates']],
                         [(r, g, 'pass') for r in ['initial', 'final'] for g in ['bind_launch', 'bind_target', 'require_ci']])
        self.assertEqual([(p['name'], p['result'], p['returncode']) for p in line['preflights']], [(Path(sys.executable).name, 'exit', 0)])
        self.assertIsInstance(line['wall_s'], float)
        # Sanitized: no secret, no env or backup argv values, no child output.
        text = self.log.read_text() + self.status.read_text()
        for value in [SECRET, str(env), str(missing_backup), str(db)]:
            self.assertNotIn(value, text)
        self.assertEqual(self.log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.status.stat().st_mode & 0o777, 0o600)
        # Zero state change: the listener pid was never signalled, the database is untouched.
        self.assert_stub_untouched()
        self.assertEqual((db.read_bytes(), db.stat().st_mtime_ns), before)

    def test_preflight_and_launch_timeouts_are_logged_the_same_sanitized_way(self):
        sentinel = self.root / 'launched'
        touch = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(sentinel)]
        slow = [sys.executable, '-c', 'import sys,time; print(sys.argv[1]); print(sys.argv[1], file=sys.stderr, flush=True); time.sleep(5)', SECRET]
        report, code = self.run_logged([slow], touch, timeout=0.5)
        self.assertEqual((code, report['status'], report['launch_reached']), (1, 'preflight_error', False))
        self.assertFalse(sentinel.exists())
        report, code = self.run_logged([[sys.executable, '-c', 'pass']], slow, timeout=0.5)
        self.assertEqual((code, report['status'], report['launch_reached']), (1, 'launch_error', True))
        first, second = self.lines()
        self.assertEqual(first['preflights'][0]['result'], 'timeout'); self.assertFalse(first['launch_reached']); self.assertNotIn('launch', first)
        self.assertEqual(first['status'], 'preflight_error'); self.assertEqual(first['wrapper_returncode'], 1)
        self.assertEqual(second['launch']['result'], 'timeout'); self.assertTrue(second['launch_reached'])
        self.assertEqual(second['launch']['status'], {'state': 'missing'}); self.assertEqual(second['status'], 'launch_error')
        self.assertNotIn(SECRET, self.log.read_text())
        self.assert_stub_untouched()

    def test_child_secret_on_stderr_or_in_status_file_never_reaches_the_log(self):
        noisy = [sys.executable, '-c', 'import sys; print(sys.argv[1]); print(sys.argv[1], file=sys.stderr)', SECRET]
        forged = [sys.executable, '-c',
                  'import json,os,sys\n'
                  'print(sys.argv[1], file=sys.stderr); print(sys.argv[1])\n'
                  'fd=os.open(sys.argv[-1], os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)\n'
                  'os.write(fd, json.dumps({"status": sys.argv[1].lower(), "phase": sys.argv[1], "service_changed": sys.argv[1], "commit": sys.argv[1], "detail": sys.argv[1]}).encode())\n'
                  'raise SystemExit(1)', SECRET]
        report, code = self.run_logged([noisy], forged)
        self.assertEqual((code, report['status']), (1, 'launch_failed'))
        [line] = self.lines()
        self.assertEqual(line['launch']['status'], {'state': 'read', 'status': 'unrecognised', 'phase': 'unrecognised'})
        self.assertEqual(line['preflights'][0]['name'], Path(sys.executable).name)
        self.assertNotIn(SECRET.lower(), self.log.read_text().lower())

    def test_positive_control_successful_preflights_launch_exactly_once(self):
        count = self.root / 'count'
        launch = [sys.executable, '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text((p.read_text() if p.exists() else "") + sys.argv[-2] + "\\n")', str(count)]
        good = [sys.executable, '-c', 'pass']
        report, code = self.run_logged([good, good], launch)
        self.assertEqual((code, report), (0, {'status': 'launched', 'returncode': 0, 'launch_reached': True}))
        self.assertEqual(count.read_text(), '--status-file\n')
        [line] = self.lines()
        self.assertEqual(line['status'], 'launched'); self.assertEqual(len(line['preflights']), 2)
        self.assertTrue(all(g['result'] == 'pass' for g in line['gates'])); self.assertEqual(len(line['gates']), 6)

    def test_log_is_bounded_to_the_newest_lines(self):
        self.log.write_text(''.join(json.dumps({'old': i}) + '\n' for i in range(250))); self.log.chmod(0o600)
        self.run_logged([[sys.executable, '-c', 'raise SystemExit(4)']], [sys.executable, '-c', 'pass'])
        lines = self.lines()
        self.assertEqual(len(lines), checked.LOG_LINES)
        self.assertEqual(lines[0], {'old': 51}); self.assertEqual(lines[-1]['status'], 'preflight_failed')
        self.assertEqual(lines[-1]['preflights'][0]['returncode'], 4)

    def test_unusable_log_refuses_before_any_gate_preflight_or_launch(self):
        sentinel = self.root / 'touched'
        touch = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(sentinel)]
        other = self.root / 'elsewhere.jsonl'; other.write_text(''); other.chmod(0o600)
        def loose(): self.log.write_text(''); self.log.chmod(0o644)
        def link(): self.log.symlink_to(other)
        def missing_dir(): self.log.parent.rmdir()
        def shared_dir(): self.log.parent.chmod(0o777)
        for setup in [loose, link, missing_dir, shared_dir]:
            with self.subTest(setup=setup.__name__):
                setup()
                stack, ci = self.gated()
                with stack:
                    report, code = checked.run([touch], touch, repository='gagan114662/dazl', commit=COMMIT, log_path=str(self.log))
                self.assertEqual((code, report), (2, {'status': 'launch_log_unavailable', 'launch_reached': False}))
                ci.assert_not_called(); self.assertFalse(sentinel.exists())
                self.assertEqual(other.read_text(), '')
                if self.log.parent.exists():
                    self.log.parent.chmod(0o700)
                    if self.log.is_symlink() or self.log.exists(): self.log.unlink()
                else:
                    self.log.parent.mkdir(mode=0o700)

    def test_gate_refusals_are_logged_by_fixed_code_only(self):
        sentinel = self.root / 'touched'
        touch = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(sentinel)]
        for error, expected in [(ValueError('ci_pending'), 'ci_pending'), (OSError('https://' + SECRET + '@example.invalid'), 'OSError')]:
            report, code = self.run_logged([touch], touch, ci=error)
            self.assertEqual((code, report['status'], report['launch_reached']), (1, 'ci_refused', False))
            self.assertEqual(self.lines()[-1]['gates'][-1], {'round': 'initial', 'gate': 'require_ci', 'result': 'fail', 'code': expected})
        self.assertFalse(sentinel.exists()); self.assertNotIn(SECRET, self.log.read_text())

    def test_operator_cannot_supply_status_file_launch_binding_unchanged(self):
        with self.assertRaisesRegex(ValueError, 'launch_options'):
            checked.bind_launch([sys.executable, SAFE, '--commit', COMMIT, '--execute', '--status-file', str(self.status)], COMMIT)
        checked.bind_launch([sys.executable, SAFE, '--commit', COMMIT, '--execute'], COMMIT)


class DefaultLaunchLogTests(unittest.TestCase):
    # #607: the shipped default must work out of the box on a stock host, without loosening any check.

    def setUp(self):
        if os.geteuid() == 0 and self._testMethodName != 'test_root_default_is_roots_own_dir_regardless_of_home':
            self.skipTest('the per-user default needs a non-root uid; the root path is never written by tests')
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'home'
        self.home.mkdir(mode=0o755); self.home.chmod(0o755)
        self.state = self.home / '.local' / 'state' / 'dazl'
        self.log = self.state / 'launch-log.jsonl'
        self.sentinel = self.root / 'launched'
        self.touch = [sys.executable, '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).touch()', str(self.sentinel)]
        stack = contextlib.ExitStack()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(stack.close)
        old_umask = os.umask(0o022)
        self.addCleanup(os.umask, old_umask)
        stack.enter_context(patch.object(checked, 'default_launch_log', REAL_DEFAULT_LAUNCH_LOG))
        stack.enter_context(patch.dict(os.environ, {'HOME': str(self.home)}))
        stack.enter_context(patch.object(checked, 'bind_launch'))
        stack.enter_context(patch.object(checked, 'bind_target'))
        self.ci = stack.enter_context(patch.object(checked, 'require_ci'))

    def run_default(self, **kwargs):
        return checked.run([[sys.executable, '-c', 'pass']], self.touch, repository='gagan114662/dazl', commit=COMMIT, **kwargs)

    def mode(self, path):
        return os.lstat(path).st_mode & 0o7777

    def assert_refused_before_anything(self, report, code):
        self.assertEqual((code, report), (2, {'status': 'launch_log_unavailable', 'launch_reached': False}))
        self.ci.assert_not_called(); self.assertFalse(self.sentinel.exists())

    def test_shipped_default_writes_out_of_the_box_and_creates_absent_dirs_0700(self):
        # Fails on the old default: /home/ubuntu/backups is absent here (and 0775 on the host) -> launch_log_unavailable.
        report, code = self.run_default()
        self.assertEqual((code, report), (0, {'status': 'launched', 'returncode': 0, 'launch_reached': True}))
        self.assertTrue(self.sentinel.exists())
        for directory in [self.home / '.local', self.home / '.local' / 'state', self.state]:
            self.assertEqual(self.mode(directory), 0o700, directory)
        self.assertEqual(self.mode(self.log), 0o600)
        [line] = [json.loads(x) for x in self.log.read_text().splitlines()]
        self.assertEqual((line['status'], line['launch']['status_file']), ('launched', str(self.state / 'launch-status.json')))
        self.assertEqual(self.mode(self.home), 0o755)
        report, code = self.run_default()
        self.assertEqual(code, 0); self.assertEqual(len(self.log.read_text().splitlines()), 2)

    def test_existing_dirs_are_never_chmodded(self):
        (self.home / '.local').mkdir(mode=0o755); (self.home / '.local').chmod(0o755)
        (self.home / '.local' / 'state').mkdir(); (self.home / '.local' / 'state').chmod(0o751)
        self.assertEqual(self.run_default()[1], 0)
        self.assertEqual((self.mode(self.home / '.local'), self.mode(self.home / '.local' / 'state'), self.mode(self.state)), (0o755, 0o751, 0o700))
        # An existing private state dir looser than 0700 but not group/world-writable is used as is.
        self.state.chmod(0o755)
        self.assertEqual(self.run_default()[1], 0)
        self.assertEqual(self.mode(self.state), 0o755)

    def test_existing_unsafe_state_dir_is_refused_and_left_alone(self):
        for unsafe in [0o775, 0o757, 0o777]:
            with self.subTest(mode=oct(unsafe)):
                self.state.mkdir(parents=True, exist_ok=True); self.state.chmod(unsafe)
                self.assert_refused_before_anything(*self.run_default())
                self.assertEqual(self.mode(self.state), unsafe)
                self.assertFalse(self.log.exists())

    def test_state_dir_symlink_or_file_is_refused(self):
        target = self.root / 'private'; target.mkdir(mode=0o700)
        (self.home / '.local' / 'state').mkdir(parents=True)
        self.state.symlink_to(target)
        self.assert_refused_before_anything(*self.run_default())
        self.assertEqual(list(target.iterdir()), [])
        self.state.unlink(); self.state.write_text('')
        self.assert_refused_before_anything(*self.run_default())
        self.assertEqual(self.state.read_text(), '')

    def test_concurrently_created_unsafe_dir_is_not_chmodded(self):
        # The dir appears between the existence check and mkdir: FileExistsError, then the parent check decides.
        self.state.mkdir(parents=True); self.state.chmod(0o777)
        real = os.path.lexists
        with patch.object(checked.os.path, 'lexists', side_effect=lambda p: False if Path(p) == self.state else real(p)):
            self.assert_refused_before_anything(*self.run_default())
        self.assertEqual(self.mode(self.state), 0o777)

    def test_bad_or_unusable_home_refuses_and_creates_nothing(self):
        cwd = os.getcwd(); os.chdir(self.root); self.addCleanup(os.chdir, cwd)
        before = sorted(p.name for p in self.root.iterdir())
        for home in [None, '', 'relative/home', '.', str(self.root / 'absent-home')]:
            with self.subTest(home=home):
                env = {k: v for k, v in os.environ.items() if k != 'HOME'}
                if home is not None:
                    env['HOME'] = home
                with patch.dict(os.environ, env, clear=True):
                    self.assert_refused_before_anything(*self.run_default())
                self.assertEqual(sorted(p.name for p in self.root.iterdir()), before)
        # An unwritable HOME (PermissionError from mkdir) refuses the same way; HOME keeps its mode.
        if os.geteuid() != 0:
            self.home.chmod(0o555)
            self.addCleanup(self.home.chmod, 0o755)
            self.assert_refused_before_anything(*self.run_default())
            self.assertEqual(self.mode(self.home), 0o555)

    def test_root_default_is_roots_own_dir_regardless_of_home(self):
        with patch.object(checked.os, 'geteuid', return_value=0):
            self.assertEqual(checked.default_launch_log(), (Path('/root/dazl-launch-log/launch-log.jsonl'), Path('/root')))
        with patch.object(checked.os, 'geteuid', return_value=1000):
            self.assertEqual(checked.default_launch_log(), (self.home / '.local/state/dazl/launch-log.jsonl', self.home))

    def test_explicit_launch_log_override_is_unchanged_and_creates_nothing(self):
        logs = self.root / 'logs'; logs.mkdir(mode=0o700)
        report, code = self.run_default(log_path=str(logs / 'override.jsonl'))
        self.assertEqual(code, 0)
        self.assertEqual(len((logs / 'override.jsonl').read_text().splitlines()), 1)
        self.assertFalse((self.home / '.local').exists())
        self.sentinel.unlink(); self.ci.reset_mock()
        for bad in [str(self.root / 'absent' / 'x.jsonl'), '']:
            with self.subTest(override=bad):
                self.assert_refused_before_anything(*self.run_default(log_path=bad))
                self.assertFalse((self.root / 'absent').exists()); self.assertFalse((self.home / '.local').exists())

    def test_cli_without_launch_log_uses_the_shipped_default(self):
        env = dict(os.environ, HOME=str(self.home))
        p = subprocess.run([sys.executable, SCRIPT, '--repository', 'gagan114662/dazl', '--commit', COMMIT,
                            '--preflight', json.dumps(self.touch), '--launch', json.dumps(self.touch)],
                           env=env, capture_output=True, text=True, timeout=60)
        # bind_launch refuses this launch argv before any network or child: the run is still recorded.
        self.assertEqual((p.returncode, json.loads(p.stdout)), (1, {'status': 'ci_refused', 'launch_reached': False}))
        [line] = [json.loads(x) for x in self.log.read_text().splitlines()]
        self.assertEqual((line['status'], line['gates']), ('ci_refused', [{'round': 'initial', 'gate': 'bind_launch', 'result': 'fail', 'code': 'launch_entrypoint'}]))
        self.assertEqual(self.mode(self.state), 0o700); self.assertFalse(self.sentinel.exists())

    def test_docs_name_the_shipped_default(self):
        docs = Path(__file__).with_name('SAFE_LAUNCH.md').read_text()
        self.assertIn('~/' + str(checked.USER_LAUNCH_LOG), docs)
        self.assertIn(str(checked.ROOT_LAUNCH_LOG), docs)
        self.assertNotIn('/home/ubuntu/backups/launch-log', docs)
        self.assertNotIn('/home/ubuntu/backups/launch-log', Path(SCRIPT).read_text())


if __name__ == '__main__':
    unittest.main()
