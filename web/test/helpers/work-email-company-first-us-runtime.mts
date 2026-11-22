// #1036: a company-first scan of a US company whose contact page prints the buyer's own address on the buyer's own card. The real
// site crawl (stubbed HTTP, no network) names the buyer and writes the US sender route and the published pair; the real readiness
// recorders run; then the real Find work email route (GET + POST) must give that published address and its page in one click.
// Contact page shape from the 2026-11-14 chicago-law finding (a law firm's marketing chief, own flast@ address printed on the firm's
// contact page); the trigger is an own-site dated sales vacancy. The company, host and first name are synthetic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET as WE_GET, POST as WE_POST } from '../../app/api/leads/[lead]/work-email/route.ts'
import { createJob } from '../../lib/scan/store.ts'
import { crawlJob, type Get } from '../../lib/connectors/sitecrawl.ts'
import { markCompanyFirstBudget } from '../../lib/company-first/product-discovery.ts'
import { addEnrichment, enrichmentsForLeads } from '../../lib/connectors/store.ts'
import { sqliteDb } from '../../lib/db/client.ts'
import { recordNeedEvidence } from '../../lib/scan/need-evidence.ts'
import { recordActionability } from '../../lib/scan/actionable.ts'
import { recordTimingProof } from '../../lib/scan/timing-proof.ts'
import { currentnessHeld } from '../../lib/outreach/currentness.ts'
import { workEmailPageRead } from '../../lib/people/work-email.ts'
import { companyFirstPublishedDisplayRows, companyFirstPublishedDisplayRowsSync } from '../../lib/people/company-first-published-display.ts'
import { qaClaudeOnlyBudget } from '../../lib/scan/qa-provider-policy.ts'
import { timingProofGap } from '../../lib/scan/timing-proof.ts'
import { requiredGateHeld } from '../../lib/scan/held-state.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch
const hdr = { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost' }
const A = { id: 'A', business_name: 'Acme' }
const prose = '<p>Our firm has served clients for many years. We help businesses handle disputes, transactions and regulatory work from start to finish with clear advice and transparent information.</p>'
const wrap = (s: string) => '<html><body>' + s + '</body></html>'

async function companyFirstLead(where: string, homeAddress: string) {
  const db = new Database(':memory:'); migrateAllSqlite(db); setScanDb(db); setUser(A)
  const host = 'harlowgrant.com', origin = 'https://' + host, company = 'Harlow Grant'
  const name = 'Jo Hammerstrom', title = 'Chief Marketing Officer', email = 'jhammerstrom@' + host
  const contact = origin + '/contact-us/', event = origin + '/careers/sales-representative'
  const now = Date.now(), at = Math.floor(now / 1000), day = new Date(now - 3 * 86_400_000).toISOString().slice(0, 10)
  const query = 'Companies hiring sales reps'
  const job = createJob(db, 'A', { business_name: 'Seller', industry: 'legal', location: where })
  db.prepare("UPDATE scan_jobs SET status='running', query=?, icp=?, run_budget=?, seller='Client intake software' WHERE id=?")
    .run(query, JSON.stringify({ who: [title], where: [where], window_days: 20 }), markCompanyFirstBudget(null), job)
  const lead = 'e'.repeat(24)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, signal_kind, source_url, evidence_excerpt, event_date, event_date_proof, confidence, fit, score) VALUES (?,?,?,?,'Open sales representative vacancy','hiring',?,?,?,'page_bound',90,5,80)")
    .run(lead, job, company, null, event, `${company} posted a sales representative vacancy in ${where} on ${day}.`, day)
  const card = `<article><h2>${name}</h2><p>${title}</p><a href="mailto:${email}">${email}</a></article>`
  const pages: Record<string, string> = {
    [origin + '/robots.txt']: 'User-agent: *\nAllow: /',
    [origin + '/']: wrap(prose + `<p>${company}, ${homeAddress}</p><a href="/contact-us/">Contact us</a>`),
    [contact]: wrap(prose + card),
    [event]: wrap(prose + `<p>${company} posted a sales representative vacancy in ${where} on ${day}.</p>`),
  }
  const get: Get = async url => ({ status: pages[url] ? 200 : 404, body: pages[url] ?? '', finalUrl: url })
  await crawlJob(db, 'A', job, { get, gapMs: 0, now, env: {} })
  const add = (kind: string, value: string, label: string) => addEnrichment(db, 'A', lead, { connector: 'scan:gate', kind, value, label, confidence: null, source_url: event, source_date: day, retrieved_at: at })
  add('gate_passed', 'requested_role_v1', 'role verified')
  add('gate_passed', 'sales_hiring', 'role verified')
  db.prepare("UPDATE scan_jobs SET status='done', candidates=1, dropped=0, enrich_finished_at=? WHERE id=?").run(at, job)
  const jobRow = { id: job, user_id: 'A', query, icp: JSON.stringify({ who: [title], where: [where], window_days: 20 }) }
  await recordNeedEvidence(sqliteDb(db), 'A', job, { asOf: new Date(now), windowDays: 20 })
  recordActionability(db, jobRow)
  recordTimingProof(db, jobRow, new Date(now))
  const refresh = async () => {
    await recordNeedEvidence(sqliteDb(db), 'A', job, { asOf: new Date(now), windowDays: 20 })
    recordActionability(db, jobRow)
    recordTimingProof(db, jobRow, new Date(now))
  }
  const params = { params: Promise.resolve({ lead }) }
  const url = `http://localhost/api/leads/${lead}/work-email`
  return {
    db, lead, email, contact, target: `${name}|${title}`, now: new Date(now), refresh,
    phone: () => addEnrichment(db, 'A', lead, { connector: 'sitecrawl', kind: 'phone', value: '+1 312 555 0100', label: 'phone published on the company site', confidence: null, source_url: contact, source_date: day, retrieved_at: at }),
    rows: (enrichmentsForLeads(db, 'A', [lead])[lead] ?? []).filter(r => r.kind === 'person' || r.kind === 'email'),
    get: () => WE_GET(new NextRequest(url), params),
    post: (target: string) => WE_POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ target }), headers: hdr }), params),
  }
}

test('US company-first buyer with an own printed address: Find work email gives it, with its page, in one click', async () => {
  const s = await companyFirstLead('Chicago, IL', '200 Example Ave, Chicago, IL 60606')
  assert.deepEqual(s.rows.map(r => [r.kind, r.value, r.source_url]).sort(), [['email', s.email, s.contact], ['person', 'Jo Hammerstrom, Chief Marketing Officer', s.contact]], 'the real crawl named the buyer and their own address on the contact page')
  assert.equal(currentnessHeld(s.db, 'A', s.lead, s.now), false, 'the lead is current, so the lookup may run: ' + JSON.stringify({ gap: timingProofGap(s.db, 'A', s.lead, s.now), gate: requiredGateHeld(s.db, 'A', s.lead) }))
  const clicked = await s.post(s.target)
  assert.equal(clicked.status, 200)
  const body = await clicked.json() as { status: string; lookup: { address: string | null; source_url: string | null; provider: string | null } }
  assert.deepEqual([body.status, body.lookup.address, body.lookup.source_url, body.lookup.provider], ['published', s.email, s.contact, 'site'])
  const read = await (await s.get()).json() as { lookups: { target: string; status: string; address: string | null; source_url: string | null }[] }
  assert.deepEqual(read.lookups.map(l => [l.target, l.status, l.address, l.source_url]), [[s.target, 'published', s.email, s.contact]], 'a reload shows the same answer')
  assert.deepEqual((workEmailPageRead(s.db, 'A', [{ id: s.lead }]).lookups[s.lead] ?? []).map(l => l.address), [s.email], 'the Leads page preload shows it too')
  s.db.close()
})

test('Canadian company-first buyer stays display-only: the one-click lookup gives no address', async () => {
  const s = await companyFirstLead('Toronto, ON', '200 Example Ave, Toronto, ON M5V 2T6, Canada')
  assert.ok(!s.rows.some(r => r.kind === 'email'), 'no sender route outside the US')
  const body = await (await s.post(s.target)).json() as { status?: string; lookup?: { address: string | null } }
  assert.notEqual(body.lookup?.address ?? null, s.email)
  assert.deepEqual((await (await s.get()).json() as { lookups: unknown[] }).lookups, [])
  s.db.close()
})

test('the US pair needs its own sender route for that address and page, a current unsuppressed pair and a company-first job', async () => {
  const cases: [string, (s: Awaited<ReturnType<typeof companyFirstLead>>) => void][] = [
    // the lead stays current through its published company phone, so only the sender-route check stands between the pair and the button
    ['no sender route', s => { s.phone(); s.db.prepare("DELETE FROM lead_enrichments WHERE lead_id=? AND kind='email'").run(s.lead) }],
    ['sender route from another page', s => { s.phone(); s.db.prepare("UPDATE lead_enrichments SET source_url='https://harlowgrant.com/' WHERE lead_id=? AND kind='email'").run(s.lead) }],
    ['suppressed address', s => { s.db.prepare("INSERT INTO suppressions (tenant_id,email,reason,created_at) VALUES ('A',?,'manual',?)").run(s.email, Math.floor(Date.now() / 1000)) }],
    ['sender route for another address on the page', s => { s.phone(); s.db.prepare("UPDATE lead_enrichments SET value='office.lead@harlowgrant.com' WHERE lead_id=? AND kind='email'").run(s.lead) }],
    ['pair from an earlier scan attempt', s => { s.phone(); s.db.prepare('UPDATE scan_jobs SET attempts=attempts+1').run() }],
    ['pair older than 45 days', s => {
      s.phone()
      s.db.prepare('UPDATE company_first_published_email_display SET observed_at=observed_at-46*86400').run()
      s.db.prepare("UPDATE lead_enrichments SET retrieved_at=retrieved_at-46*86400 WHERE lead_id=? AND kind='person'").run(s.lead)
    }],
    ['a lead still under review', s => { s.phone(); s.db.prepare("UPDATE leads SET review_reason='quote_unconfirmed' WHERE id=?").run(s.lead) }],
    // published-only, but not company-first: the pair is never read
    ['a published-only QA job that is not company-first', s => { s.db.prepare('UPDATE scan_jobs SET run_budget=?').run(qaClaudeOnlyBudget(null)) }],
  ]
  for (const [why, change] of cases) {
    const s = await companyFirstLead('Chicago, IL', '200 Example Ave, Chicago, IL 60606')
    change(s)
    await s.refresh()
    if (why.includes('sender route') || why.includes('attempt')) assert.equal(currentnessHeld(s.db, 'A', s.lead, s.now), false, why + ': the lead is current, so only the guard can refuse')
    const body = await (await s.post(s.target)).json() as { lookup?: { address: string | null } }
    assert.notEqual(body.lookup?.address ?? null, s.email, why)
    assert.ok(!(await (await s.get()).json() as { lookups: { address: string | null }[] }).lookups.some(l => l.address === s.email), why)
    s.db.close()
  }
})

test('a scan scoped to a place outside the US never gets the pair, even when the homepage prints a US address', async () => {
  for (const where of ['London', 'Toronto, ON', 'Remote', 'Toronto, CA']) {
    const s = await companyFirstLead(where, '200 Example Ave, Chicago, IL 60606')
    assert.ok(s.rows.some(r => r.kind === 'email'), where + ': the crawl wrote a US sender route from the homepage address')
    assert.equal(currentnessHeld(s.db, 'A', s.lead, s.now), false, where + ': the lead is current, so only the scope can refuse')
    const body = await (await s.post(s.target)).json() as { lookup?: { address: string | null } }
    assert.notEqual(body.lookup?.address ?? null, s.email, where)
    assert.ok(!(await (await s.get()).json() as { lookups: { address: string | null }[] }).lookups.some(l => l.address === s.email), where)
    s.db.close()
  }
  for (const where of ['Austin, TX', 'Portland, Oregon, United States', 'San Francisco, CA']) {
    const s = await companyFirstLead(where, '200 Example Ave, Chicago, IL 60606')
    assert.equal(((await (await s.post(s.target)).json()) as { lookup: { address: string | null } }).lookup.address, s.email, where)
    s.db.close()
  }
})

test('the sync reader the button uses returns exactly the rows the async display reader returns', async () => {
  const s = await companyFirstLead('Chicago, IL', '200 Example Ave, Chicago, IL 60606')
  const at = Math.floor(s.now.getTime() / 1000)
  const sync = companyFirstPublishedDisplayRowsSync(s.db, 'A', [s.lead], at)
  assert.equal(sync[s.lead]?.address, s.email)
  assert.deepEqual(sync, await companyFirstPublishedDisplayRows(sqliteDb(s.db), 'A', [s.lead], at))
  s.db.close()
})
