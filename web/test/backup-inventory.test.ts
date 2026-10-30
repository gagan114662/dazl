// ops/backup-inventory.sh: read-only metadata only. Counts and ages of local backups and the live file, never contents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

test('inventory: live file and backup directories by metadata; no file contents in the output', () => {
  const T = mkdtempSync(path.join(tmpdir(), 'inventory-test-'))
  try {
    const db = path.join(T, 'app.db'), dir = path.join(T, 'backups'); mkdirSync(dir)
    writeFileSync(db, 'SECRET-LOOKING-CONTENT')
    writeFileSync(path.join(dir, 'dazl-backup-a.db'), 'x'.repeat(100)); writeFileSync(path.join(dir, 'dazl-backup-a.db.json'), '{}')
    writeFileSync(path.join(dir, 'dazl-backup-b.db.age'), 'y'.repeat(50)); writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
    const r = spawnSync('bash', [fileURLToPath(new URL('../../ops/backup-inventory.sh', import.meta.url)), '--db', db, '--backup-dir', dir, '--backup-dir', path.join(T, 'missing')], { encoding: 'utf8', env: { ...process.env, INVENTORY_SKIP_AWS: '1' } })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!r.stdout.includes('SECRET-LOOKING-CONTENT'))
    const j = JSON.parse(r.stdout)
    assert.equal(j.db.exists, true); assert.equal(j.db.bytes, 22)
    assert.deepEqual([j.backup_dirs[0].files, j.backup_dirs[0].bytes, j.backup_dirs[0].with_sidecar], [2, 150, 1])
    assert.equal(j.backup_dirs[1].exists, false)
    assert.equal(j.aws.checked, false)
    assert.equal(typeof j.tools.age, 'boolean')
  } finally { rmSync(T, { recursive: true, force: true }) }
})
