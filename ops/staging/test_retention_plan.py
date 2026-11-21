import copy
from datetime import datetime, timezone
import runpy
from pathlib import Path
import unittest

here=Path(__file__).parent
module=runpy.run_path(here/'retention-plan.py')
plan=module['plan']
R=module['RELEASES']; S=module['SNAPSHOTS']
NOW=datetime(2026,11,21,12,0,tzinfo=timezone.utc)

def fixture():
    def release(n):
        return dict(name=n*40,commit=n*40,direct_directory=True,complete_regular_marker=True,
            immutable_build_verified=True,subtree_no_untrusted_links_or_mounts=True,no_external_references=True,
            subtree_older_than_one_hour=True,rollback_and_recovery_verified=True,completed_at=f'2026-11-{int(n):02d}T10:00:00Z')
    def snapshot(i):
        return dict(name=f'opaque-{i}',captured_at=f'2026-11-{i:02d}T10:00:00Z',environment='staging',
            manifest_commit='1'*40,signed_or_root_inventory_manifest_bound=True,integrity_verified=True,restore_verified=True,
            single_regular_file=True,not_any_live_db_or_sidecar=True,no_open_or_restore_references=True)
    return dict(schema='dazl-staging-retention-v1',observed_at='2026-11-21T11:55:00Z',
      release_root=R,snapshot_root=S,exact_installed_units=True,canonical_roots_and_ownership=True,
      mount_snapshot_complete=True,protected_db_identity_complete=True,app_worker_refs_complete=True,
      pending_refs_complete=True,captured_under_staging_lock=True,mounts=['/'],
      refs=dict(live='8'*40,current_link='8'*40,app='8'*40,health='8'*40,state='8'*40,
                previous='7'*40,worker='6'*40,pending=['5'*40]),
      releases=[release(str(i)) for i in range(1,9)], snapshots=[snapshot(i) for i in range(1,10)])

def rows(d):
    return {r['path'].rsplit('/',1)[-1]:r for r in plan(d,NOW)['entries']}

class Retention(unittest.TestCase):
    def test_live_previous_worker_pending_and_seven_snapshots(self):
        result=rows(fixture())
        for i in range(5,9): self.assertEqual(result[str(i)*40]['action'],'keep')
        self.assertEqual(result['1'*40]['action'],'candidate')
        self.assertEqual(result['4'*40]['action'],'candidate')
        self.assertEqual({s for s,r in result.items() if s.startswith('opaque-') and r['action']=='candidate'},
                         {'opaque-1','opaque-2'})
    def test_mounted_recent_unclassified_and_nonstaging(self):
        d=fixture()
        d['mounts'] += [R+'/'+'1'*40+'/web/node_modules',S]
        d['releases'][1]['subtree_older_than_one_hour']=False
        d['releases'][2]['complete_regular_marker']=False
        d['snapshots'][0]['environment']='production'
        result=rows(d)
        for i in range(1,4): self.assertEqual(result[str(i)*40]['action'],'keep')
        self.assertTrue(all(r['action']=='keep' for n,r in result.items() if n.startswith('opaque-')))
    def test_seven_ties_and_database_link_never_candidates(self):
        d=fixture()
        d['snapshots'][1]['captured_at']=d['snapshots'][2]['captured_at']
        d['snapshots'][0]['not_any_live_db_or_sidecar']=False
        result=rows(d)
        self.assertTrue(all(r['action']=='keep' for n,r in result.items() if n.startswith('opaque-')))
    def test_mismatch_expiry_previous_recovery_worker_and_scope_abort(self):
        for key, value in [('snapshot_root','/var/lib/dazl-staging-backups'),
                           ('observed_at','2026-11-21T11:00:00Z'),
                           ('mount_snapshot_complete',False), ('captured_under_staging_lock',False)]:
            d=fixture();d[key]=value
            with self.assertRaises(ValueError): plan(d,NOW)
        for key,value in [('health','9'*40),('worker','9'*40),('previous','9'*40)]:
            d=fixture();d['refs'][key]=value
            with self.assertRaises(ValueError): plan(d,NOW)
        d=fixture();d['releases'][6]['rollback_and_recovery_verified']=False
        with self.assertRaises(ValueError): plan(d,NOW)
