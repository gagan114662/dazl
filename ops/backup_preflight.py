#!/usr/bin/env python3
"""Nonprinting configuration preflight and explicit fresh backup rehearsal.

Default only validates env syntax and fixed DB identity. --create-backup is a
separate host action requiring approval. Never changes the source database.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from safe_launch import LaunchError, read_env


def reserve_private(path):
    p=Path(path)
    if not p.is_absolute() or any(x.is_symlink() for x in [p.parent,*p.parent.parents]):
        raise LaunchError('destination_path_refused')
    fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    os.close(fd)
    return p


def open_readonly(path):
    # as_uri safely escapes ?/# in paths; no URI-mode injection.
    return sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True,timeout=10)


def logical_digest(connection):
    h=hashlib.sha256()
    for line in connection.iterdump():
        h.update(line.encode('utf-8'));h.update(b'\n')
    return h.digest()


def make_backup(source,backup,restore):
    reserved=[]
    try:
        for path in [backup,restore]:reserved.append(reserve_private(path))
        with open_readonly(source) as src, sqlite3.connect(backup) as target:
            src.backup(target)
        with open_readonly(backup) as saved:
            if saved.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
                raise LaunchError('backup_integrity_failed')
            expected=logical_digest(saved)
            with sqlite3.connect(restore) as restored:saved.backup(restored)
        with open_readonly(restore) as restored:
            if restored.execute('PRAGMA integrity_check').fetchone()[0]!='ok' or logical_digest(restored)!=expected:
                raise LaunchError('restore_rehearsal_failed')
        return {'status':'backup_restore_verified','backup':str(backup),'restore_rehearsal':str(restore),
                'source':str(source),'created_at_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'source_written':False}
    except Exception:
        # Retain exclusively created partial files for investigation. Never delete
        # a pre-existing destination or overwrite source to recover from a failure.
        raise LaunchError('backup_or_rehearsal_failed') from None


def run(args):
    env=read_env(args.env_file)
    for name in ['DB_PATH','DAZL_MASTER_KEY','PUBLIC_BASE_URL']:
        if not env.get(name,'').strip():raise LaunchError('required_env_missing_'+name)
    if any(k in env for k in ['PATH','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','npm_config_prefix','npm_config_script_shell']):
        raise LaunchError('runtime_env_override_refused')
    source=Path(args.source)
    if not source.is_absolute() or env['DB_PATH']!=str(source) or any(x.is_symlink() for x in [source,*source.parents]):
        raise LaunchError('database_identity_mismatch')
    if not source.is_file() or source.stat().st_size==0:
        raise LaunchError('existing_database_required')
    if not args.create_backup:return {'status':'env_preflight_ok','source_written':False}
    backup=Path(args.backup);restore=Path(args.restore_rehearsal)
    protected=source.resolve().parent
    if any(path.resolve().is_relative_to(protected) for path in [backup,restore]):
        raise LaunchError('protected_output_directory_refused')
    if len({source.resolve(),backup.resolve(),restore.resolve()})!=3:
        raise LaunchError('distinct_paths_required')
    return make_backup(source,backup,restore)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['env-file','source','backup','restore-rehearsal']:p.add_argument('--'+name,required=True)
    p.add_argument('--create-backup',action='store_true')
    try:result=run(p.parse_args())
    except LaunchError as e:result={'status':str(e),'source_written':False}
    except Exception:result={'status':'preflight_or_backup_failed','source_written':False}
    print(json.dumps(result))
    return 0 if result['status'] in ['env_preflight_ok','backup_restore_verified'] else 1


if __name__=='__main__':raise SystemExit(main())
