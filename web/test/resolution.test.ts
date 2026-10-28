// Code decides "done": every candidate is resolved (dated, company confirmed, contact attached) or carries a specific reason after bounded targeted lookups. Stubbed pages only; invented companies.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { resolveFacts, resolveBounded, MAX_ATTEMPTS } from '../lib/scan/resolution.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { runReportFor } from '../lib/scan/run-report.ts'

const ICP = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['opened a new office'], exclude: [], window_days: 90 })
const REQ = 'Find London UK startups that opened a new office within the past 90 days.'
const today = new Date().toISOString().slice(0, 10)
function seed() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(REQ, ICP, jobId)
  let n = 0
  const lead = (o: { company: string; domain?: string | null; date?: string | null; reason?: string | null; signal?: string; excerpt?: string }) => {
    const id = `L${++n}`
    db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, event_date, review_reason) VALUES (?, ?, '', ?, ?, ?, 'https://news.example/x', ?, ?, 70, ?, ?)").run(id, jobId, o.company, o.domain ?? null, o.signal ?? 'opened a new office', o.excerpt ?? `${o.company} opened a new office in Shoreditch, London`, o.reason ? null : 80, o.date ?? null, o.reason ?? null)
    return id
  }
  const enr = (id: string, kind: string, value: string, label: string | null = null, connector = 'sitecrawl') => addEnrichment(db, 'u1', id, { connector, kind, value, label, confidence: null, source_url: 'https://acme.example/contact', source_date: today, retrieved_at: 10 })
  return { db, job: { id: jobId, user_id: 'u1', query: REQ, icp: ICP }, lead, enr }
}
const EVENT = (name: string, startDate: string, organizer = 'Embedd') => JSON.stringify({ '@type': 'Event', name: `${name} office opening`, startDate, organizer: { name: organizer }, location: { '@type': 'Place', name: `${name} office`, address: { addressLocality: 'London', addressCountry: 'GB', addressRegion: 'England' } } })

test('RESOLVED: dated, company confirmed, a named person with a published route -> resolved, no reasons', () => {
  const { db, job, lead, enr } = seed(); const id = lead({ company: 'Acme', domain: 'acme.example', date: daysAgo(10) })
  enr(id, 'person', 'Jane Doe, Founder'); enr(id, 'email', 'jane@acme.example')
  const [r] = resolveFacts(db, job); assert.deepEqual([r.date, r.identity, r.contact, r.resolved, r.reasons], ['found', 'confirmed', 'attached', true, []])
})
test('EMBEDD-type: no event date -> unresolved with the specific reason, and what was tried', () => {
  const { db, job, lead } = seed(); lead({ company: 'Embedd', domain: 'embedd.example', reason: 'outside_window_undated' })
  const r = resolveFacts(db, job, new Map([['L1', ['https://embedd.example/', 'https://embedd.example/events']]]))[0]
  assert.equal(r.date, 'missing'); assert.equal(r.resolved, false); assert.match(r.reasons[0], /^no dated evidence on 2 sources tried: https:\/\/embedd\.example\/, https:\/\/embedd\.example\/events$/)
})
test('wrong company / contact / stale each carry their own specific reason', () => {
  const { db, job, lead, enr } = seed()
  const a = lead({ company: 'Querio', reason: 'no_sales_hiring_evidence', date: daysAgo(10) }); enr(a, 'contact_rejected', 'contact rejected: location mismatch', 'contact_location_mismatch')
  const b = lead({ company: 'Old Co', domain: 'old.example', date: daysAgo(200), reason: 'outside_window' })
  const c = lead({ company: 'Half Co', domain: 'half.example', date: daysAgo(5) }); enr(c, 'person', 'Sam, CEO')
  const d = lead({ company: 'Refused Co', domain: 'ref.example', date: daysAgo(5) }); enr(d, 'contact_rejected', 'x', 'contact_domain_mismatch')
  const m = new Map(resolveFacts(db, job).map(r => [r.company, r]))
  assert.equal(m.get('Querio')!.identity, 'conflict'); assert.ok(m.get('Querio')!.reasons.some(x => /^contact page is a different company \(contact_location_mismatch\)$/.test(x)))
  assert.equal(m.get('Old Co')!.date, 'stale'); assert.ok(m.get('Old Co')!.reasons.some(x => /outside the window/.test(x)))
  assert.ok(m.get('Half Co')!.reasons.some(x => /a person is named but no route is published/.test(x)))
  assert.equal(m.get('Refused Co')!.contact, 'refused'); assert.ok(m.get('Refused Co')!.reasons.some(x => /every contact found was refused \(contact_domain_mismatch\)/.test(x)))
})
test('BOUNDED: at most MAX_ATTEMPTS own pages per candidate, never the same page twice across candidates, stops at the first dated hit', async () => {
  const { db, job, lead } = seed()
  lead({ company: 'Embedd', domain: 'embedd.example', reason: 'outside_window_undated' }); lead({ company: 'Embedd Labs', domain: 'embedd.example', reason: 'outside_window_undated' })
  const calls: string[] = []
  const s = await resolveBounded(db, job, { fetchPage: async u => { calls.push(u); return { text: 'x', title: 't', retrievedAt: 1, structured: [] } }, where: ['London, UK'] })
  assert.equal(MAX_ATTEMPTS, 3); assert.deepEqual(calls, ['https://embedd.example/', 'https://embedd.example/events', 'https://embedd.example/news'], 'three distinct pages, shared by both candidates, then a hard stop')
  assert.equal(s.unresolved, 2); assert.match(s.leads[0].reasons[0], /^no dated evidence on 3 sources tried: https:\/\/embedd\.example\/, .*\/events, .*\/news$/)
})
test('LATE DATE: a company-own page that declares the SAME event as structured data is found and stored as evidence - the reason says it was not applied; a different event (a webinar, another city) is not', async () => {
  const { db, job, lead } = seed(); lead({ company: 'Embedd', domain: 'embedd.example', reason: 'outside_window_undated' })
  const pages: Record<string, string[]> = { 'https://embedd.example/events': [EVENT('Embedd Shoreditch', daysAgo(9))] }
  const s = await resolveBounded(db, job, { fetchPage: async u => ({ text: 'x', title: 't', retrievedAt: 1, structured: pages[u] ?? [] }), where: ['London, UK'] })
  assert.equal(s.leads[0].late_date?.url, 'https://embedd.example/events'); assert.match(s.leads[0].reasons[0], /an event date \(.*\) was found on https:\/\/embedd\.example\/events .* rerun the scan to qualify it/)
  const row = db.prepare("SELECT label, value, source_url FROM lead_enrichments WHERE connector = 'scan:resolution'").get() as { label: string; value: string; source_url: string }
  assert.equal(row.label, 'unresolved'); assert.equal(row.source_url, 'https://embedd.example/events')
  const wrong = seed(); wrong.lead({ company: 'Embedd', domain: 'embedd.example', reason: 'outside_window_undated' })
  const w = await resolveBounded(wrong.db, wrong.job, { fetchPage: async () => ({ text: 'x', title: 't', retrievedAt: 1, structured: [JSON.stringify({ '@type': 'Event', name: 'Embedd customer webinar', startDate: daysAgo(3), organizer: { name: 'Embedd' } }), EVENT('Embedd Manchester', daysAgo(3)).replace('London', 'Manchester')] }), where: ['London, UK'] })
  assert.equal(w.leads[0].late_date, undefined); assert.match(w.leads[0].reasons[0], /^no dated evidence on 3 sources tried/)
})
test('identity first: a candidate whose company is not confirmed is NOT looked up at all, and says so', async () => {
  const { db, job, lead } = seed(); lead({ company: 'Ghost Ltd', reason: 'outside_window_undated' })
  let calls = 0
  const s = await resolveBounded(db, job, { fetchPage: async () => { calls++; return null }, where: [] })
  assert.equal(calls, 0); assert.deepEqual(s.leads[0].reasons.slice(0, 2), ['no dated evidence', 'company identity not confirmed: no domain agrees with the company name and place'])
})
test('REAL RUN: every scan carries a resolution summary in its run report (candidates, resolved, unresolved, reasons)', async () => {
  const NEWS = 'https://sifted.example/brightloop'; const Q = 'Brightloop, a London B2B SaaS startup, raised a 3m GBP seed round this month'
  const page = { title: 'Brightloop raises seed', text: `Published ${daysAgo(12)}. ${Q}. ${'More about the company. '.repeat(15)}` }
  const f: Fixture = { request: 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.', modelIcp: { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }, modelQueries: ['London SaaS startup seed round'], hits: [{ url: NEWS, title: page.title, snippet: Q, date: daysAgo(12) }], tfPages: { [NEWS]: page }, own: { [NEWS]: page }, extraction: [{ company: 'Brightloop', signal: 'raised a seed round', source_url: NEWS, excerpt: Q, event_date: daysAgo(12) }] }
  const x = await runFixture(f)
  const jobId = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  const res = (runReportFor(x.db, 'A', jobId) as { resolution?: { candidates: number; resolved: number; unresolved: number; by_reason: Record<string, number> } }[]).findLast(r => r.resolution)?.resolution
  assert.ok(res, 'the run report carries the resolution summary'); assert.equal(res!.candidates, 1); assert.equal(res!.resolved + res!.unresolved, 1)
  assert.equal(res!.resolved, 0, 'no domain / person / route in this offline run: it is NOT resolved, and says why'); assert.ok(Object.keys(res!.by_reason).length > 0)
})
