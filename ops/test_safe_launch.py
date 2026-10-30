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


REAL_GATE = m.check_gate_report


def gate_report(path, **over):
    report = {'tool':'dazl-deploy-gate','ok':True,'decision':'allowed','repo':'gagan114662/dazl','branch':'main','commit':'a'*40,
              'required':['test-sqlite','test-postgres','browser','migrations'],
              'checks':{'test-sqlite':'success','test-postgres':'success','browser':'success','migrations':'success'},
              'checked_at':m.time.strftime('%Y-%m-%dT%H:%M:%S.000Z', m.time.gmtime())}
    report.update(over)
    Path(path).write_text(m.json.dumps(report))
    return str(path)


class SafeLaunchTest(unittest.TestCase):
    def setUp(self):
        # every orchestration test below starts with an allowed gate; the gate's own tests use REAL_GATE
        patcher = patch.object(m, 'check_gate_report')
        patcher.start(); self.addCleanup(patcher.stop)

    def test_gate_report_allows_only_that_commit_green_on_main_recent_and_complete(self):
        with tempfile.TemporaryDirectory() as d:
            ok = gate_report(Path(d)/'ok.json')
            REAL_GATE(ok, 'a'*40)
            now = m.time.time()
            for over, code in [
                ({'commit':'c'*40}, 'gate_commit_mismatch'),
                ({'ok':False,'decision':'blocked'}, 'gate_not_allowed'),
                ({'ok':False,'decision':'pending'}, 'gate_not_allowed'),
                ({'decision':'pending'}, 'gate_not_allowed'),
                ({'checks':{'test-sqlite':'success','test-postgres':'pending','browser':'success','migrations':'success'}}, 'gate_not_allowed'),
                ({'branch':'feature'}, 'gate_scope_insufficient'),
                ({'required':['browser']}, 'gate_scope_insufficient'),
                ({'tool':'something-else'}, 'gate_report_unreadable'),
                ({'checked_at':m.time.strftime('%Y-%m-%dT%H:%M:%S.000Z', m.time.gmtime(now - 7*3600))}, 'gate_report_stale'),
                ({'checked_at':m.time.strftime('%Y-%m-%dT%H:%M:%S.000Z', m.time.gmtime(now + 3600))}, 'gate_report_stale'),
                ({'checked_at':'yesterday'}, 'gate_report_unreadable'),
            ]:
                f = gate_report(Path(d)/'r.json', **over)
                with self.assertRaisesRegex(m.LaunchError, code): REAL_GATE(f, 'a'*40)
            with self.assertRaisesRegex(m.LaunchError, 'gate_report_required'): REAL_GATE(str(Path(d)/'missing.json'), 'a'*40)
            (Path(d)/'bad.json').write_text('{not json')
            with self.assertRaisesRegex(m.LaunchError, 'gate_report_unreadable'): REAL_GATE(str(Path(d)/'bad.json'), 'a'*40)
            os.symlink(ok, Path(d)/'link.json')
            with self.assertRaisesRegex(m.LaunchError, 'gate_report_required'): REAL_GATE(str(Path(d)/'link.json'), 'a'*40)

    def test_run_refuses_without_an_allowed_gate_before_reading_env_or_signalling(self):
        with tempfile.TemporaryDirectory() as d, contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(m, 'check_gate_report', REAL_GATE))
            stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
            read_env = stack.enter_context(patch.object(m,'read_env'))
            kill = stack.enter_context(patch.object(m.os,'kill')); launch = stack.enter_context(patch.object(m,'launch'))
            args = self.args(); args.gate_report = gate_report(Path(d)/'g.json', ok=False, decision='blocked')
            with self.assertRaisesRegex(m.LaunchError, 'gate_not_allowed'): m.run(args)
            read_env.assert_not_called(); kill.assert_not_called(); launch.assert_not_called()

    def test_parser_literal_and_fail_closed(self):
        self.assertEqual(m.parse_env('A=abc\nB="two words"\nexport C=abc#fragment\nD=\n# comment\n'),
                         {'A':'abc','B':'two words','C':'abc#fragment','D':''})
        self.assertEqual(m.parse_env('ADDRESS=123 Example St, Unit 2\n'), {'ADDRESS':'123 Example St, Unit 2'})
        for text in ['A=$(command)', 'A=$HOME', 'A=`cmd`', 'A="unterminated', 'A=x\nA=y', 'bad-name=value', r'A=abc\def']:
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
                    '--rollback-stage',str(old),'--rollback-commit','b'*40,'--env-file',str(env),'--pid','99999999','--backup',str(root/'backup'),'--backup-db',str(root/'db'),'--gate-report',gate_report(root/'gate.json')],capture_output=True,text=True)
                self.assertNotIn(marker,proc.stdout+proc.stderr)
                self.assertNotIn('Traceback',proc.stdout+proc.stderr)
                self.assertNotEqual(proc.returncode,0)

    def args(self, execute=True):
        return argparse.Namespace(stage='/new',commit='a'*40,rollback_stage='/old',rollback_commit='b'*40,env_file='/env',pid=987654,port=3100,execute=execute,gate_report='/gate.json')

    def test_launch_uses_no_shell_no_env_argv_and_no_output(self):
        with patch.object(m,'RUNTIME',['/usr/bin/node','/usr/lib/npm-cli.js']), patch.object(m.subprocess,'Popen') as popen:
            m.launch(Path('/new'),{'TOKEN':'synthetic'},3100)
            args,kwargs=popen.call_args
            self.assertEqual(args,(['/usr/bin/node','/usr/lib/npm-cli.js','start'],))
            self.assertNotIn('synthetic',str(args))
            self.assertEqual(kwargs['stdout'],subprocess.DEVNULL)
            self.assertEqual(kwargs['stderr'],subprocess.DEVNULL)
            self.assertEqual(kwargs['stdin'],subprocess.DEVNULL)
            self.assertTrue(kwargs['start_new_session'])
            self.assertNotIn('shell',kwargs)

    def run_case(self, execute, waits):
        stack=contextlib.ExitStack()
        stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
        stack.enter_context(patch.object(m,'read_env',return_value={'TOKEN':'synthetic','DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid'}))
        stack.enter_context(patch.object(m,'pid_cwd',return_value=Path('/old')))
        stack.enter_context(patch.object(m,'owns_listener',return_value=True))
        stack.enter_context(patch.object(m,'health',return_value='b'*40))
        stack.enter_context(patch.object(m,'await_state',side_effect=waits))
        stack.enter_context(patch.object(m,'check_database_backup'))
        stack.enter_context(patch.object(m,'pin_executables',return_value=['/usr/bin/node','/usr/lib/npm-cli.js']))
        stack.enter_context(patch.object(m,'check_process'))
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

    def test_missing_env_and_path_override_fail_before_signal(self):
        for env, expected in [({},'required_env_missing_DB_PATH'), ({'DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid','PATH':'/evil'},'runtime_env_override_refused')]:
            with patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]), patch.object(m,'read_env',return_value=env), patch.object(m.os,'kill') as kill:
                with self.assertRaisesRegex(m.LaunchError,expected):m.run(self.args())
                kill.assert_not_called()

    def test_wrong_database_or_missing_verified_backup_refused(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/'db'; backup=Path(d)/'backup'
            for p in [db,backup]:
                with sqlite3.connect(p) as conn:conn.execute('CREATE TABLE x(id INTEGER)')
            args=argparse.Namespace(backup=str(backup),backup_db=str(db),backup_verified=True)
            m.check_database_backup({'DB_PATH':str(db)},args)
            for bad in ['',str(Path(d)/'missing')]:
                with self.assertRaises(m.LaunchError):m.check_database_backup({'DB_PATH':bad},args)
            args.backup_verified=False
            with self.assertRaisesRegex(m.LaunchError,'backup_verification_required'):m.check_database_backup({'DB_PATH':str(db)},args)

    def test_observed_ancestry_only_and_identity_failures(self):
        def rows():
            return [dict(pid=10,ppid=11,comm='next-server (v1',uid=os.getuid(),cwd=Path('/old'),cgroup='0::/user.slice/session.scope'),
                    dict(pid=11,ppid=12,comm='sh',uid=os.getuid(),cwd=Path('/old'),cgroup='0::/user.slice/session.scope'),
                    dict(pid=12,ppid=1,comm='npm start',uid=os.getuid(),cwd=Path('/old'),cgroup='0::/user.slice/session.scope')]
        with patch.object(m,'process_identity',side_effect=rows()):m.check_process(10)
        for field,value in [('comm','supervisor'),('uid',999999),('cwd',Path('/other')),('cgroup','0::/system/app.service')]:
            bad=rows();bad[1][field]=value
            with patch.object(m,'process_identity',side_effect=bad), self.assertRaises(m.LaunchError):m.check_process(10)
        bad=rows();bad[2]['ppid']=99
        with patch.object(m,'process_identity',side_effect=bad), self.assertRaises(m.LaunchError):m.check_process(10)

    def test_redirect_handler_never_redirects(self):
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,'redirect',{},'http://evil.invalid'))

    def test_env_owner_symlink_and_permissions_refused(self):
        with tempfile.TemporaryDirectory() as d:
            env=Path(d)/'env';env.write_text('A=synthetic');env.chmod(0o644)
            with self.assertRaisesRegex(m.LaunchError,'env_permissions_refused'):m.read_env(env)
            env.chmod(0o600);link=Path(d)/'link';link.symlink_to(env)
            with self.assertRaisesRegex(m.LaunchError,'env_permissions_refused'):m.read_env(link)
            self.assertEqual(m.read_env(env),{'A':'synthetic'})

    def test_run_gate_failures_never_signal(self):
        # Run orchestration must invoke each real gate, not merely unit-test helpers.
        for gate, code in [('check_database_backup','backup_gate_sentinel'),('pin_executables','runtime_gate_sentinel'),('check_process','supervisor_gate_sentinel')]:
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
                stack.enter_context(patch.object(m,'read_env',return_value={'DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid'}))
                for name in ['check_database_backup','pin_executables','check_process']:
                    stack.enter_context(patch.object(m,name,side_effect=m.LaunchError(code) if name==gate else None))
                stack.enter_context(patch.object(m,'pid_cwd',return_value=Path('/old')))
                stack.enter_context(patch.object(m,'owns_listener',return_value=True))
                stack.enter_context(patch.object(m,'health',return_value='b'*40))
                kill=stack.enter_context(patch.object(m.os,'kill'))
                launch=stack.enter_context(patch.object(m,'launch'))
                stack.enter_context(patch.object(m,'await_state',return_value=True))
                with self.assertRaisesRegex(m.LaunchError,code):m.run(self.args())
                kill.assert_not_called();launch.assert_not_called()

    def test_supervisor_is_rechecked_immediately_before_signal(self):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
            stack.enter_context(patch.object(m,'read_env',return_value={'DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid'}))
            stack.enter_context(patch.object(m,'check_database_backup'))
            stack.enter_context(patch.object(m,'pin_executables'))
            stack.enter_context(patch.object(m,'check_process',side_effect=[None,m.LaunchError('supervisor_changed')]))
            stack.enter_context(patch.object(m,'pid_cwd',return_value=Path('/old')))
            stack.enter_context(patch.object(m,'owns_listener',return_value=True))
            stack.enter_context(patch.object(m,'health',return_value='b'*40))
            kill=stack.enter_context(patch.object(m.os,'kill'))
            with self.assertRaisesRegex(m.LaunchError,'supervisor_changed'):m.run(self.args())
            kill.assert_not_called()

    def test_wrong_listener_blocks_before_signal(self):
        with patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]), patch.object(m,'read_env',return_value={'DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid'}), patch.object(m,'check_database_backup'), patch.object(m,'pin_executables'), patch.object(m,'check_process'), patch.object(m,'pid_cwd',return_value=Path('/old')), patch.object(m,'owns_listener',return_value=False), patch.object(m.os,'kill') as kill:
            with self.assertRaisesRegex(m.LaunchError,'pid_listener_mismatch'):m.run(self.args())
            kill.assert_not_called()


if __name__=='__main__': unittest.main()
