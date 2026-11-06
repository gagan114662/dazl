import argparse
import contextlib
import io
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import safe_launch as m
import hashlib
import shutil
import sqlite3
from datetime import datetime, timezone

# #911 fixtures: a backup made the supported way (SQLite online backup API) with its create-backup sidecar
# manifest and a passing restore-drill report naming the same bytes. Fixed clock; nothing touches a real host.
NOW = 1_800_000_000.0
def iso(t): return datetime.fromtimestamp(t, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write_manifest(backup, source, created=NOW - 60, **over):
    doc = {'tool':'dazl-create-backup','sourcePath':str(source),'backupPath':str(backup),'sidecarPath':str(backup)+'.json',
           'bytes':Path(backup).stat().st_size,'sha256':sha(backup),'durationMs':1,'createdAt':iso(created), **over}
    Path(str(backup)+'.json').write_text(json.dumps(doc))
def write_drill(path, bk, started=NOW - 30, **over):
    backup = bk
    doc = {'tool':'dazl-restore-drill','started_at':iso(started),'ok':True,'steps':[],'reasons':[],'warnings':[],
           'duration_ms':1,'backup':Path(backup).name,'backup_sha256':sha(backup), **over}
    Path(path).write_text(json.dumps(doc))
def online_backup(source, dest):
    with sqlite3.connect(source) as s, sqlite3.connect(dest) as d: s.backup(d)
    with sqlite3.connect(dest) as d: d.execute('PRAGMA journal_mode=DELETE')
def backup_fixture(root, max_age=3600):
    db = root/'live.db'
    with sqlite3.connect(db) as c: c.execute('CREATE TABLE x(id INTEGER)'); c.execute('INSERT INTO x VALUES (1)')
    backup = root/'dazl-backup-1.db'; online_backup(db, backup)
    write_manifest(backup, db); write_drill(root/'drill.json', backup)
    args = argparse.Namespace(backup=str(backup), backup_db=str(db.resolve()), backup_manifest=None,
                              drill_report=str(root/'drill.json'), backup_max_age_s=max_age)
    return db, backup, args


class SafeLaunchTest(unittest.TestCase):
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
                    '--rollback-stage',str(old),'--rollback-commit','b'*40,'--env-file',str(env),'--pid','99999999','--backup',str(root/'backup'),'--backup-db',str(root/'db')],capture_output=True,text=True)
                self.assertNotIn(marker,proc.stdout+proc.stderr)
                self.assertNotIn('Traceback',proc.stdout+proc.stderr)
                self.assertNotEqual(proc.returncode,0)

    def args(self, execute=True):
        return argparse.Namespace(stage='/new',commit='a'*40,rollback_stage='/old',rollback_commit='b'*40,env_file='/env',pid=987654,port=3100,execute=execute)

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
        stack.enter_context(patch.object(m,'recheck_backup'))
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
        with tempfile.TemporaryDirectory() as d:
            db, backup, args = backup_fixture(Path(d))
            self.assertEqual(m.check_database_backup({'DB_PATH':str(db)},args,now=NOW)['sha256'], sha(backup))
            for bad in ['',str(Path(d)/'missing')]:
                with self.assertRaises(m.LaunchError):m.check_database_backup({'DB_PATH':bad},args,now=NOW)
            args.backup_db=str(Path(d)/'other')
            with self.assertRaisesRegex(m.LaunchError,'backup_verification_required'):m.check_database_backup({'DB_PATH':str(db)},args,now=NOW)

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


STUB = ('import pathlib,signal,sys,time\n'
        'p=pathlib.Path(sys.argv[1])\n'
        'signal.signal(signal.SIGTERM,lambda *a:(p.write_text("SIGTERM"),sys.exit(0)))\n'
        'print("ready",flush=True)\n'
        'time.sleep(120)\n')
ENV = {'DB_PATH':'/db','DAZL_MASTER_KEY':'dummy','PUBLIC_BASE_URL':'https://example.invalid'}


class StatusFileTest(unittest.TestCase):
    """#607: safe_launch reports its own fixed-vocabulary status to a private file."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.hit = self.root/'stub-signalled'
        # A real stand-in listener: any delivered SIGTERM is recorded on disk.
        self.stub = subprocess.Popen([sys.executable,'-c',STUB,str(self.hit)],stdout=subprocess.PIPE,text=True)
        self.assertEqual(self.stub.stdout.readline().strip(),'ready')

    def tearDown(self):
        self.stub.kill(); self.stub.wait(); self.stub.stdout.close(); self.temp.cleanup()

    def argv(self, status, port='3100'):
        return ['safe_launch.py','--stage','/new','--commit','a'*40,'--rollback-stage','/old','--rollback-commit','b'*40,
                '--env-file','/env','--pid',str(self.stub.pid),'--port',port,'--backup','/backup','--backup-db','/db',
                '--drill-report','/drill','--backup-max-age-s','3600','--execute','--status-file',str(status)]

    def main(self, argv, overrides=None, waits=None):
        overrides = overrides or {}
        defaults = {'stage_path':[Path('/new'),Path('/old')],'read_env':ENV,'check_database_backup':None,'recheck_backup':None,
                    'pin_executables':['/usr/bin/node','/usr/lib/npm-cli.js'],'check_process':None,
                    'pid_cwd':Path('/old'),'owns_listener':True,'health':'b'*40}
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for name, value in {**defaults, **overrides}.items():
                if isinstance(value, BaseException) or isinstance(value, list) and name != 'pin_executables':
                    stack.enter_context(patch.object(m,name,side_effect=value))
                else:
                    stack.enter_context(patch.object(m,name,return_value=value))
            if waits is not None: stack.enter_context(patch.object(m,'await_state',side_effect=waits))
            kill = stack.enter_context(patch.object(m.os,'kill',wraps=os.kill))
            killpg = stack.enter_context(patch.object(m.os,'killpg',wraps=os.killpg))
            launch = stack.enter_context(patch.object(m,'launch',side_effect=[Mock(pid=111),Mock(pid=222)]))
            stack.enter_context(patch('sys.argv',argv))
            stack.enter_context(contextlib.redirect_stdout(out))
            code = m.main()
        return code, json.loads(out.getvalue()), kill, killpg, launch

    def test_every_pre_sigterm_error_writes_status_file_and_signals_nothing(self):
        cases = [
            ('invalid_process_or_port', {}, '80'),
            ('build_missing', {'stage_path': m.LaunchError('build_missing')}, '3100'),
            ('same_stage_refused', {'stage_path': [Path('/new'), Path('/new')]}, '3100'),
            ('env_permissions_refused', {'read_env': m.LaunchError('env_permissions_refused')}, '3100'),
            ('required_env_missing_DB_PATH', {'read_env': {}}, '3100'),
            ('runtime_env_override_refused', {'read_env': {**ENV, 'NODE_OPTIONS': '--require=/x'}}, '3100'),
            ('verified_backup_required', {'check_database_backup': m.LaunchError('verified_backup_required')}, '3100'),
            ('runtime_untrusted', {'pin_executables': m.LaunchError('runtime_untrusted')}, '3100'),
            ('unexpected_process_ancestry', {'check_process': m.LaunchError('unexpected_process_ancestry')}, '3100'),
            ('env_port_mismatch', {'read_env': {**ENV, 'PORT': '3999'}}, '3100'),
            ('pid_stage_mismatch', {'pid_cwd': Path('/elsewhere')}, '3100'),
            ('pid_listener_mismatch', {'owns_listener': [False]}, '3100'),
            ('live_commit_mismatch', {'health': 'c'*40}, '3100'),
            ('pid_changed', {'owns_listener': [True, False]}, '3100'),
            ('supervised_process_refused', {'check_process': [None, m.LaunchError('supervised_process_refused')]}, '3100'),
            ('operation_failed', {'pin_executables': RuntimeError('SYNTHETIC_SECRET_607 in an exception message')}, '3100'),
        ]
        for index, (expected, overrides, port) in enumerate(cases):
            with self.subTest(expected=expected):
                status = self.root/('status-%d.json' % index)
                code, printed, kill, killpg, launch = self.main(self.argv(status, port), overrides)
                self.assertEqual(code, 1)
                self.assertEqual(status.stat().st_mode & 0o777, 0o600)
                written = json.loads(status.read_text())
                self.assertEqual(written, printed)
                self.assertEqual(written['status'], expected); self.assertEqual(written['phase'], 'preflight')
                self.assertEqual(written['service_changed'], 'unknown' if expected == 'operation_failed' else False)
                self.assertEqual(set(written), {'status', 'service_changed', 'phase'})
                self.assertNotIn('SYNTHETIC_SECRET_607', status.read_text())
                kill.assert_not_called(); killpg.assert_not_called(); launch.assert_not_called()
                self.assertIsNone(self.stub.poll()); self.assertFalse(self.hit.exists())

    def test_status_file_is_exclusive_and_refused_before_any_gate(self):
        existing = self.root/'existing.json'; existing.write_text('keep')
        target = self.root/'target.json'; target.write_text('keep')
        link = self.root/'link.json'; link.symlink_to(target)
        for path in [existing, link, self.root/'missing-dir'/'status.json']:
            with self.subTest(path=path.name), patch.object(m,'run') as gate:
                code, printed, kill, _, _ = self.main(self.argv(path))
                self.assertEqual((code, printed), (1, {'status': 'status_file_unavailable', 'service_changed': False, 'phase': 'preflight'}))
                gate.assert_not_called(); kill.assert_not_called()
        self.assertEqual(existing.read_text(), 'keep'); self.assertEqual(target.read_text(), 'keep')
        self.assertIsNone(self.stub.poll()); self.assertFalse(self.hit.exists())

    def test_post_signal_outcomes_record_their_phase(self):
        for waits, expected, phase in [([True, True], 'deployed', 'new_start'), ([True, False, True, True], 'rolled_back', 'rollback_start'), ([False], 'old_listener_did_not_stop', 'old_signalled')]:
            with self.subTest(expected=expected), patch.object(m.os, 'kill') as fake_kill:
                status = self.root/(expected + '.json')
                code, printed, _, _, _ = self.main(self.argv(status), waits=waits)
                written = json.loads(status.read_text())
                self.assertEqual(written, printed); self.assertEqual((written['status'], written['phase']), (expected, phase))
                self.assertTrue(written['service_changed']); fake_kill.assert_called_once()

    def test_status_vocabulary_covers_every_code_the_helper_can_report(self):
        import ast
        tree = ast.parse(Path(m.__file__).read_text())
        found = {'required_env_missing_' + n for n in ['DB_PATH', 'DAZL_MASTER_KEY', 'PUBLIC_BASE_URL']}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, 'id', None) == 'LaunchError' and node.args and isinstance(node.args[0], ast.Constant):
                found.add(node.args[0].value)
            if isinstance(node, ast.Dict):
                for key, value in zip(node.keys, node.values):
                    if isinstance(key, ast.Constant) and key.value == 'status' and isinstance(value, ast.Constant):
                        found.add(value.value)
        self.assertGreater(len(found), 35)
        self.assertEqual(found - m.STATUS_CODES, set())
        self.assertTrue(all(re.fullmatch(r'[A-Za-z0-9_]+', code) for code in m.STATUS_CODES | m.PHASES))



class BackupEvidenceTest(unittest.TestCase):
    """#911: the launch gate binds the backup to fresh, source-matched create-backup + restore-drill evidence."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.db, self.backup, self.args = backup_fixture(self.root)
        self.env = {'DB_PATH': str(self.db)}

    def tearDown(self): self.temp.cleanup()

    def refused(self, code):
        with self.assertRaisesRegex(m.LaunchError, '^' + code + '$'):
            m.check_database_backup(self.env, self.args, now=NOW)

    def test_fresh_online_backup_with_matching_drill_passes(self):
        pin = m.check_database_backup(self.env, self.args, now=NOW)
        self.assertEqual(pin['sha256'], sha(self.backup)); m.recheck_backup(pin)

    def test_wal_blind_raw_copy_is_refused(self):
        live = sqlite3.connect(self.db); live.execute('PRAGMA journal_mode=WAL'); live.execute('INSERT INTO x VALUES (2)'); live.commit()
        try:
            raw = self.root/'raw.db'; shutil.copyfile(self.db, raw)
            self.args.backup = str(raw); self.refused('backup_manifest_required')
            # even a forged-looking drill for it does not help without the creator's manifest
            write_drill(self.root/'drill.json', raw); self.refused('backup_manifest_required')
        finally: live.close()

    def test_unrelated_source_is_refused(self):
        other = self.root/'other.db'
        with sqlite3.connect(other) as c: c.execute('CREATE TABLE y(id INTEGER)')
        write_manifest(self.backup, other); self.refused('backup_manifest_mismatch')

    def test_stale_or_future_manifest_is_refused(self):
        write_manifest(self.backup, self.db, created=NOW - 3601); self.refused('backup_stale')
        write_manifest(self.backup, self.db, created=NOW + 3600); self.refused('backup_stale')

    def test_cli_default_policy_is_24_hours(self):
        self.assertEqual(m.DEFAULT_BACKUP_MAX_AGE_S, 86400)
        argv = ['safe_launch.py','--stage','/new','--commit','a'*40,'--rollback-stage','/old','--rollback-commit','b'*40,
                '--env-file','/env','--pid','1','--backup','/b','--backup-db','/db']
        seen = {}
        with patch('sys.argv', argv), patch.object(m, 'run', side_effect=lambda a: (seen.setdefault('a', a), (_ for _ in ()).throw(m.LaunchError('invalid_process_or_port')))[1]), \
                contextlib.redirect_stdout(io.StringIO()):
            try: m.main()
            except (SystemExit, m.LaunchError): pass
        self.assertEqual(seen['a'].backup_max_age_s, 86400)

    def test_24h_default_refuses_older_backup(self):
        self.args.backup_max_age_s = m.DEFAULT_BACKUP_MAX_AGE_S
        write_manifest(self.backup, self.db, created=NOW - 86401); self.refused('backup_stale')
        write_manifest(self.backup, self.db, created=NOW - 86000); write_drill(self.root/'drill.json', self.backup, started=NOW - 85000)
        m.check_database_backup(self.env, self.args, now=NOW)

    def test_policy_window_must_be_explicit(self):
        for bad in [None, 0, -1, True, 8 * 24 * 3600, '3600']:
            self.args.backup_max_age_s = bad; self.refused('backup_policy_required')

    def test_tampered_bytes_are_refused(self):
        with sqlite3.connect(self.backup) as c: c.execute('INSERT INTO x VALUES (99)')
        self.refused('backup_manifest_mismatch')

    def test_wrong_or_failed_drill_is_refused(self):
        write_drill(self.root/'drill.json', self.backup, **{'backup': 'dazl-backup-other.db'}); self.refused('backup_drill_mismatch')
        write_drill(self.root/'drill.json', self.backup, backup_sha256='0'*64); self.refused('backup_drill_mismatch')
        write_drill(self.root/'drill.json', self.backup, ok=False); self.refused('backup_drill_mismatch')
        write_drill(self.root/'drill.json', self.backup, started=NOW - 600); self.refused('backup_stale')  # before the backup existed
        write_drill(self.root/'drill.json', self.backup, tool='something-else'); self.refused('backup_drill_required')
        self.args.drill_report = None; self.refused('backup_drill_required')
        self.args.drill_report = str(self.root/'missing.json'); self.refused('backup_drill_required')

    def test_bare_boolean_is_not_evidence(self):
        Path(str(self.backup)+'.json').unlink(); self.args.backup_verified = True
        self.refused('backup_manifest_required')

    def test_post_verification_swap_is_refused_before_any_signal(self):
        pin = m.check_database_backup(self.env, self.args, now=NOW)
        swapped = self.root/'swap.db'; online_backup(self.db, swapped)
        with sqlite3.connect(swapped) as c: c.execute('INSERT INTO x VALUES (7)')
        os.replace(swapped, self.backup)
        with self.assertRaisesRegex(m.LaunchError, 'backup_changed'): m.recheck_backup(pin)
        with self.assertRaisesRegex(m.LaunchError, 'backup_changed'): m.recheck_backup(None)

    def test_swap_after_preflight_stops_run_before_sigterm(self):
        pin = m.check_database_backup(self.env, self.args, now=NOW)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(m,'stage_path',side_effect=[Path('/new'),Path('/old')]))
            stack.enter_context(patch.object(m,'read_env',return_value={**ENV,'DB_PATH':str(self.db)}))
            stack.enter_context(patch.object(m,'check_database_backup',return_value=pin))
            stack.enter_context(patch.object(m,'pin_executables',return_value=['/usr/bin/node']))
            stack.enter_context(patch.object(m,'check_process'))
            stack.enter_context(patch.object(m,'pid_cwd',return_value=Path('/old')))
            stack.enter_context(patch.object(m,'owns_listener',return_value=True))
            stack.enter_context(patch.object(m,'health',return_value='b'*40))
            kill = stack.enter_context(patch.object(m.os,'kill'))
            self.backup.write_bytes(self.backup.read_bytes() + b'x')
            args = argparse.Namespace(pid=4321, port=3100, stage='/new', commit='a'*40, rollback_stage='/old', rollback_commit='b'*40,
                                      env_file='/env', execute=True)
            with self.assertRaisesRegex(m.LaunchError, 'backup_changed'): m.run(args)
            kill.assert_not_called()

if __name__=='__main__': unittest.main()
