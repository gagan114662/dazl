"""Guard: every ops test file must be run by a release-preflight discovery step (#901).

The workflow runs this file in its own step (`python3 ops/test_ci_discovery.py`), so it does not depend on a discovery pattern.
It reads every `unittest discover -s <dir> -p '<pattern>'` step from the workflow and requires every ops/**/test*.py file to be
reachable from one of them: directly (the file's directory is the start directory) or through packages (every directory between
the start directory and the file has an __init__.py, which is what unittest discovery recurses into).
"""
import fnmatch
from pathlib import Path
import re
import unittest

OPS = Path(__file__).resolve().parent
REPO = OPS.parent
WORKFLOW = REPO / '.github' / 'workflows' / 'release-preflight.yml'


def discovery_steps():
    """(start directory relative to the repo, pattern) for every unittest discover command in the workflow."""
    text = WORKFLOW.read_text()
    return re.findall(r"unittest discover -s (\S+) -p '([^']+)'", text)


def covered(path, steps):
    for start, pattern in steps:
        start_dir = (REPO / start).resolve()
        if not fnmatch.fnmatch(path.name, pattern):
            continue
        try:
            rel = path.parent.relative_to(start_dir)
        except ValueError:
            continue
        # discovery recurses only into packages
        d, ok = start_dir, True
        for part in rel.parts:
            d = d / part
            if not (d / '__init__.py').exists():
                ok = False
                break
        if ok:
            return True
    return False


def ops_test_files():
    return sorted(p for p in OPS.rglob('test*.py') if '__pycache__' not in p.parts)


class CiDiscoveryTest(unittest.TestCase):
    def test_workflow_runs_ops_discovery(self):
        self.assertTrue(discovery_steps(), 'release-preflight must run unittest discovery over ops')

    def test_workflow_runs_this_guard_on_its_own(self):
        # Not through a discovery pattern: a pattern change must not be able to switch the guard off.
        text = WORKFLOW.read_text()
        self.assertRegex(text, r'(?m)^\s*run:\s*python3 ops/test_ci_discovery\.py\s*$', 'the guard needs its own workflow step')

    def test_every_ops_test_file_is_run_by_a_discovery_step(self):
        steps = discovery_steps()
        files = ops_test_files()
        names = [str(p.relative_to(REPO)) for p in files]
        self.assertIn('ops/test_backup_preflight.py', names)
        self.assertIn('ops/staging/test_contain.py', names)
        self.assertIn('ops/staging/test_recovery_point.py', names)
        missed = [str(p.relative_to(REPO)) for p in files if not covered(p, steps)]
        self.assertEqual(missed, [], 'ops test files outside CI discovery: %s' % missed)

    def test_guard_detects_a_nested_directory_without_its_own_step(self):
        # Negative control against the real workflow's steps: the staging file is only covered because of the ops/staging step.
        steps = discovery_steps()
        staging = REPO / 'ops' / 'staging' / 'test_contain.py'
        self.assertTrue(covered(staging, steps))
        self.assertFalse(covered(staging, [s for s in steps if s[0].rstrip('/') != 'ops/staging']))
        self.assertFalse(covered(OPS / 'test_backup_preflight.py', [('ops', 'test_*launch*.py')]))


if __name__ == '__main__':
    unittest.main()
