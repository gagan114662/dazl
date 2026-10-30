// The canonical account/contact graph (lib/accounts/graph.ts, #364), on both engines. Synthetic tenants, plays,
// companies and addresses only; nothing is fetched or sent.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { accountLeads, assignQuarantined, contactForEmail, IdentityError, leadLink, mergeAccounts, normName, splitLead, syncAccountGraph } from '../lib/accounts/graph.ts'
import { recordBooking, listBookings } from '../lib/calcom/index.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = 1_800_000_000
let seq = 0
async function play(db: Db, tenant: string): Promise<string> {
  const id = `job-${tenant}-${++seq}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')", [id, tenant])
  return id
}
async function lead(db: Db, job: string, company: string, o: { domain?: string; contact?: string; name?: string; url?: string } = {}): Promise<string> {
  const id = `lead-${++seq}`
  await db.run('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, company_domain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, job, o.name ?? 'Pat', company, o.contact ?? null, `signal for ${company}`, o.url ?? `https://news.example/${id}`, o.domain ?? null, NOW + seq])
  return id
}
const link = async (db: Db, t: string, l: string) => { const k = await leadLink(db, t, l); assert.ok(k, `link for ${l}`); return k }
const count = async (db: Db, sql: string, p: (string | number)[]) => Number((await db.get<{ n: number }>(sql, p))?.n ?? 0)

bothEngines('the same company and contact from two plays is one account and one contact; each play keeps its own observation', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Acme Roofing Inc.', { domain: 'www.acme-roofing.example', contact: 'Jane@Acme-Roofing.example', url: 'https://news.example/acme-hiring' })
  const b = await lead(db, p2, 'ACME Roofing', { domain: 'acme-roofing.example', contact: 'jane@acme-roofing.example ', url: 'https://jobs.example/acme-funding' })
  assert.deepEqual(await syncAccountGraph(db, 'T', { now: NOW }), { linked: 2, quarantined: 0, remaining: false })
  const [ka, kb] = [await link(db, 'T', a), await link(db, 'T', b)]
  assert.equal(ka.account_id, kb.account_id); assert.equal(ka.contact_id, kb.contact_id); assert.ok(ka.contact_id)
  assert.deepEqual([ka.basis, kb.basis], ['company_domain', 'company_domain'])
  // Provenance: both observations, each with its own play, source and signal.
  assert.deepEqual((await accountLeads(db, 'T', ka.account_id!)).map(r => [r.lead_id, r.job_id, r.source_url]),
    [[a, p1, 'https://news.example/acme-hiring'], [b, p2, 'https://jobs.example/acme-funding']])
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_accounts WHERE tenant_id = 'T'", []), 1)
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_contacts WHERE tenant_id = 'T'", []), 1)
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_identity_history WHERE tenant_id = 'T' AND action = 'link'", []), 2)
  // Idempotent: a second sync links nothing new and writes nothing.
  assert.deepEqual(await syncAccountGraph(db, 'T', { now: NOW + 5 }), { linked: 0, quarantined: 0, remaining: false })
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_identity_history WHERE tenant_id = 'T'", []), 2)
})

bothEngines('same-name businesses are never merged: different websites are different accounts; a bare name never joins another', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Northside Plumbing', { domain: 'northside-plumbing-a.example' })
  const b = await lead(db, p2, 'Northside Plumbing', { domain: 'northside-plumbing-b.example' })
  const c = await lead(db, p2, 'Northside Plumbing') // no website, no email
  const d = await lead(db, p1, 'Main Street Bakery'), e = await lead(db, p2, 'Main Street Bakery')
  const f = await lead(db, p2, 'Solo Cafe', { contact: 'owner@gmail.com' }) // a consumer mailbox is not a company key
  await syncAccountGraph(db, 'T', { now: NOW })
  const [ka, kb, kc, kd, ke, kf] = await Promise.all([a, b, c, d, e, f].map(l => link(db, 'T', l)))
  assert.notEqual(ka.account_id, kb.account_id)
  assert.deepEqual([kc.status, kc.account_id, kc.basis], ['quarantined', null, 'name_only'], 'held for a person: two accounts already carry that name')
  assert.deepEqual([kd.status, kd.basis], ['linked', 'name_only'], 'the first bare name gets its own account')
  assert.deepEqual([ke.status, ke.reason], ['quarantined', 'same name as another account, no website or email to tell them apart'])
  assert.deepEqual([kf.status, kf.basis], ['linked', 'name_only'])
  // Another tenant's same-named company is no evidence for this tenant.
  const q = await play(db, 'U')
  const u = await lead(db, q, 'Main Street Bakery')
  await syncAccountGraph(db, 'U', { now: NOW })
  assert.equal((await link(db, 'U', u)).status, 'linked')
})

bothEngines('an email domain stands in for a website only when the name agrees; a contact email on another account is quarantined', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Pine Co', { contact: 'ana@pine.example' })
  const b = await lead(db, p2, 'Pine', { contact: 'ben@pine.example' })
  const c = await lead(db, p2, 'Cedar Group', { contact: 'cal@pine.example' })
  // The same person's email on a lead whose website says another company: never moved onto it.
  const d = await lead(db, p2, 'Other Works', { domain: 'other-works.example', contact: 'ana@pine.example' })
  await syncAccountGraph(db, 'T', { now: NOW })
  const [ka, kb, kc, kd] = await Promise.all([a, b, c, d].map(l => link(db, 'T', l)))
  assert.equal(normName('Pine Co'), normName('Pine'))
  assert.deepEqual([ka.basis, kb.basis, kb.account_id], ['email_domain', 'email_domain', ka.account_id])
  assert.notEqual(ka.contact_id, kb.contact_id, 'two people at one company')
  assert.deepEqual([kc.status, kc.reason], ['quarantined', 'email domain matches an account with another name'])
  assert.deepEqual([kd.status, kd.reason], ['quarantined', 'contact email belongs to another account'])
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_accounts WHERE tenant_id = 'T' AND domain = 'other-works.example'", []), 1, 'its own account exists; only the link waits')
  // The quarantined email makes the person ambiguous: a booking for it does not resolve to the contact.
  assert.equal(await contactForEmail(db, 'T', 'ana@pine.example'), null)
  assert.ok(await contactForEmail(db, 'T', 'ben@pine.example'))
})

bothEngines('booking: the same person found by two plays books both leads through the canonical contact; ambiguity stays unmatched', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Acme Roofing', { domain: 'acme-roofing.example', contact: 'jane@acme-roofing.example' })
  const b = await lead(db, p2, 'Acme Roofing Ltd', { domain: 'acme-roofing.example', contact: 'jane@acme-roofing.example' })
  // Before #364 two leads with one email stayed unmatched; now they are one contact.
  assert.equal(await recordBooking(db, 'T', { uid: 'bk1', email: 'Jane@acme-roofing.example', name: 'Jane' }), 'matched')
  const k = await link(db, 'T', a)
  const row = await db.get<{ lead_id: string; contact_id: string }>("SELECT lead_id, contact_id FROM calcom_bookings WHERE tenant_id = 'T' AND booking_uid = 'bk1'")
  assert.deepEqual([row?.lead_id, row?.contact_id], [b, k.contact_id], 'the newest observation, and the contact')
  assert.deepEqual((await db.all<{ stage: string | null }>('SELECT stage FROM leads WHERE id IN (?, ?) ORDER BY id', [a, b])).map(r => r.stage), ['booked_call', 'booked_call'])
  // Same email at two different companies (two websites): two accounts, the second link quarantined, no guess.
  const c = await lead(db, p1, 'Cedar Works', { domain: 'cedar-works.example', contact: 'sam@shared.example' })
  const d = await lead(db, p2, 'Birch Works', { domain: 'birch-works.example', contact: 'sam@shared.example' })
  assert.equal(await recordBooking(db, 'T', { uid: 'bk2', email: 'sam@shared.example', name: null }), 'unmatched')
  assert.deepEqual((await db.all<{ stage: string | null }>('SELECT stage FROM leads WHERE id IN (?, ?) ORDER BY id', [c, d])).map(r => r.stage), [null, null])
  assert.equal((await listBookings(db, 'T') as { lead_id: string | null }[]).filter(r => r.lead_id === null).length, 1)
  // Another tenant's booking for the same address never touches this tenant.
  assert.equal(await recordBooking(db, 'U', { uid: 'bk3', email: 'jane@acme-roofing.example', name: null }), 'unmatched')
})

bothEngines('merge, split and assign: each by a person, recorded with what moved; later sightings follow the merged account', async ({ db }) => {
  const p1 = await play(db, 'T'), p2 = await play(db, 'T')
  const a = await lead(db, p1, 'Harbor Freight Movers', { domain: 'harbormovers.example', contact: 'lee@harbormovers.example' })
  const b = await lead(db, p2, 'Harbor Movers', { domain: 'harbor-movers.example' })
  await syncAccountGraph(db, 'T', { now: NOW })
  const keep = (await link(db, 'T', a)).account_id!, drop = (await link(db, 'T', b)).account_id!
  assert.notEqual(keep, drop)
  await mergeAccounts(db, 'T', keep, drop, 'owner:T', NOW + 10)
  assert.equal((await link(db, 'T', b)).account_id, keep)
  const h = await db.get<{ detail: string; actor: string }>("SELECT detail, actor FROM tenant_identity_history WHERE tenant_id = 'T' AND action = 'merge'")
  assert.deepEqual(JSON.parse(h!.detail).leads, [b]); assert.equal(h!.actor, 'owner:T')
  assert.equal((await db.get<{ status: string; merged_into: string }>("SELECT status, merged_into FROM tenant_accounts WHERE tenant_id = 'T' AND id = ?", [drop]))?.merged_into, keep)
  // The dropped account's website now names the kept one.
  const c = await lead(db, p2, 'Harbor Movers LLC', { domain: 'harbor-movers.example' })
  await syncAccountGraph(db, 'T', { now: NOW + 20 })
  assert.equal((await link(db, 'T', c)).account_id, keep)
  await assert.rejects(mergeAccounts(db, 'T', keep, drop, 'owner:T'), (e: unknown) => e instanceof IdentityError && e.code === 'not_active')
  // Split: the person says this observation is a different company after all.
  const own = await splitLead(db, 'T', c, 'owner:T', NOW + 30)
  const kc = await link(db, 'T', c)
  assert.deepEqual([kc.account_id, kc.contact_id, kc.basis], [own, null, 'manual'])
  assert.equal(JSON.parse((await db.get<{ detail: string }>("SELECT detail FROM tenant_identity_history WHERE tenant_id = 'T' AND action = 'split'"))!.detail).from_account, keep)
  // Assign: a quarantined lead resolved by a person onto an account; its email becomes that account's contact.
  const q = await lead(db, p1, 'Harbor Freight Movers')
  await syncAccountGraph(db, 'T', { now: NOW + 40 })
  assert.equal((await link(db, 'T', q)).status, 'quarantined')
  await assignQuarantined(db, 'T', q, keep, 'owner:T', NOW + 50)
  assert.deepEqual([(await link(db, 'T', q)).status, (await link(db, 'T', q)).account_id], ['linked', keep])
  await assert.rejects(assignQuarantined(db, 'T', q, keep, 'owner:T'), (e: unknown) => e instanceof IdentityError && e.code === 'not_quarantined')
})

bothEngines('tenant scope: another tenant\'s accounts, contacts and leads are never read, merged or assigned', async ({ db }) => {
  const pa = await play(db, 'A'), pb = await play(db, 'B')
  const a = await lead(db, pa, 'Acme Roofing', { domain: 'acme-roofing.example', contact: 'jane@acme-roofing.example' })
  const b = await lead(db, pb, 'Acme Roofing', { domain: 'acme-roofing.example', contact: 'jane@acme-roofing.example' })
  await syncAccountGraph(db, 'A', { now: NOW })
  assert.equal(await leadLink(db, 'A', b), null, 'A\'s sync never links B\'s lead')
  await syncAccountGraph(db, 'B', { now: NOW })
  const [ka, kb] = [await link(db, 'A', a), await link(db, 'B', b)]
  assert.notEqual(ka.account_id, kb.account_id)
  assert.equal(await contactForEmail(db, 'A', 'jane@acme-roofing.example').then(c => c?.lead_ids.join()), a)
  await assert.rejects(mergeAccounts(db, 'A', ka.account_id!, kb.account_id!, 'owner:A'), (e: unknown) => e instanceof IdentityError && e.code === 'not_found')
  await assert.rejects(splitLead(db, 'A', b, 'owner:A'), (e: unknown) => e instanceof IdentityError && e.code === 'not_found')
  assert.deepEqual((await accountLeads(db, 'A', kb.account_id!)), [])
})

bothEngines('two syncs at once on one tenant: one account per website, one contact per email, every lead linked once', async ({ db }) => {
  const plays = [await play(db, 'T'), await play(db, 'T'), await play(db, 'T')]
  for (const p of plays) for (let i = 0; i < 6; i++) await lead(db, p, `Company ${i}`, { domain: `company-${i}.example`, contact: `buyer@company-${i}.example` })
  await Promise.all([syncAccountGraph(db, 'T', { now: NOW }), syncAccountGraph(db, 'T', { now: NOW }), syncAccountGraph(db, 'T', { now: NOW })])
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_accounts WHERE tenant_id = 'T'", []), 6)
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_contacts WHERE tenant_id = 'T'", []), 6)
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_lead_links WHERE tenant_id = 'T' AND status = 'linked'", []), 18)
  assert.equal(await count(db, "SELECT COUNT(*) AS n FROM tenant_identity_history WHERE tenant_id = 'T'", []), 18, 'one link record per lead')
}, { pgMax: 6 })
