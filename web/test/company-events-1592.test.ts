// #1592: company events (funding, expansion, launch, contract) as leads - the event's own date from the source,
// the funding amount only when the proof page prints it, the kind on the card line, and the fields stored on the row.
// Invented companies and pages; no network in these tests (checkLead reads only the run's own seen page).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead } from '../lib/discover/check.ts'
import { discoverLine } from '../lib/discover/card.ts'
import { discoveredLead } from '../lib/scan/runner.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { createQueryJob, finishJob, type LeadRow } from '../lib/scan/store-db.ts'

const base = {
  company: 'Northwind Dental', domain: 'northwind-dental.example', signal: 'Raised a seed round',
  signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind-seed', evidence_quote: 'Northwind Dental has raised a seed round',
  person: 'Dana Ruiz', title: 'Founder', person_source_url: 'https://northwind-dental.example/team', linkedin_url: null,
  email: null, email_source_url: null, confidence: 'high' as const, why: 'a first round pays for the equipment a seller of dental fit-out quotes',
}
const event = (o: Record<string, unknown> = {}) => parseLeads(JSON.stringify({ leads: [{ ...base, event_kind: 'funding', amount: 'US$4.2 million', ...o }] }), 1).leads[0]

test('parseLeads: a company event keeps its kind and the funding amount as the page prints it; other kinds carry no amount', () => {
  const l = event()
  assert.equal(l.event_kind, 'funding')
  assert.equal(l.amount, 'US$4.2 million')
  assert.equal(event({ event_kind: 'expansion' }).event_kind, 'expansion')
  assert.equal(event({ event_kind: 'garbage' }).event_kind, null, 'an unknown kind word is not kept')
  assert.equal(event({ event_kind: null }).event_kind, null)
  assert.equal(event({ event_kind: 'expansion', amount: 'US$4.2 million' }).amount, null, 'an amount belongs to a funding event only')
  assert.equal(event({ amount: null }).amount, null)
})

test('checkLead: the amount survives only when the proof page prints it; the lead stands either way', async () => {
  const never = (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch
  const page = (extra: string) => [{ url: base.evidence_url, title: 't', page_age: null, text: `Northwind Dental has raised a seed round of ${extra} to open a second clinic.` }]
  const kept = await checkLead(event(), page('US$4.2 million'), never)
  assert.equal(kept.proof, 'confirmed')
  assert.equal(kept.amount, 'US$4.2 million')
  assert.equal(kept.event_kind, 'funding')
  const dropped = await checkLead(event(), page('an undisclosed sum'), never)
  assert.equal(dropped.proof, 'confirmed', 'the lead is not hidden - only the unprinted amount is')
  assert.equal(dropped.amount, null)
  assert.equal(dropped.event_kind, 'funding', 'the kind is a claim about the event, not about the page text')
})

test('checkLead (#377): an article published now about an old event does not arrive as a dated, verified event', async () => {
  const never = (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch
  const now = new Date('2026-11-26T00:00:00Z')
  // a today-published article whose quote names the event's own, older year; the model supplied the publication day
  const old = await checkLead(event({ signal: 'Raised a seed round in 2019', evidence_quote: 'Northwind Dental raised a seed round of US$4.2 million in March 2019', signal_date: '2026-11-26' }),
    [{ url: base.evidence_url, title: 't', page_age: null, text: 'Published 26 November 2026. Northwind Dental raised a seed round of US$4.2 million in March 2019, the company said.' }], never, undefined, now)
  assert.equal(old.proof, 'confirmed', 'the company and the quote are on the page: the lead stands')
  assert.equal(old.date, '2026-11-26', 'the day still shows')
  assert.equal(old.date_on_page, false, 'a publication day over an event the quote itself dates to 2019 is not the event\'s day')
  assert.equal(old.amount, 'US$4.2 million')
  const v = discoveredLead({ ...old, date_source: 'page', proof_read_by: 'reader', page_age: null, quote_on_page: true, signal_seen: true, claim_lacks: [] } as never, 1_800_000_000)
  assert.equal(v.event_date_proof, null, 'never page_bound for a freshened old event')
  assert.equal(v.date_status, 'unverified')
  // the page dating the event to another day than the supplied one: the same refusal
  const other = await checkLead(event({ evidence_quote: 'Northwind Dental has raised a seed round', signal_date: '2026-11-26' }),
    [{ url: base.evidence_url, title: 't', page_age: null, text: 'Published 26 November 2026. Northwind Dental has raised a seed round, the company announced on 12 May 2019.' }], never, undefined, now)
  assert.equal(other.date_on_page, false, 'the event\'s own statement dates it to 2019-05-12, not the supplied day')
  // control: an announcement whose own words carry no other date keeps its day
  const announce = await checkLead(event({ evidence_quote: 'Northwind Dental has raised a seed round' }),
    [{ url: base.evidence_url, title: 't', page_age: null, text: 'Published 14 October 2026. Northwind Dental has raised a seed round.' }], never, undefined, now)
  assert.equal(announce.date_on_page, true, 'a page that is itself the announcement keeps its day')
  assert.equal(announce.date, '2026-10-14')
})

test('discoveredLead: an event lead carries its kind, amount and why-now to the stored row', () => {
  const v = discoveredLead({ ...event(), date: '2026-10-14', date_source: 'page', date_on_page: true, proof: 'confirmed',
    proof_read_by: 'reader', page_age: null, quote_on_page: true, signal_seen: true, claim_lacks: [] } as never, 1_800_000_000)
  assert.equal(v.event_kind, 'funding')
  assert.equal(v.event_amount, 'US$4.2 million')
  assert.ok((v.why ?? '').includes('first round'), 'why-now is the run\'s one line on why the event creates the need')
})

test('discoverLine: the card says what kind of event it is and the funding amount; a non-event lead keeps today\'s line', () => {
  const l = { source_kind: 'discover', confidence: 85, event_date: '2026-10-14', date_status: 'verified', name: 'Dana Ruiz', company_domain: 'northwind-dental.example', event_kind: 'funding', event_amount: 'US$4.2 million', enrichments: [] }
  assert.match(discoverLine(l), /Funding round .*US\$4\.2 million/)
  assert.doesNotMatch(discoverLine({ ...l, event_kind: null, event_amount: null }), /Funding/)
  assert.match(discoverLine({ ...l, event_kind: 'expansion', event_amount: null }), /Expansion or new location/)
  assert.doesNotMatch(discoverLine({ ...l, event_kind: 'expansion', event_amount: null }), /US\$/)
})

test('storage: an event lead round-trips its kind and amount through the job\'s stored rows', async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateAllSqlite(db)
  db.prepare('INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, ?, ?, ?, ?)').run('U1', 'u@example.test', 'N', 'B', 'h', 's')
  const sdb = sqliteDb(db)
  const job = await createQueryJob(sdb, 'U1', { query: 'a real-shaped query about companies' }, 1_800_000_000)
  await sdb.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  const lead: LeadRow = { name: 'Dana Ruiz', company: 'Northwind Dental', contact: null, signal: 'Raised a seed round', source_url: base.evidence_url, score: 85, evidence_excerpt: 'Northwind Dental has raised a seed round', event_date: '2026-10-14', date_status: 'verified', retrieved_at: 1_800_000_000, confidence: 85, dedup_key: 'k1', why: 'why now line', event_kind: 'funding', event_amount: 'US$4.2 million' }
  await finishJob(sdb, { id: job, attempts: 1 }, { status: 'done', error: null, leads: [lead], candidates: 1, now: 1_800_000_001 })
  const row = db.prepare('SELECT event_kind, event_amount, why FROM leads WHERE scan_job_id = ?').get(job) as { event_kind: string | null; event_amount: string | null; why: string | null }
  assert.deepEqual([row.event_kind, row.event_amount, row.why], ['funding', 'US$4.2 million', 'why now line'])
  db.close()
})
