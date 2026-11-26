import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { matchReadyApolloBuyer, planApolloBuyerMatches, type ApolloBuyerEvidence } from '../lib/enrich/apollo-ready-match.ts'
import { reserveApolloLead } from '../lib/enrich/apollo-credit-ledger.ts'

test('Apollo refuses when off and admits only one lookup per lead across restarts and tenants', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-ledger-'))
  const path = join(directory, 'test.db')
  let db = new Database(path)
  try {
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', {}, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '1.5' }, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), true)
    db.close()
    db = new Database(path)
    assert.equal(await reserveApolloLead(db, 'tenant-a', 'first', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), false)
    assert.equal(await reserveApolloLead(db, 'tenant-b', 'second', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), true)
    assert.equal(await reserveApolloLead(db, 'tenant-c', 'third', { APOLLO_CREDIT_CAP: '2' }, { id: 'scan', limit: 2 }), false)
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
  const match = (leadId: string, evidence = buyer, cap = '1', tenantId = 'a', scanId = 'scan-a') =>
    matchReadyApolloBuyer(db, tenantId, leadId, evidence, {
      key: 'test-only', scanId, scanLimit: 1,
      env: { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: cap },
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
    await match('at-cap', buyer, '1', 'b', 'scan-b')
    await match('same-scan', buyer, '2')
    assert.equal(calls.length, 1)
    assert.deepEqual(db.prepare('SELECT lead_id, scan_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'eligible', scan_id: 'scan-a', credit: 1, result: 'empty' }])
    assert.deepEqual(calls, ['https://api.apollo.io/api/v1/people/match'])
  } finally {
    db.close()
  }
})

test('dry plan counts eligible new requests within both caps without reserving', async () => {
  const db = new Database(':memory:')
  const env = { APOLLO_CREDIT_CAP: '3' }
  const scan = { id: 'planned-scan', limit: 2 }
  const buyer: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  try {
    assert.equal(await reserveApolloLead(db, 'a', 'already', env, scan), true)
    const candidates = [
      { leadId: 'already', evidence: buyer },
      { leadId: 'held', evidence: { ...buyer, otherwiseReady: false } },
      { leadId: 'eligible', evidence: buyer },
      { leadId: 'eligible', evidence: buyer },
      { leadId: 'past-scan-cap', evidence: buyer },
    ]
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, env), ['eligible'])
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM apollo_credit_ledger').pluck().get(), 1)
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, {}), [])
    assert.equal(await reserveApolloLead(db, 'b', 'other', env, scan), true)
    assert.equal(await reserveApolloLead(db, 'b', 'third', env, scan), true)
    assert.deepEqual(await planApolloBuyerMatches(db, 'a', candidates, scan, env), [])
  } finally {
    db.close()
  }
})

test('a committed reservation blocks a second tenant while the first request is in flight', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-in-flight-'))
  const path = join(directory, 'ledger.db')
  const first = new Database(path)
  const second = new Database(path)
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  const env = { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '1' }
  let attempted = 0
  try {
    await matchReadyApolloBuyer(first, 'tenant-a', 'lead-a', evidence, {
      key: 'fixture-only', scanId: 'scan-a', scanLimit: 2, env,
      fetchImpl: async (_input, init) => {
        assert.equal(init?.redirect, 'error')
        attempted++
        assert.deepEqual(second.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
          [{ lead_id: 'lead-a', credit: 1, result: 'reserved' }])
        assert.equal(await matchReadyApolloBuyer(second, 'tenant-b', 'lead-b', evidence, {
          key: 'fixture-only', scanId: 'scan-b', scanLimit: 2, env,
          fetchImpl: async () => {
            attempted++
            return Response.json({ person: null })
          },
        }), null)
        return Response.json({ person: null })
      },
    })
    assert.equal(attempted, 1)
    assert.deepEqual(second.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'lead-a', credit: 1, result: 'empty' }])
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an ambiguous transport error is logged and remains charged against the cap', async () => {
  const db = new Database(':memory:')
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  let attempted = 0
  const options = {
    key: 'fixture-only', scanLimit: 2, env: { DAZL_ENV: 'staging', APOLLO_CREDIT_CAP: '1' },
    fetchImpl: async () => {
      attempted++
      throw new Error('fixture transport disconnected after sending')
    },
  }
  try {
    await assert.rejects(matchReadyApolloBuyer(db, 'a', 'first', evidence, { ...options, scanId: 'scan-a' }),
      /fixture transport disconnected/)
    assert.equal(await matchReadyApolloBuyer(db, 'a', 'first', evidence, { ...options, scanId: 'scan-a' }), null)
    assert.equal(await matchReadyApolloBuyer(db, 'b', 'second', evidence, { ...options, scanId: 'scan-b' }), null)
    assert.equal(attempted, 1)
    assert.deepEqual(db.prepare('SELECT lead_id, credit, result FROM apollo_credit_ledger').all(),
      [{ lead_id: 'first', credit: 1, result: 'uncertain' }])
  } finally { db.close() }
})

test('a production or unset deployment cannot reserve or dispatch an Apollo pilot request', async () => {
  const db = new Database(':memory:')
  const evidence: ApolloBuyerEvidence = {
    first: 'Casey', last: 'Olsen', confirmedDomain: 'example.test',
    dayVerified: true, otherwiseReady: true, ownSiteRead: 'none_published',
  }
  try {
    for (const DAZL_ENV of ['production', undefined]) {
      assert.equal(await matchReadyApolloBuyer(db, 'tenant', 'lead', evidence, {
        key: 'fixture-only', scanId: 'scan', scanLimit: 1,
        env: { DAZL_ENV, APOLLO_CREDIT_CAP: '1' },
        fetchImpl: async () => { assert.fail('non-staging request reached transport') },
      }), null)
    }
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'apollo_credit_ledger'").get(), undefined)
  } finally { db.close() }
})

test('the operator cannot configure a cap above the approved pilot ceiling', async () => {
  const db = new Database(':memory:')
  const scan = { id: 'scan', limit: 1 }
  try {
    assert.equal(await reserveApolloLead(db, 'tenant', 'lead', { APOLLO_CREDIT_CAP: '51' }, scan), false)
    assert.equal(await reserveApolloLead(db, 'tenant', 'lead', { APOLLO_CREDIT_CAP: '50' }, scan), true)
  } finally { db.close() }
})
