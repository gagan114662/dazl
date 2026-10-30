// Structured lead feedback (lib/scan/feedback.ts, #385): reasoned rejections at account / person / event level, applied to
// later runs, explainable and reversible, tenant-isolated; learned preferences reported apart from rules. Stubbed pages
// only (the real runJob through the acceptance harness); every company, person and address is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { sqliteDb, type Db } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { migrateFeedback } from '../lib/scan/feedback-tables.ts'
import { activeRejections, applyProposal, applyRejections, explainEntity, FeedbackError, listFeedback, proposeProfile, recordFeedback, resetFeedback, sourceYield } from '../lib/scan/feedback.ts'
import { referenceCohort } from '../lib/scan/lookalike.ts'
import { readMemory, writeMemory } from '../lib/memory.ts'

const seed = async (db: Db, t: string, leads: { id: string; company: string; domain?: string; name?: string; contact?: string; event_date?: string; url?: string }[]) => {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [`job-${t}`, t])
  for (const l of leads) await db.run('INSERT INTO leads (id, scan_job_id, company, company_domain, name, contact, signal, source_url, evidence_excerpt, event_date, confidence) VALUES (?, ?, ?, ?, ?, ?, \'s\', ?, \'q\', ?, 80)', [l.id, `job-${t}`, l.company, l.domain ?? null, l.name ?? '', l.contact ?? null, l.url ?? 'https://news.example/a', l.event_date ?? null])
}

bothEngines('recorded at its level, tenant-isolated, explainable and reversible', async ({ db }) => {
  await seed(db, 'A', [{ id: 'a1', company: 'Rival Labs Ltd', domain: 'rival.example' }, { id: 'a2', company: 'Querix', name: 'Pat Doe', contact: 'pat@querix.example' }, { id: 'a3', company: 'Fernhill', event_date: '2026-09-01' }])
  await seed(db, 'B', [{ id: 'b1', company: 'Rival Labs Ltd' }])
  const r1 = await recordFeedback(db, 'A', { lead_id: 'a1', verdict: 'reject', reason: 'competitor', note: 'our competitor' })
  const r2 = await recordFeedback(db, 'A', { lead_id: 'a2', verdict: 'reject', reason: 'wrong_person' })
  const r3 = await recordFeedback(db, 'A', { lead_id: 'a3', verdict: 'reject', reason: 'wrong_timing' })
  assert.deepEqual([r1.level, r1.company_key, r1.domain, r2.level, r2.person_key, r3.level, r3.event_date], ['account', 'rival labs', 'rival.example', 'person', 'pat@querix.example', 'event', '2026-09-01'])
  // another tenant's lead is unknown here, and B sees none of A's feedback
  await assert.rejects(recordFeedback(db, 'B', { lead_id: 'a1', verdict: 'reject', reason: 'competitor' }), /no such lead/)
  assert.deepEqual(await listFeedback(db, 'B'), [])
  assert.deepEqual((await activeRejections(db, 'B')).account, [])
  // validation: a reason is required and must fit the lead
  await assert.rejects(recordFeedback(db, 'A', { lead_id: 'a1', verdict: 'reject' }), (e: unknown) => e instanceof FeedbackError)
  await assert.rejects(recordFeedback(db, 'A', { lead_id: 'a1', verdict: 'reject', reason: 'wrong_person' }), /needs a named person/)
  await assert.rejects(recordFeedback(db, 'A', { lead_id: 'a1', verdict: 'reject', reason: 'wrong_timing' }), /needs a dated event/)
  // explain and reset
  assert.deepEqual((await explainEntity(db, 'A', 'Rival Labs')).map(r => r.reason), ['competitor'])
  assert.equal(await resetFeedback(db, 'B', r1.id, 'not mine'), false)                 // another tenant cannot reset it
  assert.equal(await resetFeedback(db, 'A', r1.id, 'they became a partner'), true)
  assert.equal(await resetFeedback(db, 'A', r1.id, 'twice'), false)
  assert.deepEqual((await activeRejections(db, 'A')).account, [])
  assert.equal((await listFeedback(db, 'A')).find(r => r.id === r1.id)!.reset_reason, 'they became a partner')
})

test('applyRejections: account drops, a rejected person is stripped (company stays), only the same or an older event is dropped', () => {
  const rj = { account: [{ id: 'f1', reason: 'wrong_industry', company_key: 'rival labs', domain: 'rival.example' }], person: [{ id: 'f2', reason: 'wrong_person', company_key: 'querix', domain: null, person_key: 'pat@querix.example' }], event: [{ id: 'f3', reason: 'wrong_timing', company_key: 'fernhill', domain: null, event_date: '2026-09-01' }] } as never
  const c = (company: string, over: Record<string, unknown> = {}) => ({ company, name: '', contact: null as string | null, event_date: null as string | null, source_url: `https://news.example/${company}`, ...over })
  const r = applyRejections([c('Rival Labs Inc'), c('Other', { company_domain: 'www.rival.example'.replace('www.', '') }), c('Querix', { name: 'Pat Doe', contact: 'pat@querix.example' }), c('Querix', { name: 'Sam Roe', contact: 'sam@querix.example' }), c('Fernhill', { event_date: '2026-09-01' }), c('Fernhill', { event_date: '2026-08-01' }), c('Fernhill', { event_date: '2026-10-10' }), c('Fernhill'), c('Unrelated')], rj)
  assert.deepEqual(r.dropped.map(d => [d.company, d.reason]), [['Rival Labs Inc', 'wrong_industry'], ['Other', 'wrong_industry'], ['Fernhill', 'wrong_timing'], ['Fernhill', 'wrong_timing'], ['Fernhill', 'wrong_timing']])
  assert.deepEqual(r.kept.map(k => [k.company, k.name, k.contact, k.event_date]), [['Querix', '', null, null], ['Querix', 'Sam Roe', 'sam@querix.example', null], ['Fernhill', '', null, '2026-10-10'], ['Unrelated', '', null, null]])
  assert.deepEqual(r.persons_removed.map(p => p.feedback_id), ['f2'])
})

// ---- through the real runJob: reject in one play, the next run does not bring it back ----
const QUOTE = (co: string) => `${co}, a London B2B SaaS startup, raised a 3m GBP seed round`
const PAGE = (co: string) => ({ title: `${co} raises seed`, text: `Published ${daysAgo(12)}. ${QUOTE(co)}. ${'More about the company and its people. '.repeat(15)}` })
const play = (cos: string[], rejectWith?: (db: Database.Database) => void): Fixture => ({
  request: 'Find London B2B SaaS startups that raised a seed round in the past 90 days',
  modelIcp: { summary: 'London seed-funded B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['raised a seed round'], exclude: [], country: 'GB', language: 'en', window_days: 90 }, modelQueries: ['London SaaS seed round'],
  hits: cos.map(co => ({ url: `https://news.example/${co.toLowerCase()}`, title: PAGE(co).title, snippet: QUOTE(co), date: daysAgo(12) })),
  tfPages: Object.fromEntries(cos.map(co => [`https://news.example/${co.toLowerCase()}`, PAGE(co)])), own: Object.fromEntries(cos.map(co => [`https://news.example/${co.toLowerCase()}`, PAGE(co)])),
  extraction: cos.map(co => ({ company: co, signal: 'raised a seed round', source_url: `https://news.example/${co.toLowerCase()}`, excerpt: QUOTE(co), event_date: daysAgo(12) })),
  ...(rejectWith ? { beforeRun: rejectWith } : {}),
})

test('a company rejected in an earlier play is not reintroduced by a later run; the run report says why; a reset brings it back', async () => {
  const first = await runFixture(play(['Brightloop', 'Querix']))
  assert.equal((first.db.prepare("SELECT count(*) AS n FROM leads WHERE review_reason IS NULL").get() as { n: number }).n, 2)
  // the same tenant rejected Brightloop (wrong industry) in that play; the next run starts with that feedback in its store
  let fid = ''
  const reject = (db: Database.Database) => { migrateFeedback(db); fid = 'fb-1'; db.prepare("INSERT INTO lead_feedback (id, tenant_id, verdict, level, reason, company_key, created_at) VALUES ('fb-1', 'A', 'reject', 'account', 'wrong_industry', 'brightloop', 1)").run() }
  const second = await runFixture(play(['Brightloop', 'Querix'], reject))
  assert.deepEqual((second.db.prepare('SELECT company FROM leads ORDER BY company').all() as { company: string }[]).map(r => r.company), ['Querix'])
  const rep = JSON.parse((second.db.prepare('SELECT report FROM scan_run_report ORDER BY attempt DESC LIMIT 1').get() as { report: string }).report) as { candidates: { company: string; fate: string }[] }
  assert.match(rep.candidates.find(c => c.company === 'Brightloop')!.fate, new RegExp(`previously_rejected:wrong_industry:${fid}`))
  // reversed: after a reset the company can come back
  const third = await runFixture(play(['Brightloop', 'Querix'], db => { reject(db); db.prepare("UPDATE lead_feedback SET reset_at = 2, reset_reason = 'industry widened'").run() }))
  assert.deepEqual((third.db.prepare('SELECT company FROM leads ORDER BY company').all() as { company: string }[]).map(r => r.company), ['Brightloop', 'Querix'])
})

test('feedback steers ranking: a rejected lead never trains the lookalike cohort, nor does an opted-out contact', () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  raw.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES ('j', 'A', 'b', 'i', 'l', 'running')").run()
  for (const [id, contact] of [['good1', 'a@x1.example'], ['good2', 'a@x2.example'], ['rejected', 'a@x3.example'], ['optedout', 'a@x4.example']]) raw.prepare("INSERT INTO leads (id, scan_job_id, company, contact, signal, source_url, fit) VALUES (?, 'j', ?, ?, 'raised a seed round', 'https://n.example/', 5)").run(id, id, contact)
  raw.prepare("INSERT INTO lead_feedback (id, tenant_id, verdict, level, reason, company_key, lead_id, created_at) VALUES ('f', 'A', 'reject', 'account', 'not_useful', 'rejected', 'rejected', 1)").run()
  raw.prepare("INSERT INTO suppressions (tenant_id, email, reason, created_at) VALUES ('A', 'a@x4.example', 'unsubscribe', 1)").run()
  assert.deepEqual(referenceCohort(raw, 'A', []).map(r => r.id).sort(), ['good1', 'good2'])
})

bothEngines('learned preferences are reported, not applied: source yield, and a versioned exclusion proposal applied only explicitly', async ({ db }) => {
  await seed(db, 'A', [{ id: 'l1', company: 'Rival Labs', url: 'https://listicle.example/1' }, { id: 'l2', company: 'Old Client Co', url: 'https://listicle.example/2' }, { id: 'l3', company: 'Querix', url: 'https://news.example/q' }, { id: 'l4', company: 'Fernhill', url: 'https://listicle.example/3' }])
  await recordFeedback(db, 'A', { lead_id: 'l1', verdict: 'reject', reason: 'competitor' })
  await recordFeedback(db, 'A', { lead_id: 'l2', verdict: 'reject', reason: 'existing_relationship' })
  await recordFeedback(db, 'A', { lead_id: 'l4', verdict: 'reject', reason: 'wrong_industry' })
  await recordFeedback(db, 'A', { lead_id: 'l3', verdict: 'accept' })
  assert.deepEqual(await sourceYield(db, 'A'), [{ host: 'listicle.example', accepted: 0, rejected: 3, by_reason: { competitor: 1, existing_relationship: 1, wrong_industry: 1 } }, { host: 'news.example', accepted: 1, rejected: 0, by_reason: {} }])
  const p = await proposeProfile(db, 'A')
  assert.deepEqual(p.add_exclusions, ['Old Client Co', 'Rival Labs'])           // wrong industry is not turned into a name exclusion
  assert.equal(await readMemory(db, 'A'), null)                                 // nothing applied by itself
  await writeMemory(db, 'A', { icp: 'x', positioning: '', tone: '', exclusions: [], objections: [] })
  await assert.rejects(applyProposal(db, 'A', p), /memory changed since this proposal/) // versioned: a stale proposal is refused
  const fresh = await proposeProfile(db, 'A')
  assert.deepEqual((await applyProposal(db, 'A', fresh)).exclusions, ['Old Client Co', 'Rival Labs'])
  assert.deepEqual((await proposeProfile(db, 'A')).add_exclusions, [])
})
