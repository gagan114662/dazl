// Privacy: a conversion (signup/activation/payment) stops pending acquisition work, but the
// tenant-visible stop reason must never carry the conversion kind - the contacting customer
// could see "converted_payment" on a lead card or in an export and learn the seller's
// signup/activation/payment state. The kind stays in lifecycle_events (server-side) and is
// handed to onboarding internally; tenant rows and every tenant-readable surface show the
// generic 'policy_stop'. Legacy rows holding converted_* are mapped at read time (no migration,
// no protected-data rewrite). Behavior (suppression, cancel counts, onboarding transition) is
// unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { seedOffers } from './helpers/seed-offer.ts'
import { displayStopReason, POLICY_STOP, recordLifecycleEvent, recordLifecycleEventDb, type LifecycleKind } from '../lib/outreach/lifecycle.ts'
import { sequenceStatusByLead } from '../lib/outreach/sequences.ts'
import { followupOverview } from '../lib/outreach/followups.ts'
import { exportTenant } from '../lib/tenant/lifecycle.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { displayAuditDetail } from '../lib/outreach/lifecycle.ts'
import { listMessages } from '../lib/outreach/service.ts'
import { recentAutopilotAudit } from '../lib/outreach/autopilot.ts'
import { optInOnboarding, onboardingSendAllowed } from '../lib/outreach/onboarding-policy.ts'

const KINDS: LifecycleKind[] = ['signup', 'activation', 'payment']
const CONVERTED_TERMS = /converted_|signup|activation|payment/i

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateAutopilot(db); migrateReplies(db); migrateSequences(db); seedOffers(db, ['A', 'B'])
  return db
}
// pending acquisition work addressed to email, owned by tenant t
function pending(db: Database.Database, t: string, email: string, tag: string) {
  const job = createJob(db, t, { business_name: 'Acme', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  const lead = 'lead-' + tag
  db.prepare('INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, evidence_excerpt, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(lead, job, 'Co', email, 'Hiring', 'https://n.example/a', 'Hiring', 85)
  const mid = 'msg-' + tag
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, hold_reason) VALUES (?, ?, ?, ?, 'Hi', 'A note long enough to pass the check.', 'draft', 'consent_required')").run(mid, t, lead, email)
  db.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status) VALUES (?, ?, ?, ?, ?, 'approved')").run('seq-' + tag, t, lead, mid, email)
  db.prepare("INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, ?, ?, ?, 'root', 1700000000, 1700000000, 0)").run(t, 'th-' + tag, lead, email)
  return { lead, mid, seq: 'seq-' + tag, th: 'th-' + tag }
}

for (const kind of KINDS) {
  test(`conversion (${kind}): pending work stops, but every tenant-visible reason is the generic policy stop`, () => {
    const db = setup()
    const p = pending(db, 'A', 'person@prospect.example', kind)
    const stopped = recordLifecycleEvent(db, kind, 'person@prospect.example', 'B')
    assert.ok(stopped >= 3, `the cancel cascade still stops the pending work (got ${stopped})`)
    const seq = db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(p.seq) as { stop_reason: string }
    const th = db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(p.th) as { stopped: string }
    const msg = db.prepare('SELECT status, error FROM outreach_messages WHERE id = ?').get(p.mid) as { status: string; error: string }
    assert.equal(seq.stop_reason, POLICY_STOP, 'sequences.stop_reason must not name the conversion kind')
    assert.equal(th.stopped, POLICY_STOP, 'followup_threads.stopped must not name the conversion kind')
    assert.equal(msg.error, POLICY_STOP, 'outreach_messages.error must not name the conversion kind')
    assert.equal(msg.status, 'skipped', 'the held first touch is still cancelled')
    // the audit trail records the stop without the kind
    const audit = db.prepare("SELECT detail FROM autopilot_audit WHERE tenant_id = 'A' AND action = 'sequence_stopped'").all() as { detail: string }[]
    for (const a of audit) assert.ok(!CONVERTED_TERMS.test(a.detail), `audit detail leaks: ${a.detail}`)
    // the kind survives only server-side, in lifecycle_events
    assert.equal((db.prepare('SELECT kind FROM lifecycle_events WHERE email = ?').get('person@prospect.example') as { kind: string }).kind, kind)
  })
}

test('the both-engines conversion path (recordLifecycleEventDb) writes the same generic stop', async () => {
  const db = setup()
  const p = pending(db, 'A', 'person2@prospect.example', 'db')
  const stopped = await recordLifecycleEventDb(sqliteDb(db), 'payment', 'person2@prospect.example', 'B')
  assert.ok(stopped >= 3)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(p.seq) as { stop_reason: string }).stop_reason, POLICY_STOP)
  assert.equal((db.prepare('SELECT stopped FROM followup_threads WHERE thread_id = ?').get(p.th) as { stopped: string }).stopped, POLICY_STOP)
  assert.equal((db.prepare('SELECT error FROM outreach_messages WHERE id = ?').get(p.mid) as { error: string }).error, POLICY_STOP)
})

test('legacy converted_* rows never render on tenant surfaces: leads card, follow-ups overview, export', async () => {
  const db = setup()
  db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT); INSERT OR IGNORE INTO users (id, email) VALUES ('A', 'owner@a.example'); CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT)")
  const p = pending(db, 'A', 'legacy@prospect.example', 'legacy')
  db.prepare("UPDATE sequences SET status = 'stopped', stop_reason = 'converted_payment' WHERE id = ?").run(p.seq)
  db.prepare("UPDATE followup_threads SET stopped = 'converted_signup' WHERE thread_id = ?").run(p.th)
  db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'converted_activation' WHERE id = ?").run(p.mid)
  // leads card data
  const card = sequenceStatusByLead(db, 'A').get(p.lead)
  assert.ok(card && !CONVERTED_TERMS.test(card.stop_reason ?? ''), `leads card stop_reason leaks: ${card?.stop_reason}`)
  // follow-ups overview (the /api/outreach/followups body)
  const o = await followupOverview(sqliteDb(db), 'A')
  assert.ok(!CONVERTED_TERMS.test(JSON.stringify(o)), 'follow-ups overview leaks a conversion kind')
  // tenant data export
  const ex = await exportTenant(sqliteDb(db), 'A')
  for (const [table, rows] of Object.entries(ex.tables)) {
    if (!['sequences', 'followup_threads', 'outreach_messages'].includes(table)) continue
    for (const r of rows as Record<string, unknown>[]) {
      for (const col of ['stop_reason', 'stopped', 'error'])
        if (typeof r[col] === 'string') assert.ok(!CONVERTED_TERMS.test(r[col] as string), `export ${table}.${col} leaks: ${r[col]}`)
    }
  }
})

test('unrelated stop reasons pass through untouched; other tenants are unaffected', () => {
  const db = setup()
  const a = pending(db, 'A', 'person3@prospect.example', 'a3')
  const b = pending(db, 'B', 'other@prospect.example', 'b3')
  db.prepare("UPDATE sequences SET stop_reason = 'user_stopped' WHERE id = ?").run(b.seq)
  recordLifecycleEvent(db, 'payment', 'person3@prospect.example', null)
  assert.equal((db.prepare('SELECT stop_reason FROM sequences WHERE id = ?').get(b.seq) as { stop_reason: string }).stop_reason, 'user_stopped')
  assert.equal(displayStopReason('user_stopped'), 'user_stopped')
  assert.equal(displayStopReason('suppressed'), 'suppressed')
  assert.equal(displayStopReason('evidence_withdrawn'), 'evidence_withdrawn')
  assert.equal(displayStopReason(null), null)
  assert.equal(displayStopReason('converted_payment'), POLICY_STOP)
  void a
})

test('legacy converted_* error on a held draft is mapped in the Outreach drafts list (listMessages)', () => {
  const db = setup()
  const p = pending(db, 'A', 'legacy2@prospect.example', 'lm')
  db.prepare("UPDATE outreach_messages SET status = 'skipped', error = 'converted_activation' WHERE id = ?").run(p.mid)
  const rows = listMessages(db, 'A')
  const row = rows.find(r => r.id === p.mid)
  assert.ok(row, 'the draft is listed')
  assert.equal(row.error, POLICY_STOP, 'the drafts list must not render the conversion kind')
  // the stored row is untouched: read-time mapping only, no rewrite
  assert.equal((db.prepare('SELECT error FROM outreach_messages WHERE id = ?').get(p.mid) as { error: string }).error, 'converted_activation')
})

test('legacy converted_* detail in the autopilot activity feed (GET /api/outreach/autopilot audit) is mapped', () => {
  const db = setup()
  db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('au1', 'A', 'sequence_stopped', 'converted_payment', 1700000000)").run()
  db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('au2', 'A', 'sequence_stopped', 'user_stopped', 1700000001)").run()
  const feed = recentAutopilotAudit(db, 'A')
  assert.equal(feed.find(r => r.id === 'au1')?.detail, POLICY_STOP)
  assert.equal(feed.find(r => r.id === 'au2')?.detail, 'user_stopped', 'unrelated details pass through')
  assert.equal((db.prepare("SELECT detail FROM autopilot_audit WHERE id = 'au1'").get() as { detail: string }).detail, 'converted_payment', 'the audit row itself is never rewritten')
})

for (const kind of KINDS) {
  test(`export redacts the conversion kind from onboarding records and audit, honestly (${kind})`, async () => {
    const db = setup()
    db.exec("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT); INSERT OR IGNORE INTO users (id, email) VALUES ('A', 'owner@a.example')")
    optInOnboarding(db, 'A', 'A')
    // legacy/internal rows exactly as the writers store them
    db.prepare('INSERT INTO onboarding_enrollments (tenant_id, email, source, enrolled_at) VALUES (?, ?, ?, ?)').run('A', 'lead@prospect.example', `conversion:${kind}`, 1700000000)
    db.prepare("INSERT INTO onboarding_audit (id, tenant_id, action, detail, created_at) VALUES ('oa1', 'A', 'enrolled', ?, 1700000000)").run(`conversion:${kind}`)
    db.prepare("INSERT INTO autopilot_audit (id, tenant_id, action, detail, created_at) VALUES ('aa1', 'A', 'sequence_stopped', ?, 1700000000)").run(`converted_${kind}`)
    const ex = await exportTenant(sqliteDb(db), 'A')
    const enr = ex.tables.onboarding_enrollments?.[0] as { source: string }
    const oa = ex.tables.onboarding_audit?.find(r => (r as { id: string }).id === 'oa1') as { detail: string }
    const aa = ex.tables.autopilot_audit?.find(r => (r as { id: string }).id === 'aa1') as { detail: string }
    assert.equal(enr.source, 'conversion', 'enrollment source generalized in the export')
    assert.equal(oa.detail, 'conversion', 'onboarding audit detail generalized in the export')
    assert.equal(aa.detail, POLICY_STOP, 'autopilot audit detail generalized in the export')
    for (const col of ['onboarding_enrollments.source', 'onboarding_audit.detail', 'autopilot_audit.detail'])
      assert.ok(ex.redacted_columns.includes(col), `export must disclose the redaction of ${col}, got ${JSON.stringify(ex.redacted_columns)}`)
    // no rewrite: the stored rows still hold the internal kind
    assert.equal((db.prepare('SELECT source FROM onboarding_enrollments WHERE tenant_id = ?').get('A') as { source: string }).source, `conversion:${kind}`)
    assert.equal((db.prepare("SELECT detail FROM onboarding_audit WHERE id = 'oa1'").get() as { detail: string }).detail, `conversion:${kind}`)
  })
}

test('the onboarding gate reads lifecycle_events, not any mapped tenant column', () => {
  const db = setup()
  pending(db, 'A', 'gate@prospect.example', 'gate')
  optInOnboarding(db, 'A', 'A')
  assert.equal(onboardingSendAllowed(db, 'A', 'gate@prospect.example'), false, 'no conversion, no onboarding sends')
  recordLifecycleEvent(db, 'payment', 'gate@prospect.example', 'B')
  assert.equal(onboardingSendAllowed(db, 'A', 'gate@prospect.example'), true, 'activated conversion + enrollment opens the gate')
  assert.equal((db.prepare('SELECT kind FROM lifecycle_events WHERE email = ?').get('gate@prospect.example') as { kind: string }).kind, 'payment')
})

test('displayAuditDetail generalizes only conversion-bearing values', () => {
  for (const kind of KINDS) {
    assert.equal(displayAuditDetail(`converted_${kind}`), POLICY_STOP)
    assert.equal(displayAuditDetail(`conversion:${kind}`), 'conversion')
  }
  assert.equal(displayAuditDetail('user_stopped'), 'user_stopped')
  assert.equal(displayAuditDetail('policy v1'), 'policy v1')
  assert.equal(displayAuditDetail('replied'), 'replied')
  assert.equal(displayAuditDetail(null), null)
})
