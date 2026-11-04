// #389 acceptance contract (Instinct, 2026-11-03): the technology branch's outcome is always a named, recorded state —
// branch_never_ran, crawl_ran_no_observations (with the pages the crawl read), branch_error (never a silent zero), or
// disabled (the negative control: zero rows AND a ledger saying the branch did not run). Synthetic sites only, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawlJob, techBranch, TECH_AUDIT, techScanEnabled, type Get } from '../lib/connectors/sitecrawl.ts'
import { EnrichmentTrace, auditSummary, noteFromAudit, noteTech } from '../lib/scan/enrichment-trace.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, recentAudit } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'
import { crawlAuditCount } from '../lib/scan/job-feed.ts'

const FILLER = '<p>Brightloop is a design and web agency in Leeds. We build marketing sites, run brand workshops and help growing teams publish faster. Talk to us about your next launch, your content plan or your site migration.</p>'
const page = (scripts: string) => `<!doctype html><html><head><title>Brightloop</title>${scripts}</head><body>${FILLER}</body></html>`
const WF = '<script src="https://brightloop.com/js/webflow.js"></script>'
const AT = Date.parse('2026-10-01T12:00:00Z') / 1000

function fresh() { const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db); return db }
const ledger = (db: Database.Database) => db.prepare('SELECT tenant_id, scan_job_id, lookup, status, results FROM connector_audit WHERE connector = ? ORDER BY insert_seq').all(TECH_AUDIT) as { tenant_id: string; scan_job_id: string; lookup: string; status: string; results: number }[]
const techRows = (db: Database.Database) => (db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE kind IN ('tech_scan', 'tech_change')").get() as { n: number }).n

async function crawl(db: Database.Database, home: { status: number; body: string } | null, env: Record<string, string | undefined> = {}) {
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'news.example') return { status: 200, body: '<html><body><a href="https://brightloop.com">Brightloop</a> raised a seed round.</body></html>', finalUrl: url }
    if (u.hostname === 'brightloop.com' && u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
    if (u.hostname === 'brightloop.com' && u.pathname === '/' && home) return { ...home, finalUrl: url }
    return { status: 404, body: '', finalUrl: url }
  }
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', 'Brightloop', 'raised a seed round', 'https://news.example/a', 'Brightloop raised a seed round.', '2026-09-20', 80, 80, 5)").run(`l-${jobId}`, jobId)
  await crawlJob(db, 'u1', jobId, { get, gapMs: 0, env, now: AT * 1000 })
  return jobId
}
const stage = (db: Database.Database, jobId: string) => { const t = new EnrichmentTrace(); noteTech(t, auditSummary(db, 'u1', jobId, TECH_AUDIT)); return t.stages[0] }

test('through the crawl: an observed homepage writes its tech_scan row and one ledger row naming it; the run report stage is ok', async () => {
  const db = fresh()
  const jobId = await crawl(db, { status: 200, body: page(WF) })
  assert.equal(techRows(db), 1)
  const l = ledger(db)
  assert.equal(l.length, 1)
  assert.deepEqual([l[0].tenant_id, l[0].scan_job_id, l[0].lookup, l[0].results], ['u1', jobId, 'brightloop.com', 1])
  assert.match(l[0].status, /^observed ok: 1 technologies, 0 changes; pages \d+$/)
  const s = stage(db, jobId)
  assert.deepEqual([s.stage, s.status, s.detail], ['tech', 'ok', { sites: 1, observed: 1, no_observation: 0, errors: 0, disabled: 0 }])
})

test('negative control: TECH_SCAN_ENABLED=0 writes zero tech rows AND a ledger row saying the branch did not run', async () => {
  const db = fresh()
  const jobId = await crawl(db, { status: 200, body: page(WF) }, { TECH_SCAN_ENABLED: '0' })
  assert.equal(techRows(db), 0, 'no tech_scan / tech_change row from any path')
  assert.deepEqual(ledger(db).map(r => [r.status, r.results]), [['disabled', 0]])
  const s = stage(db, jobId)
  assert.deepEqual([s.status, s.reason], ['skipped', 'disabled: TECH_SCAN_ENABLED=0, the technology branch did not run'])
  // the old display path is unchanged and separate: the crawl itself still ran and audited under 'sitecrawl'
  assert.ok((db.prepare("SELECT count(*) AS n FROM connector_audit WHERE connector = 'sitecrawl'").get() as { n: number }).n >= 1)
  // only the exact '0' disables; anything else keeps the shipped default (on)
  for (const v of [undefined, '', '1', 'false', 'off', ' 0']) assert.equal(techScanEnabled({ TECH_SCAN_ENABLED: v }), true, String(v))
})

test('branch_never_ran: no confirmed site crawled means no ledger row, and the stage says so instead of zero', async () => {
  const db = fresh()
  const jobId = await crawl(db, null) // the homepage 404s: the site is never confirmed, so the branch never runs
  assert.deepEqual([ledger(db).length, techRows(db)], [0, 0])
  const s = stage(db, jobId)
  assert.deepEqual([s.status, s.reason], ['attempted_no_result', 'branch_never_ran: no confirmed company site was crawled in this run'])
})

test('crawl_ran_no_observations: the ledger names why and how many pages were read; an unreadable page is recorded, never a migration', () => {
  const db = fresh()
  techBranch(db, 'u1', 'j1', 'l1', 'brightloop.com', { tech: [], pages: 3 }, AT, {})
  techBranch(db, 'u1', 'j1', 'l1', 'localhost', { tech: [], homeObs: 'ok', pages: 2 }, AT, {})
  techBranch(db, 'u1', 'j1', 'l1', 'x'.repeat(130) + '.com', { tech: [], homeObs: 'ok', pages: 1 }, AT, {})
  assert.deepEqual(ledger(db).map(r => [r.status, r.results]), [
    ['no_observation: no homepage verdict; pages 3', 0],
    ['no_observation: not a comparable domain; pages 2', 0],
    ['no_observation: not a comparable domain; pages 1', 0],
  ])
  assert.equal(techRows(db), 0)
  const t = new EnrichmentTrace(); noteTech(t, auditSummary(db, 'u1', 'j1', TECH_AUDIT))
  assert.equal(t.stages[0].status, 'attempted_no_result')
  assert.match(t.stages[0].reason!, /^crawl_ran_no_observations: /)
  // a blocked homepage IS an observation (recorded as blocked) and is never compared, so no change row
  techBranch(db, 'u1', 'j2', 'l2', 'brightloop.com', { tech: [], homeObs: 'blocked', pages: 1 }, AT, {})
  assert.match(ledger(db).at(-1)!.status, /^observed blocked: 0 technologies, 0 changes; pages 1$/)
  assert.equal((db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE kind = 'tech_change'").get() as { n: number }).n, 0)
})

test('malformed page counts read as 0, never NaN or a negative number', () => {
  const db = fresh()
  for (const pages of [NaN, -1, 1.5, '3' as unknown as number, null as unknown as number, Number.MAX_SAFE_INTEGER + 2, undefined]) techBranch(db, 'u1', 'j1', 'l1', 'brightloop.com', { pages }, AT, {})
  assert.ok(ledger(db).every(r => r.status === 'no_observation: no homepage verdict; pages 0'), JSON.stringify(ledger(db)))
})

test('branch_error: the branch throwing is recorded by its class name only (Error, non-Error, odd names) and never blocks the crawl', () => {
  const db = fresh()
  const throwing = (thrown: unknown) => new Proxy(db, { get(t, k, r) {
    const v = Reflect.get(t, k, r)
    return k === 'prepare' ? (sql: string) => { if (/lead_enrichments/.test(sql)) throw thrown; return t.prepare(sql) } : typeof v === 'function' ? v.bind(t) : v
  } }) as Database.Database
  const errOf = (msg: string) => Object.assign(new Error(msg), { name: 'SqliteError' })
  const named = (name: unknown) => Object.assign(new Error('m'), { name })
  for (const thrown of [errOf('no such table: lead_enrichments'), 'a bare string', { code: 'X' }, null, errOf('bad \u0000\u001b[31m\u00e9 ' + 'y'.repeat(400)), named('Sqlite Error: x'), named(7), named('A'.repeat(41)), new TypeError('x')])
    assert.doesNotThrow(() => techBranch(throwing(thrown), 'u1', 'j1', 'l1', 'brightloop.com', { tech: [], homeObs: 'ok', pages: 1 }, AT, {}))
  const st = ledger(db).map(r => r.status)
  assert.deepEqual(st, ['error: SqliteError', 'error: unknown', 'error: unknown', 'error: unknown', 'error: SqliteError', 'error: unknown', 'error: unknown', 'error: unknown', 'error: TypeError'])
  const t = new EnrichmentTrace(); noteTech(t, auditSummary(db, 'u1', 'j1', TECH_AUDIT))
  assert.equal(t.stages[0].status, 'failed')
  assert.match(t.stages[0].reason!, /^branch_error on 9 of 9 sites: /)
  // a ledger that cannot be written (old schema without connector_audit) still never throws into the crawl
  const bare = new Database(':memory:')
  assert.doesNotThrow(() => techBranch(bare, 'u1', 'j1', 'l1', 'brightloop.com', { homeObs: 'ok', pages: 1 }, AT, {}))
})

test('mixed outcomes: one error makes the stage failed even when other sites observed; tenants and jobs stay apart', () => {
  const db = fresh()
  techBranch(db, 'u1', 'j1', 'l1', 'brightloop.com', { tech: [], homeObs: 'ok', pages: 1 }, AT, {})
  techBranch(db, 'u1', 'j1', 'l2', 'localhost', { homeObs: 'ok', pages: 1 }, AT, {})
  techBranch(db, 'u2', 'j1', 'l9', 'other.com', { homeObs: 'ok', pages: 1 }, AT, { TECH_SCAN_ENABLED: '0' })
  db.prepare("INSERT INTO connector_audit (id, tenant_id, connector, scan_job_id, lookup, status, results) VALUES ('e1', 'u1', ?, 'j1', 'x.com', 'error: Error: boom', 0)").run(TECH_AUDIT)
  const t = new EnrichmentTrace(); noteTech(t, auditSummary(db, 'u1', 'j1', TECH_AUDIT))
  assert.deepEqual([t.stages[0].status, t.stages[0].detail], ['failed', { sites: 3, observed: 1, no_observation: 1, errors: 1, disabled: 0 }])
  const other = new EnrichmentTrace(); noteTech(other, auditSummary(db, 'u2', 'j1', TECH_AUDIT))
  assert.deepEqual([other.stages[0].status, other.stages[0].detail], ['skipped', { sites: 1, observed: 0, no_observation: 0, errors: 0, disabled: 1 }])
  const none = new EnrichmentTrace(); noteTech(none, auditSummary(db, 'u1', 'j-other', TECH_AUDIT))
  assert.match(none.stages[0].reason!, /^branch_never_ran/)
})

test('the ledger never changes the crawl stage or the settings audit list', async () => {
  const db = fresh()
  const jobId = await crawl(db, { status: 200, body: page(WF) })
  const t = new EnrichmentTrace(); noteFromAudit(t, db, 'u1', jobId, 'crawl', 'sitecrawl')
  const crawlRows = (db.prepare("SELECT count(*) AS n FROM connector_audit WHERE connector = 'sitecrawl' AND scan_job_id = ?").get(jobId) as { n: number }).n
  assert.equal(t.stages[0].detail!.lookups, crawlRows, "the 'crawl' stage counts only sitecrawl rows, not the tech ledger")
  assert.ok((recentAudit(db, 'u1') as { connector: string }[]).every(r => r.connector !== TECH_AUDIT), 'not shown in the settings status list')
})

// Every caller of connector_audit counts: the hiring-feed crawl reads 'finished' when the crawl added a row. The ledger row is written
// before the crawl's own row, so it must never count: a crawl that failed after the ledger row stays 'failed'.
test('the ledger row never makes a failed hiring-feed crawl read as finished', () => {
  const db = fresh()
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  const before = crawlAuditCount(db, jobId)
  techBranch(db, 'u1', jobId, 'lead-1', 'brightloop.com', {}, AT)
  assert.equal(ledger(db).length, 1, 'the ledger row was written')
  assert.equal(crawlAuditCount(db, jobId), before, 'and is not a crawl row')
  db.prepare("INSERT INTO connector_audit (tenant_id, connector, scan_job_id, lookup, status, results, created_at) VALUES ('u1', 'sitecrawl', ?, 'brightloop.com', 'ok', 0, ?)").run(jobId, AT)
  assert.equal(crawlAuditCount(db, jobId), before + 1)
})

// Review on 7b3619c5: an error's message can echo a URL, a token or a provider body. Neither the ledger row nor the run report may hold it.
test('branch_error never stores the error message: a thrown URL, token or body reaches neither the ledger nor the run report', () => {
  const db = fresh()
  const leaky = Object.assign(new Error('https://x.example/?token=SECRET body=PRIVATE'), { name: 'SqliteError' })
  const throwing = new Proxy(db, { get(t, k, r) {
    const v = Reflect.get(t, k, r)
    return k === 'prepare' ? (sql: string) => { if (/lead_enrichments/.test(sql)) throw leaky; return t.prepare(sql) } : typeof v === 'function' ? v.bind(t) : v
  } }) as Database.Database
  techBranch(throwing, 'u1', 'j1', 'l1', 'brightloop.com', { tech: [], homeObs: 'ok', pages: 1 }, AT, {})
  const t = new EnrichmentTrace(); noteTech(t, auditSummary(db, 'u1', 'j1', TECH_AUDIT))
  const stored = JSON.stringify([ledger(db), t.stages])
  assert.deepEqual(ledger(db).map(r => r.status), ['error: SqliteError'])
  for (const leak of ['token', 'SECRET', 'PRIVATE', 'x.example', 'https://']) assert.ok(!stored.includes(leak), leak)
})

