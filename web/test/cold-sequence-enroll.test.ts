import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { completeOAuth, startOAuth, GMAIL_READ_SCOPE } from '../lib/gmail/oauth.ts'
import { migrateAutopilot, enable, runAutopilot, ATTESTATIONS, CONSENT_VERSION } from '../lib/outreach/autopilot.ts'
import { migrateLedger } from '../lib/outreach/ledger.ts'
import { migrateReplies, acceptReadConsent } from '../lib/outreach/replies.ts'
import { saveSettings, suppress, approve, sendMessage, type Deps } from '../lib/outreach/service.ts'
import { migrateSequences, acceptAutoSequencePolicy, autoSequencePolicyAccepted, revokeAutoSequencePolicy, AUTO_SEQUENCE_POLICY, AUTO_SEQUENCE_POLICY_TEXT, enrollColdSequence, createSequence, approveSequence, runSequences } from '../lib/outreach/sequences.ts'

// #414: under a separately versioned one-time policy, a successful autopilot first touch enrolls a bounded
// cold no-reply sequence (day 3 / day 7) without per-lead creation or approval. Manual mode is unchanged.

const NOW = 1800000000, DAY = 86400
const master = randomBytes(32)
const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '0', SEQUENCES_ENABLED: '1' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

async function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateLedger(db); migrateReplies(db); migrateSequences(db); seedOffers(db)
  const state = new URL(startOAuth(db, 'A', { env, now: NOW, withRead: true })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: `https://www.googleapis.com/auth/gmail.send ${GMAIL_READ_SCOPE}`, id_token: 'x.' + Buffer.from(JSON.stringify({ email: 'me@acme.example', email_verified: true })).toString('base64url') + '.y' })) as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  acceptReadConsent(db, 'A')
  return db
}
function lead(db: Database.Database, email: string, company = 'Acme') {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, company, email, 'Hiring roofers', 'https://acme.example/jobs', 'Hiring roofers', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at = 1800000000, human_confirmed_from = 'test_review' WHERE id = ?").run(id)
  return id
}
// A first touch already sent (the autopilot outcome enrollment hooks after).
function sentMessage(db: Database.Database, leadId: string, email: string) {
  const mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at, gmail_id, thread_id) VALUES (?, 'A', ?, ?, 'A quick question', 'This is the sent first touch.', 'sent', ?, 'g1', 'thread-1')").run(mid, leadId, email, NOW)
  return mid
}
const sends = () => { const sent: string[] = []; const d: Deps & { flags: Record<string, string> } = { flags: ON, env, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: (async (u: unknown) => { const url = String(u); if (url.includes('token')) return json({ access_token: 'at' }); if (url.includes('/threads/')) return json({ messages: [] }); return json({}, 404) }) as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(Buffer.from(raw, 'base64url').toString('utf8')); return { id: 'g' + sent.length, threadId: 'thread-1' } }) as never }; return { sent, d } }
const seqRows = (db: Database.Database) => db.prepare('SELECT id, lead_id, status, policy, claims_hash FROM sequences').all() as { id: string; lead_id: string; status: string; policy: string | null; claims_hash: string | null }[]

test('policy acceptance is exact and versioned; without it nothing enrolls', async () => {
  assert.ok(AUTO_SEQUENCE_POLICY_TEXT.length >= 3 && AUTO_SEQUENCE_POLICY_TEXT.every(t => t.length > 40), 'the acceptance screen has real policy text')
  const db = await setup()
  assert.throws(() => acceptAutoSequencePolicy(db, 'A', 'some-other-version'), /policy_unknown/)
  assert.equal(autoSequencePolicyAccepted(db, 'A'), false)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  assert.equal(enrollColdSequence(db, 'A', m), null)
  assert.equal(seqRows(db).length, 0)
  acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  assert.equal(autoSequencePolicyAccepted(db, 'A'), true)
})

test('a sent first touch enrolls: active set, step 1 = the sent snapshot, steps 2/3 approved templates, consent recorded', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  const id = enrollColdSequence(db, 'A', m, { businessName: 'Acme' })!
  assert.ok(id)
  const s = seqRows(db)[0]
  assert.equal(s.status, 'active'); assert.equal(s.policy, AUTO_SEQUENCE_POLICY); assert.ok(s.claims_hash)
  const steps = db.prepare('SELECT step, subject, body, status, sent_at FROM sequence_steps WHERE sequence_id = ? ORDER BY step').all(id) as { step: number; subject: string; body: string; status: string; sent_at: number | null }[]
  assert.equal(steps.length, 3)
  assert.equal(steps[0].status, 'sent'); assert.equal(steps[0].sent_at, NOW); assert.equal(steps[0].body, 'This is the sent first touch.')
  assert.equal(steps[1].status, 'approved'); assert.match(steps[1].subject, /^Re: /); assert.match(steps[1].body, /Hiring roofers \(https:\/\/acme\.example\/jobs\)/)
  assert.equal(steps[2].status, 'approved'); assert.match(steps[2].body, /Last note/)
  assert.ok(db.prepare("SELECT 1 FROM consent_ledger WHERE tenant_id = 'A' AND scope = 'sequence' AND basis = 'auto_policy'").get(), 'auto-policy consent recorded')
})

test('only a proven send enrolls: drafts, approved-unsent and uncertain messages never do', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  for (const st of ['draft', 'approved', 'uncertain', 'sending']) {
    const l = lead(db, `a@${st}.example`)
    const mid = randomBytes(12).toString('hex')
    db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', ?, ?, 'S', 'B body of some length', ?)").run(mid, l, `a@${st}.example`, st)
    assert.equal(enrollColdSequence(db, 'A', mid), null, st)
  }
  assert.equal(seqRows(db).length, 0)
})

test('enrollment is atomic and cannot duplicate: one sequence per lead, idempotent on retry', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  assert.ok(enrollColdSequence(db, 'A', m))
  assert.equal(enrollColdSequence(db, 'A', m), null, 'second call is a no-op, not an error')
  assert.equal(seqRows(db).length, 1)
  // the schema itself forbids a second first-touch row for the lead (UNIQUE tenant_id, lead_id)
  assert.throws(() => sentMessage(db, l, 'a@one.example'), /UNIQUE/)
  assert.equal(seqRows(db).length, 1)
})

test('due steps send at day 3 and day 7 from the real send; repeat ticks never duplicate; set completes', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  const id = enrollColdSequence(db, 'A', m, { businessName: 'Acme' })!
  const { sent, d } = sends()
  const at = async (t: number) => runSequences(db, 'A', 'Acme', { ...d, now: t })
  assert.equal((await at(NOW)).sent, 0); assert.equal((await at(NOW + 2 * DAY)).sent, 0, 'day 2: nothing due')
  assert.equal((await at(NOW + 3 * DAY)).sent, 1, 'day 3: step 2')
  assert.equal((await at(NOW + 3 * DAY)).sent, 0, 'repeat tick: no duplicate')
  assert.equal((await at(NOW + 6 * DAY)).sent, 0)
  assert.equal((await at(NOW + 7 * DAY)).sent, 1, 'day 7: step 3')
  assert.equal(sent.length, 2)
  await at(NOW + 8 * DAY)
  assert.equal((db.prepare('SELECT status FROM sequences WHERE id = ?').get(id) as { status: string }).status, 'done')
})

test('a reply stops the auto-enrolled set before any step sends', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  enrollColdSequence(db, 'A', m)
  const { sent, d } = sends()
  const replyFetch = (async (u: unknown) => { const url = String(u); if (url.includes('token')) return json({ access_token: 'at' }); if (url.includes('/threads/')) return json({ messages: [{ id: 'r1', internalDate: String((NOW + 1) * 1000), payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'a@one.example' }], body: { data: Buffer.from('interested!').toString('base64url') } } }] }); return json({}, 404) }) as typeof fetch
  const r = await runSequences(db, 'A', 'Acme', { ...d, fetchImpl: replyFetch, now: NOW + 3 * DAY })
  assert.equal(r.sent, 0); assert.equal(sent.length, 0)
  assert.equal((db.prepare('SELECT status FROM sequences').get() as { status: string }).status, 'replied')
})

test('opt-out (suppression) before a due step: nothing sends', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  enrollColdSequence(db, 'A', m)
  suppress(db, 'A', 'a@one.example', 'unsubscribe')
  const { sent, d } = sends()
  await runSequences(db, 'A', 'Acme', { ...d, now: NOW + 3 * DAY })
  assert.equal(sent.length, 0)
})

test('changed claims stop the set instead of sending stale words; policy tampering stops it too', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l1 = lead(db, 'a@one.example'), m1 = sentMessage(db, l1, 'a@one.example')
  const l2 = lead(db, 'b@two.example', 'Beta'), m2 = sentMessage(db, l2, 'b@two.example')
  enrollColdSequence(db, 'A', m1); enrollColdSequence(db, 'A', m2)
  db.prepare("UPDATE leads SET signal = 'A different signal entirely' WHERE id = ?").run(l1)
  db.prepare("UPDATE sequences SET policy = '1999-01-01-old' WHERE lead_id = ?").run(l2)
  const { sent, d } = sends()
  await runSequences(db, 'A', 'Acme', { ...d, now: NOW + 3 * DAY })
  assert.equal(sent.length, 0)
  const stops = db.prepare('SELECT lead_id, status, stop_reason FROM sequences ORDER BY lead_id').all() as { lead_id: string; status: string; stop_reason: string }[]
  assert.deepEqual(stops.map(x => x.stop_reason).sort(), ['claims_changed', 'policy_changed'])
  assert.ok(stops.every(x => x.status === 'stopped'))
})

test('manual sequences (policy NULL) are untouched by the auto guard', async () => {
  const db = await setup()
  const l = lead(db, 'a@one.example')
  const mid = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, 'A', ?, 'a@one.example', 'A quick question', 'This is a draft message for review.')").run(mid, l)
  const seq = createSequence(db, 'A', mid)
  approveSequence(db, 'A', seq, id => approve(db, 'A', id, true), NOW)
  const { sent, d } = sends()
  await sendMessage(db, 'A', mid, d)
  assert.equal((await runSequences(db, 'A', 'Acme', { ...d, now: NOW + 3 * DAY })).sent, 1, 'manual set still sends its day-3 step')
  assert.equal((db.prepare('SELECT policy FROM sequences WHERE id = ?').get(seq) as { policy: string | null }).policy, null)
})

test('runAutopilot enrolls after a real send only when the policy is accepted; enrollment failure never affects the send', async () => {
  const db = await setup()
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  // Past the warmup: one prior approved send, so the policy arm sends.
  const warm = lead(db, 'warm@warm.example', 'Warm')
  sentMessage(db, warm, 'warm@warm.example')
  lead(db, 'a@one.example')
  const { sent, d } = sends()
  d.flags = { ...d.flags, AUTOPILOT_WARMUP: '1' }
  assert.equal((await runAutopilot(db, 'A', 'Acme', d)).sent, 1)
  assert.equal(seqRows(db).length, 0, 'no acceptance, no enrollment')
  // accepted: the next first touch enrolls
  acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  lead(db, 'b@two.example', 'Beta')
  assert.equal((await runAutopilot(db, 'A', 'Acme', d)).sent, 1)
  assert.equal(seqRows(db).length, 1)
  // enrollment throwing (here: sequences table dropped) cannot pause the tenant or undo the send
  db.exec('DROP TABLE sequences')
  lead(db, 'c@three.example', 'Gamma')
  assert.equal((await runAutopilot(db, 'A', 'Acme', d)).sent, 1)
  assert.equal(sent.length, 3)
  assert.equal(getPaused(db), 0)
})
const getPaused = (db: Database.Database) => (db.prepare('SELECT paused FROM autopilot_settings WHERE tenant_id = ?').get('A') as { paused: number }).paused

test('revocation: no new enrollment, in-flight auto sets stop at the next tick, manual sets unaffected, re-acceptance does not revive', async () => {
  const db = await setup(); acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  const l = lead(db, 'a@one.example'), m = sentMessage(db, l, 'a@one.example')
  const id = enrollColdSequence(db, 'A', m, { businessName: 'Acme' })!
  // a manual set in flight at the same time proves revocation is scoped to auto sets
  const l2 = lead(db, 'b@two.example', 'Beta')
  const mid2 = randomBytes(12).toString('hex')
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body) VALUES (?, 'A', ?, 'b@two.example', 'A quick question', 'This is a manual draft for review.')").run(mid2, l2)
  const manual = createSequence(db, 'A', mid2)!
  approveSequence(db, 'A', manual, x => approve(db, 'A', x, true), NOW)
  const { sent, d } = sends()
  await sendMessage(db, 'A', mid2, d)
  revokeAutoSequencePolicy(db, 'A')
  assert.equal(autoSequencePolicyAccepted(db, 'A'), false)
  assert.equal(enrollColdSequence(db, 'A', m, { businessName: 'Acme' }), null, 'no enrollment while revoked')
  const r = await runSequences(db, 'A', 'Acme', { ...d, now: NOW + 3 * DAY })
  const rows = Object.fromEntries(seqRows(db).map(x => [x.id, x]))
  assert.equal(rows[id].status, 'stopped', 'auto set stopped at the tick after revocation')
  assert.equal(sent.filter(b => b.includes('b@two.example')).length, 2, 'manual step 1 + its due day-3 step both sent')
  assert.ok(!sent.some(b => b.includes('a@one.example')), 'no auto step sends after revocation')
  // re-accepting starts a clean slate: the stopped set stays stopped, only a new proven send enrolls again
  acceptAutoSequencePolicy(db, 'A', AUTO_SEQUENCE_POLICY)
  await runSequences(db, 'A', 'Acme', { ...d, now: NOW + 7 * DAY })
  assert.ok(!sent.some(b => b.includes('a@one.example')), 'stopped sets never revive')
  assert.equal(seqRows(db).find(x => x.id === id)!.status, 'stopped')
  const acts = (db.prepare("SELECT action FROM autopilot_audit WHERE tenant_id = 'A' AND action LIKE 'sequence_policy%' ORDER BY rowid").all() as { action: string }[]).map(x => x.action)
  assert.deepEqual(acts, ['sequence_policy_accepted', 'sequence_policy_revoked', 'sequence_policy_accepted'], 'accept/revoke decisions are audited')
})
