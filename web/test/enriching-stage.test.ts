// The enriching stage: rows are written (job row 'done') but contacts, people and the fit gate are still being added. Clients must see
// 'enriching' until that ends.
// All pages, hits and model replies are INVENTED and stubbed; nothing leaves the process.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { runFixture, daysAgo, type Fixture } from './helpers/acceptance-harness.ts'
import { enrichState, effectiveStatus, beginEnrichment, endEnrichment, ENRICH_STALE_S } from '../lib/scan/enrichment.ts'
import { migrateScan, createQueryJob, listJobs, getJob, countActiveJobs } from '../lib/scan/store.ts'

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

test('status route, jobs route and the leads page use the effective status', async () => {
  const fs = await import('node:fs'); const rd = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  assert.match(rd('../app/api/scan/status/route.ts'), /status: effectiveStatus\(job\)/); assert.match(rd('../app/api/scan/status/route.ts'), /enrichment: \{ state: enrichState\(job\)/)
  // The jobs route serves historyJobs (lib/scan/history-jobs.ts), which maps the effective status (behaviour: test/history-jobs.test.ts).
  assert.match(rd('../app/api/scan/jobs/route.ts'), /historyJobs\(/); assert.match(rd('../lib/scan/history-jobs.ts'), /status: effectiveStatus\(j\)/)
  const ui = rd('../app/app/leads/leads-client.tsx')
  assert.match(ui, /status === 'enriching'/); assert.match(ui, /The scan is not done until this ends/)
})

test('countActiveJobs: a scan that is pending, running or enriching is active; done, failed and a stale enrichment mark are not', () => {
  const db = new Database(':memory:'); migrateScan(db)
  const id = createQueryJob(db, 'A', { query: 'q', icp: '{}' })
  assert.equal(countActiveJobs(db, 'A'), 1, 'pending')
  db.prepare("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?").run(id); assert.equal(countActiveJobs(db, 'A'), 1, 'running')
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ?").run(id); assert.equal(countActiveJobs(db, 'A'), 0, 'done without an enrichment stage')
  beginEnrichment(db, id, 1); assert.equal(countActiveJobs(db, 'A'), 1, 'enriching is active'); assert.equal(countActiveJobs(db, 'B'), 0, 'another tenant is unaffected')
  endEnrichment(db, id, 1); assert.equal(countActiveJobs(db, 'A'), 0, 'finished')
  db.prepare("UPDATE scan_jobs SET enrich_started_at = CAST(strftime('%s','now') AS INTEGER) - ?, enrich_finished_at = NULL WHERE id = ?").run(ENRICH_STALE_S + 5, id)
  assert.equal(countActiveJobs(db, 'A'), 0, 'a crashed enrichment does not block forever')
})
test('the Find leads button is disabled while the scan runs or enriches, with a reason (string check; the rendered check is test/ui/scan-active.ui.mjs)', async () => {
  const fs = await import('node:fs'); const ui = fs.readFileSync(new URL('../app/app/leads/leads-client.tsx', import.meta.url), 'utf8')
  assert.match(ui, /status === 'pending' \|\| status === 'running' \|\| status === 'enriching'\)/); assert.match(ui, /disabled=\{busy \|\| starting \|\| scanActive\}/); assert.match(ui, /data-reason="scan-active"/)
})
