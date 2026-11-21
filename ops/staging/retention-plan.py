#!/usr/bin/env python3
"""Read a redacted staging operator inventory on stdin; print a proposal, never apply it."""
from datetime import datetime, timezone
from pathlib import PurePosixPath
import json
import re
import sys

RELEASES = '/srv/dazl-staging-releases'
SHA = re.compile(r'[a-f0-9]{40}')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,179}')
# Checked against the installed unit by the operator; not inferred from filenames.
SNAPSHOTS = '/home/ubuntu/dazl-data'

def full_sha(s):
    return isinstance(s, str) and SHA.fullmatch(s) is not None

def parsed_time(s):
    if not isinstance(s,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',s):
        raise ValueError('UTC timestamps required')
    return datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)

def flag(row, name):
    return row.get(name) is True

def plan(doc, now):
    if not isinstance(doc,dict) or doc.get('schema') != 'dazl-staging-retention-v1':
        raise ValueError('unrecognized inventory')
    age = (now - parsed_time(doc.get('observed_at'))).total_seconds()
    if not 0 <= age <= 900:
        raise ValueError('inventory older than 15 minutes or in the future')
    if doc.get('release_root') != RELEASES or doc.get('snapshot_root') != SNAPSHOTS:
        raise ValueError('roots do not match the reviewed staging release and archive inventory roots')
    for gate in ('exact_installed_units','canonical_roots_and_ownership','mount_snapshot_complete',
                 'protected_db_identity_complete','app_worker_refs_complete','pending_refs_complete',
                 'captured_under_staging_lock'):
        if not flag(doc,gate):
            raise ValueError('unproved inventory gate: '+gate)
    releases, snapshots, mounts = (doc.get(k) for k in ('releases','snapshots','mounts'))
    if any(not isinstance(x,list) or len(x)>4096 for x in (releases,snapshots,mounts)):
        raise ValueError('bounded inventories required')
    for m in mounts:
        if not isinstance(m,str) or not m.startswith('/') or str(PurePosixPath(m))!=m or '..' in PurePosixPath(m).parts:
            raise ValueError('invalid mount path')
    def mounted(path):
        return any(m==path or m.startswith(path+'/') or
                   (m!='/' and path.startswith(m+'/')) for m in mounts)
    def indexed(rows,regex):
        out={}
        for r in rows:
            if not isinstance(r,dict) or not isinstance(r.get('name'),str) or not regex.fullmatch(r['name']) or r['name'] in out:
                raise ValueError('ambiguous entry name')
            out[r['name']]=r
        return out
    rr, ss = indexed(releases,NAME),indexed(snapshots,NAME)
    refs = doc.get('refs')
    if not isinstance(refs,dict):
        raise ValueError('missing runtime references')
    live = refs.get('live')
    if not full_sha(live) or any(refs.get(k)!=live for k in ('current_link','app','health','state')):
        raise ValueError('live release references disagree')
    worker=refs.get('worker')
    if not (full_sha(worker) or (worker is None and flag(refs,'worker_verified_inactive'))):
        raise ValueError('unverified worker reference')
    pending=refs.get('pending')
    if not isinstance(pending,list) or not all(full_sha(s) for s in pending):
        raise ValueError('unverified pending refs')
    if any(s not in rr for s in pending) or (worker and worker not in rr):
        raise ValueError('known runtime references absent from release inventory')
    def directory_usable(r,name):
        return full_sha(name) and r.get('commit')==name and all(flag(r,k) for k in (
            'direct_directory','complete_regular_marker','immutable_build_verified','subtree_no_untrusted_links_or_mounts'))
    if not directory_usable(rr.get(live,{}),live):
        raise ValueError('live release not verified')
    previous=refs.get('previous')
    if previous==live or not full_sha(previous) or not directory_usable(rr.get(previous,{}),previous) or not flag(rr[previous],'rollback_and_recovery_verified'):
        raise ValueError('known previous rollback and compatible recovery point not verified')
    retained_releases={live:'live',previous:'verified_previous'}
    if worker: retained_releases[worker]='worker_reference'
    retained_releases.update({s:'pending_reference' for s in pending})
    out=[]
    def item(root,n,r,action,reason):
        nbytes=r.get('allocated_bytes')
        if type(nbytes) is not int or nbytes<0: nbytes=None
        out.append({'path':root+'/'+n,'action':action,'reason':reason,'allocated_bytes':nbytes})
    for n,r in sorted(rr.items()):
        reason=retained_releases.get(n)
        if not reason:
            if flag(r,'operator_pinned'): reason='operator_pinned'
            elif mounted(RELEASES+'/'+n): reason='mounted'
            elif not directory_usable(r,n): reason='unclassified_or_unsafe'
            elif not (flag(r,'no_external_references') and flag(r,'subtree_older_than_one_hour')): reason='referenced_recent_or_unknown'
        item(RELEASES,n,r,'keep' if reason else 'candidate',reason or 'older_complete_unused_staging_release')
    proven=[]
    def snapshot_proven(r):
        return r.get('environment')=='staging' and r.get('manifest_commit') is not None and full_sha(r['manifest_commit']) and all(
            flag(r,k) for k in ('signed_or_root_inventory_manifest_bound','integrity_verified','restore_verified','single_regular_file',
                'not_any_live_db_or_sidecar','no_open_or_restore_references'))
    for n,r in ss.items():
        if snapshot_proven(r) and not mounted(SNAPSHOTS+'/'+n):
            proven.append((parsed_time(r.get('captured_at')),n))
    ordered=sorted(proven,reverse=True)
    preserved={n for t,n in ordered if len(ordered)<7 or t>=ordered[6][0]}
    proven_names={n for _,n in proven}
    for n,r in sorted(ss.items()):
        if flag(r,'operator_pinned'): reason='operator_pinned'
        elif n not in proven_names: reason='unknown_mounted_referenced_or_not_staging'
        elif n in preserved: reason='newest_seven_proven_staging_snapshots_including_ties'
        else: reason=None
        item(SNAPSHOTS,n,r,'keep' if reason else 'candidate',reason or 'older_manifest_proven_staging_snapshot')
    return {'state':'proposal_only','observed_at':doc['observed_at'],'entries':out}

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(4_194_305)
        if len(raw)>4_194_304: raise ValueError('inventory too large')
        print(json.dumps(plan(json.loads(raw),datetime.now(timezone.utc)),indent=2))
    except (ValueError,TypeError,KeyError):
        print(json.dumps({'state':'hold','reason':'invalid_or_unverified_inventory','entries':[]}))
        sys.exit(2)
