// The tenant's customer / open-deal list (lib/accounts/relationships.ts, #364), on both engines: how a lead matches
// an entry, and what never matches. Synthetic tenants, companies and addresses.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { syncAccountGraph, leadLink, mergeAccounts } from '../lib/accounts/graph.ts'
import { addRelationship, listRelationships, relationshipForLead, removeRelationship, RelationshipError } from '../lib/accounts/relationships.ts'
import { firstTouchHold } from '../lib/accounts/cooldown.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = 1_800_000_000
let seq = 0
async function play(db: Db, tenant: string) {
  const id = `job-${tenant}-${++seq}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')", [id, tenant])
  return id
}
async function lead(db: Db, job: string, company: string, contact: string | null, domain: string | null) {
  const id = `lead-${++seq}`
  await db.run('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, company_domain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, job, 'Pat', company, contact, `signal for ${company}`, `https://news.example/${id}`, domain, NOW + seq])
  return id
}
const code = (c: string) => (e: unknown) => e instanceof RelationshipError && e.code === c

bothEngines('a lead matches only through its own resolved identity; unknown and quarantined identities stay unknown', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const acme = await lead(db, p1, 'Acme Roofing', 'jane@acme-roofing.example', 'acme-roofing.example')
  const acme2 = await lead(db, p2, 'Acme Roofing Ltd', 'bob@acme-roofing.example', 'acme-roofing.example')
  const birch = await lead(db, p1, 'Birch Works', 'kim@birch-works.example', 'birch-works.example')
  const bare = await lead(db, p2, 'Acme Roofing', null, null) // same name, no website or email: quarantined
  await syncAccountGraph(db, 'T', { now: NOW })
  const unlinked = await lead(db, p2, 'Cedar Works', 'sam@cedar-works.example', 'cedar-works.example') // found after the sync
  assert.equal(await leadLink(db, 'T', unlinked), null)
  await addRelationship(db, 'T', { domain: 'WWW.acme-roofing.example', status: 'customer' }, 'member:T', NOW)
  await addRelationship(db, 'T', { domain: 'cedar-works.example', status: 'open_deal' }, 'member:T', NOW)
  assert.equal((await relationshipForLead(db, 'T', acme))?.status, 'customer')
  assert.equal((await relationshipForLead(db, 'T', acme2))?.status, 'customer', 'the second play\'s lead of the same account')
  assert.equal(await relationshipForLead(db, 'T', birch), null)
  assert.equal(await relationshipForLead(db, 'T', bare), null, 'quarantined: unknown, never matched by name')
  assert.equal(await relationshipForLead(db, 'T', unlinked), null, 'not yet resolved: unknown')
  // The first-touch check resolves the identity itself and then applies the list, with exclusions on.
  assert.equal(await firstTouchHold(db, db, 'T', unlinked, { now: NOW, env: { DAZL_ACCOUNT_EXCLUSIONS: '1' } }), 'open_deal')
  assert.equal(await firstTouchHold(db, db, 'T', acme, { now: NOW, env: {} }), null, 'exclusions off: no hold')
  assert.equal(await firstTouchHold(db, db, 'T', bare, { now: NOW, env: { DAZL_ACCOUNT_EXCLUSIONS: '1' } }), 'identity_review_required', 'still held for review, not for the list')
})

bothEngines('entries by account id follow a merge; removal is reversible and stops matching; tenants never see each other\'s', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Harbor Movers', 'lee@harbormovers.example', 'harbormovers.example')
  const b = await lead(db, p2, 'Harbor Movers', 'kai@harbor-movers.example', 'harbor-movers.example')
  await syncAccountGraph(db, 'T', { now: NOW })
  const keep = (await leadLink(db, 'T', a))!.account_id!, drop = (await leadLink(db, 'T', b))!.account_id!
  const e = await addRelationship(db, 'T', { accountId: drop, status: 'customer', note: 'contract 2025' }, 'member:T', NOW)
  assert.equal((await relationshipForLead(db, 'T', a)), null)
  await mergeAccounts(db, 'T', keep, drop, 'member:T', NOW + 1)
  assert.equal((await relationshipForLead(db, 'T', a))?.id, e.id, 'the merged account\'s entry names the kept account too')
  await assert.rejects(addRelationship(db, 'T', { accountId: drop, status: 'open_deal' }, 'member:T', NOW), code('account_not_found'), 'a merged account takes no new entries')
  await removeRelationship(db, 'T', e.id, 'member:T', NOW + 2)
  assert.equal(await relationshipForLead(db, 'T', a), null)
  assert.deepEqual((await listRelationships(db, 'T', { includeRemoved: true })).map(r => [r.id, r.removed_at, r.removed_by]), [[e.id, NOW + 2, 'member:T']])
  await assert.rejects(removeRelationship(db, 'T', e.id, 'member:T'), code('not_found'), 'removed once')
  // Another tenant.
  const q = await play(db, 'U')
  const u = await lead(db, q, 'Harbor Movers', 'lee@harbormovers.example', 'harbormovers.example')
  await syncAccountGraph(db, 'U', { now: NOW })
  await addRelationship(db, 'T', { domain: 'harbormovers.example', status: 'customer' }, 'member:T', NOW)
  assert.equal(await relationshipForLead(db, 'U', u), null, 'T\'s list is not U\'s')
  assert.deepEqual(await listRelationships(db, 'U'), [])
  await assert.rejects(removeRelationship(db, 'U', (await listRelationships(db, 'T'))[0].id, 'member:U'), code('not_found'))
  await assert.rejects(addRelationship(db, 'U', { accountId: keep, status: 'customer' }, 'member:U'), code('account_not_found'))
})
