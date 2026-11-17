"""Exercise the generated command shell without privileged host changes."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

BOOTSTRAP = Path(__file__).resolve().parents[1] / '.github/scripts/ci-container-bootstrap.sh'


class ContainerCommandShellTests(unittest.TestCase):
    def test_each_job_gets_a_valid_machine_id_without_reusing_the_host(self):
        source = BOOTSTRAP.read_text()
        start = source.find('initialize_ci_machine_id() {')
        self.assertGreaterEqual(start, 0, 'job image needs a fresh container-local machine id')
        function = source[start:source.index('\n}', start) + 2]
        with tempfile.TemporaryDirectory() as tmp:
            ids = []
            for index in range(2):
                target = Path(tmp) / str(index)
                target.write_text('')  # ubuntu:24.04 image ships an empty/missing ID
                result = subprocess.run(['bash', '-c', function + '\ninitialize_ci_machine_id "$1"', 'fixture', str(target)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = target.read_text()
                self.assertRegex(value, r'^[0-9a-f]{32}\n$')
                ids.append(value)
            self.assertNotEqual(ids[0], ids[1], 'never copy or fix a shared host identity')

    def test_command_files_are_not_group_or_world_writable_after_sudo(self):
        source = BOOTSTRAP.read_text()
        wrapper = source.split("<<'CI_SHELL'\n", 1)[1].split('\nCI_SHELL', 1)[0]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, body in {
                'id': '#!/bin/sh\nprintf "0\n"\n',
                'chown': '#!/bin/sh\nexit 0\n',
                # Model the privileged boundary resetting the incoming mask.
                # The command shell must establish its own mask AFTER it.
                'sudo': '#!/bin/bash\nwhile [[ "$1" == -* ]]; do case "$1" in -u) shift 2;; *) shift;; esac; done\numask 0000\nexec "$@"\n',
            }.items():
                f = root / name
                f.write_text(body)
                f.chmod(0o755)
            shell = root / 'ci-bash'
            shell.write_text(wrapper)
            command = root / 'command.sh'
            command.write_text('umask; touch "$GITHUB_WORKSPACE/created"; mkdir "$GITHUB_WORKSPACE/directory"\n')
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], GITHUB_WORKSPACE=str(root))
            result = subprocess.run(['bash', str(shell), str(command)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines()[-1], '0022', result.stdout)
            self.assertEqual(stat.S_IMODE((root / 'created').stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE((root / 'directory').stat().st_mode), 0o755)


if __name__ == '__main__':
    unittest.main()
