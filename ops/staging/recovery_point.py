#!/usr/bin/env python3
"""Staging pre-migration recovery point (#908). Run by ops/staging/deploy.sh as root while the staging service is STOPPED.

  recovery_point.py create  --db DB_PATH --dir RP_DIR --commit OLD_SHA   take and verify a WAL-safe copy before any migration
  recovery_point.py restore --db DB_PATH --dir RP_DIR                    put that exact database back (or its absence)

create uses SQLite's online backup API (never a raw copy of a WAL database), checks integrity, normalizes the copy to a single
self-contained file, then writes manifest.json binding the copy's sha256/bytes to the source's canonical path, device:inode
and the old release commit. It re-reads the copy and refuses (exit 1) unless the bytes match. A database that does not exist
yet is recorded as absent, so a failed first migration is undone by removing what it created.

restore verifies the copy against its manifest and that DB_PATH is the same database the manifest names, replaces DB_PATH
atomically (same directory, same owner and mode), removes stale -wal/-shm, and re-hashes the result. Any mismatch: exit 1,
nothing claimed. Prints only fixed messages: no paths beyond what the caller passed, no database contents.
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time

MANIFEST = 'manifest.json'
COPY = 'app.db'


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def die(msg):
    print('recovery-point: ' + msg, file=sys.stderr)
    sys.exit(1)


def create(db, d, commit):
    if os.path.exists(d):
        die('recovery point directory already exists; refusing to reuse it')
    os.makedirs(d, mode=0o700)
    src = os.path.realpath(db)
    if not os.path.exists(src):
        manifest = {'tool': 'dazl-staging-recovery-point', 'absent': True, 'source': src, 'commit': commit, 'created': int(time.time())}
    else:
        st = os.stat(src)
        part = os.path.join(d, COPY + '.partial')
        s = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
        t = sqlite3.connect(part)
        try:
            s.backup(t)
        finally:
            s.close()
        try:
            if t.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                die('the copy failed integrity_check')
            t.execute('PRAGMA journal_mode=DELETE').fetchone()
        finally:
            t.close()
        final = os.path.join(d, COPY)
        os.replace(part, final)
        manifest = {'tool': 'dazl-staging-recovery-point', 'absent': False, 'source': src, 'source_id': f'{st.st_dev}:{st.st_ino}',
                    'owner': [st.st_uid, st.st_gid], 'mode': st.st_mode & 0o7777, 'commit': commit,
                    'bytes': os.path.getsize(final), 'sha256': sha256(final), 'created': int(time.time())}
    fd = os.open(os.path.join(d, MANIFEST), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(manifest, f)
        f.flush(); os.fsync(f.fileno())
    verify(d, src)
    print('recovery-point: verified' + (' (no database yet: recorded as absent)' if manifest['absent'] else ''))


def verify(d, src):
    try:
        with open(os.path.join(d, MANIFEST)) as f:
            m = json.load(f)
    except Exception:
        die('no readable manifest')
    if m.get('tool') != 'dazl-staging-recovery-point' or m.get('source') != src:
        die('the manifest is for another database')
    if not m.get('absent'):
        copy = os.path.join(d, COPY)
        if not os.path.isfile(copy) or os.path.getsize(copy) != m.get('bytes') or sha256(copy) != m.get('sha256'):
            die('the copy does not match its manifest')
    return m


def restore(db, d):
    src = os.path.realpath(db)
    m = verify(d, src)
    side = [src + '-wal', src + '-shm', src + '-journal']
    if m['absent']:
        for p in [src, *side]:
            if os.path.exists(p):
                os.remove(p)
        if os.path.exists(src):
            die('could not remove the database the failed release created')
        print('recovery-point: restored (no database, as before)')
        return
    tmp = src + '.restore'
    with open(os.path.join(d, COPY), 'rb') as r, open(tmp, 'wb') as w:
        for chunk in iter(lambda: r.read(1 << 20), b''):
            w.write(chunk)
        w.flush(); os.fsync(w.fileno())
    try:
        os.chown(tmp, *m['owner'])
    except PermissionError:
        pass
    os.chmod(tmp, m['mode'])
    for p in side:
        if os.path.exists(p):
            os.remove(p)
    os.replace(tmp, src)
    if sha256(src) != m['sha256']:
        die('the restored database does not match the recovery point')
    print('recovery-point: restored and verified')


def main():
    p = argparse.ArgumentParser(allow_abbrev=False)
    p.add_argument('action', choices=['create', 'restore'])
    p.add_argument('--db', required=True)
    p.add_argument('--dir', required=True)
    p.add_argument('--commit', default='')
    a = p.parse_args()
    if not os.path.isabs(a.db):
        die('DB_PATH must be absolute')
    try:
        create(a.db, a.dir, a.commit) if a.action == 'create' else restore(a.db, a.dir)
    except SystemExit:
        raise
    except Exception as e:
        die(f'{a.action} failed ({type(e).__name__})')


if __name__ == '__main__':
    main()
