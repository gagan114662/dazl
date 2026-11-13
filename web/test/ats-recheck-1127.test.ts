// #1127 (follow-up to #1117, Refs #533): (1) the evidence recheck dates a hiring lead by the board's own first-published day
// for exactly its posting URL, the verifier's rule; (2) ATS board record reads are bounded per scan. The real page fetcher
// is used throughout; only the socket is faked (no network).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import Database from 'better-sqlite3'

process.env.SCAN_PAGE_TIMEOUT_MS = '400' // the request timeout, read when fetch-page loads (a hung read must give its slot back quickly)
const { fetchPageDetailed, isFail, resetBoardMemo } = await import('../lib/scan/fetch-page.ts')
const { evidenceRecheck } = await import('../lib/scan/evidence-recheck.ts')
const { migrateScan, createQueryJob } = await import('../lib/scan/store.ts')
const { verifyLeads } = await import('../lib/scan/runner.ts')
const { runWithScanSpend, scanCapConfig } = await import('../lib/scan/spend-cap.ts')
const { ATS_RECORD_CONCURRENCY } = await import('../lib/scan/ats-read-slots.ts')
const { pgDb } = await import('../lib/db/client.ts')
const { runPgMigrations } = await import('../lib/db/migrate-pg.ts')
const { PG_URL, pgSkip, freshSchema } = await import('./helpers/pg-test.ts')
type LeadDraft = import('../lib/scan/runner.ts').LeadDraft

// ---- the fake socket: answers after `delay` ms, counts the requests in flight (started, not yet answered or destroyed)
type Answer = { status: number; type: string; body: string } | 'error' | 'hang'
function fakeHttps(serve: (url: string) => Answer, delay = 0) {
  const real = https.request
  resetBoardMemo()
  const seen: string[] = []
  const stats = { inFlight: 0, max: 0 }
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(e?: Error): void }
    let open = false
    const done = () => { if (open) { open = false; stats.inFlight-- } }
    req.destroy = (e?: Error) => { done(); if (e) queueMicrotask(() => req.emit('error', e)) }
    req.end = () => {
      seen.push(String(url)); open = true; stats.inFlight++; stats.max = Math.max(stats.max, stats.inFlight)
      const r = serve(String(url))
      if (r === 'hang') return // only the request timeout ends it
      setTimeout(() => {
        if (!open) return
        if (r === 'error') { done(); req.emit('error', new Error('ECONNRESET')); return }
        done()
        const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} })
        cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end')
      }, delay)
    }
    return req
  }
  return { seen, stats, restore: () => { (https as { request: unknown }).request = real } }
}
const json = (b: unknown) => ({ status: 200, type: 'application/json', body: JSON.stringify(b) })
const scan = <T>(fn: () => Promise<T>) => runWithScanSpend({ db: null as never, jobId: 'j', tenantId: 'u', attempt: 1, cap: scanCapConfig() }, fn)

// ---- (1) the recheck
const NOW = new Date('2026-11-13T12:00:00Z')
const ID = 'b1f00000-0000-4000-8000-0000000000c1', OTHER = 'b1f00000-0000-4000-8000-0000000000c2'
const URL1 = `https://jobs.ashbyhq.com/tekion/${ID}`, URL2 = `https://jobs.ashbyhq.com/tekion/${OTHER}`
const QUOTE = 'Sales Operations Manager - Deal Desk Location Virtual - California (Bay Area) Employment Type Full time'
const job = (id: string, title: string, publishedAt: string) => ({ id, title, location: 'Virtual - California (Bay Area)', employmentType: 'FullTime', department: 'Sales', isListed: true, publishedAt, jobUrl: `https://jobs.ashbyhq.com/tekion/${id}`, descriptionPlain: `Tekion is hiring a ${title} to run quoting and approvals.` })
const BOARD = { jobs: [job(ID, 'Sales Operations Manager - Deal Desk', '2026-11-11T18:56:50.000+00:00'), job(OTHER, 'Sales Operations Manager - Deal Desk', '2026-10-20T09:00:00.000+00:00')] }
const ICP = JSON.stringify({ summary: 'US sales ops hires', who: ['head of sales'], industries: ['software'], sizes: [], where: ['California', 'US'], signals: ['hiring sales operations'], exclude: [], window_days: 90 })
const QUERY = 'Find US software companies hiring sales operations roles in the last 90 days. We sell deal desk software.'
type Row = { signal: string; kind: string | null; url: string; date: string | null }
function sqlite(rows: Row[]) {
  const db = new Database(':memory:'); migrateScan(db)
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)'); db.prepare('INSERT INTO users VALUES(?,?,?)').run('u', 'Deal desk software', '')
  const j = createQueryJob(db, 'u', { query: QUERY })
  db.prepare("UPDATE scan_jobs SET status='running',offer=?,icp=? WHERE id=?").run('Deal desk software', ICP, j)
  const ids = rows.map((r, i) => { const id = String(i + 1).padStart(24, '0'); db.prepare('INSERT INTO leads(id,scan_job_id,company,signal,signal_kind,source_url,evidence_excerpt,event_date,review_reason) VALUES(?,?,?,?,?,?,?,?,?)').run(id, j, 'Tekion', r.signal, r.kind, r.url, QUOTE, r.date, 'blocked_by_site'); return id })
  return { db, ids }
}
const HIRING = 'Is hiring a Sales Operations Manager for the Deal Desk'
const ROWS: Row[] = [
  { signal: HIRING, kind: null, url: URL1, date: '2026-11-11' },                                   // 0: hiring, the board's day for exactly this URL
  { signal: 'Posted a Sales Operations Manager - Deal Desk role on Ashby', kind: 'hiring', url: `${URL1}?action=apply`, date: '2026-11-11' }, // 1: the same posting (query ignored)
  { signal: 'Raised a Series B round', kind: null, url: URL1, date: '2026-11-11' },                // 2: not hiring
  { signal: 'Posted a Sales Operations Manager - Deal Desk role on Ashby', kind: 'funding', url: URL1, date: '2026-11-11' }, // 3: a stored non-hiring kind wins over the board wording
  { signal: HIRING, kind: null, url: URL1, date: '2026-11-10' },                                   // 4: hiring, another day
  { signal: HIRING, kind: null, url: URL2, date: '2026-11-11' },                                   // 5: hiring, the day of ANOTHER posting on the same board
]
const EXPECT: [boolean, string | null, string][] = [[true, 'ats_structured', 'inside'], [true, 'ats_structured', 'inside'], [false, null, 'undated'], [false, null, 'undated'], [false, null, 'undated'], [false, null, 'undated']]
async function recheckAll(db: Parameters<typeof evidenceRecheck>[0], ids: string[]) {
  const fake = fakeHttps(u => u.startsWith('https://api.ashbyhq.com/posting-api/job-board/tekion') ? json(BOARD) : { status: 403, type: 'text/html', body: '' })
  try {
    const out = []
    for (const id of ids) out.push(await evidenceRecheck(db, 'u', id, undefined, NOW)) // the default fetcher: the real page read
    return out
  } finally { fake.restore() }
}

test('#1127 (1): the recheck dates a hiring lead by the board day for exactly its posting URL (ats_structured), never a non-hiring lead or another day', async () => {
  const { db, ids } = sqlite(ROWS)
  const before = db.prepare('SELECT * FROM leads').all()
  const out = await recheckAll(db, ids)
  out.forEach((p, i) => {
    assert.equal(p?.status, 'checked', `row ${i}: ${JSON.stringify(p)}`)
    const c = p!.checks as { event_date_bound: boolean; event_date_proof?: string | null; window: string }
    assert.deepEqual([c.event_date_bound, c.event_date_proof ?? null, c.window], EXPECT[i], `row ${i}: ${JSON.stringify(p)}`)
    assert.equal(p?.can_draft, false); assert.equal(p?.eligibility_changed, false)
  })
  assert.doesNotMatch(out[0]!.reasons.join(' '), /not tied to this company|undated/, 'the hiring lead is not downgraded to undated')
  assert.match(out[2]!.reasons.join(' '), /not tied to this company and event/)
  assert.deepEqual(db.prepare('SELECT * FROM leads').all(), before, 'the recheck writes nothing')
})

test('#1127 (1): the recheck and the verifier give the same saved posting the same proof', async () => {
  // rows the verifier takes as they are (row 4's other day the verifier re-dates to the board's; the read-only recheck never rewrites a saved day)
  const same = [0, 1, 2]
  const { db, ids } = sqlite(same.map(i => ROWS[i]))
  const rechecked = await recheckAll(db, ids)
  const fake = fakeHttps(u => u.startsWith('https://api.ashbyhq.com/') ? json(BOARD) : { status: 403, type: 'text/html', body: '' })
  try {
    for (const [k, i] of same.entries()) {
      const r = ROWS[i]
      const o = await verifyLeads([{ name: '', company: 'Tekion', signal: r.signal, source_url: r.url, excerpt: QUOTE, event_date: r.date, contact: null, score: 80, signal_kind: r.kind } as LeadDraft], u => fetchPageDetailed(u, async () => null), NOW)
      const v = [...o.leads, ...o.review][0]
      const verifierProof = v?.event_date ? v.event_date_proof ?? null : null
      assert.equal((rechecked[k]!.checks as { event_date_proof?: string | null }).event_date_proof ?? null, verifierProof, `row ${i}: verifier ${JSON.stringify(o)}`)
    }
  } finally { fake.restore() }
})

test('[pg] #1127 (1): the recheck reads the stored signal kind and dates by the board day on Postgres too', { skip: pgSkip }, async () => {
  const schema = await freshSchema(), db = pgDb({ connectionString: PG_URL!, searchPath: schema.schema })
  try {
    await runPgMigrations(db.pool)
    await db.run("INSERT INTO users(id,email,password_hash,salt,sells)VALUES('u','r1127@example.test','x','y','Deal desk software')")
    await db.run("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,offer,icp)VALUES('j1127','u','Request','software','US','running',?,?,?)", [QUERY, 'Deal desk software', ICP])
    const ids: string[] = []
    for (const [i, r] of ROWS.entries()) { const id = String(i + 1).padStart(24, '0'); ids.push(id); await db.run("INSERT INTO leads(id,scan_job_id,company,signal,signal_kind,source_url,evidence_excerpt,event_date,review_reason)VALUES(?,'j1127','Tekion',?,?,?,?,?,'blocked_by_site')", [id, r.signal, r.kind, r.url, QUOTE, r.date]) }
    const out = await recheckAll(db, ids)
    out.forEach((p, i) => { const c = p!.checks as { event_date_bound: boolean; event_date_proof?: string | null; window: string }; assert.deepEqual([c.event_date_bound, c.event_date_proof ?? null, c.window], EXPECT[i], `row ${i}`) })
  } finally { await db.close(); await schema.drop() }
})

// ---- (2) the per-scan bound
const ashby = (n: number) => `https://jobs.ashbyhq.com/org${n}/${ID}`
const boardFor = (u: string) => { const m = /job-board\/(org\d+)/.exec(u); return m ? json({ jobs: [{ ...job(ID, 'Account Executive', '2026-11-01T00:00:00Z'), jobUrl: `https://jobs.ashbyhq.com/${m[1]}/${ID}` }] }) : null }

test('#1127 (2): with 6 distinct boards, at most ATS_RECORD_CONCURRENCY record reads are in flight at once; the rest queue and all are read', async () => {
  assert.equal(ATS_RECORD_CONCURRENCY, 2)
  const fake = fakeHttps(u => boardFor(u) ?? { status: 403, type: 'text/html', body: '' }, 40)
  try {
    const pages = await scan(() => Promise.all([1, 2, 3, 4, 5, 6].map(n => fetchPageDetailed(ashby(n), async () => null))))
    assert.ok(pages.every(p => !isFail(p) && p.postedAt === '2026-11-01'), JSON.stringify(pages))
    assert.equal(fake.seen.length, 6, 'each board read once')
    assert.equal(fake.stats.max, ATS_RECORD_CONCURRENCY, `max in flight ${fake.stats.max}`)
  } finally { fake.restore() }
})

test('#1127 (2): the verifier fan-out over 6 boards is bounded; Greenhouse and Lever record reads share the same bound', async () => {
  const gh = (n: number) => `https://boards.greenhouse.io/gh${n}/jobs/${100 + n}`, lv = (n: number) => `https://jobs.lever.co/lv${n}/${ID}`
  const fake = fakeHttps(u => boardFor(u) ?? { status: 404, type: 'application/json', body: '{}' }, 40)
  try {
    const urls = [ashby(1), ashby(2), gh(1), gh(2), lv(1), lv(2)]
    const o = await scan(() => verifyLeads(urls.map(u => ({ name: '', company: 'Org', signal: 'Is hiring an Account Executive', source_url: u, excerpt: 'Account Executive', event_date: null, contact: null, score: 80 } as LeadDraft)), u => fetchPageDetailed(u, async () => null), NOW))
    assert.ok(o, 'the verifier finished')
    assert.equal(fake.seen.length, 6)
    assert.ok(fake.stats.max <= ATS_RECORD_CONCURRENCY, `max in flight ${fake.stats.max}`)
  } finally { fake.restore() }
})

test('#1127 (2): the bound is per scan: two scans each read 2 at once, never more than 2 each', async () => {
  const perScanMax: Record<string, number> = {}, live: Record<string, number> = {}
  const fake = fakeHttps(u => { const s = /org(\d)/.exec(u)![1] < '4' ? 'a' : 'b'; live[s] = (live[s] ?? 0) + 1; perScanMax[s] = Math.max(perScanMax[s] ?? 0, live[s]); setTimeout(() => { live[s]-- }, 40); return boardFor(u)! }, 40)
  try {
    await Promise.all([scan(() => Promise.all([1, 2, 3].map(n => fetchPageDetailed(ashby(n), async () => null)))), scan(() => Promise.all([4, 5, 6].map(n => fetchPageDetailed(ashby(n), async () => null))))])
    assert.equal(fake.stats.max, 2 * ATS_RECORD_CONCURRENCY, 'one scan does not wait for the other')
    assert.ok(perScanMax.a <= ATS_RECORD_CONCURRENCY && perScanMax.b <= ATS_RECORD_CONCURRENCY, JSON.stringify(perScanMax))
  } finally { fake.restore() }
})

test('#1127 (2): a read that errors or times out gives its slot back; the queue drains and the next read starts at once', async () => {
  // org1 resets, org2 hangs until the request timeout, org3 resets; org4..6 answer
  const fake = fakeHttps(u => /org1\b|org3\b/.test(u) ? 'error' : /org2\b/.test(u) ? 'hang' : boardFor(u)!, 20)
  try {
    await scan(async () => {
      const t0 = Date.now()
      const pages = await Promise.all([1, 2, 3, 4, 5, 6].map(n => fetchPageDetailed(ashby(n), async () => null)))
      assert.deepEqual(pages.map(p => isFail(p) ? p.fail : 'ok'), ['error', 'error', 'error', 'ok', 'ok', 'ok'])
      assert.ok(Date.now() - t0 < 2000, 'bounded by the request timeout, never stuck')
      assert.ok(fake.stats.max <= ATS_RECORD_CONCURRENCY, `max in flight ${fake.stats.max}`)
      // every slot is free again: two fresh boards start together, with nothing ahead of them
      fake.stats.max = 0; resetBoardMemo()
      const again = await Promise.all([7, 8].map(n => fetchPageDetailed(ashby(n), async () => null)))
      assert.ok(again.every(p => !isFail(p)))
      assert.equal(fake.stats.max, 2)
    })
  } finally { fake.restore() }
})

test('#1127 (2): a caller cancelled while queued leaves the queue and never makes its request', async () => {
  const gh = (n: number) => `https://boards.greenhouse.io/gh${n}/jobs/${100 + n}`
  const fake = fakeHttps(u => json({ id: Number(/jobs\/(\d+)/.exec(u)![1]), title: 'Account Executive', first_published: '2026-11-01T00:00:00Z', content: 'x', location: { name: 'US' } }), 60)
  try {
    await scan(async () => {
      const ac = new AbortController()
      const all = Promise.all([fetchPageDetailed(gh(1), async () => null), fetchPageDetailed(gh(2), async () => null), fetchPageDetailed(gh(3), async () => null, ac.signal)])
      await new Promise(r => setTimeout(r, 10)); ac.abort()
      const [a, b, c] = await all
      assert.ok(!isFail(a) && !isFail(b)); assert.deepEqual(c, { fail: 'error' })
      assert.equal(fake.seen.length, 2, 'the cancelled read was never sent')
      assert.equal(fake.stats.max, 2)
    })
  } finally { fake.restore() }
})
