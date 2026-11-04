// Reasoned lead feedback (lib/scan/feedback.ts, #385): rejections captured at account / person / event level, enforced
// by later runs (through the real runJob), explainable, reversible, versioned and tenant-isolated; learned preferences
// only order and propose. Stubbed pages and models only; every company, person and address is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import {
  applyProposal, applyRejections, explainAccount, FeedbackError, FeedbackUnreadable, heldBy, learnedPreference, listFeedback, migrateFeedback, NO_REJECTIONS,
  proposeProfile, readRejections, recordFeedback, rejectLead, releaseLead, resetFeedback, sourceYield, stripRejectedPeople, type FeedbackRow, type Rejections,
} from '../lib/scan/feedback.ts'
import { feedbackGate } from '../lib/scan/runner.ts'
import { referenceCohort } from '../lib/scan/lookalike.ts'
import { rankLeads } from '../lib/events/prioritize.ts'
import { readMemory, writeMemory } from '../lib/memory.ts'

type SeedLead = { id: string; company: string; domain?: string; name?: string; contact?: string; event_date?: string; url?: string; kind?: string; fit?: number }
const seed = async (db: Db, t: string, leads: SeedLead[], job = `job-${t}`) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [job, t])
  for (const l of leads) await db.run("INSERT INTO leads (id, scan_job_id, company, company_domain, name, contact, signal, source_url, evidence_excerpt, event_date, confidence, signal_kind, fit) VALUES (?, ?, ?, ?, ?, ?, 'opened a second office', ?, 'q', ?, 80, ?, ?)",
    [l.id, job, l.company, l.domain ?? null, l.name ?? '', l.contact ?? null, l.url ?? 'https://news.example/a', l.event_date ?? null, l.kind ?? null, l.fit ?? null])
}
const quarantined = async (db: Db, id: string) => (await db.get<{ q: number | null }>('SELECT quarantined_at AS q FROM leads WHERE id = ?', [id]))?.q ?? null

bothEngines('captured at its level, versioned, tenant-isolated, explainable and reversible', async ({ db }) => {
  await seed(db, 'A', [{ id: 'a1', company: 'Rival Labs Ltd', domain: 'https://www.rival.example/about' }, { id: 'a2', company: 'Querix', name: 'Pat Doe', contact: 'pat@querix.example' }, { id: 'a3', company: 'Fernhill', event_date: '2026-09-01' }])
  await seed(db, 'B', [{ id: 'b1', company: 'Rival Labs Ltd' }])
  const r1 = await rejectLead(db, 'A', 'a1', { reason: 'competitor', note: 'our competitor', actorId: 'u-a' })
  const r2 = await rejectLead(db, 'A', 'a2', { reason: 'wrong_person' })
  const r3 = await rejectLead(db, 'A', 'a3', { reason: 'wrong_timing' })
  assert.ok(r1.status === 'rejected' && r2.status === 'rejected' && r3.status === 'rejected')
  assert.deepEqual([r1.feedback.level, r1.feedback.company_key, r1.feedback.domain, r1.feedback.actor_id, r2.feedback.level, r2.feedback.person_name, r2.feedback.person_contact, r3.feedback.level, r3.feedback.event_date],
    ['account', 'rival labs', 'rival.example', 'u-a', 'person', 'pat doe', 'pat@querix.example', 'event', '2026-09-01'])
  assert.deepEqual([r1.feedback.version, r2.feedback.version, r3.feedback.version], [1, 2, 3])
  assert.notEqual(await quarantined(db, 'a1'), null)
  // another tenant: A's lead is unknown, A's feedback is invisible, B's versions start at 1
  assert.deepEqual(await rejectLead(db, 'B', 'a1', { reason: 'competitor' }), { status: 'not_found' })
  await assert.rejects(recordFeedback(db, 'B', 'a1', { verdict: 'accept' }), /no such lead/)
  assert.deepEqual(await listFeedback(db, 'B'), [])
  assert.deepEqual((await readRejections(db, 'B')).account, [])
  assert.equal((await recordFeedback(db, 'B', 'b1', { verdict: 'accept' })).version, 1)
  // explain and reset (history kept); another tenant cannot reset
  assert.deepEqual((await explainAccount(db, 'A', { company: 'Rival Labs' })).map(r => r.reason), ['competitor'])
  assert.equal(await resetFeedback(db, 'B', r1.feedback.id, 'not mine'), false)
  await assert.rejects(resetFeedback(db, 'A', r1.feedback.id, '  '), /a reset says why/)
  assert.equal(await resetFeedback(db, 'A', r1.feedback.id, 'they became a partner'), true)
  assert.equal(await resetFeedback(db, 'A', r1.feedback.id, 'twice'), false)
  assert.deepEqual((await readRejections(db, 'A')).account, [])
  assert.equal((await listFeedback(db, 'A')).find(r => r.id === r1.feedback.id)!.reset_reason, 'they became a partner')
  // releasing a lead resets exactly what its rejection taught
  assert.deepEqual(await releaseLead(db, 'B', 'a2'), { status: 'not_found' })
  assert.deepEqual(await releaseLead(db, 'A', 'a2'), { status: 'released', reset: 1 })
  assert.equal(await quarantined(db, 'a2'), null)
  assert.deepEqual((await readRejections(db, 'A')).person, [])
  assert.equal((await readRejections(db, 'A')).event.length, 1)
})

bothEngines('validated before anything is written: a bad or unfit reason quarantines nothing and records nothing', async ({ db }) => {
  await seed(db, 'A', [{ id: 'a1', company: 'Querix' }, { id: 'a2', company: '-' }])
  for (const [reason, code] of [['bogus', 'invalid_feedback_reason'], [undefined, 'invalid_feedback_reason'], ['wrong_person', 'person_required'], ['wrong_timing', 'event_date_required']] as const) {
    await assert.rejects(rejectLead(db, 'A', 'a1', { reason }), (e: unknown) => e instanceof FeedbackError && e.code === code)
    assert.equal(await quarantined(db, 'a1'), null, String(reason))
  }
  await assert.rejects(rejectLead(db, 'A', 'a2', { reason: 'not_useful' }), (e: unknown) => e instanceof FeedbackError && e.code === 'no_company')
  await assert.rejects(recordFeedback(db, 'A', 'a1', { verdict: 'accept', reason: 'not_useful' }), /no rejection reason/)
  assert.deepEqual(await listFeedback(db, 'A'), [])
  // an explicit person given with the rejection is enough
  const r = await rejectLead(db, 'A', 'a1', { reason: 'wrong_person', person: 'Sam Roe' })
  assert.ok(r.status === 'rejected' && r.feedback.person_name === 'sam roe')
})

bothEngines('version race: concurrent verdicts get distinct, gapless versions per tenant', async ({ db }) => {
  await seed(db, 'A', Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, company: `Brand${i} Labs` })))
  const rows = await Promise.all(Array.from({ length: 8 }, (_, i) => recordFeedback(db, 'A', `c${i}`, { verdict: i % 2 ? 'accept' : 'reject', reason: i % 2 ? undefined : 'not_useful' })))
  assert.deepEqual(rows.map(r => r.version).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
}, { pgMax: 8 })

const row = (o: Partial<FeedbackRow>): FeedbackRow => ({ id: 'f', tenant_id: 'A', version: 1, verdict: 'reject', level: 'account', reason: 'wrong_industry', company_key: 'harbor dental', domain: null, person_name: null, person_contact: null, event_date: null, source_host: null, signal_kind: null, lead_id: null, job_id: null, actor_id: null, note: null, created_at: 1, reset_at: null, reset_reason: null, ...o })
const rj = (rows: FeedbackRow[]): Rejections => ({ account: rows.filter(r => r.level === 'account'), person: rows.filter(r => r.level === 'person'), event: rows.filter(r => r.level === 'event') })
const cand = (company: string, o: Record<string, unknown> = {}) => ({ company, name: '', contact: null as string | null, event_date: null as string | null, source_url: `https://news.example/${company.length}`, ...o })

test('timing: the rejected day, an older day (any URL), a mirror on another URL and an undated one are held; only a strictly later day passes', () => {
  const r = rj([row({ id: 't', level: 'event', reason: 'wrong_timing', event_date: '2026-10-01' })])
  assert.ok(heldBy(r, cand('Harbor Dental', { event_date: '2026-06-01', source_url: 'https://other.example/old' })), 'older event at another URL')
  for (const u of ['https://mirror.example/copy', 'https://www.news.example/a?utm=x']) assert.ok(heldBy(r, cand('Harbor Dental Inc', { event_date: '2026-10-01', source_url: u })), `mirror ${u}`)
  assert.ok(heldBy(r, cand('Harbor Dental')), 'undated')
  assert.ok(heldBy(r, cand('Harbor Dental', { event_date: 'last week' })), 'unparseable date')
  assert.equal(heldBy(r, cand('Harbor Dental', { event_date: '2026-10-02' })), null, 'a strictly later event is a new relevant event')
})

test('accounts: explicit different domains never collapse by display name; the same domain matches under another name; no domain falls back to the name', () => {
  const r = rj([row({ id: 'a', company_key: 'apex', domain: 'apex-dental.example' })])
  assert.equal(heldBy(r, { company: 'Apex', company_domain: 'apex-roofing.example' }), null, 'same name, another explicit domain: someone else')
  assert.ok(heldBy(r, { company: 'Apex Dental Group', company_domain: 'https://www.apex-dental.example/' }))
  assert.ok(heldBy(r, { company: 'APEX LLC' }), 'no domain on the candidate: held by name (fail closed until #364)')
  const noDomain = rj([row({ id: 'n', company_key: 'apex' })])
  assert.ok(heldBy(noDomain, { company: 'Apex', company_domain: 'apex-roofing.example' }))
})

test('persons: stripped by name or address at the same account only; the company stays', () => {
  const r = rj([row({ id: 'p', level: 'person', reason: 'wrong_person', company_key: 'querix', person_name: 'pat doe', person_contact: 'pat@querix.example' })])
  const out = applyRejections([cand('Querix', { name: 'Pat Doe' }), cand('Querix', { contact: 'PAT@querix.example' }), cand('Querix', { name: 'Sam Roe', contact: 'sam@querix.example' }), cand('Other Co', { name: 'Pat Doe' })], r)
  assert.deepEqual(out.kept.map(k => [k.company, k.name, k.contact]), [['Querix', '', null], ['Querix', '', null], ['Querix', 'Sam Roe', 'sam@querix.example'], ['Other Co', 'Pat Doe', null]])
  assert.deepEqual([out.dropped.length, out.stripped.length], [0, 2])
})

test('every active rejection is enforced, the 5001st as much as the first', async () => {
  const raw = new Database(':memory:'); migrateFeedback(raw)
  const ins = raw.prepare("INSERT INTO lead_feedback (id, tenant_id, version, verdict, level, reason, company_key, created_at) VALUES (?, 'A', ?, 'reject', 'account', 'not_useful', ?, 1)")
  raw.transaction(() => { for (let i = 1; i <= 5001; i++) ins.run(`f${i}`, i, `brand ${i}`) })()
  const r = await readRejections(sqliteDb(raw), 'A')
  assert.equal(r.account.length, 5001)
  assert.equal(heldBy(r, { company: 'Brand 5001' })?.id, 'f5001')
})

test('an unreadable store is unknown, never "nothing rejected": the run gate holds everything; a missing table is an older store with no feedback', async () => {
  const broken = new Database(':memory:'); broken.exec('CREATE TABLE lead_feedback (id TEXT)')
  await assert.rejects(readRejections(sqliteDb(broken), 'A'), FeedbackUnreadable)
  const counts: Record<string, number> = {}; const why: string[] = []
  assert.deepEqual(await feedbackGate(broken, 'A').apply([cand('Querix'), cand('Fernhill')] as never[], counts, (rows, reason) => why.push(`${rows.length}:${reason}`)), [])
  assert.deepEqual([counts, why], [{ feedback_unreadable: 2 }, ['2:feedback_unreadable']])
  assert.deepEqual(await readRejections(sqliteDb(new Database(':memory:')), 'A'), NO_REJECTIONS)
  assert.deepEqual(referenceCohort(broken, 'A', []), [], 'and no lookalike cohort that might hold a rejected lead')
})

test('after enrichment: a rejected person re-added by the crawl or people search is stripped from the lead and its rows', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j', 'A', 'b', 'i', 'l', 'running')").run()
  raw.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url) VALUES ('l1', 'j', 'Querix', 'Pat Doe', 'pat@querix.example', 's', 'https://n.example/')").run()
  const enr = raw.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, 'l1', 'A', 'x', ?, ?, null, null, 'https://n.example/p', '2026-10-01', 1)")
  enr.run('e1', 'person', 'Pat Doe, Head of Sales'); enr.run('e2', 'email', 'pat@querix.example'); enr.run('e3', 'person', 'Sam Roe, CEO')
  const r = rj([row({ id: 'p', level: 'person', reason: 'wrong_person', company_key: 'querix', person_name: 'pat doe' })])
  assert.equal(await stripRejectedPeople(sqliteDb(raw), 'B', 'j', r), 0, 'another tenant touches nothing')
  assert.equal(await stripRejectedPeople(sqliteDb(raw), 'A', 'j', r), 2)
  assert.deepEqual(raw.prepare("SELECT name, contact FROM leads WHERE id = 'l1'").get(), { name: '', contact: null })
  assert.deepEqual((raw.prepare('SELECT id FROM lead_enrichments ORDER BY id').all() as { id: string }[]).map(x => x.id), ['e2', 'e3'], 'an address not tied to the rejected name stays')
})

// ---- through the real runJob: reject in one play, later runs do not bring it back ----
const QUOTE = (co: string) => `${co}, a London B2B SaaS startup, raised a 3m GBP seed round`
const url = (co: string) => `https://news.example/${co.toLowerCase()}`
const PAGE = (co: string, day: string) => ({ title: `${co} raises seed`, text: `On ${day}, ${QUOTE(co)}. ${'More about the company and its people. '.repeat(15)}` })
const play = (cos: { co: string; day?: string; name?: string; contact?: string }[], before?: Fixture['beforeRun']): Fixture => ({
  request: 'Find London B2B SaaS startups that raised a seed round in the past 90 days',
  modelIcp: { summary: 'London seed-funded B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['raised a seed round'], exclude: [], country: 'GB', language: 'en', window_days: 90 }, modelQueries: ['London SaaS seed round'],
  hits: cos.map(({ co, day }) => ({ url: url(co), title: `${co} raises seed`, snippet: QUOTE(co), date: day ?? daysAgo(12) })),
  tfPages: Object.fromEntries(cos.map(({ co, day }) => [url(co), PAGE(co, day ?? daysAgo(12))])), own: Object.fromEntries(cos.map(({ co, day }) => [url(co), PAGE(co, day ?? daysAgo(12))])),
  extraction: cos.map(({ co, day, name, contact }) => ({ company: co, name, contact, signal: 'raised a seed round', source_url: url(co), excerpt: QUOTE(co), event_date: day ?? daysAgo(12) })),
  ...(before ? { beforeRun: before } : {}),
})
// The state an earlier play of the same tenant left: its lead, rejected through the same function the route calls.
const earlierPlay = (leads: SeedLead[], reasons: Record<string, { reason: string; person?: string }>) => async (raw: Database.Database) => {
  migrateFeedback(raw)
  const db = sqliteDb(raw)
  const job = createJob(raw, 'A', { business_name: 'Acme', industry: 'x', location: 'y' }); raw.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  for (const l of leads) raw.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, event_date, confidence) VALUES (?, ?, ?, ?, ?, 's', ?, ?, 80)").run(l.id, job, l.company, l.name ?? '', l.contact ?? null, l.url ?? url(l.company), l.event_date ?? null)
  raw.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(job)
  for (const [id, r] of Object.entries(reasons)) assert.equal((await rejectLead(db, 'A', id, { reason: r.reason, person: r.person })).status, 'rejected')
}
const current = (x: Awaited<ReturnType<typeof runFixture>>) => (x.db.prepare("SELECT l.company, l.name, l.contact FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.query IS NOT NULL ORDER BY l.company").all() as { company: string; name: string; contact: string | null }[])
const fate = (x: Awaited<ReturnType<typeof runFixture>>, co: string) => x.report!.candidates.find((c: { company: string }) => c.company === co)?.fate as string | undefined

test('runner: an account rejected in an earlier play is not reintroduced; the run report names the feedback; releasing it brings it back', async () => {
  const cos = [{ co: 'Brightloop' }, { co: 'Querix' }]
  const control = await runFixture(play(cos))
  assert.deepEqual(current(control).map(l => l.company), ['Brightloop', 'Querix'], 'control: both verify without feedback')
  let fid = ''
  const rejected = await runFixture(play(cos, async raw => { await earlierPlay([{ id: 'old1', company: 'Brightloop Ltd' }], { old1: { reason: 'wrong_industry' } })(raw); fid = (raw.prepare('SELECT id FROM lead_feedback').get() as { id: string }).id }))
  assert.deepEqual(current(rejected).map(l => l.company), ['Querix'])
  assert.equal(fate(rejected, 'Brightloop'), `dropped:previously_rejected:wrong_industry:${fid}`)
  assert.equal(rejected.job.drop_reasons && JSON.parse(rejected.job.drop_reasons as string).previously_rejected, 1)
  const released = await runFixture(play(cos, async raw => { await earlierPlay([{ id: 'old1', company: 'Brightloop Ltd' }], { old1: { reason: 'wrong_industry' } })(raw); assert.equal((await releaseLead(sqliteDb(raw), 'A', 'old1')).status, 'released') }))
  assert.deepEqual(current(released).map(l => l.company), ['Brightloop', 'Querix'], 'reversible: after the reset the company can come back')
})

test('runner: a timing rejection holds the same or an older event and lifts for a strictly later one', async () => {
  const before = earlierPlay([{ id: 'old1', company: 'Brightloop', event_date: daysAgo(20) }], { old1: { reason: 'wrong_timing' } })
  const older = await runFixture(play([{ co: 'Brightloop', day: daysAgo(30) }, { co: 'Querix' }], before))
  assert.deepEqual(current(older).map(l => l.company), ['Querix'])
  const newer = await runFixture(play([{ co: 'Brightloop', day: daysAgo(5) }, { co: 'Querix' }], before))
  assert.deepEqual(current(newer).map(l => l.company), ['Brightloop', 'Querix'])
})

test('runner: a rejected person is stripped from the run (name and contact), the company is kept', async () => {
  const x = await runFixture(play([{ co: 'Querix', name: 'Pat Doe', contact: 'pat@querix.example' }, { co: 'Brightloop', name: 'Sam Roe' }], earlierPlay([{ id: 'old1', company: 'Querix', name: 'Pat Doe' }], { old1: { reason: 'wrong_person' } })))
  assert.deepEqual(current(x).map(l => [l.company, l.name, l.contact]), [['Brightloop', 'Sam Roe', null], ['Querix', '', null]])
})

test('runner: a feedback store that cannot be read holds every candidate (fail closed) and says so', async () => {
  const x = await runFixture(play([{ co: 'Brightloop' }, { co: 'Querix' }], raw => { raw.exec('CREATE TABLE lead_feedback (id TEXT)') }))
  assert.deepEqual(current(x), [])
  assert.equal(fate(x, 'Querix'), 'dropped:feedback_unreadable')
})

// ---- ranking: outcomes change what is ranked first, for the same tenant ----
test('lookalike cohort: an explicit accept joins it, a rejection (lead or account) leaves it whatever its grade, an opted-out contact never joins', () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j', 'A', 'b', 'i', 'l', 'running')").run()
  for (const [id, company, fit, contact] of [['good', 'Good Co', 5, 'a@good.example'], ['rej', 'Rej Co', 5, 'a@rej.example'], ['sameacct', 'Rej Co Ltd', 5, null], ['acc', 'Acc Co', null, 'a@acc.example'], ['optout', 'Opt Co', null, 'a@opt.example']] as const)
    raw.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, fit) VALUES (?, 'j', ?, ?, 'raised a seed round', 'https://n.example/', ?)").run(id, company, contact, fit)
  const db = sqliteDb(raw)
  assert.deepEqual(referenceCohort(raw, 'A', []).map(r => r.id).sort(), ['good', 'rej', 'sameacct'], 'before any verdict')
  return (async () => {
    await rejectLead(db, 'A', 'rej', { reason: 'not_useful' }); await recordFeedback(db, 'A', 'acc', { verdict: 'accept' }); await recordFeedback(db, 'A', 'optout', { verdict: 'accept' })
    raw.prepare("INSERT INTO suppressions (tenant_id, email, reason, created_at) VALUES ('A', 'a@opt.example', 'unsubscribe', 1)").run()
    assert.deepEqual(referenceCohort(raw, 'A', []).map(r => r.id).sort(), ['acc', 'good'])
    assert.deepEqual(referenceCohort(raw, 'B', []), [], 'tenant-scoped')
  })()
})

bothEngines('recorded verdicts reorder the same tenant\'s leads inside a fit lane (and only there); a reset undoes it', async ({ db }) => {
  const past: SeedLead[] = [1, 2, 3].flatMap(i => [{ id: `pa${i}`, company: `Alpha ${i}`, url: `https://good.example/${i}`, kind: 'funding' }, { id: `pb${i}`, company: `Beta ${i}`, url: `https://listicle.example/${i}`, kind: 'funding' }])
  await seed(db, 'A', past)
  const now = [{ id: 'n1', score: 90, fit: 4, intent: 3, action: 3, source_url: 'https://listicle.example/new', signal_kind: 'funding' }, { id: 'n2', score: 50, fit: 4, intent: 3, action: 3, source_url: 'https://good.example/new', signal_kind: 'funding' }, { id: 'n3', score: 10, fit: 5, intent: 1, action: 1, source_url: 'https://listicle.example/x', signal_kind: 'funding' }]
  const order = async (t: string) => { const y = sourceYield(await listFeedback(db, t, { activeOnly: true })); return rankLeads(now, {}, Object.fromEntries(now.map(l => [l.id, learnedPreference(y, l).delta]))).map(l => l.id) }
  assert.deepEqual(await order('A'), ['n3', 'n1', 'n2'], 'no verdicts: fit, then the raw score')
  for (let i = 1; i <= 3; i++) { await recordFeedback(db, 'A', `pa${i}`, { verdict: 'accept' }); await rejectLead(db, 'A', `pb${i}`, { reason: 'not_useful' }) }
  assert.deepEqual(await order('A'), ['n3', 'n2', 'n1'], 'accepted source first inside the fit-4 lane; the fit-5 lead stays first')
  assert.match(learnedPreference(sourceYield(await listFeedback(db, 'A', { activeOnly: true })), now[0]).why, /rejected 3 of 3 leads from listicle\.example/)
  assert.deepEqual(await order('B'), ['n3', 'n1', 'n2'], 'another tenant is unaffected')
  for (const r of await listFeedback(db, 'A')) await resetFeedback(db, 'A', r.id, 'start over')
  assert.deepEqual(await order('A'), ['n3', 'n1', 'n2'], 'reset: back to the original order')
  assert.deepEqual(learnedPreference([{ host: 'good.example', signal_kind: 'hiring', accepted: 3, rejected: 0, by_reason: {} }], now[1]).delta, 0, 'calibration is per signal kind')
})

bothEngines('learned preferences are proposed, never applied by themselves; a proposal applies only while memory and feedback are unchanged', async ({ db }) => {
  await seed(db, 'A', [{ id: 'l1', company: 'Rival Labs', domain: 'rival.example' }, { id: 'l2', company: 'Old Client Co' }, { id: 'l3', company: 'Fernhill' }])
  await rejectLead(db, 'A', 'l1', { reason: 'competitor' }); await rejectLead(db, 'A', 'l2', { reason: 'existing_relationship' }); await rejectLead(db, 'A', 'l3', { reason: 'wrong_industry' })
  const p = await proposeProfile(db, 'A')
  assert.deepEqual([p.add_exclusions, p.feedback_version], [['Old Client Co', 'rival.example'], 3], 'wrong industry is not turned into a name exclusion; a known domain is used')
  assert.equal(await readMemory(db, 'A'), null, 'nothing applied by itself')
  await writeMemory(db, 'A', { icp: 'x', exclusions: ['Someone'] })
  await assert.rejects(applyProposal(db, 'A', p), (e: unknown) => e instanceof FeedbackError && e.code === 'stale_proposal')
  const fresh = await proposeProfile(db, 'A')
  await recordFeedback(db, 'A', 'l3', { verdict: 'accept' })
  await assert.rejects(applyProposal(db, 'A', fresh), /changed since/, 'a newer verdict makes it stale too')
  assert.deepEqual((await applyProposal(db, 'A', await proposeProfile(db, 'A'))).exclusions, ['Someone', 'Old Client Co', 'rival.example'])
  assert.deepEqual((await proposeProfile(db, 'A')).add_exclusions, [])
})
