"""Guard: every ops test file must be inside release-preflight CI discovery (#901)."""
import fnmatch
from pathlib import Path
import re
import unittest

OPS = Path(__file__).resolve().parent
WORKFLOW = OPS.parent / '.github' / 'workflows' / 'release-preflight.yml'


def discovery_patterns():
    text = WORKFLOW.read_text()
    found = re.findall(r"unittest discover -s ops -p '([^']+)'", text)
    return found


class CiDiscoveryTest(unittest.TestCase):
    def test_workflow_runs_ops_discovery(self):
        self.assertTrue(discovery_patterns(), 'release-preflight must run unittest discovery over ops')

    def test_every_ops_test_file_is_discovered(self):
        patterns = discovery_patterns()
        test_files = sorted(p.name for p in OPS.glob('test*.py'))
        self.assertIn('test_backup_preflight.py', test_files)
        missed = [name for name in test_files if not any(fnmatch.fnmatch(name, pat) for pat in patterns)]
        self.assertEqual(missed, [], 'ops test files outside CI discovery: %s' % missed)

    def test_no_nested_ops_tests_hidden_from_discovery(self):
        # discover -s ops does not recurse into non-package dirs; keep tests at ops/ top level.
        nested = [str(p.relative_to(OPS)) for p in OPS.rglob('test*.py')
                  if p.parent != OPS and '__pycache__' not in p.parts]
        self.assertEqual(nested, [], 'nested ops tests would be skipped by CI: %s' % nested)


if __name__ == '__main__':
    unittest.main()
