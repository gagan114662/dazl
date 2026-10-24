import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot, enable, ATTESTATIONS, CONSENT_VERSION } from '../lib/outreach/autopilot.ts'
import { migrateLedger, grantConsent } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { runFollowups, setFollowups } from '../lib/outreach/followups.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { saveSettings, approve, sendMessage, createDraft } from '../lib/outreach/service.ts'
import { migrateSequences, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { domainReviewFor } from '../lib/outreach/domain-review.ts'
import { setDomainReview } from '../lib/scan/domain-review-action.ts'
import { confirmLeadReview, unconfirmLeadReview } from '../lib/scan/review-confirm.ts'

// Revocation safety: withdrawing a human confirmation must block approval and sending of
// every dependent unsent draft and sequence step, at approval time AND at execution time,
// unless the lead is independently eligible again (re-confirmed or machine-verified).
// The exact-word approval hash does not preserve revoked evidence eligibility. Machine
// verification paths, suppression, and already-sent mail are untouched.

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://app.test' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'test-token', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y' })) as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  return db
}

function addReviewLead(db: Database.Database, email = 'lead@acme.example') {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'roofing', location: 'Toronto' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, review_reason, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    lead, job, 'Acme Roofing', email, 'Acme Roofing is hiring five roofers', 'https://news.example/a',
    'Acme Roofing is hiring five roofers', null, 'quote_unconfirmed', 70)
  return { lead, job }
}

function mock() {
  const calls: string[] = []
  const fetchImpl = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) return json({ access_token: 'at' })
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const sendFn = (async (_t: string, raw: string) => { calls.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: `gm${calls.length}`, threadId: 'thread-1' } })
  return { calls, fetchImpl, sendFn, env, master, now: NOW, flags: { SEQUENCES_ENABLED: '1' } }
}

test('withdraw blocks approval of a dependent unsent draft', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  assert.equal(confirmLeadReview(db, 'A', lead), true)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  assert.throws(() => approve(db, 'A', draftId), /lead_evidence_withdrawn/)
  const m = db.prepare('SELECT status, approved_hash FROM outreach_messages WHERE id = ?').get(draftId) as { status: string; approved_hash: string | null }
  assert.equal(m.status, 'draft')
  assert.equal(m.approved_hash, null)
})

test('withdraw blocks sending of a draft approved before the withdrawal', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  approve(db, 'A', draftId) // approved while the confirmation stood
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  await assert.rejects(sendMessage(db, 'A', draftId, mock()), /lead_evidence_withdrawn/)
  const m = db.prepare('SELECT status, sent_at FROM outreach_messages WHERE id = ?').get(draftId) as { status: string; sent_at: number | null }
  assert.equal(m.sent_at, null) // nothing went out
})

test('re-confirming restores eligibility: the same draft approves and sends', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  unconfirmLeadReview(db, 'A', lead)
  assert.throws(() => approve(db, 'A', draftId), /lead_evidence_withdrawn/)
  assert.equal(confirmLeadReview(db, 'A', lead), true) // explicit restore
  approve(db, 'A', draftId)
  const m = mock()
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent')
  assert.equal(m.calls.length, 1)
})

test('legacy quote and confidence alone cannot create a new draft', async () => {
  const db = await setup()
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES (?,?,?,?,?,?,?,?)').run(lead, job, 'Acme', 'lead@acme.example', 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90)
  assert.throws(()=>createDraft(db,'A',lead,'Acme'),/lead_currentness_unconfirmed/)
})

test('withdraw blocks sequence set approval', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  assert.throws(() => approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW), /lead_evidence_withdrawn/)
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'draft')
})

test('withdraw stops an approved sequence at execution before any unsent step', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent') // step 1 out while confirmed - never recalled
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1) // step 2 never went out
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.equal(s.status, 'stopped')
  assert.equal(s.stop_reason, 'evidence_withdrawn')
})

test('withdraw stops an already-active sequence at its next due step', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', draftId, m)
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 1 }) // activates: step 1 mirrored, still confirmed
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active')
  unconfirmLeadReview(db, 'A', lead)
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(seq) as { stop_reason: string | null }).stop_reason, 'evidence_withdrawn')
})

test('withdraw during a due sequence step token fetch: zero send, claim released, sequence stopped', async () => {
  const db = await setup()
  const { lead } = addReviewLead(db)
  confirmLeadReview(db, 'A', lead)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  const seq = createSequence(db, 'A', draftId)
  const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent') // step 1 out while confirmed - never recalled
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 1 }) // activates while still confirmed
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'active')
  // Withdrawal lands DURING the access-token await, after the loop-top and claim checks passed.
  const withdrawFetch = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) { unconfirmLeadReview(db, 'A', lead); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const r = await runSequences(db, 'A', 'Acme', { ...m, fetchImpl: withdrawFetch, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 1) // step 2 never went out
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.equal(s.status, 'stopped')
  assert.equal(s.stop_reason, 'evidence_withdrawn')
  const step2 = db.prepare("SELECT status, claimed_at FROM sequence_steps WHERE tenant_id = 'A' AND sequence_id = ? AND step = 2").get(seq) as { status: string; claimed_at: number | null }
  assert.equal(step2.status, 'approved') // claim released, not stuck in sending
  assert.equal(step2.claimed_at, null)
})

async function setupFollowups() {
  const db = await setup()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 5 })
  setFollowups(db, 'A', true)
  return db
}

function interestedReviewThread(db: Database.Database, email = 'lead@acme.example') {
  const { lead } = addReviewLead(db, email)
  confirmLeadReview(db, 'A', lead)
  const mid = randomBytes(12).toString('hex'), thread = 't-' + mid
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, claimed_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'Quick question', 'bodybodybodybodybodybody', 'sent', ?, ?, ?, ?)").run(mid, lead, email, NOW - 4 * DAY, NOW - 4 * DAY, 'g-' + mid, thread)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, last_followup_at, stopped) VALUES ('A', ?, ?, ?, ?, ?, ?, 0, NULL, NULL)").run(thread, lead, email, 'root-' + mid, NOW - 4 * DAY, NOW - 4 * DAY)
  grantConsent(db, 'A', email, { channel: 'email', scope: 'followup', basis: 'reply_interest', evidenceRef: 'gmail:1', now: NOW - 4 * DAY })
  return { lead, thread }
}

const followupFlags = { AUTOPILOT_ENABLED: '1', SEQUENCES_ENABLED: '1' }

test('withdraw stops a warm follow-up thread before send; re-confirm does not resurrect it', async () => {
  const db = await setupFollowups()
  const { lead, thread } = interestedReviewThread(db)
  const m = mock()
  assert.equal(unconfirmLeadReview(db, 'A', lead), true)
  const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
  // Re-confirming restores lead eligibility, but the stopped thread stays stopped.
  assert.equal(confirmLeadReview(db, 'A', lead), true)
  const r2 = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, now: NOW + 10 * DAY })
  assert.equal(r2.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
})

test('withdraw during a follow-up token fetch: zero send, claim row deleted, thread stopped', async () => {
  const db = await setupFollowups()
  const { lead, thread } = interestedReviewThread(db)
  const m = mock()
  const withdrawFetch = (async (u: unknown) => {
    const url = String(u)
    if (url.includes('oauth2')) { unconfirmLeadReview(db, 'A', lead); return json({ access_token: 'at' }) }
    if (url.includes('/threads/')) return json({ messages: [] })
    return json({}, 404)
  }) as typeof fetch
  const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, fetchImpl: withdrawFetch })
  assert.equal(r.sent, 0)
  assert.equal(m.calls.length, 0)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped, 'evidence_withdrawn')
  assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0) // claim deleted, none stuck sending
})

test('legacy currentness hold preserves approved words and sent history; blocks approval/send and new draft', async()=>{
 const db=await setup(),{lead}=addReviewLead(db)
 confirmLeadReview(db,'A',lead)
 const draft=createDraft(db,'A',lead,'Acme');approve(db,'A',draft)
 const original=db.prepare('SELECT subject,body,status,approved_hash FROM outreach_messages WHERE id=?').get(draft)
 db.prepare('UPDATE leads SET human_confirmed_at=NULL,human_confirmed_from=NULL,confidence=85,review_reason=NULL WHERE id=?').run(lead)
 const m=mock()
 await assert.rejects(sendMessage(db,'A',draft,m),/lead_currentness_unconfirmed/)
 assert.equal(m.calls.length,0)
 assert.deepEqual(db.prepare('SELECT subject,body,status,approved_hash FROM outreach_messages WHERE id=?').get(draft),original)
 db.prepare("UPDATE outreach_messages SET status='draft' WHERE id=?").run(draft)
 assert.throws(()=>approve(db,'A',draft),/lead_currentness_unconfirmed/)
 assert.throws(()=>createDraft(db,'A',lead,'Acme'),/lead_currentness_unconfirmed/)
 assert.equal((db.prepare('SELECT human_confirmed_at FROM leads WHERE id=?').get(lead) as {human_confirmed_at:null}).human_confirmed_at,null)
})
test('legacy hold skips active sequence without cancelling or rewriting its approval',async()=>{
 const db=await setup(),{lead}=addReviewLead(db)
 confirmLeadReview(db,'A',lead)
 const draft=createDraft(db,'A',lead,'Acme'),seq=createSequence(db,'A',draft),m=mock()
 approveSequence(db,'A',seq,id=>approve(db,'A',id,true),NOW)
 await sendMessage(db,'A',draft,m)
 await runSequences(db,'A','Acme',{...m,now:NOW+1})
 const before=db.prepare('SELECT status,stop_reason FROM sequences WHERE id=?').get(seq)
 const words=db.prepare('SELECT step,subject,body,approved_hash,status FROM sequence_steps WHERE sequence_id=? ORDER BY step').all(seq)
 db.prepare('UPDATE leads SET human_confirmed_at=NULL,human_confirmed_from=NULL,confidence=85 WHERE id=?').run(lead)
 const out=await runSequences(db,'A','Acme',{...m,now:NOW+4*DAY})
 assert.equal(out.sent,0);assert.equal(m.calls.length,1)
 assert.deepEqual(db.prepare('SELECT status,stop_reason FROM sequences WHERE id=?').get(seq),before)
 assert.deepEqual(db.prepare('SELECT step,subject,body,approved_hash,status FROM sequence_steps WHERE sequence_id=? ORDER BY step').all(seq),words)
 assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id=?').get(draft) as {status:string}).status,'sent')
})
test('legacy hold appears during send token await and releases claim without send',async()=>{
 const db=await setup(),{lead}=addReviewLead(db);confirmLeadReview(db,'A',lead)
 const draft=createDraft(db,'A',lead,'Acme');approve(db,'A',draft)
 const m=mock(),fetchImpl=(async(u:unknown)=>{
  if(String(u).includes('oauth2')){db.prepare('UPDATE leads SET human_confirmed_at=NULL,human_confirmed_from=NULL,confidence=85 WHERE id=?').run(lead);return json({access_token:'at'})}
  return json({},404)
 }) as typeof fetch
 await assert.rejects(sendMessage(db,'A',draft,{...m,fetchImpl}),/lead_currentness_unconfirmed/)
 assert.equal(m.calls.length,0)
 assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id=?').get(draft) as {status:string}).status,'approved')
})
test('explicit review restores a legacy lead without replacing its historical verdict; withdrawal restores the hold',async()=>{
 const db=await setup(),{lead}=addReviewLead(db)
 db.prepare('UPDATE leads SET review_reason=NULL,confidence=85 WHERE id=?').run(lead)
 const original=db.prepare('SELECT signal,event_date,date_status,confidence FROM leads WHERE id=?').get(lead)
 assert.equal(confirmLeadReview(db,'A',lead),true)
 const draft=createDraft(db,'A',lead,'Acme');assert.ok(draft)
 assert.deepEqual(db.prepare('SELECT signal,event_date,date_status,confidence FROM leads WHERE id=?').get(lead),original)
 assert.equal(unconfirmLeadReview(db,'A',lead),true)
 assert.equal((db.prepare('SELECT review_reason FROM leads WHERE id=?').get(lead) as {review_reason:null}).review_reason,null)
 assert.throws(()=>approve(db,'A',draft),/lead_currentness_unconfirmed/)
})

test('a withdrawn website confirmation stops a warm follow-up before the claim and after the token await; re-confirming does not restart it', async () => {
  const mk = async () => {
    const db = await setupFollowups(); migrateConnectors(db)
    const { lead, thread } = interestedReviewThread(db)
    db.prepare('UPDATE leads SET contact = NULL WHERE id = ?').run(lead)
    const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
    ins.run(lead, 'email', 'lead@acme.example', null, 'https://acme.example/contact'); ins.run(lead, 'domain', 'acme.example|name_probe', 'domain-basis-v1:name_probe', 'https://acme.example/')
    const bind = domainReviewFor({ id: lead, contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never).binding!
    setDomainReview(db, 'A', lead, 'confirm', bind)
    return { db, lead, thread, bind }
  }
  const stoppedOf = (db: Database.Database, t: string) => (db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(t) as { stopped: string | null }).stopped
  // Before the claim.
  { const { db, lead, thread, bind } = await mk(); const m = mock()
    setDomainReview(db, 'A', lead, 'withdraw')
    const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags })
    assert.equal(r.sent, 0); assert.equal(m.calls.length, 0)
    assert.equal(stoppedOf(db, thread), 'domain_unconfirmed')
    assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0)
    setDomainReview(db, 'A', lead, 'confirm', bind)
    await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, now: NOW + 10 * DAY })
    assert.equal(m.calls.length, 0, 're-confirming does not restart a stopped thread'); assert.equal(stoppedOf(db, thread), 'domain_unconfirmed') }
  // During the token await: claim row removed, nothing sent.
  { const { db, lead, thread } = await mk(); const m = mock()
    const f = (async (u: unknown) => { const url = String(u); if (url.includes('oauth2')) { setDomainReview(db, 'A', lead, 'withdraw'); return json({ access_token: 'at' }) }; if (url.includes('/threads/')) return json({ messages: [] }); return json({}, 404) }) as typeof fetch
    const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags, fetchImpl: f })
    assert.equal(r.sent, 0); assert.equal(m.calls.length, 0)
    assert.equal(stoppedOf(db, thread), 'domain_unconfirmed')
    assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0) }
})

async function crawlSeq() {
  const db = await setup(); migrateConnectors(db)
  const { lead } = addReviewLead(db)
  db.prepare('UPDATE leads SET contact = NULL WHERE id = ?').run(lead)
  confirmLeadReview(db, 'A', lead)
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'lead@acme.example', null, 'https://acme.example/contact'); ins.run(lead, 'domain', 'acme.example|name_probe', 'domain-basis-v1:name_probe', 'https://acme.example/')
  const bind = domainReviewFor({ id: lead, contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never).binding!
  setDomainReview(db, 'A', lead, 'confirm', bind)
  const draftId = createDraft(db, 'A', lead, 'Acme')
  return { db, lead, draftId, seq: createSequence(db, 'A', draftId) }
}

test('withdrawn website confirmation blocks sequence set approval', async () => {
  const { db, lead, draftId, seq } = await crawlSeq()
  setDomainReview(db, 'A', lead, 'withdraw')
  assert.throws(() => approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW), /domain_unconfirmed/)
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(seq) as { status: string }).status, 'draft')
  assert.equal((db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(draftId) as { status: string }).status, 'draft')
})

test('withdrawn website confirmation stops an approved sequence before step 2 and re-confirming does not restart it', async () => {
  const { db, lead, draftId, seq } = await crawlSeq(); const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent')
  setDomainReview(db, 'A', lead, 'withdraw')
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0); assert.equal(m.calls.length, 1)
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.deepEqual(s, { status: 'stopped', stop_reason: 'domain_unconfirmed' })
  const rows = db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never
  setDomainReview(db, 'A', lead, 'confirm', domainReviewFor({ id: lead, contact: null }, rows).binding!)
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 6 * DAY })
  assert.equal(m.calls.length, 1)
})

test('withdrawn website confirmation during the step token await releases the claim and sends nothing', async () => {
  const { db, lead, draftId, seq } = await crawlSeq(); const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  await sendMessage(db, 'A', draftId, m)
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 1 })
  const f = (async (u: unknown) => { const url = String(u); if (url.includes('oauth2')) { setDomainReview(db, 'A', lead, 'withdraw'); return json({ access_token: 'at' }) }; if (url.includes('/threads/')) return json({ messages: [] }); return json({}, 404) }) as typeof fetch
  const r = await runSequences(db, 'A', 'Acme', { ...m, fetchImpl: f, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0); assert.equal(m.calls.length, 1)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(seq) as { stop_reason: string }).stop_reason, 'domain_unconfirmed')
  assert.equal((db.prepare("SELECT count(*) AS n FROM sequence_steps WHERE status = 'sending'").get() as { n: number }).n, 0)
})

test('unreadable website state: approved send is refused with exactly review_unreadable, nothing sent, status unchanged; recovery sends under the existing confirmation', async () => {
  const db = await setup(); migrateConnectors(db)
  const { lead } = addReviewLead(db); confirmLeadReview(db, 'A', lead)
  db.prepare('UPDATE leads SET contact = NULL WHERE id = ?').run(lead)
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'lead@acme.example', null, 'https://acme.example/contact'); ins.run(lead, 'domain', 'acme.example|name_probe', 'domain-basis-v1:name_probe', 'https://acme.example/')
  const bind = domainReviewFor({ id: lead, contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never).binding!
  setDomainReview(db, 'A', lead, 'confirm', bind)
  const draftId = createDraft(db, 'A', lead, 'Acme'); approve(db, 'A', draftId)
  const status = () => (db.prepare('SELECT status FROM outreach_messages WHERE id = ?').get(draftId) as { status: string }).status
  assert.equal(status(), 'approved')
  const m = mock()
  db.exec('ALTER TABLE lead_enrichments RENAME TO le_bak')
  await assert.rejects(sendMessage(db, 'A', draftId, m), (e: Error) => e.message === 'review_unreadable')
  assert.equal(m.calls.length, 0); assert.equal(status(), 'approved')
  db.exec('ALTER TABLE le_bak RENAME TO lead_enrichments')
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent'); assert.equal(m.calls.length, 1)
})

test('unreadable website state: follow-up round skips with no call, no stop and no leaked claim; recovery continues under the existing confirmation', async () => {
  const db = await setupFollowups(); migrateConnectors(db)
  const { lead, thread } = interestedReviewThread(db)
  db.prepare('UPDATE leads SET contact = NULL WHERE id = ?').run(lead)
  const ins = db.prepare("INSERT INTO lead_enrichments (tenant_id, lead_id, connector, kind, value, label, source_url, source_date, retrieved_at) VALUES ('A', ?, 'sitecrawl', ?, ?, ?, ?, '2026-10-24', 10)")
  ins.run(lead, 'email', 'lead@acme.example', null, 'https://acme.example/contact'); ins.run(lead, 'domain', 'acme.example|name_probe', 'domain-basis-v1:name_probe', 'https://acme.example/')
  setDomainReview(db, 'A', lead, 'confirm', domainReviewFor({ id: lead, contact: null }, db.prepare('SELECT connector, kind, value, label, source_url, retrieved_at FROM lead_enrichments WHERE lead_id = ?').all(lead) as never).binding!)
  const m = mock()
  const stopped = () => (db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(thread) as { stopped: string | null }).stopped
  db.exec('ALTER TABLE lead_enrichments RENAME TO le_bak')
  const r = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags })
  assert.equal(r.sent, 0); assert.equal(m.calls.length, 0); assert.equal(stopped(), null)
  assert.equal((db.prepare('SELECT count(*) AS n FROM followup_messages').get() as { n: number }).n, 0, 'no leaked claim row')
  db.exec('ALTER TABLE le_bak RENAME TO lead_enrichments')
  const r2 = await runFollowups(db, 'A', 'Acme', { ...m, flags: followupFlags })
  assert.equal(r2.sent, 1); assert.equal(m.calls.length, 1); assert.equal(stopped(), null)
})

test('unreadable website state: due sequence step skips with no call and no stop; recovery sends step 2 under the existing approval', async () => {
  const { db, lead, draftId, seq } = await crawlSeq(); const m = mock()
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  assert.equal(await sendMessage(db, 'A', draftId, m), 'sent')
  db.exec('ALTER TABLE lead_enrichments RENAME TO le_bak')
  const r = await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0); assert.equal(m.calls.length, 1)
  const s = db.prepare('SELECT status, stop_reason FROM sequences WHERE id = ?').get(seq) as { status: string; stop_reason: string | null }
  assert.notEqual(s.status, 'stopped'); assert.equal(s.stop_reason, null)
  const claims = db.prepare("SELECT count(*) AS n FROM outreach_messages WHERE status = 'sending'").get() as { n: number }
  assert.equal(claims.n, 0, 'no leaked sending claim')
  db.exec('ALTER TABLE le_bak RENAME TO lead_enrichments')
  void lead
  await runSequences(db, 'A', 'Acme', { ...m, now: NOW + 3 * DAY + 1 })
  assert.equal(m.calls.length, 2)
})
