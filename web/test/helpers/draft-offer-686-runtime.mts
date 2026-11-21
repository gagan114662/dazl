// #686: the draft preview uses the play's own offer. A draft's words are written once, under the offer the play had then;
// when the play's offer is changed afterwards (campaign page, or the offer card above the drafts), the preview must not
// keep presenting, approving or sending words written for an offer the play no longer sells. The real routes:
// POST /api/outreach (create), POST /api/campaigns/[id] (change the play's offer), GET /api/outreach (the preview list),
// POST /api/outreach/[id] (approve) and PATCH /api/outreach/[id] (a person rewrites the words).
// REAL wording: the staging live check of 2026-11-13 on #686 (demo account): the play "B2B software companies hiring
// account executives" was recorded with "Dental chairs, sterilisers and practice equipment" and changed on its campaign
// page to "Onboarding and ramp-up coaching for newly hired account executives"; the seller "Harbour Dental Supply (demo)".
// The buyer lead is synthetic (.invalid). In-memory SQLite, every migration; no network, no send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { saveSettings, sendBlockReason } from '../../lib/outreach/service.ts'
import { polishDraft } from '../../lib/outreach/draft-llm.ts'
import { saveKey } from '../../lib/llm/key-store.ts'
import type { Provider } from '../../lib/llm/provider.ts'
import { GET as LIST, POST as DRAFT } from '../../app/api/outreach/route.ts'
import { PATCH as EDIT, POST as ACT } from '../../app/api/outreach/[id]/route.ts'
import { POST as SET_OFFER } from '../../app/api/campaigns/[id]/route.ts'

process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
globalThis.fetch = (async (u: unknown) => { throw new Error(`network fenced: ${String(u)}`) }) as typeof fetch
const RECORDED = 'Dental chairs, sterilisers and practice equipment'
const CHOSEN = 'Onboarding and ramp-up coaching for newly hired account executives'
const SELLER = 'Harbour Dental Supply (demo)'
const QUERY = 'B2B software companies hiring account executives'
const A = 'a'.repeat(24)
const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db)
db.prepare("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, 'a@example.test', 'n', ?, 'x', 'y', ?)").run(A, SELLER, RECORDED)
saveSettings(db, A, { sender_name: 'G', postal_address: '1 King St W, Toronto ON, Canada', booking_url: null })
setUser({ id: A, business_name: SELLER })
const recent = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
function play(): { job: string; lead: string } {
  const job = randomBytes(12).toString('hex'), lead = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES (?, ?, ?, 'test', 'test', 'running', ?, ?)").run(job, A, SELLER, QUERY, `${RECORDED} - https://seller.example`)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at, human_confirmed_from, event_date) VALUES (?, ?, 'Pat', 'Buyer', 'sales@buyer.invalid', 'Buyer is hiring an account executive', 'https://buyer.invalid/careers', 'Buyer is hiring an account executive', 70, 1800000000, 'test_review', ?)").run(lead, job, recent)
  // the sales-hiring gate's durable pass record, as a finished scan for this request writes it
  for (const v of ['sales_hiring', 'requested_role_v1']) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:gate', 'gate_passed', ?, 'The required sales-hiring check passed', NULL, 'https://invalid.example/', ?, 1)").run(randomBytes(12).toString('hex'), lead, A, v, recent)
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  return { job, lead }
}
const req = (path: string, method: string, body?: unknown) => new NextRequest(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', host: 'localhost' }, body: body === undefined ? undefined : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const draft = async (lead: string) => { const r = await DRAFT(req('/api/outreach', 'POST', { lead_id: lead })); const j = await r.json() as { id?: string }; assert.equal(r.status, 201, JSON.stringify(j)); return j.id! }
const setOffer = async (job: string, offer: string) => { const r = await SET_OFFER(req(`/api/campaigns/${job}`, 'POST', { offer }), ctx(job)); assert.equal(r.status, 200) }
const preview = async (id: string) => ((await (await LIST()).json()) as { messages: { id: string; body: string; offer_changed?: boolean }[] }).messages.find(m => m.id === id)!
const approve = async (id: string) => { const r = await ACT(req(`/api/outreach/${id}`, 'POST', { action: 'approve' }), ctx(id)); return { status: r.status, ...(await r.json()) as { error?: string } } }

test('#686 a draft written under the recorded offer is marked and refused once the play sells something else', async () => {
  const p = play()
  const id = await draft(p.lead)
  const before = await preview(id)
  assert.match(before.body, new RegExp(`About ${SELLER.replace(/[()]/g, '\\$&')}: ${RECORDED}`))
  assert.equal(before.offer_changed, false, 'written under the offer the play has now')
  await setOffer(p.job, CHOSEN)
  const after = await preview(id)
  assert.equal(after.offer_changed, true, 'the preview says these words were written for an earlier offer')
  assert.deepEqual(await approve(id), { status: 409, error: 'offer_changed' })
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(id) as { status: string }).status, 'draft', 'nothing approved')
})

test('#686 a person rewriting the words under the play\'s current offer clears it; the offer check then passes', async () => {
  const p = play()
  const id = await draft(p.lead)
  await setOffer(p.job, CHOSEN)
  const r = await EDIT(req(`/api/outreach/${id}`, 'PATCH', { subject: 'Ramp-up coaching for your new AEs', body: `Hi Pat, I saw Buyer is hiring an account executive. About ${SELLER}: ${CHOSEN}.` }), ctx(id))
  assert.equal(r.status, 200)
  assert.equal((await preview(id)).offer_changed, false)
  const a = await approve(id)
  assert.notEqual(a.error, 'offer_changed')
  assert.equal(a.error, 'gmail_not_connected', 'the next, unrelated gate: the offer check passed')
})

test('#686 an approved draft whose play offer changes before sending is held from sending', async () => {
  const p = play()
  const id = await draft(p.lead)
  // approved under the offer it was written for (the approval stamp the service records: its exact recipient and words)
  const m = db.prepare('SELECT to_email, subject, body FROM outreach_messages WHERE id = ?').get(id) as { to_email: string; subject: string; body: string }
  db.prepare("UPDATE outreach_messages SET status = 'approved', approved_hash = ? WHERE id = ?").run(createHash('sha256').update(JSON.stringify([m.to_email, m.subject, m.body])).digest('hex'), id)
  assert.notEqual(sendBlockReason(db, A, id, { skipAccount: true }), 'offer_changed')
  await setOffer(p.job, CHOSEN)
  assert.equal(sendBlockReason(db, A, id, { skipAccount: true }), 'offer_changed')
})

test('#686 the unchanged offer and another play\'s change never mark a draft; an unbound older draft keeps working', async () => {
  const p = play(), other = play()
  const id = await draft(p.lead)
  await setOffer(other.job, CHOSEN)
  await setOffer(p.job, RECORDED) // the same offer chosen explicitly: the words still match it
  assert.equal((await preview(id)).offer_changed, false)
  assert.notEqual((await approve(id)).error, 'offer_changed')
  // a draft created before drafts were bound to their offer (no record of it): unchanged behaviour
  const q = play()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('legacy0000000000000000aa', ?, ?, 'sales@buyer.invalid', 's', 'an older body long enough for the checks', 'draft')").run(A, q.lead)
  await setOffer(q.job, CHOSEN)
  assert.equal((await preview('legacy0000000000000000aa')).offer_changed, false)
})

test('#686 a play whose offer becomes contested after drafting holds the draft; an edit then keeps it held', async () => {
  const p = play()
  const id = await draft(p.lead)
  const hash0 = (db.prepare('SELECT offer_hash FROM outreach_messages WHERE id = ?').get(id) as { offer_hash: string }).offer_hash
  // the play's request now states another offer than the one it was recorded with, and none is chosen: contested
  db.prepare('UPDATE scan_jobs SET query = ? WHERE id = ?').run(`${QUERY}. We sell CRM setup and outbound sales consulting.`, p.job)
  assert.equal((await preview(id)).offer_changed, true)
  assert.deepEqual(await approve(id), { status: 409, error: 'offer_changed' })
  const r = await EDIT(req(`/api/outreach/${id}`, 'PATCH', { subject: 'A new subject line', body: 'Hi Pat, a rewritten body long enough for the checks.' }), ctx(id))
  assert.equal(r.status, 200)
  assert.equal((db.prepare('SELECT offer_hash FROM outreach_messages WHERE id = ?').get(id) as { offer_hash: string }).offer_hash, hash0, 'no current offer to bind to: the old record stays')
  assert.deepEqual(await approve(id), { status: 409, error: 'offer_changed' }, 'still held until the play\'s offer is chosen')
})

test('#686 an AI rewrite records the offer it wrote under: a stale draft rewritten for the current offer is no longer marked', async () => {
  const master = randomBytes(32)
  saveKey(db, A, 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const providers = { anthropic: { completeDetailed: async () => ({ text: `Subject: Ramp-up coaching for your new AEs\n\nHi Pat, I saw Buyer is hiring an account executive. ${SELLER} offers ${CHOSEN}.`, model: 'm' }) } } as unknown as Record<string, Provider>
  const p = play()
  const id = await draft(p.lead)
  await setOffer(p.job, CHOSEN)
  assert.equal((await preview(id)).offer_changed, true)
  const out = await polishDraft(db, A, id, SELLER, { master, providers })
  assert.equal(out.rewritten, true, JSON.stringify(out))
  assert.equal((await preview(id)).offer_changed, false)
  await setOffer(p.job, RECORDED)
  assert.equal((await preview(id)).offer_changed, true, 'the rewrite is bound to the offer it was written for')
})
