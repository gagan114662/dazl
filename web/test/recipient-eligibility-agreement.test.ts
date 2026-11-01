// #412 acceptance: "Manual readiness, autopilot eligibility and no-contact reasons agree."
// One fixture lead shape, three paths, one answer:
//  - draftBlockReason (the read-only view every "next step" surface uses) runs the SAME draftChecks as createDraft,
//  - createDraft is the single draft entry for the API and for autopilot,
//  - runAutopilot's candidate prefilter admits exactly the leads that have any published-email route.
// So a lead with no usable address is refused for the SAME reason (no_email_contact) on every path, and a lead whose
// only address is the verified company-published crawl email is eligible on every path. Staged fixture; no sends.
import { seedOffers } from './helpers/seed-offer.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { createDraft, draftBlockReason } from '../lib/outreach/service.ts'
import { completeOAuth, startOAuth } from '../lib/gmail/oauth.ts'
import { saveSettings, type Deps } from '../lib/outreach/service.ts'
import { ATTESTATIONS, CONSENT_VERSION, enable, migrateAutopilot, recentAutopilotAudit, runAutopilot } from '../lib/outreach/autopilot.ts'

const master = randomBytes(32)
const genv = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'cs', PUBLIC_BASE_URL: 'https://app.test' }
const NOW = 1_800_000_000
const ON = { AUTOPILOT_ENABLED: '1', AUTOPILOT_WARMUP: '2' }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
const idToken = (email: string) => 'x.' + Buffer.from(JSON.stringify({ email, email_verified: true })).toString('base64url') + '.y'

async function setup() {
  const db = new Database(':memory:'); migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); seedOffers(db)
  const state = new URL(startOAuth(db, 'A', { env: genv, now: NOW })).searchParams.get('state')!
  await completeOAuth(db, 'A', 'c', state, { env: genv, master, now: NOW, fetchImpl: (async () => json({ refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/gmail.send', id_token: idToken('me@acme.example') })) as unknown as typeof fetch })
  saveSettings(db, 'A', { sender_name: 'Pat', postal_address: '1 King St W, Toronto ON M5H 1A1' })
  enable(db, 'A', { version: CONSENT_VERSION, attestations: [...ATTESTATIONS], daily_cap: 3 })
  return db
}
// A fully machine-proven lead (verified evidence, confidence, human review): only the recipient route varies.
function provenLead(db: Database.Database, contact: string | null) {
  const job = createJob(db, 'A', { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const id = randomBytes(12).toString('hex')
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, job, 'Co ' + id.slice(0, 4), contact, 'Hiring roofers', 'https://n.example/a', 'Co is hiring', 90, 80)
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE id = ?").run(id)
  return id
}
const deps = () => { const sent: string[] = []; const d: Deps & { flags: Record<string, string> } = { flags: ON, env: genv, master, now: NOW, baseUrl: 'https://app.test', fetchImpl: (async (u: string) => String(u).includes('token') ? json({ access_token: 'at' }) : json({}, 404)) as unknown as typeof fetch, sendFn: (async (_t: string, raw: string) => { sent.push(raw); return { id: 'g' } }) as never }; return { sent, d } }

test('#412 no contact anywhere: manual readiness, draft gate and autopilot eligibility agree on no_email_contact', async () => {
  const db = await setup()
  const id = provenLead(db, null) // contact NULL, no crawl email
  assert.equal(draftBlockReason(db, 'A', id), 'no_email_contact', 'manual readiness names the no-contact reason')
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /no_email_contact/, 'the draft gate refuses with the same reason')
  const { sent, d } = deps()
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0); assert.equal(sent.length, 0)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM outreach_messages WHERE lead_id = ?').get(id) as { n: number }).n, 0, 'autopilot never drafts it')
  const audited = recentAutopilotAudit(db, 'A').filter(a => a.lead_id === id)
  assert.ok(audited.every(a => a.detail === 'no_email_contact'), 'if autopilot ever names a reason for this lead, it is the same one')
})

test('#412 phone-only contact: the surfaced autopilot skip reason agrees with manual readiness', async () => {
  const db = await setup()
  const id = provenLead(db, '+1 416 555 0100') // contact present but not an email; no crawl email
  assert.equal(draftBlockReason(db, 'A', id), 'no_email_contact')
  assert.throws(() => createDraft(db, 'A', id, 'Acme'), /no_email_contact/)
  const { sent, d } = deps()
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(r.sent, 0); assert.equal(sent.length, 0)
  const skip = recentAutopilotAudit(db, 'A').find(a => a.lead_id === id && a.action === 'skipped')
  assert.equal(skip?.detail, 'no_email_contact', 'autopilot surfaces the same no-contact reason')
})

test('#412 contact NULL but verified company-published crawl email: eligible on every path', async () => {
  const db = await setup()
  const id = provenLead(db, null)
  const dom = 'brightloop.io'
  const ins = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', ?, ?, 'x', NULL, ?, '2026-10-28', 1)")
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', 'domain', ?, 'domain-basis-v1:evidence_own_domain', NULL, ?, '2026-10-28', 1)").run(`${id}d`, id, `${dom}|evidence_own_domain`, `https://${dom}/`)
  ins.run(`${id}e`, id, 'email', `sales@${dom}`, `https://${dom}/contact`)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_passed', 'sales_hiring', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(`${id}g`, id)
  assert.equal(draftBlockReason(db, 'A', id), null, 'manual readiness: draftable')
  const mid = createDraft(db, 'A', id, 'Acme')
  assert.equal((db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(mid) as { to_email: string }).to_email, `sales@${dom}`, 'the draft goes to the company-published crawl address')
  // Autopilot agrees the same lead shape is a candidate (fresh identical lead, warmup holds the draft for approval).
  const id2 = provenLead(db, null)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'sitecrawl', 'domain', ?, 'domain-basis-v1:evidence_own_domain', NULL, ?, '2026-10-28', 1)").run(`${id2}d`, id2, `${dom}|evidence_own_domain`, `https://${dom}/`)
  ins.run(`${id2}e`, id2, 'email', `sales@${dom}`, `https://${dom}/contact`)
  db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'A', 'scan:gate', 'gate_passed', 'sales_hiring', 'x', NULL, 'https://invalid.example/', '2026-10-28', 1)").run(`${id2}g`, id2)
  const { sent, d } = deps()
  const r = await runAutopilot(db, 'A', 'Acme', d)
  assert.equal(sent.length, 0, 'warmup: held for approval, never auto-sent')
  assert.equal(r.held, 1)
  assert.equal((db.prepare("SELECT to_email FROM outreach_messages WHERE lead_id = ?").get(id2) as { to_email: string }).to_email, `sales@${dom}`, 'autopilot drafts the same address manual readiness approved')
})
