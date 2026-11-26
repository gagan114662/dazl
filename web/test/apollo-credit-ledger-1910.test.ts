import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { reserveApolloLead } from '../lib/enrich/apollo-credit-ledger.ts'

test('Apollo refuses when off and admits only one lookup per lead across restarts and tenants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-ledger-'))
  const path = join(directory, 'test.db')
  let db = new Database(path)
  try {
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', {}), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '1.5' }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }), true)
    db.close()
    db = new Database(path)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-b', 'second', { APOLLO_CREDIT_CAP: '2' }), true)
    assert.equal(await reserveApolloLead(db, 'tenant-c', 'third', { APOLLO_CREDIT_CAP: '2' }), false)
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
