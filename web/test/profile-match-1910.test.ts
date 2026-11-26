import assert from 'node:assert/strict'
import test from 'node:test'
import type { Icp } from '../lib/scan/icp.ts'
import { runWithoutAccountSpend } from '../lib/scan/spend-cap.ts'
import { resolveSearchProfile } from '../lib/scan/profile-match.ts'

const saved: Icp = {
  summary: 'Small marketing agencies in Toronto',
  who: ['small marketing agencies'],
  industries: ['marketing'],
  where: ['Toronto'],
  sizes: ['1-10 employees'],
  signals: [],
  exclude: [],
  country: 'CA',
}

function claudeReply(query: string, reply: unknown): typeof fetch {
  return async (url, init) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages')
    const prompt = JSON.parse(String(init?.body)).messages[0].content
    assert.ok(prompt.includes(query))
    assert.ok(prompt.includes('Toronto'))
    assert.ok(prompt.includes('small marketing agencies'))
    return Response.json({ model: 'claude-sonnet-4-5', content: [{ type: 'text', text: JSON.stringify(reply) }] })
  }
}

function resolveFixture(query: string, reply: unknown) {
  return runWithoutAccountSpend('test', () =>
    resolveSearchProfile(query, saved, 'offline-fixture', claudeReply(query, reply)))
}

for (const { query, buyer, place } of [
  { query: 'Marketing agencies in Austin, TX that are hiring', buyer: 'Marketing agencies', place: 'Austin, TX' },
  { query: 'Dental clinics that are hiring', buyer: 'Dental clinics', place: null },
]) {
  test(`explicit search gets its own profile: ${query}`, async () => {
    const result = await resolveFixture(query, {
      decision: 'replace',
      buyer,
      place,
      profile: { summary: query, industries: [buyer], signals: ['hiring'], ...(place ? { country: 'US' } : {}) },
    })
    assert.equal(result.source, 'inferred')
    assert.equal(result.profile.summary, query)
    assert.deepEqual(result.profile.who, [buyer])
    assert.deepEqual(result.profile.where, place ? [place] : [])
    assert.equal(result.profile.country, place ? 'US' : undefined)
    assert.deepEqual(result.profile.sizes, [])
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
    await assert.rejects(resolveFixture(query, reply), /profile/i)
  }
})
