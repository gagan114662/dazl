"""Repository hygiene: Python bytecode caches must never be tracked (#896).

Named to match release-preflight's `test_*launch*.py` discovery glob.
"""
import os
import re
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = re.compile(r"(^|/)__pycache__/|\.py[cod]$")


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout.decode("utf-8", "surrogateescape")
    return [p for p in out.split("\0") if p]


class TrackedPythonCachesTest(unittest.TestCase):
    def test_no_tracked_bytecode(self):
        files = tracked_files()
        self.assertTrue(files, "git ls-files returned nothing; not a checkout?")
        bad = [p for p in files if CACHE.search(p)]
        self.assertEqual(bad, [], "tracked Python caches: %s" % bad)

    def test_pattern_matches_known_offenders(self):
        for p in ("ops/__pycache__/safe_launch.cpython-313.pyc", "x/y.pyo", "a.pyd"):
            self.assertRegex(p, CACHE)
        for p in ("ops/safe_launch.py", "ops/pycache_notes.md"):
            self.assertNotRegex(p, CACHE)

    def test_ignore_rules(self):
        def ignored(path):
            return subprocess.run(
                ["git", "check-ignore", "-q", "--no-index", path], cwd=ROOT
            ).returncode == 0

        self.assertTrue(ignored("ops/__pycache__/safe_launch.cpython-313.pyc"))
        self.assertTrue(ignored("web/foo.pyc"))
        self.assertTrue(ignored('{"level":"error","msg":"x"}'))
        self.assertFalse(ignored("ops/safe_launch.py"))
        self.assertFalse(ignored("web/package.json"))

    def test_gitignore_braces_are_escaped(self):
        # `/{"level"*` is accepted by git but is an unclosed alternate group for ripgrep ("error parsing glob"), which breaks `rg --files`
        # on any tree carrying this file. git check-ignore cannot tell the two forms apart, so check the text: every non-comment line
        # of the root .gitignore that contains a brace has it escaped.
        for n, line in enumerate(open(os.path.join(ROOT, ".gitignore")).read().splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            self.assertNotRegex(line, r"(?<!\\)[{}]", ".gitignore line %d has an unescaped brace: %r" % (n, line))


if __name__ == "__main__":
    unittest.main()
