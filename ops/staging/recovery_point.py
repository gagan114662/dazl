#!/usr/bin/env python3
"""Staging pre-migration recovery point (#908). Run by ops/staging/deploy.sh as root while the staging service is STOPPED.

  recovery_point.py check-root --dir RECOVERY_ROOT                     the recovery root is private to its owner (preflight)
  recovery_point.py create  --db DB_PATH --dir RP_DIR --commit OLD_SHA  take and verify a WAL-safe copy before any migration;
                                                                       prints the manifest's sha256 (stdout, nothing else)
  recovery_point.py restore --db DB_PATH --dir RP_DIR [--expect-manifest SHA]
                                                                       put that exact database back (or its absence)

Where recovery points live. RP_DIR's parent (the recovery root, /var/lib/dazl-staging-recovery by default) must be owned by
root (or by the user running this, for tests), mode 700, and every ancestor must be owned by root or that user and not
writable by anyone else (a root-owned sticky directory such as /tmp is allowed). So the service account, which owns the
staging home and the database directory, cannot rename, replace or remove a recovery point. Inside it, the copy and the
manifest are created exclusively (O_EXCL|O_NOFOLLOW), made read-only (0400) and fsynced, and the recovery point directory and
the root are fsynced so the recovery point survives a host crash once create reports success.

create uses SQLite's online backup API (never a raw copy of a WAL database), checks integrity, normalizes the copy to a single
self-contained file, then writes manifest.json binding the copy's sha256/bytes to the source's canonical path and the old
release commit. It re-reads both before reporting. DB_PATH must be a regular file (never a symlink) or absent; an absent
database is recorded as absent, so a failed first migration is undone by removing what it created.

restore refuses unless: the recovery point directory and files are owned by this user, private, read-only, single-linked and
not symlinks; the manifest's sha256 equals --expect-manifest (the value create printed, which the deploy keeps in its own
root-only marker), so a swapped recovery point is refused; the manifest names this DB_PATH; the copy matches the manifest.
The database directory is writable by the service account, so every step there goes through a directory descriptor and never
follows a symlink: the new file is created O_EXCL|O_NOFOLLOW under an unpredictable name, owner and mode are set through its
descriptor, it is renamed over DB_PATH (rename replaces a planted symlink, it never writes through one) and the installed
entry must still be that same inode, hashed through the descriptor.

Durable restore protocol (an interrupted restore never leaves a half state that claims anything):
  1. restore-state.json (in the root-only recovery point) is written and fsynced: restore in progress;
  2. -wal/-shm/-journal are moved aside (renamed to .<db>-wal.quarantine-<id>, not deleted), directory fsynced;
  3. the verified copy is written to a temporary file and fsynced, renamed over DB_PATH, directory fsynced;
  4. only then are the quarantined sidecars and stale temporaries removed, directory fsynced, and the state removed.
Re-running restore after a crash at any point finishes the same restore (it is idempotent). deploy.sh keeps its own pending
marker until the restore succeeds, so no release is started against a database that is not fully restored.

Prints only fixed messages: no paths beyond what the caller passed, no database contents.
"""
import argparse
import hashlib
import json
import os
import secrets
import sqlite3
import stat
import sys
import time
import urllib.parse

TOOL = 'dazl-staging-recovery-point'
MANIFEST = 'manifest.json'
COPY = 'app.db'
STATE = 'restore-state.json'
SIDECARS = ('-wal', '-shm', '-journal')
NOFOLLOW = os.O_NOFOLLOW
DIRFLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def die(msg):
    print('recovery-point: ' + msg, file=sys.stderr)
    sys.exit(1)


def say(msg):
    print('recovery-point: ' + msg, file=sys.stderr)


def crash_point(name):
    # TEST ONLY: simulate a crash (kill -9 / power loss) right after a restore phase. Unset in every real deploy.
    if os.environ.get('RECOVERY_POINT_TEST_CRASH_AT') == name:
        os._exit(86)


def fsync_dir(fd):
    os.fsync(fd)


def sha_fd(fd):
    h = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1 << 20)
        if not chunk:
            break
        h.update(chunk)
    return h.hexdigest()


def secure_chain(path, what):
    """Every directory from / down to path: a real directory (no symlink), owned by root or by us, and not writable by
    group/other (a root-owned sticky directory, like /tmp, is allowed: others cannot rename entries in it)."""
    me = os.geteuid()
    parts = [p for p in path.split('/') if p]
    cur = '/'
    for i in range(len(parts) + 1):
        if i:
            cur = os.path.join(cur, parts[i - 1])
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            die(f'{what} is missing')
        if not stat.S_ISDIR(st.st_mode):
            die(f'{what} is not safe: a path component is a symlink or not a directory')
        if st.st_uid not in (0, me):
            die(f'{what} is not safe: a directory on its path is owned by another user')
        if st.st_mode & 0o022 and not (st.st_mode & stat.S_ISVTX and st.st_uid == 0):
            die(f'{what} is not safe: a directory on its path is writable by other users')


def check_root(root):
    root = os.path.realpath(root)
    secure_chain(root, 'the recovery root')
    st = os.lstat(root)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        die('the recovery root is not private to its owner (want mode 700, owned by the deploy user)')
    return root


def open_db_dir(db):
    """The database's directory, opened without following a symlink; its ancestors must not be writable by the service
    account (the directory itself is the service account's). Returns (canonical source path, basename, dir fd)."""
    if not os.path.isabs(db):
        die('DB_PATH must be absolute')
    base = os.path.basename(db)
    if base in ('', '.', '..'):
        die('DB_PATH must name a file')
    dbdir = os.path.realpath(os.path.dirname(db))
    secure_chain(os.path.dirname(dbdir), "the database directory's parent")
    try:
        dfd = os.open(dbdir, DIRFLAGS)
    except FileNotFoundError:
        die('the database directory is missing')
    return os.path.join(dbdir, base), base, dfd


def lstat_at(name, dfd):
    try:
        return os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def create(db, d, commit):
    d = os.path.abspath(d)
    root = check_root(os.path.dirname(d))
    name = os.path.basename(d)
    rfd = os.open(root, DIRFLAGS)
    try:
        os.mkdir(name, 0o700, dir_fd=rfd)
    except FileExistsError:
        die('recovery point directory already exists; refusing to reuse it')
    dfd = os.open(name, DIRFLAGS, dir_fd=rfd)
    src, base, sfd = open_db_dir(db)
    st = lstat_at(base, sfd)
    if st is not None and not stat.S_ISREG(st.st_mode):
        die('DB_PATH is not a regular file (a symlink or something else); refusing to copy through it')
    if st is None:
        manifest = {'tool': TOOL, 'absent': True, 'source': src, 'commit': commit, 'created': int(time.time())}
    else:
        part = os.path.join(root, name, COPY + '.partial')
        s = sqlite3.connect('file:' + urllib.parse.quote(src) + '?mode=ro', uri=True)
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
        after = lstat_at(base, sfd)
        if after is None or not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != (st.st_dev, st.st_ino):
            die('DB_PATH changed while it was being copied; refusing')
        os.rename(COPY + '.partial', COPY, src_dir_fd=dfd, dst_dir_fd=dfd)
        cfd = os.open(COPY, os.O_RDONLY | NOFOLLOW, dir_fd=dfd)
        try:
            os.fchmod(cfd, 0o400)
            os.fsync(cfd)
            manifest = {'tool': TOOL, 'absent': False, 'source': src, 'source_id': f'{st.st_dev}:{st.st_ino}',
                        'owner': [st.st_uid, st.st_gid], 'mode': st.st_mode & 0o777, 'commit': commit,
                        'bytes': os.fstat(cfd).st_size, 'sha256': sha_fd(cfd), 'created': int(time.time())}
        finally:
            os.close(cfd)
    mfd = os.open(MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o400, dir_fd=dfd)
    with os.fdopen(mfd, 'w') as f:
        json.dump(manifest, f)
        f.flush()
        os.fsync(f.fileno())
    fsync_dir(dfd)   # the copy's and the manifest's directory entries
    fsync_dir(rfd)   # the recovery point's own entry in the root
    _, msha = verify(d, src)
    say('verified' + (' (no database yet: recorded as absent)' if manifest['absent'] else ''))
    print(msha)


def open_private_file(name, dfd):
    try:
        fd = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return None
    except OSError:
        die('the recovery point was modified or replaced (a symlink in place of its files)')
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o222 or st.st_mode & 0o077 or st.st_nlink != 1:
        os.close(fd)
        die('the recovery point was modified or replaced (its files are not read-only, private and single-linked)')
    return fd


def verify(d, src, expect=None):
    d = os.path.abspath(d)
    check_root(os.path.dirname(d))
    try:
        dfd = os.open(d, DIRFLAGS)
    except OSError:
        die('no recovery point directory (missing, or a symlink)')
    st = os.fstat(dfd)
    if st.st_uid != os.geteuid() or st.st_mode & 0o077:
        die('the recovery point directory is not private to its owner')
    mfd = open_private_file(MANIFEST, dfd)
    if mfd is None:
        die('no readable manifest')
    try:
        raw = b''
        while True:
            chunk = os.read(mfd, 1 << 16)
            if not chunk:
                break
            raw += chunk
    finally:
        os.close(mfd)
    msha = hashlib.sha256(raw).hexdigest()
    if expect is not None and msha != expect:
        die('the recovery point was replaced: its manifest is not the one this deploy recorded')
    try:
        m = json.loads(raw)
    except Exception:
        die('no readable manifest')
    if m.get('tool') != TOOL or m.get('source') != src:
        die('the manifest is for another database')
    if not m.get('absent'):
        cfd = open_private_file(COPY, dfd)
        try:
            if cfd is None or os.fstat(cfd).st_size != m.get('bytes') or sha_fd(cfd) != m.get('sha256'):
                die('the copy does not match its manifest')
        finally:
            if cfd is not None:
                os.close(cfd)
    os.close(dfd)
    return m, msha


def write_state(dfd, state):
    tmp = STATE + '.tmp'
    try:
        os.unlink(tmp, dir_fd=dfd)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=dfd)
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f)
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, STATE, src_dir_fd=dfd, dst_dir_fd=dfd)
    fsync_dir(dfd)


def read_state(dfd):
    try:
        fd = os.open(STATE, os.O_RDONLY | NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return None
    with os.fdopen(fd) as f:
        try:
            return json.load(f)
        except Exception:
            return None


def restore(db, d, expect):
    src, base, sfd = open_db_dir(db)
    m, _ = verify(d, src, expect)
    dfd = os.open(os.path.abspath(d), DIRFLAGS)
    prior = read_state(dfd)
    token = prior.get('id') if prior and isinstance(prior.get('id'), str) and prior['id'].isalnum() else secrets.token_hex(8)
    if prior:
        say('finishing an interrupted restore')
    # 1. restore in progress, durably
    write_state(dfd, {'id': token, 'phase': 'restoring', 'started': int(time.time())})
    # 2. sidecars aside, not deleted: a crash here leaves the migrated database's transactional state recoverable
    for sfx in SIDECARS:
        if lstat_at(base + sfx, sfd) is not None:
            os.rename(base + sfx, f'.{base}{sfx}.quarantine-{token}', src_dir_fd=sfd, dst_dir_fd=sfd)
    fsync_dir(sfd)
    crash_point('quarantined')
    # 3. the verified copy (or the absence) installed
    if m['absent']:
        st = lstat_at(base, sfd)
        if st is not None:
            try:
                os.unlink(base, dir_fd=sfd)
            except OSError:
                die('could not remove the database the failed release created')
        fsync_dir(sfd)
        crash_point('installed')
    else:
        tmp = f'.{base}.restore-{token}-{secrets.token_hex(4)}'
        wfd = os.open(tmp, os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=sfd)
        try:
            rfd = os.open(os.path.join(os.path.abspath(d), COPY), os.O_RDONLY | NOFOLLOW)
            try:
                while True:
                    chunk = os.read(rfd, 1 << 20)
                    if not chunk:
                        break
                    os.write(wfd, chunk)
            finally:
                os.close(rfd)
            try:
                os.fchown(wfd, *m['owner'])
            except PermissionError:
                pass
            os.fchmod(wfd, m['mode'] & 0o777)
            os.fsync(wfd)
            mine = os.fstat(wfd)
            crash_point('copied')
            os.rename(tmp, base, src_dir_fd=sfd, dst_dir_fd=sfd)
            fsync_dir(sfd)
            now = lstat_at(base, sfd)
            if now is None or not stat.S_ISREG(now.st_mode) or (now.st_dev, now.st_ino) != (mine.st_dev, mine.st_ino):
                die('the restored file was swapped before it was installed; nothing claimed')
            if sha_fd(wfd) != m['sha256']:
                die('the restored database does not match the recovery point')
        finally:
            os.close(wfd)
        crash_point('installed')
    # 4. only now: quarantined sidecars and stale temporaries go (this restore's and any interrupted one's)
    for sfx in SIDECARS:
        if lstat_at(base + sfx, sfd) is not None:   # nothing may write while stopped; if something did, it is not trusted
            os.unlink(base + sfx, dir_fd=sfd)
    for entry in os.listdir(sfd):
        if entry.startswith(f'.{base}') and ('.quarantine-' in entry or f'.{base}.restore-' in entry):
            try:
                os.unlink(entry, dir_fd=sfd)
            except IsADirectoryError:
                pass
    fsync_dir(sfd)
    os.unlink(STATE, dir_fd=dfd)
    fsync_dir(dfd)
    say('restored (no database, as before)' if m['absent'] else 'restored and verified')


def main():
    p = argparse.ArgumentParser(allow_abbrev=False)
    p.add_argument('action', choices=['check-root', 'create', 'restore'])
    p.add_argument('--db')
    p.add_argument('--dir', required=True)
    p.add_argument('--commit', default='')
    p.add_argument('--expect-manifest')
    a = p.parse_args()
    if a.action != 'check-root' and not a.db:
        die('--db is required')
    if a.expect_manifest is not None and (len(a.expect_manifest) != 64 or any(c not in '0123456789abcdef' for c in a.expect_manifest)):
        die('--expect-manifest must be a sha256')
    if a.db is not None and not os.path.isabs(a.db):
        die('DB_PATH must be absolute')
    try:
        if a.action == 'check-root':
            check_root(a.dir)
        elif a.action == 'create':
            create(a.db, a.dir, a.commit)
        else:
            restore(a.db, a.dir, a.expect_manifest)
    except SystemExit:
        raise
    except Exception as e:
        die(f'{a.action} failed ({type(e).__name__})')


if __name__ == '__main__':
    main()
