"""Synthetic git checkouts only. No provider, real process or business data."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('checked_launch.py')
REAL_RUN = subprocess.run


class TargetIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'repo'
        (self.root / 'web').mkdir(parents=True)
        (self.root / 'ops').mkdir()
        shutil.copy(SOURCE, self.root / 'ops/checked_launch.py')
        (self.root / 'ops/safe_launch.py').write_text('# synthetic inner, never executed\n')
        self.git('init', '-q')
        self.git('add', 'ops')
        self.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        self.sha = self.git('rev-parse', 'HEAD').strip()
        (self.root / 'web/.build-commit').write_text(self.sha + '\n')
        spec = importlib.util.spec_from_file_location('identity_fixture', self.root / 'ops/checked_launch.py')
        self.m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.m)
        self.launch = [sys.executable, str(self.root / 'ops/safe_launch.py'), '--stage', str(self.root / 'web'), '--commit', self.sha, '--execute']

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL).decode()

    def test_exact_checkout_passes_and_bytecode_cache_is_not_a_source(self):
        (self.root / 'ops/__pycache__').mkdir(exist_ok=True)
        (self.root / 'ops/__pycache__/safe_launch.cpython-312.pyc').write_bytes(b'synthetic')
        self.m.bind_target(self.launch, self.sha)

    def test_wrong_stage_head_build_and_missing_history_refuse(self):
        for index, value in [(self.launch.index('--stage') + 1, str(self.root / 'missing'))]:
            launch = self.launch.copy(); launch[index] = value
            with self.assertRaises(Exception): self.m.bind_target(launch, self.sha)
        with self.assertRaisesRegex(ValueError, 'head_mismatch'): self.m.bind_target(self.launch, 'b'*40)
        marker = self.root / 'web/.build-commit'; marker.write_text('b'*40)
        with self.assertRaisesRegex(ValueError, 'build_mismatch'): self.m.bind_target(self.launch, self.sha)
        marker.write_text(self.sha)
        shutil.rmtree(self.root / '.git')
        with self.assertRaises(Exception): self.m.bind_target(self.launch, self.sha)

    def test_old_launcher_new_target_refuses_under_new_guard(self):
        # An immutable old launcher with no guard cannot be controlled here.
        # This verifies accidental invocation of this guarded version from a
        # different checkout is refused, not an OS-level bypass prevention.
        with patch.object(self.m, '__file__', str(Path(self.temp.name) / 'old/ops/checked_launch.py')):
            with self.assertRaisesRegex(ValueError, 'helper_path'): self.m.bind_target(self.launch, self.sha)

    def test_mutated_helpers_and_symlink_refuse(self):
        safe = self.root / 'ops/safe_launch.py'; original = safe.read_bytes()
        safe.write_bytes(original + b'# modified\n')
        with self.assertRaisesRegex(ValueError, 'tracked_dirty'): self.m.bind_target(self.launch, self.sha)
        safe.write_bytes(original)
        safe.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'helper_permissions'): self.m.bind_target(self.launch, self.sha)
        safe.chmod(0o644)
        saved = self.root / 'saved'; safe.rename(saved); safe.symlink_to(saved)
        with self.assertRaises(Exception): self.m.bind_target(self.launch, self.sha)

    def test_blob_comparison_survives_git_assume_unchanged(self):
        safe = self.root / 'ops/safe_launch.py'
        self.git('update-index', '--assume-unchanged', 'ops/safe_launch.py')
        safe.write_text('# hidden modified helper\n')
        self.assertFalse(self.git('status', '--porcelain', '--untracked-files=no').strip())
        with self.assertRaisesRegex(ValueError, 'helper_bytes'): self.m.bind_target(self.launch, self.sha)

    def test_stage_marker_and_alternate_inner_paths_refuse(self):
        alias = self.root / 'alias'; alias.symlink_to(self.root / 'web', target_is_directory=True)
        launch = self.launch.copy(); launch[launch.index('--stage') + 1] = str(alias)
        with self.assertRaisesRegex(ValueError, 'stage_symlink'): self.m.bind_target(launch, self.sha)
        launch = self.launch.copy(); launch[1] = str(self.root / 'other.py')
        with self.assertRaisesRegex(ValueError, 'helper_path'): self.m.bind_target(launch, self.sha)
        marker = self.root / 'web/.build-commit'; marker.unlink()
        saved = self.root / 'marker'; saved.write_text(self.sha); marker.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, 'build_mismatch'): self.m.bind_target(self.launch, self.sha)

    def test_build_or_helper_mutated_in_preflight_never_reaches_launch(self):
        for target in [self.root / 'web/.build-commit', self.root / 'ops/safe_launch.py']:
            original = target.read_bytes()
            def child(argv, **kwargs):
                if argv[0] == 'git': return REAL_RUN(argv, **kwargs)
                target.write_bytes(original + b'bad')
                return subprocess.CompletedProcess(argv, 0)
            with patch.object(self.m, 'require_ci'), patch.object(self.m.subprocess, 'run', side_effect=child) as run:
                report, code = self.m.run([['synthetic-preflight']], self.launch, repository='gagan114662/dazl', commit=self.sha)
            self.assertEqual(code, 1); self.assertFalse(report['launch_reached']); self.assertEqual(sum(c.args[0][0] != 'git' for c in run.call_args_list), 1)
            target.write_bytes(original)

    def test_positive_control_launch_once_after_two_real_bindings(self):
        def child(argv, **kwargs):
            return REAL_RUN(argv, **kwargs) if argv[0] == 'git' else subprocess.CompletedProcess(argv, 0)
        with patch.object(self.m, 'require_ci'), patch.object(self.m.subprocess, 'run', side_effect=child) as run:
            report, code = self.m.run([['synthetic-preflight']], self.launch, repository='gagan114662/dazl', commit=self.sha)
        self.assertEqual(code, 0); self.assertTrue(report['launch_reached']); self.assertEqual(sum(c.args[0][0] != 'git' for c in run.call_args_list), 2)
