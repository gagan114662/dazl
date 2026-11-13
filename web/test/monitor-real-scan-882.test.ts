// #882 / #759: a monitor run whose leads come from the REAL scan pipeline (runJob with stubbed search, model and HTTP; no network).
// Before the fix the detector kept a lead only when date_status = 'verified', a value the scanner stopped writing on 2026-10-23, so
// no real scan could raise an alert; every older monitor test passed because it inserted 'verified' rows by hand.
// The posting is the real staging lead of 2026-11-13 (job 13808d9c..., lead 0c11163f...): Flexport, Greenhouse posting 8383190, with its
// signal and quote as stored and the board's real record. Only the publish day moves with the clock.
// The REQUEST is not the real one ("B2B software companies hiring account executives"): that request adds the sales-hiring gate, which the
// real run passed through the website crawl and a board lookup this harness does not run. The request here asks for a posted job without
// naming a sales role, so the scan's own verdict stands. The real rows of that staging scan, gate verdicts included, are replayed
// through the detector in test/monitor-events.test.ts ("#882 real staging scan").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import type Database from 'better-sqlite3'
import { fetchPageDetailed, resetBoardMemo } from '../lib/scan/fetch-page.ts'
import { runFixture, daysAgo } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateMonitors, createMonitor, collectMonitorResults } from '../lib/monitors.ts'
import { detectionReport } from '../lib/monitor-events.ts'
import { ENRICH_STALE_S } from '../lib/scan/enrichment.ts'

const REQUEST = 'Find logistics and supply chain software companies that posted a new job in the past 90 days.'
const GH = 'https://job-boards.greenhouse.io/flexport/jobs/8383190'
const SIGNAL = 'Flexport is hiring an Account Executive for Enterprise'
const QUOTE = 'The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals'
const ICP = { summary: 'Logistics and supply chain software companies with a new job posting', who: ['Operations leader'], industries: ['Logistics software', 'Supply chain software'], sizes: [], where: [], signals: ['posted a new job'], exclude: [], country: 'US', language: 'en' }
const nowS = () => Math.floor(Date.now() / 1000)

// The public Greenhouse record of that posting, read 2026-11-13 from boards-api.greenhouse.io/v1/boards/flexport/jobs/8383190: its real
// title, company_name, location and the paragraph the quote was cut from (content is entity-escaped HTML, as Greenhouse serves it).
// The record's real first_published was 2026-11-12T12:34:11-05:00; here it is `published` at the same time of day.
const record = (published: string) => ({
  absolute_url: GH, id: 8383190, internal_job_id: 3618280, requisition_id: 'P-12539', title: 'Account Executive, Enterprise ', company_name: 'Flexport', language: 'en',
  location: { name: 'London, England' }, first_published: `${published}T12:34:11-05:00`, updated_at: `${published}T12:34:11-05:00`,
  departments: [{ id: 12334, name: 'Sales' }], offices: [{ id: 67638, name: 'London', location: 'London, England' }],
  content: '&lt;p&gt;Ready to tackle global challenges that impact business, society, and the environment? Come join us.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;The opportunity:&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals and establishing long-term strategic partnerships with large customers. This role owns advanced, multi-stakeholder sales cycles that often span regions, business units, and decision layers. The ENT AE operates with a high degree of autonomy, shaping deal strategy, influencing executive stakeholders, and orchestrating cross-functional teams to deliver differentiated, value-driven solutions.&lt;/p&gt;',
})
// The socket is faked (no network); the page read itself is the real one (lib/scan/fetch-page.ts reads a posting through its board's record).
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => { const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} }); cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end') }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}

// One monitor run: the monitor's job is the scan the harness runs. `published`: the board's own first-published day of the posting.
async function monitorScan(published: string) {
  let monitorId = ''
  const restore = fakeHttps(u => u.startsWith('https://boards-api.greenhouse.io/v1/boards/flexport/jobs/8383190') ? { status: 200, type: 'application/json', body: JSON.stringify(record(published)) } : { status: 404, type: 'text/html', body: '' })
  try {
    const x = await runFixture({
      request: REQUEST, reviewedIcp: ICP, icpReviewed: true, modelIcp: ICP, modelQueries: ['logistics software company job posting'],
      hits: [{ url: GH, title: 'Account Executive, Enterprise - Flexport', snippet: QUOTE, date: null }],
      tfPages: {}, own: {},
      extraction: [{ company: 'Flexport', signal: SIGNAL, source_url: GH, excerpt: QUOTE, event_date: null }],
      // the REAL page read (the harness's canned pages are not used); the job feeds answer nothing
      deps: { fetchPage: (u: string) => fetchPageDetailed(u, async () => null), sourceHttp: (async () => null) as SafeGet },
      // what runDueMonitors does when a monitor is due: the monitor's run record points at the job the scan then runs
      beforeRun: async (db: Database.Database) => {
        migrateMonitors(db)
        const m = await createMonitor(sqliteDb(db), 'A', { query: REQUEST })
        assert.ok('id' in m); monitorId = m.id
        const job = (db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
        db.prepare('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at) VALUES (?, ?, ?, ?)').run(randomBytes(12).toString('hex'), monitorId, job, nowS())
      },
    })
    return { ...x, monitorId }
  } finally { restore() }
}
const leadRows = (db: Database.Database) => db.prepare('SELECT company, signal, signal_kind, event_date, date_status, event_date_proof, review_reason, confidence FROM leads').all() as
  { company: string; signal: string; signal_kind: string | null; event_date: string | null; date_status: string | null; event_date_proof: string | null; review_reason: string | null; confidence: number | null }[]

test('#882 #759 a real scan\'s board-dated hiring lead raises one new_company alert, with its event times and source cursor; the same event again raises nothing', async () => {
  const published = daysAgo(1)
  const x = await monitorScan(published)
  const rows = leadRows(x.db)
  // what the real pipeline stored: a ready lead whose day is proven by the board, and NOT date_status 'verified'
  assert.equal(rows.length, 1, JSON.stringify({ job: x.job, rows }))
  assert.deepEqual([rows[0].company, rows[0].event_date, rows[0].event_date_proof, rows[0].review_reason], ['Flexport', published, 'ats_structured', null], JSON.stringify(rows[0]))
  assert.notEqual(rows[0].date_status, 'verified')
  assert.notEqual(rows[0].confidence, null)

  const db = sqliteDb(x.db)
  const foldAt = nowS() + ENRICH_STALE_S + 60
  assert.equal(await collectMonitorResults(db, { now: foldAt }), 1, 'the run raised alerts')
  const run = x.db.prepare('SELECT id, new_count, processed FROM monitor_runs').get() as { id: string; new_count: number; processed: number }
  assert.deepEqual([run.new_count, run.processed], [1, 1])
  const alerts = x.db.prepare('SELECT kind, company, event_key, latency_s FROM monitor_alerts').all() as { kind: string; company: string; event_key: string; latency_s: number }[]
  assert.equal(alerts.length, 1)
  assert.deepEqual([alerts[0].kind, alerts[0].company], ['new_company', 'Flexport'])
  const occurred = Date.parse(`${published}T00:00:00Z`) / 1000
  assert.equal(alerts[0].latency_s, foldAt - occurred)
  // #759: the event's three times and the per-source cursor
  const ev = x.db.prepare('SELECT event_key, occurred_at, first_seen_at, last_checked_at, actionable_at FROM monitor_events').all() as { event_key: string; occurred_at: number; first_seen_at: number; last_checked_at: number; actionable_at: number | null }[]
  assert.equal(ev.length, 1)
  assert.deepEqual([ev[0].occurred_at, ev[0].first_seen_at, ev[0].last_checked_at, ev[0].actionable_at], [occurred, foldAt, foldAt, foldAt])
  assert.ok(ev[0].event_key.endsWith(`|${published}|signal`) || ev[0].event_key.includes(`|${published}|`), ev[0].event_key)
  const cursors = x.db.prepare('SELECT source, last_event_at, last_checked_at FROM monitor_cursors').all()
  assert.deepEqual(cursors, [{ source: 'job-boards.greenhouse.io', last_event_at: occurred, last_checked_at: foldAt }])
  const rep = await detectionReport(db, 'A', x.monitorId, 90)
  assert.deepEqual([rep.alerts, rep.by_kind.new_company, rep.latency.median_s, rep.sources.length], [1, 1, foldAt - occurred, 1])

  // the next run returns the same posting: checked again, not alerted again
  const job = (x.db.prepare('SELECT id FROM scan_jobs').get() as { id: string }).id
  x.db.prepare('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at) VALUES (?, ?, ?, ?)').run(randomBytes(12).toString('hex'), x.monitorId, job, foldAt + 3600)
  assert.equal(await collectMonitorResults(db, { now: foldAt + 7200 }), 0)
  assert.equal((x.db.prepare('SELECT count(*) AS n FROM monitor_alerts').get() as { n: number }).n, 1)
  const again = x.db.prepare('SELECT first_seen_at, last_checked_at FROM monitor_events').get() as { first_seen_at: number; last_checked_at: number }
  assert.deepEqual([again.first_seen_at, again.last_checked_at], [foldAt, foldAt + 7200])
  assert.deepEqual((x.db.prepare('SELECT new_count FROM monitor_runs ORDER BY ran_at').all() as { new_count: number }[]).map(r => r.new_count), [1, 0])
})

test('#882 a real scan\'s posting published outside the play\'s window is stored by the scan but raises no alert and no event', async () => {
  const x = await monitorScan(daysAgo(200))
  assert.equal(await collectMonitorResults(sqliteDb(x.db), { now: nowS() + ENRICH_STALE_S + 60 }), 0)
  assert.equal((x.db.prepare('SELECT count(*) AS n FROM monitor_events').get() as { n: number }).n, 0)
  assert.equal((x.db.prepare('SELECT new_count FROM monitor_runs').get() as { new_count: number }).new_count, 0)
})
