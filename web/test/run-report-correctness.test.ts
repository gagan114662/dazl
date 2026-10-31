// Run-report correctness (Instinct's #224 findings): every terminal decision is its own entry, usage comes from the canonical ledger,
// unobserved stages are null not zero, and the table has a retention. Real verifyLeads + buildRunReport / real runJob; all calls stubbed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { verifyLeads, type VerifiedLead } from '../lib/scan/runner.ts'
import { dedupKey } from '../lib/scan/evidence.ts'
import { buildRunReport, writeRunReport, runReportFor, RUN_REPORT_RETENTION_DAYS, type CandidateAudit } from '../lib/scan/run-report.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'

const TXT = (q: string) => `On ${daysAgo(5)}, ${q}. ${'The practice serves families in Manhattan every week. '.repeat(8)}`
const mk = (company: string, url: string, q = `${company} opened a second Manhattan dental office this month`) => ({ name: '', company, contact: null as string | null, signal: 's', source_url: url, score: 70, excerpt: q, event_date: daysAgo(5) })
const pageFor = (map: Record<string, string>) => async (u: string) => ({ text: TXT(map[u]), title: 'Dental news', retrievedAt: 1 })
async function report(cands: ReturnType<typeof mk>[], map: Record<string, string>, judge?: (c: unknown, p: string) => Promise<'supports' | 'contradicts' | 'unclear' | 'unavailable'>) {
  const audit: CandidateAudit[] = []
  const out = await verifyLeads(cands, pageFor(map), new Date(), judge as never, null, undefined, audit)
  const rep = buildRunReport({ audit, search: { attempted: 1, ok: 1, hits_raw: 1, hits_unique_urls: 1, hits_complete: true }, extracted_candidates: cands.length, dropCounts: out.dropped }, out.leads.map(l => ({ key: `${dedupKey(l)}|${l.source_url}` })), out.review.map(r => ({ key: `${dedupKey(r)}|${r.source_url}`, review_reason: r.review_reason })), 1)
  return { out, rep }
}
test('two identical valid candidates: one verified, one dropped as a duplicate - the report funnel equals the real outcome', async () => {
  const c = mk('Smile Studio', 'https://a.example/1'); const map = { 'https://a.example/1': c.excerpt }
  const { out, rep } = await report([c, { ...c }], map)
  assert.equal(out.leads.length, 1); assert.equal(out.dropped.duplicate, 1)
  assert.deepEqual([rep.funnel.verified, rep.funnel.dropped, rep.funnel.drop_reasons.duplicate], [1, 1, 1]); assert.equal(rep.candidates.filter((x: { fate: string }) => x.fate === 'verified').length, 1)
})
test('a duplicate of a company that survives elsewhere is not relabelled: the better-confidence occurrence wins, the other is the duplicate', async () => {
  const a = mk('Smile Studio', 'https://a.example/1'), b = { ...mk('Smile Studio', 'https://b.example/2'), contact: 'info@smile.example' }
  const { out, rep } = await report([a, b], { 'https://a.example/1': a.excerpt, 'https://b.example/2': b.excerpt })
  assert.equal(out.leads.length, 1); assert.equal(rep.funnel.verified, 1); assert.equal(rep.funnel.drop_reasons.duplicate, 1)
  const fates = rep.candidates.map((x: { url: string; fate: string }) => [x.url, x.fate]); assert.equal(fates.filter(f => f[1] === 'verified').length, 1)
})
test('a judge that contradicts the quote is reported as dropped:contradicted', async () => {
  const c = mk('Smile Studio', 'https://a.example/1')
  const { out, rep } = await report([c], { 'https://a.example/1': c.excerpt }, async () => 'contradicts')
  assert.equal(out.dropped.contradicted, 1); assert.equal(rep.candidates[0].fate, 'dropped:contradicted'); assert.equal(rep.funnel.drop_reasons.contradicted, 1)
})
test('the per-source cap is attributed to the capped candidate (not a generic duplicate/cap bucket)', async () => {
  const cs = ['Alpha Dental', 'Beta Dental', 'Gamma Dental', 'Delta Dental'].map(n => mk(n, 'https://list.example/top'))
  const { out, rep } = await report(cs, { 'https://list.example/top': cs.map(c => c.excerpt).join('. ') })
  assert.equal(out.leads.length, 3); assert.equal(out.dropped.source_cap, 1)
  assert.equal(rep.funnel.verified, 3); assert.equal(rep.funnel.drop_reasons.source_cap, 1); assert.ok(rep.candidates.some((x: { fate: string }) => x.fate === 'dropped:source_cap'))
})
const NYC = 'Find independent dental practices in New York City that opened a new location in the past 90 days.'
const icp = { summary: 's', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en' }
const base = (cands: Cand[], pages: Record<string, string>): Fixture => ({ request: NYC, modelIcp: icp, modelQueries: ['dental office opens Manhattan'], hits: Object.keys(pages).map(u => ({ url: u, title: 't', snippet: pages[u], date: daysAgo(5) })), tfPages: {}, own: Object.fromEntries(Object.entries(pages).map(([u, q]) => [u, { title: 'Dental news', text: TXT(q) }])), extraction: cands })
test('memory exclusions: the excluded candidate is reported dropped:excluded and the funnel matches the stored job', async () => {
  const q1 = 'Alpha Dental opened a second Manhattan dental office this month', q2 = 'Beta Dental opened a second Manhattan dental office this month'
  const x = await runFixture({ ...base([{ company: 'Alpha Dental', signal: 's', source_url: 'https://a.example/1', excerpt: q1, event_date: daysAgo(5) }, { company: 'Beta Dental', signal: 's', source_url: 'https://b.example/2', excerpt: q2, event_date: daysAgo(5) }], { 'https://a.example/1': q1, 'https://b.example/2': q2 }), deps: { memory: { icp: '', positioning: '', tone: '', exclusions: ['Beta Dental'], objections: [], updated_at: 0 } } })
  const fates = Object.fromEntries(x.report!.candidates.map((c: { company: string; fate: string }) => [c.company, c.fate]))
  assert.equal(fates['Alpha Dental'], 'verified'); assert.equal(fates['Beta Dental'], 'dropped:excluded')
  assert.equal(x.report!.funnel.verified, x.job.verified); assert.equal(x.report!.funnel.dropped, 1)
})
test('login-wall holds are audited too (they are added outside the verifier)', async () => {
  const q = 'Anyone know the new dental office on 5th Ave is hiring a front desk receptionist in Manhattan'
  const fb = 'https://www.facebook.com/groups/nycdental/posts/1'
  const f = base([{ company: 'Fifth Avenue Dental', signal: 's', source_url: fb, excerpt: q, event_date: null }], { [fb]: q }); f.own = { [fb]: 'blocked' }
  const x = await runFixture(f)
  assert.ok(x.report!.candidates.some((c: { company: string; fate: string }) => c.company === 'Fifth Avenue Dental' && /^review:/.test(c.fate)), JSON.stringify(x.report!.candidates))
})
test('model usage in the report is the canonical whole-attempt total, with its completeness: TinyFish finds nothing, the provider research fallback runs', async () => {
  const f = base([], {}); f.hits = []
  const x = await runFixture(f)
  assert.ok(x.usage.requests_recorded >= 2, 'the query call and the research fallback')
  assert.equal(x.report!.model.requests_recorded, x.usage.requests_recorded); assert.equal(x.report!.model.tokens_complete, x.usage.tokens_complete); assert.equal(x.report!.model.tokens_complete, false, 'research reports no tokens: never presented as complete')
  assert.ok(x.report!.coverage.some((c: string) => /Never a bill/.test(c)) && x.report!.coverage.some((c: string) => /TinyFish search hits only/.test(c)))
})
test('a stage that never ran is null, not zero', () => {
  const rep = buildRunReport({}, null, null, 1)
  assert.deepEqual(rep.observed, { search: false, extraction: false, verification: false }); assert.equal(rep.funnel.verified, null); assert.equal(rep.funnel.candidates, null); assert.equal(rep.search, null)
})
test('retention: a report older than the retention is deleted the next time any report is written', () => {
  const db = new Database(':memory:'); migrateScan(db)
  const j1 = createJob(db, 'A', { business_name: 'a', industry: 'x', location: 'y' }), j2 = createJob(db, 'A', { business_name: 'b', industry: 'x', location: 'y' })
  assert.equal(writeRunReport(db, j1, 1, { v: 1 }), true)
  db.prepare('UPDATE scan_run_report SET created_at = ? WHERE job_id = ?').run(Math.floor(Date.now() / 1000) - (RUN_REPORT_RETENTION_DAYS + 1) * 86_400, j1)
  assert.equal(writeRunReport(db, j2, 1, { v: 1 }), true)
  assert.equal(runReportFor(db, 'A', j1), null, 'expired'); assert.ok(runReportFor(db, 'A', j2))
})
