import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('checked',Path(__file__).with_name('checked_launch.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SHA='a'*40
class Response:
 def __init__(self,value):self.value=value
 def __enter__(self):return self
 def __exit__(self,*a):pass
 def read(self):return json.dumps(self.value).encode()
class CiGateTests(unittest.TestCase):
 def test_live_evidence_rejects_every_incomplete_or_wrong_result(self):
  good=[dict(name=n,head_sha=SHA,status='completed',conclusion='success',app={'slug':'github-actions'})for n in m.REQUIRED_CI]
  variants=[[],good[:-1],good+[good[0]],'malformed']
  for field,value in [('status','in_progress'),('conclusion','failure'),('conclusion',None),('head_sha','b'*40),('app',{'slug':'other'})]:
   rows=[dict(x)for x in good];rows[0][field]=value;variants.append(rows)
  with tempfile.TemporaryDirectory()as tmp:
   token=Path(tmp)/'token';token.write_text('synthetic')
   for rows in variants:
    def get(req,**kw):return Response({'object':{'sha':SHA}}if'git/ref'in req.full_url else {'total_count':len(rows),'check_runs':rows})
    with patch.object(m.urllib.request,'urlopen',side_effect=get),self.assertRaises(Exception):m.require_ci('gagan114662/dazl',SHA,str(token))
   def get(req,**kw):return Response({'object':{'sha':SHA}}if'git/ref'in req.full_url else {'total_count':len(good),'check_runs':good})
   with patch.object(m.urllib.request,'urlopen',side_effect=get):m.require_ci('gagan114662/dazl',SHA,str(token))
 def test_ci_refusal_inside_run_cannot_reach_mutation(self):
  for error in [ValueError('pending'),ValueError('missing'),ValueError('malformed'),OSError('network')]:
   with patch.object(m,'bind_launch'),patch.object(m,'require_ci',side_effect=error),patch.object(m.subprocess,'run')as child:
    r,c=m.run([['preflight']],['launch']);self.assertEqual(c,1);self.assertFalse(r['launch_reached']);child.assert_not_called()
 def test_ci_rechecked_after_preflights(self):
  with patch.object(m,'bind_launch'),patch.object(m,'require_ci',side_effect=[None,ValueError('changed')]),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0))as child:
   r,c=m.run([['preflight']],['launch']);self.assertEqual(c,1);self.assertFalse(r['launch_reached']);self.assertEqual(child.call_count,1)
 def test_shell_ignoring_nonzero_cannot_launch_without_ci_contract(self):
  with tempfile.TemporaryDirectory()as tmp:
   sentinel=Path(tmp)/'launched';launch=[sys.executable,'-c','from pathlib import Path;Path('+repr(str(sentinel))+').touch()']
   r=subprocess.run([sys.executable,str(Path(m.__file__)),'--preflight',json.dumps([sys.executable,'-c','pass']),'--launch',json.dumps(launch)],capture_output=True)
   # Even if caller continues after this error, no launch happened inside the entrypoint.
   self.assertNotEqual(r.returncode,0);self.assertFalse(sentinel.exists())

 def test_launch_identity_cannot_differ_from_checked_commit(self):
  safe=str(Path(m.__file__).with_name('safe_launch.py'))
  m.bind_launch([sys.executable,safe,'--commit',SHA,'--execute'],SHA)
  for launch in [[sys.executable,safe,'--commit','b'*40,'--execute'],[sys.executable,safe,'--commit',SHA],[sys.executable,'/tmp/other.py','--commit',SHA,'--execute'],[sys.executable,safe,'--commit',SHA,'--commit',SHA,'--execute']]:
   with self.assertRaises(ValueError):m.bind_launch(launch,SHA)
 def test_shell_continues_but_pending_or_malformed_ci_never_mutates(self):
  # CLI runs in a fresh child; fixture injects only HTTPS results, never bypasses real gate or launch binding.
  script=str(Path(m.__file__))
  with tempfile.TemporaryDirectory() as tmp:
   tmp=Path(tmp);token=tmp/'token';token.write_text('synthetic');sentinel=tmp/'mutation'
   fixture=tmp/'sitecustomize.py'
   for state in ['in_progress','malformed','missing','failure','network']:
    # HTTPS fixture is a separate process: production CLI, parsing, checks and binding are unchanged.
    fixture.write_text('import urllib.request,json\nSTATE='+repr(state)+'\nSHA='+repr(SHA)+'\nclass R:\n def __enter__(self):return self\n def __exit__(self,*a):pass\n def read(self):\n  if "git/ref" in self.u:return json.dumps({"object":{"sha":SHA}}).encode()\n  if STATE=="malformed":return b"not json"\n  rows=[dict(name=n,head_sha=SHA,status="completed",conclusion="success",app={"slug":"github-actions"})for n in ["browser","migrations","test-sqlite","test-postgres","fail-closed"]]\n  if STATE=="missing":rows.pop()\n  if STATE=="in_progress":rows[0]["status"]="in_progress"\n  if STATE=="failure":rows[0]["conclusion"]="failure"\n  return json.dumps({"total_count":len(rows),"check_runs":rows}).encode()\ndef get(req,**kw):\n if STATE=="network":raise OSError("unavailable")\n r=R();r.u=req.full_url;return r\nurllib.request.urlopen=get\n')
    import os,shlex
    pre=[sys.executable,'-c','from pathlib import Path;Path('+repr(str(sentinel))+').touch()']
    args=[sys.executable,script,'--repository','gagan114662/dazl','--commit',SHA,'--ci-token-file',str(token),'--preflight',json.dumps(pre),'--launch',json.dumps([sys.executable,str(Path(m.__file__).with_name('safe_launch.py')),'--commit',SHA,'--execute'])]
    r=subprocess.run(' '.join(map(shlex.quote,args))+'; true',shell=True,env={**os.environ,'PYTHONPATH':str(tmp)},capture_output=True,text=True)
    self.assertEqual(r.returncode,0);self.assertFalse(sentinel.exists());self.assertIn('ci_refused',r.stdout)

 def test_main_movement_truncated_results_and_wrong_repo_refuse(self):
  good=[dict(name=n,head_sha=SHA,status='completed',conclusion='success',app={'slug':'github-actions'})for n in m.REQUIRED_CI]
  with tempfile.TemporaryDirectory() as tmp:
   token=Path(tmp)/'token';token.write_text('synthetic')
   for values in [
    [{'object':{'sha':'b'*40}}],
    [{'object':{'sha':SHA}},{'total_count':len(good)+1,'check_runs':good}],
    [{'object':{'sha':SHA}},{'total_count':len(good),'check_runs':good},{'object':{'sha':'b'*40}}],
   ]:
    with patch.object(m.urllib.request,'urlopen',side_effect=[Response(v)for v in values]),self.assertRaises(Exception):m.require_ci('gagan114662/dazl',SHA,str(token))
   with self.assertRaises(ValueError):m.require_ci('other/repo',SHA,str(token))
 def test_positive_ci_launch_runs_exactly_once(self):
  with patch.object(m,'bind_launch'),patch.object(m,'require_ci') as ci,patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0))as child:
   result,code=m.run([['check']],['launch']);self.assertEqual(code,0);self.assertTrue(result['launch_reached']);self.assertEqual(ci.call_count,2);self.assertEqual(child.call_count,2);self.assertEqual(child.call_args.args[0],['launch'])
