// #385: the capture side. Rejecting a lead WITH a reason teaches the feedback store (account / person / event level), releasing it reverts exactly that; tenant-isolated; a bare reject teaches nothing.
// Synthetic leads, both engines, no network.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import type { Db } from '../lib/db/client.ts'
import { recordLeadRejection, revertLeadRejection, isReason } from '../lib/scan/reject-feedback.ts'
import { activeFeedback, heldBy } from '../lib/scan/feedback.ts'
import { setQuarantine } from '../lib/scan/quarantine.ts'

async function seed(db: Db, tenant: string, id: string, o: { company?: string; domain?: string | null; date?: string | null; url?: string } = {}) {
  const job = `job${id}`
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, attempts) VALUES (?, ?, 'x', '(from request)', '-', 'dentists hiring in Austin', 'running', 1)", [job, tenant])
  await db.run('INSERT INTO leads (id, scan_job_id, company, signal, source_url, company_domain, event_date) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, job, o.company ?? 'Harbor Dental', 'opened a second site', o.url ?? 'https://news.example/harbor', o.domain === undefined ? 'harbordental.example' : o.domain, o.date === undefined ? '2026-10-01' : o.date])
}

bothEngines('reject with a reason: the account is learned (source + query kept), explained, and a later lead for the same account is held; another tenant is unaffected', async ({ db }) => {
  await seed(db, 'A', 'l1'); await seed(db, 'B', 'l2')
  const row = await recordLeadRejection(db, 'A', 'l1', 'wrong_industry')
  assert.equal(row!.entity_kind, 'account'); assert.equal(row!.source, 'news.example'); assert.equal(row!.query_key, 'dentists hiring in austin'); assert.equal(row!.note, 'lead:l1')
  const mine = await activeFeedback(db, 'A')
  const h = heldBy(mine, { company: 'Harbor Dental Inc', company_domain: 'https://www.harbordental.example' }); assert.ok(h); assert.match(h!.explanation, /wrong_industry.*account level/)
  assert.equal(heldBy(await activeFeedback(db, 'B'), { company: 'Harbor Dental', company_domain: 'harbordental.example' }), null)
  assert.equal(await recordLeadRejection(db, 'B', 'l1', 'competitor'), null, 'another tenant cannot reject (or learn from) this lead')
})

bothEngines('reason decides the level: wrong_person -> person, wrong_timing -> the event (a different new event lifts it), the rest -> account', async ({ db }) => {
  await seed(db, 'A', 'l1', { date: '2026-06-01', url: 'https://news.example/a' })
  const p = await recordLeadRejection(db, 'A', 'l1', 'wrong_person', 'Fay Buyer'); assert.equal(p!.entity_kind, 'person')
  const t = await recordLeadRejection(db, 'A', 'l1', 'wrong_timing'); assert.equal(t!.entity_kind, 'event')
  const lead = { company: 'Harbor Dental', company_domain: 'harbordental.example' }, rows = await activeFeedback(db, 'A')
  assert.ok(heldBy(rows, lead, { event: { date: '2026-06-01', source_url: 'https://news.example/a' } }), 'the same event stays held')
  assert.equal(heldBy(rows, lead, { person: 'Bob Other', event: { date: '2026-10-20', source_url: 'https://news.example/new' } }), null, 'a different person at a new event is not held')
  assert.ok(heldBy(rows, lead, { person: 'Fay Buyer', event: { date: '2026-10-20', source_url: 'https://news.example/new' } }), 'the rejected person is still held')
})

bothEngines('releasing the lead reverts exactly its rejection (history kept); a bare quarantine teaches nothing; a bad reason is not a reason', async ({ db }) => {
  await seed(db, 'A', 'l1'); await seed(db, 'A', 'l3', { company: 'Other Co', domain: 'other.example' })
  await setQuarantine(db, 'A', 'l1', 'quarantine', 'wrong'); await recordLeadRejection(db, 'A', 'l1', 'not_useful')
  await setQuarantine(db, 'A', 'l3', 'quarantine', 'wrong'); assert.equal((await activeFeedback(db, 'A')).length, 1, 'the bare quarantine of l3 taught nothing')
  assert.equal(await revertLeadRejection(db, 'B', 'l1'), 0, 'another tenant cannot revert it')
  assert.equal(await revertLeadRejection(db, 'A', 'l1'), 1); assert.equal((await activeFeedback(db, 'A')).length, 0)
  const all = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM lead_feedback WHERE tenant_id = ?', ['A']); assert.equal(Number(all!.n), 1, 'the row is kept as history')
  assert.equal(await revertLeadRejection(db, 'A', 'l1'), 0, 'already reverted')
  assert.equal(isReason('because'), false); assert.equal(isReason('competitor'), true)
})
