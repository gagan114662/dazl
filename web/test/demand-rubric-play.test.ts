// #401: the demand rubric comes from the play's own configuration (effective offer + saved competitors), tenant scoped,
// on SQLite and Postgres. Synthetic tenants and plays only.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { setCompetitors } from '../lib/signals/competitor-reddit.ts'
import { loadPlayDemandRubric } from '../lib/scan/demand-rubric-play.ts'
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
