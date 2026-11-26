import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { matchReadyApolloBuyer, type ApolloBuyerEvidence } from '../lib/enrich/apollo-ready-match.ts'
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

test('only an otherwise Ready buyer after a completed empty crawl reaches one Apollo people endpoint', async () => {
  const db = new Database(':memory:')
  const calls: string[] = []
  const buyer: ApolloBuyerEvidence = { first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test', dayVerified: true,
    otherwiseReady: true, ownSiteRead: 'none_published' as const }
  const match = (leadId: string, evidence = buyer, cap = '1', tenantId = 'a') =>
    matchReadyApolloBuyer(db, tenantId, leadId, evidence, {
      key: 'test-only',
      env: { APOLLO_CREDIT_CAP: cap },
      fetchImpl: async input => {
        calls.push(String(input))
        return Response.json({ person: null })
      },
    })
  try {
    await match('held', { ...buyer, otherwiseReady: false })
    await match('undated', { ...buyer, dayVerified: false })
    await match('unresolved', { ...buyer, confirmedDomain: '' })
    await match('unread', { ...buyer, ownSiteRead: 'incomplete' })
    await match('already-found', { ...buyer, ownSiteRead: 'address_found' })
    assert.deepEqual(calls, [])
    await match('eligible')
    await match('eligible', buyer, '2')
    await match('at-cap', buyer, '1', 'b')
    assert.deepEqual(calls, ['https://api.apollo.io/api/v1/people/match'])
  } finally {
    db.close()
  }
})
