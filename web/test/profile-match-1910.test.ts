import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { fallbackIcp, type Icp } from '../lib/scan/icp.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { runWithoutAccountSpend } from '../lib/scan/spend-cap.ts'
import { resolveSearchProfile } from '../lib/scan/profile-match.ts'

const saved: Icp = {
  summary: 'Small marketing agencies in Toronto',
  who: ['small marketing agencies'],
  industries: ['marketing'],
  where: ['Toronto'],
  sizes: ['1-10 employees'],
  signals: [],
  exclude: ['recruiters'],
  country: 'CA',
}

function claudeReply(query: string, reply: unknown): typeof fetch {
  return async (url, init) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages')
    const prompt = JSON.parse(String(init?.body)).messages[0].content
    assert.ok(prompt.includes(query))
    assert.ok(prompt.includes('Toronto'))
    assert.ok(prompt.includes('small marketing agencies'))
    return Response.json({ model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 30 }, content: [{ type: 'text', text: JSON.stringify(reply) }] })
  }
}

function resolveFixture(query: string, reply: unknown) {
  return runWithoutAccountSpend('test', () =>
    resolveSearchProfile(query, saved, 'offline-fixture', claudeReply(query, reply)))
}

for (const { query, buyer, place, expectedBuyer, expectedPlace, country } of [
  { query: 'Marketing agencies in Austin, TX that are hiring', buyer: 'Marketing agencies', place: 'Austin, TX',
    expectedBuyer: ['Marketing agencies'], expectedPlace: ['Austin, TX'], country: 'US' },
  { query: 'Dental clinics that are hiring', buyer: 'Dental clinics', place: null,
    expectedBuyer: ['Dental clinics'], expectedPlace: saved.where, country: 'CA' },
  { query: 'Look in Austin, TX', buyer: null, place: 'Austin, TX',
    expectedBuyer: saved.who, expectedPlace: ['Austin, TX'], country: 'US' },
  { query: 'Dental clinics in Toronto that are hiring', buyer: 'Dental clinics', place: 'Toronto',
    expectedBuyer: ['Dental clinics'], expectedPlace: ['Toronto'], country: 'CA' },
  { query: 'Dental   Clinics in Toronto that are hiring', buyer: 'dental clinics', place: 'TORONTO',
    expectedBuyer: ['Dental   Clinics'], expectedPlace: ['Toronto'], country: 'CA' },
]) {
  test(`explicit search gets its own profile: ${query}`, async () => {
    const result = await resolveFixture(query, {
      decision: 'replace',
      buyer,
      place,
      profile: { industries: buyer ? [buyer] : [], signals: ['hiring'], ...(place ? { country } : {}) },
    })
    assert.equal(result.source, 'inferred')
    assert.equal(result.profile.summary, fallbackIcp(query).summary)
    assert.deepEqual(result.profile.who, expectedBuyer)
    assert.deepEqual(result.profile.where, expectedPlace)
    assert.equal(result.profile.country, country)
    if (!buyer) assert.deepEqual(result.profile.industries, saved.industries)
    assert.deepEqual(result.profile.sizes, [])
    assert.deepEqual(result.profile.exclude, [])
    assert.equal(saved.where[0], 'Toronto')
  })
}

test('a compatible request keeps the saved profile and carried provenance', async () => {
  const query = 'Find more hiring signals'
  const result = await resolveFixture(query, { decision: 'keep' })
  assert.equal(result.profile, saved)
  assert.equal(result.source, 'carried')
})

test('uncertain or ungrounded model output cannot authorize use of the saved profile', async () => {
  const query = 'Dental clinics that are hiring'
  for (const reply of [
    { decision: 'unknown' },
    { decision: 'replace', buyer: 'small marketing agencies', place: null, profile: { summary: query } },
    { decision: 'replace', buyer: 'Dental clinics', place: 'Toronto', profile: { summary: query } },
  ]) {
    await assert.rejects(resolveFixture(query, reply), /^Error: search_profile:/)
  }
})

for (const invalidReply of [false, true]) {
  test(`runner uses and persists the ${invalidReply ? 'request-only fallback' : 'inferred profile'}`, async t => {
    const db = new Database(':memory:')
    t.after(() => db.close())
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'profile-test', 'anthropic', 'sk-ant-test', master)
    const query = 'Dental clinics in Toronto that are hiring'
    const id = createQueryJob(db, 'profile-test', { query, icp: JSON.stringify(saved) })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const reply = invalidReply ? { decision: 'unknown' } : {
      decision: 'replace', buyer: 'Dental clinics', place: 'Toronto',
      profile: { industries: ['dental'], signals: ['hiring'], country: 'CA' },
    }
    const warnings = t.mock.method(console, 'warn', () => {})
    const profiles: unknown[] = []
    const empty: DiscoverResult = {
      leads: [], seen: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.01 },
      stop: 'end_turn', model: 'fixture', note: null,
    }
    assert.equal(await runJob(db, job, {
      master, discover: true, enrichImpl: null, fetchImpl: claudeReply(query, reply),
      discoverImpl: async input => {
        assert.equal(input.profileCarried, false)
        profiles.push(input.profile)
        return empty
      },
    }), 'done')
    const status = await readScanStatus(sqliteDb(db), 'profile-test', id)
    assert.ok(status)
    assert.equal(status.icp_source, invalidReply ? 'request_only' : 'inferred')
    assert.ok(profiles.length)
    for (const profile of profiles) assert.deepEqual(profile, status.icp)
    const requestOnly = fallbackIcp(query)
    assert.deepEqual(status.icp, invalidReply ? requestOnly : {
      ...requestOnly, who: ['Dental clinics'], industries: ['dental'], where: ['Toronto'], signals: ['hiring'], country: 'CA',
    })
    assert.equal(warnings.mock.callCount(), Number(invalidReply))
    assert.deepEqual(db.prepare('SELECT kind FROM scan_spend_calls WHERE scan_job_id = ? ORDER BY rowid').all(id),
      [{ kind: 'llm.anthropic' }, { kind: 'llm.anthropic.web_search' }])
  })
}
