import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { writeFenceActive, openFencedDb } from '../lib/write-fence.ts'

test('fence inactive by default: no env, no file', () => {
  assert.equal(writeFenceActive({}), false)
  assert.equal(writeFenceActive({ DAZL_WRITE_FENCE: '0' }), false)
})

test('fence active via env var', () => {
  assert.equal(writeFenceActive({ DAZL_WRITE_FENCE: '1' }), true)
})

test('fence active via fence file, inactive when file removed', () => {
  const f = '/tmp/dazl-fence-test'
  writeFileSync(f, 'migration in progress')
  assert.equal(writeFenceActive({ DAZL_WRITE_FENCE_FILE: f }), true)
  rmSync(f)
  assert.equal(writeFenceActive({ DAZL_WRITE_FENCE_FILE: f }), false)
})

test('fenced open is read-only: reads work, writes fail; unfenced writes work', () => {
  const p = '/tmp/dazl-fence-db-test.db'
  rmSync(p, { force: true })
  const setup = openFencedDb(p, {})
  setup.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')
  setup.close()

  const fenced = openFencedDb(p, { DAZL_WRITE_FENCE: '1' })
  assert.equal(fenced.readonly, true)
  assert.doesNotThrow(() => fenced.prepare('SELECT * FROM t').all())
  assert.throws(() => fenced.prepare("INSERT INTO t (id) VALUES ('x')").run(), /readonly/)
  fenced.close()

  const open = openFencedDb(p, {})
  assert.equal(open.readonly, false)
  open.prepare("INSERT INTO t (id) VALUES ('x')").run()
  assert.equal((open.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c, 1)
  open.close()
  rmSync(p, { force: true })
})
