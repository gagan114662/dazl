// Code decides "done": every candidate is resolved (dated, company confirmed, contact attached) or carries a specific reason after bounded targeted lookups. Stubbed pages only; invented companies.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { resolveFacts, resolveBounded, MAX_ATTEMPTS } from '../lib/scan/resolution.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { runReportFor } from '../lib/scan/run-report.ts'
import { applySalesHiringGate } from '../lib/scan/sales-hiring-gate.ts'

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

// ---- #316 review: role, calendar truth, one overall deadline, cancellation ----
const ICP_NOWIN = JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Founder'], signals: ['opened a new office'], exclude: [] })
test('WRONG ROLE: a named person who is not the requested decision-maker (a dentist at a SaaS lead) does not make the contact "attached"; founder / requested-role titles do', () => {
  const { db, job, lead, enr } = seed()
  const wrong = lead({ company: 'Acme', domain: 'acme.example', date: daysAgo(10) }); enr(wrong, 'person', 'Jane Doe, Dentist'); enr(wrong, 'email', 'jane@acme.example')
  const ok = lead({ company: 'Beta', domain: 'beta.example', date: daysAgo(10) }); enr(ok, 'person', 'Sam Roe, Co-founder'); enr(ok, 'email', 'sam@beta.example')
  const ceo = lead({ company: 'Gamma', domain: 'gamma.example', date: daysAgo(10) }); enr(ceo, 'person', 'Lee Poe, CEO'); enr(ceo, 'phone', '+44 20 7946 0000')
  const m = new Map(resolveFacts(db, job).map(r => [r.company, r]))
  assert.deepEqual([m.get('Acme')!.contact, m.get('Acme')!.resolved], ['missing', false]); assert.ok(m.get('Acme')!.reasons.includes('the named person (Jane Doe, Dentist) is not the requested role (Founder)'), JSON.stringify(m.get('Acme')!.reasons))
  assert.deepEqual([m.get('Beta')!.contact, m.get('Beta')!.resolved], ['attached', true]); assert.deepEqual([m.get('Gamma')!.contact, m.get('Gamma')!.resolved], ['attached', true])
  // a requested non-founder role works too
  const s2 = seed(); s2.db.prepare('UPDATE scan_jobs SET icp = ? WHERE id = ?').run(JSON.stringify({ summary: 's', where: ['London, UK'], who: ['Head of Sales'], signals: ['x'], exclude: [], window_days: 90 }), s2.job.id)
  const a = s2.lead({ company: 'Delta', domain: 'delta.example', date: daysAgo(10) }); s2.enr(a, 'person', 'Ann Lee, Head of Sales'); s2.enr(a, 'email', 'ann@delta.example')
  assert.equal(resolveFacts(s2.db, { ...s2.job, icp: JSON.stringify({ summary: 's', who: ['Head of Sales'], window_days: 90 }) })[0].contact, 'attached')
})
test('CALENDAR TRUTH, with or without a recency window: an impossible date, a future date and unconfirmed timing are never "found" - each carries its own reason', () => {
  for (const icp of [ICP, ICP_NOWIN]) {
    const { db, job, lead, enr } = seed(); db.prepare('UPDATE scan_jobs SET icp = ? WHERE id = ?').run(icp, job.id)
    const mk = (company: string, date: string | null, reason: string | null = null) => { const id = lead({ company, domain: `${company.toLowerCase()}.example`, date, reason }); enr(id, 'person', 'Jo Bo, Founder'); enr(id, 'email', `jo@${company.toLowerCase()}.example`); return id }
    mk('Badday', '2026-02-30'); mk('Future', '2099-01-01'); mk('FutureHeld', '2099-01-01', 'event_date_future_date'); mk('BadHeld', null, 'event_date_bad_date'); mk('Season', null, 'event_timing_unconfirmed'); mk('Fine', daysAgo(10))
    const m = new Map(resolveFacts(db, { ...job, icp }).map(r => [r.company, r]))
    assert.equal(m.get('Badday')!.date, 'invalid'); assert.deepEqual(m.get('Badday')!.reasons, ['the event date "2026-02-30" is not a real calendar date'])
    assert.equal(m.get('Future')!.date, 'future'); assert.deepEqual(m.get('Future')!.reasons, ['the event date 2099-01-01 is in the future'])
    assert.equal(m.get('FutureHeld')!.date, 'future'); assert.equal(m.get('BadHeld')!.date, 'invalid'); assert.equal(m.get('Season')!.date, 'unconfirmed'); assert.match(m.get('Season')!.reasons[0], /event timing is unconfirmed/)
    for (const c of ['Badday', 'Future', 'FutureHeld', 'BadHeld', 'Season']) assert.equal(m.get(c)!.resolved, false, c)
    assert.deepEqual([m.get('Fine')!.date, m.get('Fine')!.resolved], ['found', true])
  }
})
const stuck = (calls: { u: string; signal?: AbortSignal }[]) => (u: string, signal?: AbortSignal) => { calls.push({ u, signal }); return new Promise<never>(() => { /* never answers: only the deadline / cancel can end it */ }) }
function manyDomains(n: number) { const s = seed(); for (let i = 0; i < n; i++) s.lead({ company: `Co${i}`, domain: `co${i}.example`, reason: 'outside_window_undated' }); return s }
test('ONE OVERALL DEADLINE: slow pages on many domains cannot hold the worker - the run ends at the deadline, the request in flight is aborted, the untried work is recorded as skipped (not as tried)', async () => {
  const { db, job } = manyDomains(5); const calls: { u: string; signal?: AbortSignal }[] = []
  const t0 = Date.now(); const s = await resolveBounded(db, job, { fetchPage: stuck(calls), where: ['London, UK'], deadlineMs: 80 }); const ms = Date.now() - t0
  assert.ok(ms < 1500, `ended at the deadline, not after 5 domains x 3 pages: ${ms}ms`); assert.equal(s.interrupted, 'deadline'); assert.equal(calls.length, 1, 'no request was started after the deadline'); assert.equal(calls[0].signal?.aborted, true, 'the in-flight request was aborted')
  assert.ok(s.leads.every(l => l.tried.length === 0), 'an interrupted page is not counted as tried'); assert.ok(s.leads.every(l => /own-site date lookup not completed: the overall lookup deadline \(0\.08s\) was reached/.test(l.reasons.join('|'))), JSON.stringify(s.leads[0].reasons))
  assert.ok(s.leads.every(l => !/on \d+ sources? tried/.test(l.reasons.join('|'))), 'untried work is never presented as completed')
})
test('CANCELLATION: aborting the scan stops new requests and aborts the one in flight', async () => {
  const { db, job } = manyDomains(4); const calls: { u: string; signal?: AbortSignal }[] = []; const ctrl = new AbortController()
  const p = resolveBounded(db, job, { fetchPage: stuck(calls), signal: ctrl.signal, deadlineMs: 10_000 }); await new Promise(r => setTimeout(r, 30)); ctrl.abort(); const s = await p
  assert.equal(s.interrupted, 'cancelled'); assert.equal(calls.length, 1); assert.equal(calls[0].signal?.aborted, true); assert.ok(s.leads.every(l => /the scan was cancelled/.test(l.reasons.join('|'))))
  // already cancelled: nothing is started at all
  const none: { u: string }[] = []; const pre = new AbortController(); pre.abort()
  const s2 = await resolveBounded(db, job, { fetchPage: async u => { none.push({ u }); return null }, signal: pre.signal }); assert.equal(none.length, 0); assert.equal(s2.interrupted, 'cancelled')
})
test('SCAN-WIDE BOUND: many domains with failing pages stop at the scan-wide cap, with the rest recorded as skipped', async () => {
  const { db, job } = manyDomains(6); let calls = 0
  const s = await resolveBounded(db, job, { fetchPage: async () => { calls++; throw new Error('boom') }, maxFetches: 4, deadlineMs: 5000 })
  assert.equal(calls, 4); assert.equal(s.lookups, 4); assert.ok(s.leads.some(l => /the scan-wide limit of 4 page reads was reached/.test(l.reasons.join('|')))); assert.equal(s.interrupted, null)
})
test('the real fetcher takes the signal: an already-aborted signal makes no connection at all', async () => {
  const { once, fetchPageDetailed } = await import('../lib/scan/fetch-page.ts')
  const pre = new AbortController(); pre.abort()
  await assert.rejects(once(new URL('https://203.0.113.9/'), 10_000, undefined, pre.signal), /aborted/)
  assert.deepEqual(await fetchPageDetailed('https://203.0.113.9/', async () => null, pre.signal), { fail: 'error' })
})

// ---- #316 review 2: tomorrow is not resolved; a normal post-scan lookup is not a cancellation ----
test('TOMORROW (no window): a date-only day after today is future and never resolved; today is found', () => {
  const { db, job, lead, enr } = seed(); db.prepare('UPDATE scan_jobs SET query = ?, icp = ? WHERE id = ?').run('Find startups', '{}', job.id)
  const mk = (company: string, date: string) => { const id = lead({ company, domain: `${company.toLowerCase()}.example`, date }); enr(id, 'person', 'Jo Bo, Founder'); enr(id, 'email', `jo@${company.toLowerCase()}.example`) }
  mk('Tomorrow', '2026-10-29'); mk('Today', '2026-10-28'); mk('Yesterday', '2026-10-27')
  const m = new Map(resolveFacts(db, { ...job, query: 'Find startups', icp: '{}' }, new Map(), new Date('2026-10-28T14:00:00Z')).map(r => [r.company, r]))
  assert.deepEqual([m.get('Tomorrow')!.date, m.get('Tomorrow')!.resolved, m.get('Tomorrow')!.reasons], ['future', false, ['the event date 2026-10-29 is in the future']])
  assert.deepEqual([m.get('Today')!.date, m.get('Today')!.resolved], ['found', true]); assert.deepEqual([m.get('Yesterday')!.date, m.get('Yesterday')!.resolved], ['found', true])
  assert.equal(resolveFacts(db, { ...job, query: 'Find startups', icp: '{}' }, new Map(), new Date('2026-10-28T23:59:59Z')).find(r => r.company === 'Tomorrow')!.date, 'future')
})

// A real runJob whose finish() has already written status 'done': the own-page lookup runs AFTER that. SITECRAWL on (stubbed crawl) only to bind the lead's domain, exactly as the sales-hiring tests do.
const QUOTE = 'Brightloop opened a new office in Shoreditch, London for its growing engineering team'
const PAGE = { title: 'Brightloop opens in Shoreditch', text: `Published ${daysAgo(12)}. ${QUOTE}. ${'More about the company and its people. '.repeat(15)}` }
const NEWSU = 'https://sifted.example/brightloop-opens'
const EVENTLD = JSON.stringify({ '@type': 'Event', name: 'Brightloop office opening', startDate: daysAgo(10), organizer: { name: 'Brightloop' }, location: { '@type': 'Place', name: 'Brightloop Shoreditch office', address: { addressLocality: 'London', addressCountry: 'GB', addressRegion: 'England' } } })
interface Seen { started: string[]; finished: string[]; abortedAtEnd: boolean[]; db?: Database.Database; jobId?: string }
function undated(slowMs: number, seen: Seen, cancelAfterMs?: number): Fixture {
  const crawl = async (url: string) => { const u = new URL(url)
    if (u.hostname === 'sifted.example') return { status: 200, body: `<html><body><a href="https://brightloop.io/">Brightloop</a> ${PAGE.text}</body></html>`, finalUrl: url }
    if (u.hostname === 'brightloop.io') return u.pathname === '/robots.txt' ? { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url } : u.pathname === '/' ? { status: 200, body: `<html><body>Brightloop - London SaaS, 1 Old Street, London EC1V 9HX. ${PAGE.text}`, finalUrl: url } : { status: 404, body: '', finalUrl: url }
    return null }
  const fetchPage = async (u: string, signal?: AbortSignal) => {
    if (signal && new URL(u).hostname === 'brightloop.io') {   // ONLY the post-finish own-site lookup passes a signal: slow, and it answers with the company's own Event
      seen.started.push(u)
      if (cancelAfterMs !== undefined) setTimeout(() => { try { seen.db?.prepare('UPDATE scan_jobs SET attempts = attempts + 1 WHERE id = ?').run(seen.jobId) } catch (e) { console.error('flip failed', e instanceof Error ? e.message : e) } }, cancelAfterMs)
      await new Promise<void>(r => { const tm = setTimeout(r, slowMs); signal.addEventListener('abort', () => { clearTimeout(tm); r() }, { once: true }) })   // honours the signal like the real fetcher
      seen.abortedAtEnd.push(signal.aborted); if (!signal.aborted) seen.finished.push(u)
      return { text: 'Brightloop home. ' + 'x'.repeat(300), title: 'Brightloop', retrievedAt: 1, structured: [EVENTLD] }
    }
    return u === NEWSU ? { text: PAGE.text, title: PAGE.title, retrievedAt: 1 } : { fail: 'error' as const }
  }
  return { request: 'Find London UK startups that opened a new office within the past 90 days.', modelIcp: { summary: 's', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['opened a new office'], exclude: [], country: 'GB', language: 'en', window_days: 90 }, modelQueries: ['london startup opens office'],
    hits: [{ url: NEWSU, title: PAGE.title, snippet: QUOTE, date: daysAgo(12) }], tfPages: { [NEWSU]: PAGE }, own: { [NEWSU]: PAGE }, extraction: [{ company: 'Brightloop', signal: 'opened a new office', source_url: NEWSU, excerpt: QUOTE, event_date: null }],
    deps: { crawlGet: crawl as never, fetchPage: fetchPage as never, salesHiringGate: (async (db: Database.Database, job: { id: string }, ...rest: unknown[]) => { seen.db = db; seen.jobId = job.id; return (applySalesHiringGate as (...a: unknown[]) => Promise<unknown>)(db, job, ...rest) }) as never } }
}
async function runCrawl(f: Fixture) { const saved = process.env.SITECRAWL_ENABLED; process.env.SITECRAWL_ENABLED = '1'; try { return await runFixture(f) } finally { if (saved === undefined) delete process.env.SITECRAWL_ENABLED; else process.env.SITECRAWL_ENABLED = saved } }
const resOf = (x: Awaited<ReturnType<typeof runFixture>>) => (runReportFor(x.db, 'A', (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id) as { resolution?: { interrupted: string | null; lookups: number; leads: { company: string; late_date?: { date: string; url: string }; reasons: string[] }[] } }[]).findLast(r => r.resolution)?.resolution

test('REAL RUNNER: a normal own-page lookup that takes longer than the 500ms ownership poll is NOT cancelled - it completes and finds the company\'s own Event date', async () => {
  const seen: Seen = { started: [], finished: [], abortedAtEnd: [] }
  const x = await runCrawl(undated(900, seen))
  assert.equal((x.db.prepare("SELECT company_domain FROM leads WHERE company = 'Brightloop'").get() as { company_domain: string }).company_domain, 'brightloop.io')
  assert.ok(seen.started.length >= 1 && seen.finished.length >= 1, `the lookup ran and finished: ${JSON.stringify(seen)}`)
  assert.deepEqual(seen.abortedAtEnd, seen.abortedAtEnd.map(() => false), 'its signal was not aborted while it ran'); const res = resOf(x)!
  assert.equal(res.interrupted, null); const l = res.leads.find(r => r.company === 'Brightloop')!; assert.ok(l.late_date, JSON.stringify(res)); assert.equal(l.late_date!.date, daysAgo(10))
})
test('REAL RUNNER: an actual cancellation (a newer attempt has taken the job row) aborts the lookup in flight and records it', async () => {
  const seen: Seen = { started: [], finished: [], abortedAtEnd: [] }
  const x = await runCrawl(undated(8000, seen, 100))
  assert.ok(seen.started.length >= 1 && seen.finished.length === 0, `the lookup started and never completed: ${JSON.stringify(seen)}`); assert.ok(seen.abortedAtEnd.includes(true), 'the in-flight request was aborted by the cancellation')
  const res = resOf(x); assert.ok(res, 'the run report still carries the resolution summary'); assert.equal(res!.interrupted, 'cancelled'); assert.ok(res!.leads.some(l => /own-site date lookup not completed: the scan was cancelled/.test(l.reasons.join('|'))), JSON.stringify(res))
})
