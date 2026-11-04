// #401: the demand rubric comes from the play's own configuration (effective offer + saved competitors), tenant scoped,
// on SQLite and Postgres. Synthetic tenants and plays only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Db } from '../lib/db/client.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { loadPlayDemandRubric, ownNamesFrom } from '../lib/scan/demand-rubric-play.ts'
import { qualifyDemand } from '../lib/scan/demand-qualifier.ts'
import { bothEngines } from './helpers/engines.ts'

const tenant = async (db: Db, id: string, sells: string) =>
  db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, ?, 'n', 'Acme', 'x', 'y', ?)", [id, `${id}@example.test`, sells])

bothEngines('a play rubric uses that play offer and the tenant competitors; other tenants and conflicted plays get none', async ({ db }) => {
  const A = 'a'.repeat(32), B = 'b'.repeat(32)
  await tenant(db, A, 'Verified prospect lists for outbound teams'); await tenant(db, B, 'Bookkeeping for restaurants')
  assert.equal((await setCompetitors(db, A, ['LeadForge'])).ok, true)
  const play = await createQueryJob(db, A, { query: 'B2B SaaS founders asking for lead sources', icp: null, seller: 'Verified prospect lists for outbound teams - https://seller.example', offer: 'Verified B2B prospect lists and sales leads' })
  const conflicted = await createQueryJob(db, A, { query: 'Selling CRM consulting to London startups', icp: null, seller: 'Verified prospect lists for outbound teams - https://seller.example' })

  const got = await loadPlayDemandRubric(db, A, play)
  assert.equal(got.reason, null)
  assert.ok(got.rubric)
  assert.deepEqual(got.rubric.competitors, ['LeadForge'])
  assert.ok(got.rubric.need_terms.includes('prospect list'))
  assert.equal(got.rubric.offer, 'Verified B2B prospect lists and sales leads')

  // the rubric drives the qualifier: a saved competitor's employee is excluded, a founder asking is a buyer
  const asOf = new Date('2026-11-03T12:00:00Z')
  const base = { source_url: 'https://forum.example.test/t/1', published_at: '2026-11-01T00:00:00Z', text: "I'm the founder of a B2B SaaS company and we need a prospect list provider." }
  assert.equal(qualifyDemand({ ...base, author: { name: 'G', headline: 'VP Sales, LeadForge', company: 'LeadForge' } }, got.rubric, asOf).class, 'competitor')
  assert.equal(qualifyDemand({ ...base, author: { name: 'M', headline: 'Founder, Tallyline', company: 'Tallyline' } }, got.rubric, asOf).tier, 'high_intent')

  assert.deepEqual(await loadPlayDemandRubric(db, B, play), { rubric: null, reason: 'no_such_play' })
  assert.deepEqual(await loadPlayDemandRubric(db, A, conflicted), { rubric: null, reason: 'offer_conflict' })
})

// The #401 blocker: quiet self-promotion with no strong promo cue must not reach high_intent through the PRODUCTION rubric.
bothEngines('the seller own quiet post is excluded through the production rubric; the same words from a buyer still qualify', async ({ db }) => {
  const A = 'c'.repeat(32)
  await tenant(db, A, 'Verified prospect lists for outbound teams')
  await db.run('UPDATE users SET website = ? WHERE id = ?', ['https://www.acme.io', A])
  const play = await createQueryJob(db, A, { query: 'B2B SaaS founders asking for lead sources', icp: null, seller: 'Verified prospect lists for outbound teams - https://acme.io', offer: 'Verified B2B prospect lists and sales leads' })
  const { rubric } = await loadPlayDemandRubric(db, A, play)
  assert.ok(rubric)
  assert.ok(rubric.own_names.includes('Acme') && rubric.own_names.includes('acme'))
  const asOf = new Date('2026-11-03T12:00:00Z')
  const text = 'Our sales team needs a steady stream of qualified leads. We are looking for a prospect list provider that is verified.'
  const base = { source_url: 'https://forum.example.test/t/2', published_at: '2026-11-01T00:00:00Z', text }
  const own = qualifyDemand({ ...base, author: { name: 'S', headline: 'CEO, Acme', company: 'Acme' } }, rubric, asOf)
  assert.notEqual(own.tier, 'high_intent'); assert.equal(own.class, 'competitor')
  assert.equal(qualifyDemand({ ...base, author: { name: 'B', headline: 'CEO, Buyer Inc', company: 'Buyer Inc' } }, rubric, asOf).tier, 'high_intent')
})

test('ownNamesFrom: business name and website brand; generic or tiny labels are never an own name', () => {
  assert.deepEqual(ownNamesFrom('Acme', 'https://www.acme.io/pricing'), ['Acme', 'acme'])
  assert.deepEqual(ownNamesFrom('Sales', 'group.com'), [])
  assert.deepEqual(ownNamesFrom(null, 'https://shop.example.co.uk'), ['example'])
  assert.deepEqual(ownNamesFrom('', 'not a url %%'), [])
})

test('ownNamesFrom (#401 review): subdomains and short brands resolve to the registrable label, never to the subdomain', () => {
  assert.deepEqual(ownNamesFrom(null, 'https://app.acm.io'), ['acm'])
  assert.deepEqual(ownNamesFrom(null, 'https://www.acm.io'), ['acm'])
  assert.deepEqual(ownNamesFrom(null, 'https://app.foo.ai'), ['foo'])
  assert.deepEqual(ownNamesFrom(null, 'shop.acme.io'), ['acme'])
  assert.deepEqual(ownNamesFrom(null, 'https://ibm.com'), ['ibm'])
  assert.deepEqual(ownNamesFrom(null, 'https://www.bbc.co.uk'), ['bbc'])
  assert.deepEqual(ownNamesFrom(null, 'https://shop.mysite.com.au'), ['mysite'])
  assert.deepEqual(ownNamesFrom(null, 'https://app.web.io'), [])   // generic label and no business name: nothing invented
})

// Instinct's reproduction: website-only seller identity on a subdomain, quiet post by the seller's own CEO.
bothEngines('a website-only seller on a subdomain still excludes its own CEO through the production rubric', async ({ db }) => {
  const A = 'd'.repeat(32)
  await tenant(db, A, 'Verified prospect lists for outbound teams')
  await db.run('UPDATE users SET business_name = NULL, website = ? WHERE id = ?', ['https://app.acm.io', A])
  const play = await createQueryJob(db, A, { query: 'B2B SaaS founders asking for lead sources', icp: null, seller: 'Verified prospect lists for outbound teams - https://app.acm.io', offer: 'Verified B2B prospect lists and sales leads' })
  const { rubric } = await loadPlayDemandRubric(db, A, play)
  assert.ok(rubric)
  assert.deepEqual(rubric.own_names, ['acm'])
  const asOf = new Date('2026-11-03T12:00:00Z')
  const text = 'Our sales team needs a steady stream of qualified leads. We are looking for a prospect list provider that is verified.'
  const base = { source_url: 'https://forum.example.test/t/3', published_at: '2026-11-01T00:00:00Z', text }
  const own = qualifyDemand({ ...base, author: { name: 'S', headline: 'CEO, Acm', company: 'Acm' } }, rubric, asOf)
  assert.notEqual(own.tier, 'high_intent'); assert.equal(own.class, 'competitor')
  assert.equal(qualifyDemand({ ...base, author: { name: 'B', headline: 'CEO, Buyer Inc', company: 'Buyer Inc' } }, rubric, asOf).tier, 'high_intent')
})
