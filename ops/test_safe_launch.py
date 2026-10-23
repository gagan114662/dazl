import argparse
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import safe_launch as m


class SafeLaunchTest(unittest.TestCase):
    def test_parser_literal_and_fail_closed(self):
        self.assertEqual(m.parse_env('A=abc\nB="two words"\nexport C=abc#fragment\nD=\n# comment\n'),
                         {'A':'abc','B':'two words','C':'abc#fragment','D':''})
        for text in ['A=$(command)', 'A=$HOME', 'A=`cmd`', 'A=two words', 'A="unterminated', 'A=x\nA=y', 'bad-name=value']:
            with self.assertRaises(m.LaunchError): m.parse_env(text)

    def test_real_subprocess_never_outputs_synthetic_secret_on_errors(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); stage=root/'stage'; old=root/'old'
            for folder,commit in [(stage,'a'*40),(old,'b'*40)]:
                (folder/'.next').mkdir(parents=True)
                (folder/'.next/BUILD_ID').write_text('synthetic-build')
                (folder/'.build-commit').write_text(commit)
                (folder/'package.json').write_text('{}')
            env=root/'env'; marker='SYNTHETIC_DO_NOT_OUTPUT_97'
            for content in [f'TOKEN={marker}\n', f'TOKEN="{marker}\n', f'TOKEN=${marker}\n']:
                env.write_text(content);env.chmod(0o600)
                proc=subprocess.run([sys.executable,str(Path(m.__file__)), '--stage',str(stage),'--commit','a'*40,
                    '--rollback-stage',str(old),'--rollback-commit','b'*40,'--env-file',str(env),'--pid','99999999'],capture_output=True,text=True)
                self.assertNotIn(marker,proc.stdout+proc.stderr)
                self.assertNotIn('Traceback',proc.stdout+proc.stderr)
                self.assertNotEqual(proc.returncode,0)

    def args(self, execute=True):
        return argparse.Namespace(stage='/new',commit='a'*40,rollback_stage='/old',rollback_commit='b'*40,env_file='/env',pid=987654,port=3100,execute=execute)

    def test_launch_uses_no_shell_no_env_argv_and_no_output(self):
        with patch.object(m.subprocess,'Popen') as popen:
            m.launch(Path('/new'),{'TOKEN':'synthetic'},3100)
            args,kwargs=popen.call_args
            self.assertEqual(args,(['npm','start'],))
            self.assertNotIn('synthetic',str(args))
            self.assertEqual(kwargs['stdout'],subprocess.DEVNULL)
            self.assertEqual(kwargs['stderr'],subprocess.DEVNULL)
            self.assertEqual(kwargs['stdin'],subprocess.DEVNULL)
            self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('shell',kwargs)

    def run_case(self, execute, waits):
        stack=contextlib.ExitStack()
        stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
        stack.enter_context(patch.object(m,'read_env',return_value={'TOKEN':'synthetic'}))
        stack.enter_context(patch.object(m,'pid_cwd',return_value=Path('/old')))
        stack.enter_context(patch.object(m,'owns_listener',return_value=True))
        stack.enter_context(patch.object(m,'health',return_value='b'*40))
        stack.enter_context(patch.object(m,'await_state',side_effect=waits))
        kill=stack.enter_context(patch.object(m.os,'kill'))
        killpg=stack.enter_context(patch.object(m.os,'killpg'))
        launch=stack.enter_context(patch.object(m,'launch',side_effect=[Mock(pid=111),Mock(pid=222)]))
        with stack: result=m.run(self.args(execute))
        return result,kill,killpg,launch

    def test_dryrun_never_signals_or_starts(self):
        result,kill,_,launch=self.run_case(False,[])
        self.assertEqual(result['status'],'preflight_only');kill.assert_not_called();launch.assert_not_called()

    def test_success_and_rollback_order(self):
        result,kill,_,launch=self.run_case(True,[True,True])
        self.assertEqual(result['status'],'deployed');kill.assert_called_once_with(987654,m.signal.SIGTERM)
        self.assertEqual(launch.call_count,1)
        result,_,killpg,launch=self.run_case(True,[True,False,True,True])
        self.assertEqual(result['status'],'rolled_back')
        self.assertEqual([c.args[0] for c in launch.call_args_list],[Path('/new'),Path('/old')])
        killpg.assert_called_once_with(111,m.signal.SIGTERM)

    def test_stuck_old_listener_never_launches_new(self):
        result,_,_,launch=self.run_case(True,[False])
        self.assertEqual(result['status'],'old_listener_did_not_stop');launch.assert_not_called()

    def test_wrong_listener_blocks_before_signal(self):
        with patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]), patch.object(m,'read_env',return_value={}), patch.object(m,'pid_cwd',return_value=Path('/old')), patch.object(m,'owns_listener',return_value=False), patch.object(m.os,'kill') as kill:
            with self.assertRaisesRegex(m.LaunchError,'pid_listener_mismatch'):m.run(self.args())
            kill.assert_not_called()


if __name__=='__main__': unittest.main()
