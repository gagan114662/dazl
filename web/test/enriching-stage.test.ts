// The enriching stage: rows are written (job row 'done') but contacts, people and the fit gate are still being added. Clients must see
// 'enriching' until that ends, and a failed / fully rejected / zero-match scan must stay a different outcome from a pending one.
// All pages, hits and model replies are INVENTED and stubbed; nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { enrichState, effectiveStatus, beginEnrichment, endEnrichment, ENRICH_STALE_S } from '../lib/scan/enrichment.ts'
import { scanOutcome } from '../lib/scan/outcome.ts'
import { migrateScan, createQueryJob, listJobs, getJob } from '../lib/scan/store.ts'

const REQUEST = 'Find independent dental practices in New York City that opened a new location in the past 90 days.'
const ICP = { summary: 'NYC dental practices', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['opened a new location'], exclude: [], country: 'US', language: 'en' }
const Q = 'BrightSmile Dental opened its second location on Court Street in Brooklyn this month'
const pad = (s: string) => `${s} ${'The practice serves families across the borough and welcomes new patients every week. '.repeat(6)}`
const URL1 = 'https://news.example/brightsmile-opens'
const fx = (over: Partial<Fixture> = {}): Fixture => ({
  request: REQUEST, modelIcp: ICP, modelQueries: ['dental practice opens new location New York City'],
  hits: [{ url: URL1, title: 'BrightSmile Dental opens in Brooklyn', snippet: Q, date: daysAgo(20) }],
  tfPages: { [URL1]: { title: 'BrightSmile Dental opens in Brooklyn', text: pad(`Published ${daysAgo(20)}. ${Q}.`) } },
  own: { [URL1]: { title: 'BrightSmile Dental opens in Brooklyn', text: pad(`Published ${daysAgo(20)}. ${Q}.`) } },
  extraction: [{ company: 'BrightSmile Dental', signal: 'opened a second location', source_url: URL1, excerpt: Q, event_date: daysAgo(20) }],
  ...over,
})

test('enrichState / effectiveStatus: only a done job whose stage started and has not ended reads "enriching"; a crashed stage is "interrupted", never forever', () => {
  const now = 1_000_000
  assert.equal(enrichState({ status: 'done' }, now), 'none'); assert.equal(effectiveStatus({ status: 'done' }, now), 'done')
  assert.equal(enrichState({ status: 'done', enrich_started_at: now - 5 }, now), 'running'); assert.equal(effectiveStatus({ status: 'done', enrich_started_at: now - 5 }, now), 'enriching')
  assert.equal(effectiveStatus({ status: 'done', enrich_started_at: now - 5, enrich_finished_at: now }, now), 'done')
  assert.equal(enrichState({ status: 'done', enrich_started_at: now - ENRICH_STALE_S - 1 }, now), 'interrupted'); assert.equal(effectiveStatus({ status: 'done', enrich_started_at: now - ENRICH_STALE_S - 1 }, now), 'done')
  for (const st of ['failed', 'running', 'pending']) assert.equal(effectiveStatus({ status: st, enrich_started_at: now - 5 }, now), st, `${st} is never rewritten`)
})

test('through the real runJob: the job reads "enriching" while the people-search / crawl stage runs and "done" only after; autopilot runs after the end mark', async () => {
  const seen: string[] = []; let dbRef: Database.Database | null = null; let jobId = ''
  const snap = (tag: string) => { if (!dbRef) return; const j = dbRef.prepare('SELECT status, enrich_started_at, enrich_finished_at FROM scan_jobs WHERE id = ?').get(jobId) as { status: string; enrich_started_at: number | null; enrich_finished_at: number | null }; seen.push(`${tag}:${effectiveStatus(j)}`) }
  const f = fx({
    onVerify: (db, id) => { dbRef = db; jobId = id; snap('verifying') },
    deps: {
      fetchImpl: (async (u: string, init?: RequestInit) => { if (u.includes('site%3Alinkedin.com%2Fin') || u.includes('site:linkedin.com/in')) snap('people'); return globalThis.fetch(u, init) }) as typeof fetch,
      crawlGet: async () => { snap('crawl'); throw new Error('no net in test') },
      autopilot: async () => { snap('autopilot') },
    },
  })
  const r = await runFixture(f)
  assert.equal(r.r, 'done'); assert.equal(r.job.status, 'done')
  assert.equal(seen[0], 'verifying:running', 'the scan itself is still running while verifying')
  assert.ok(seen.some(s => s.startsWith('crawl:') || s.startsWith('people:')), `the stage ran: ${seen.join(' ')}`)
  for (const s of seen.filter(x => x.startsWith('crawl:') || x.startsWith('people:'))) assert.match(s, /:enriching$/, 'enriching while contacts / people are being found')
  assert.deepEqual(seen.filter(x => x.startsWith('autopilot:')), ['autopilot:done'], 'done before autopilot starts')
  const row = r.db.prepare('SELECT status, enrich_started_at, enrich_finished_at FROM scan_jobs').get() as { status: string; enrich_started_at: number | null; enrich_finished_at: number | null }
  assert.ok(row.enrich_started_at && row.enrich_finished_at && row.enrich_finished_at >= row.enrich_started_at); assert.equal(effectiveStatus(row), 'done')
})

test('a post-finish step that throws still ends the stage: the page never waits on "enriching" for a crashed enrichment', async () => {
  const f = fx({ deps: { crawlGet: async () => { throw new Error('boom') }, autopilot: async () => { throw new Error('autopilot boom') } } })
  const r = await runFixture(f).catch(e => e)
  const db = (r as { db?: Database.Database }).db
  assert.ok(db, 'the scan returned despite the failing post-finish step')
  { const row = db.prepare('SELECT status, enrich_started_at, enrich_finished_at FROM scan_jobs').get() as { status: string; enrich_started_at: number | null; enrich_finished_at: number | null }; assert.ok(row.enrich_finished_at, 'end mark written'); assert.notEqual(effectiveStatus(row), 'enriching') }
})

test('history and status: begin/end are conditional on this attempt owning a done row', () => {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT, business_name TEXT)'); db.prepare('INSERT INTO users VALUES (?, ?)').run('A', 'Acme')
  createQueryJob(db, 'A', { query: 'q', icp: '{}' })
  const id = (db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id)
  beginEnrichment(db, id, 1); assert.equal(getJob(db, 'A', id)!.enrich_started_at, null, 'a running job is not enriching')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id)
  beginEnrichment(db, id, 2); assert.equal(getJob(db, 'A', id)!.enrich_started_at, null, 'another attempt does nothing')
  beginEnrichment(db, id, 1); assert.ok(getJob(db, 'A', id)!.enrich_started_at); assert.equal(effectiveStatus(listJobs(db, 'A')[0]), 'enriching')
  endEnrichment(db, id, 1); assert.equal(effectiveStatus(listJobs(db, 'A')[0]), 'done')
})

test('outcomes stay distinct, also while enriching: failed, all rejected and zero matches are never reported as pending or completed', () => {
  const rep = { searches_attempted: 4, searches_ok: 4, hits_unique_urls: 0, hits_complete: true, searches_failed: null, extracted: 0, review_reasons: {}, drop_reasons: {} } as never
  const now = 1_000_000, enr = { enrich_started_at: now - 5 }
  const failed = scanOutcome({ status: 'failed', error: 'key_rejected' }, null, now)
  const rejected = scanOutcome({ status: 'done', candidates: 3, verified: 0, needs_review: 1, dropped: 2 }, rep, now)
  const zero = scanOutcome({ status: 'failed', error: 'no_candidates', candidates: 0 }, rep, now)
  const searchFailed = scanOutcome({ status: 'failed', error: 'no_candidates', candidates: 0 }, { ...(rep as object), searches_ok: 1, hits_complete: false, searches_failed: { rate: 2 } } as never, now)
  assert.deepEqual([failed.kind, rejected.kind, zero.kind, searchFailed.kind], ['search_failed', 'all_rejected', 'no_matches', 'search_failed'])
  assert.notEqual(rejected.kind, zero.kind); assert.notEqual(failed.next_step, rejected.next_step)
  // enriching keeps what the result is so far
  const enrichingRejected = scanOutcome({ status: 'done', candidates: 3, verified: 0, needs_review: 1, dropped: 2, ...enr }, rep, now)
  assert.equal(enrichingRejected.kind, 'enriching'); assert.equal(enrichingRejected.then, 'all_rejected'); assert.match(enrichingRejected.detail, /none passed|3 candidates/)
  const enrichingOk = scanOutcome({ status: 'done', candidates: 2, verified: 1, needs_review: 1, ...enr }, null, now)
  assert.equal(enrichingOk.kind, 'enriching'); assert.equal(enrichingOk.then, 'completed')
  // a failed job is never "enriching", even with a stray stage mark
  assert.equal(scanOutcome({ status: 'failed', error: 'key_rejected', ...enr }, null, now).kind, 'search_failed')
})

test('status route, jobs route and the leads page use the effective status and keep the outcomes visible', async () => {
  const fs = await import('node:fs'); const rd = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(rd('../app/api/scan/status/route.ts'), /status: effectiveStatus\(job\)/); assert.match(rd('../app/api/scan/status/route.ts'), /enrichment: \{ state: enrichState\(job\)/)
  assert.match(rd('../app/api/scan/jobs/route.ts'), /status: effectiveStatus\(j\)/)
  const ui = rd('../app/app/leads/leads-client.tsx')
  assert.match(ui, /status === 'enriching'/); assert.match(ui, /The scan is not done until this ends/)
  assert.match(ui, /data-outcome=\{outcome\.kind\}/); assert.match(ui, /outcome\.kind === 'all_rejected' \|\| outcome\.kind === 'no_matches'/)
})
