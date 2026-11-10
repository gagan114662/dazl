// #914: the machine timing proof and the actionability verdict are derived from the CURRENT identity / person / route evidence,
// not from a stale "Actionable" summary or an assumed contact-source pass. Actual writers (recordActionability, recordTimingProof)
// then the actual reader (timingProofGap). Synthetic data, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { recordActionability, classifyLeads } from '../lib/scan/actionable.ts'
import { recordTimingProof, timingProofGap } from '../lib/scan/timing-proof.ts'
import { domainConfirmed } from '../lib/signals/domain-basis.ts'
import { seedNeedVerified, NEED_GATE } from './helpers/need.ts'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const D = 'acme-dental.test'

async function setup(opts: { domainBasis?: string | null; seedNeed?: boolean } = {}) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db); migrateConnectors(db); migrateMemory(db)
  const id = createJob(db, 'A', { business_name: 'Seller', industry: 'dental', location: 'Austin' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run('dental groups in Austin that opened a new clinic in the last 30 days', JSON.stringify({ window_days: 30, who: ['owner'] }), id)
  db.prepare(`INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, score, fit, intent, action, why, signal_kind, event_date, event_date_proof, company_domain)
    VALUES ('L1', ?, 'Acme Dental', 'Dana Lee', NULL, 'Opened a second clinic', 'https://news.example.test/acme', 'Acme Dental opened its second clinic.', 80, 70, 4, 4, 3, 'fit', 'expansion', ?, 'page_bound', ?)`).run(id, day(5), D)
  const put = (kind: string, value: string, url: string, label: string | null = null) => addEnrichment(db, 'A', 'L1', { connector: 'sitecrawl', kind, value, label, confidence: null, source_url: url, source_date: day(0), retrieved_at: Math.floor(Date.now() / 1000) })
  const basis = opts.domainBasis === undefined ? 'evidence_own_domain' : opts.domainBasis
  if (basis) put('domain', `${D}|${basis}`, `https://${D}/news`, `domain-basis-v1:${basis}`)
  put('person', 'Dana Lee, Owner', `https://${D}/team`)
  put('email', `hello@${D}`, `https://${D}/contact`)
  const job = { id, user_id: 'A', query: 'dental groups in Austin that opened a new clinic in the last 30 days', icp: JSON.stringify({ window_days: 30, who: ['owner'] }) }
  // #401/#379: the lead carries the search's recorded, still-valid verified buying-need verdict, so the promotion
  // gate passes and the facts under test (domain / person / route) decide actionability. A name-probed domain can
  // never carry one (the writer refuses), so that setup seeds none and the need gate holds the lead first.
  if (opts.seedNeed !== false) await seedNeedVerified(db, 'A', id, 'L1', 'Acme Dental')
  const run = () => { const y = recordActionability(db, job, new Map(), NEED_GATE); const t = recordTimingProof(db, job); return { actionable: y.actionable, proven: t.proven } }
  const summary = () => (db.prepare("SELECT value FROM lead_enrichments WHERE connector = 'scan:actionable' AND lead_id = 'L1'").get() as { value: string } | undefined)?.value ?? null
  return { db, run, summary, put }
}

test('#914 audit reproduction: deleting the underlying domain/person/email rows holds the proof though both summaries remain', async () => {
  const s = await setup()
  assert.deepEqual(s.run(), { actionable: 1, proven: 1 })
  assert.equal(timingProofGap(s.db, 'A', 'L1'), null, 'supported, unchanged: clears')
  s.db.prepare("DELETE FROM lead_enrichments WHERE connector = 'sitecrawl' AND kind IN ('domain', 'person', 'email')").run()
  assert.equal(domainConfirmed(s.db, 'A', 'L1', D), false)
  assert.match(s.summary()!, /^Actionable:/, 'the stale derived summary is still there')
  assert.notEqual(timingProofGap(s.db, 'A', 'L1'), null, 'but the proof no longer stands')
  assert.equal(timingProofGap(s.db, 'A', 'L1'), 'domain_unconfirmed')
})

test('#914 each removed / changed fact holds a previously proven lead, with the stale summary left untouched', async () => {
  const changes: [string, string, string][] = [
    ['person removed', "DELETE FROM lead_enrichments WHERE kind = 'person'", 'not_actionable'],
    ['person changed to a non-matching role', "UPDATE lead_enrichments SET value = 'Sam Roe, Hygienist' WHERE kind = 'person'", 'not_actionable'],
    ['person renamed', "UPDATE lead_enrichments SET value = 'Someone Else, Owner' WHERE kind = 'person'", 'binding_changed'],
    ['email removed', "DELETE FROM lead_enrichments WHERE kind = 'email'", 'not_actionable'],
    ['email changed', "UPDATE lead_enrichments SET value = 'owner@acme-dental.test' WHERE kind = 'email'", 'binding_changed'],
    ['email moved off the company domain', "UPDATE lead_enrichments SET value = 'hello@other-dental.test' WHERE kind = 'email'", 'not_actionable'],
    ['email turned into a support inbox', "UPDATE lead_enrichments SET value = 'support@acme-dental.test' WHERE kind = 'email'", 'not_actionable'],
    ['email source page changed', `UPDATE lead_enrichments SET source_url = 'https://${D}/about' WHERE kind = 'email'`, 'binding_changed'],
    ['email source page on another site', "UPDATE lead_enrichments SET source_url = 'https://namesake.test/contact' WHERE kind = 'email'", 'not_actionable'],
    ['person source page on another site', "UPDATE lead_enrichments SET source_url = 'https://namesake.test/team' WHERE kind = 'person'", 'not_actionable'],
    ['domain confirmation lost', "DELETE FROM lead_enrichments WHERE kind = 'domain'", 'domain_unconfirmed'],
    ['domain confirmation weakened to a name probe', `UPDATE lead_enrichments SET value = '${D}|name_probe', label = 'domain-basis-v1:name_probe' WHERE kind = 'domain'`, 'domain_unconfirmed'],
    ['company domain changed', "UPDATE leads SET company_domain = 'other-dental.test'", 'domain_unconfirmed'],
  ]
  for (const [name, sql, gap] of changes) {
    const s = await setup(); assert.deepEqual(s.run(), { actionable: 1, proven: 1 }, name)
    const before = s.summary()
    s.db.prepare(sql).run()
    assert.equal(s.summary(), before, name + ': summary unchanged')
    assert.equal(timingProofGap(s.db, 'A', 'L1'), gap, name)
  }
})

test('#914 a phone route is revalidated the same way', async () => {
  const s = await setup(); s.db.prepare("DELETE FROM lead_enrichments WHERE kind = 'email'").run(); s.put('phone', '+1 512 555 0100', `https://${D}/contact`)
  assert.deepEqual(s.run(), { actionable: 1, proven: 1 })
  s.db.prepare("UPDATE lead_enrichments SET value = '+1 512 555 0199' WHERE kind = 'phone'").run()
  assert.equal(timingProofGap(s.db, 'A', 'L1'), 'binding_changed')
  s.db.prepare("DELETE FROM lead_enrichments WHERE kind = 'phone'").run()
  assert.equal(timingProofGap(s.db, 'A', 'L1'), 'not_actionable')
})

test('#914 a contact-source pass that never ran (foreign rows retained) cannot produce positive actionability or timing proof', async () => {
  // domain only name-probed (not confirmed); a namesake's contacts were attached and never removed
  const s = await setup({ domainBasis: 'name_probe', seedNeed: false })
  const [y] = classifyLeads(s.db, { id: (s.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id, user_id: 'A', icp: JSON.stringify({ who: ['owner'] }) })
  assert.equal(y.actionable, false); assert.ok(y.missing.includes('domain_unconfirmed'))
  assert.deepEqual(s.run(), { actionable: 0, proven: 0 })
  assert.equal(timingProofGap(s.db, 'A', 'L1'), 'domain_unconfirmed')
  // confirmed domain, but the person and route came from another site
  const f = await setup(); f.db.prepare("UPDATE lead_enrichments SET source_url = 'https://namesake.test/x' WHERE kind IN ('person', 'email')").run()
  assert.deepEqual(f.run(), { actionable: 0, proven: 0 })
  assert.equal(timingProofGap(f.db, 'A', 'L1'), 'not_actionable')
})

test('#914 tenant isolation is preserved', async () => {
  const s = await setup(); s.run()
  assert.equal(timingProofGap(s.db, 'B', 'L1'), 'no_lead')
})
