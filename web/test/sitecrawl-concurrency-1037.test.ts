import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import * as sc from '../lib/connectors/sitecrawl.ts'

// #1037: the people crawl read one lead's site after another (about 12 s a site) inside the 90 s post-finish window, capped at 8 sites, so
// most of a scan's leads never had their own site checked for a named person. It now reads a few leads at once and checks up to 20.
// The crawl runs for real (crawlJob); only the network is a table of pages with a small delay, so overlap can be measured.
const html = (b: string) => `<html><body>${b}</body></html>`
const PROSE = '<p>We have cared for families in our neighbourhood for many years and we welcome every new patient who walks through our doors.</p>'
const HOME = (name: string) => html(`<h1>${name}</h1><p>Visit us at 200 Bloor Street West, Toronto, ON M5S 1T8.</p>${PROSE}<a href="/contact">Contact</a><a href="/team">Our team</a>`)
const TEAM = html(`${PROSE}<h2>Our team</h2><h3>Priya Shah</h3><p>Owner</p>`)
const BOARD = 'board.example'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function setup(n: number, opts: { sameSite?: boolean; concurrency?: number } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const sites: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    const company = opts.sameSite ? 'Bloor Dental Group' : `Bloor Dental ${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`
    const host = opts.sameSite ? 'bloordentalgroup.example' : `bloordental${String.fromCharCode(97 + i)}.example`
    sites[`https://${BOARD}/jobs/${i}`] = host
    ins.run(`L${i}`, job, company, null, 'Hiring a dental receptionist in Toronto', `https://${BOARD}/jobs/${i}`, `${company} is hiring a dental receptionist in Toronto, Ontario`, 90, 90 - i, null)
  }
  const companyOf = (host: string) => (db.prepare('SELECT company FROM leads WHERE source_url IN (' + Object.keys(sites).filter(k => sites[k] === host).map(() => '?').join(',') + ') LIMIT 1').get(...Object.keys(sites).filter(k => sites[k] === host)) as { company: string }).company
  let inFlightSites = 0, maxSites = 0, inFlightBoard = 0, maxBoard = 0
  const fetched: string[] = []
  const get: Get = async url => {
    const u = new URL(url); fetched.push(u.hostname + u.pathname)
    if (u.hostname === BOARD) {
      inFlightBoard++; maxBoard = Math.max(maxBoard, inFlightBoard)
      try { await sleep(5); const host = sites[url]; return { status: 200, body: html(`<p>${companyOf(host)} is hiring in Toronto.</p><a href="https://${host}/">${companyOf(host)}</a>`), finalUrl: url } } finally { inFlightBoard-- }
    }
    inFlightSites++; maxSites = Math.max(maxSites, inFlightSites)
    try {
      await sleep(20)
      if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      if (u.pathname === '/') return { status: 200, body: HOME(companyOf(u.hostname)), finalUrl: url }
      if (u.pathname === '/team') return { status: 200, body: TEAM, finalUrl: url }
      if (u.pathname === '/contact') return { status: 200, body: html(`Email: hello@${u.hostname}`), finalUrl: url }
      return { status: 404, body: '', finalUrl: url }
    } finally { inFlightSites-- }
  }
  await crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z'), redirectOf: async () => null, ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}) })
  const domains = (db.prepare('SELECT id, company_domain FROM leads ORDER BY id').all() as { id: string; company_domain: string | null }[])
  const people = db.prepare("SELECT lead_id, value FROM lead_enrichments WHERE kind = 'person'").all() as { lead_id: string; value: string }[]
  return { domains, people, maxSites, maxBoard, fetched }
}

test('#1037 crawlConcurrency: default 4, bounded 1..6, bad values fall back to the default', () => {
  assert.equal(sc.crawlConcurrency(undefined, undefined, {}), sc.CRAWL_CONCURRENCY_DEFAULT)
  assert.equal(sc.CRAWL_CONCURRENCY_DEFAULT, 4)
  assert.equal(sc.crawlConcurrency(undefined, undefined, { SITECRAWL_CONCURRENCY: '2' }), 2)
  assert.equal(sc.crawlConcurrency(undefined, undefined, { SITECRAWL_CONCURRENCY: '50' }), 6)
  for (const bad of ['0', '-3', 'abc', 'NaN']) assert.equal(sc.crawlConcurrency(undefined, undefined, { SITECRAWL_CONCURRENCY: bad }), 4, bad)
  assert.equal(sc.crawlConcurrency(1, undefined, { SITECRAWL_CONCURRENCY: '5' }), 1, 'an explicit width wins')
  assert.equal(sc.crawlConcurrency(undefined, 1, { SITECRAWL_CONCURRENCY: '5' }), 1, 'an injected fetch (tests) keeps the old one-at-a-time order')
})

test('#1037 the crawl checks up to 20 leads per scan (was 8), so later leads get a site check too', () => {
  assert.equal(sc.MAX_SITES_PER_SCAN, 20)
  assert.equal(sc.MAX_PROBES_PER_SCAN, 20)
})

test('#1037 leads are read several at once: every lead gets its site and named person; evidence pages on one host are never fetched at once', async () => {
  const r = await setup(10, { concurrency: 4 })
  assert.ok(r.maxSites > 1 && r.maxSites <= 4, `sites read at once: ${r.maxSites}`)
  assert.equal(r.maxBoard, 1, 'the job board is fetched one page at a time')
  for (const d of r.domains) assert.ok(d.company_domain?.startsWith('bloordental'), JSON.stringify(d))
  const named = new Set(r.people.filter(p => p.value.startsWith('Priya Shah')).map(p => p.lead_id))
  assert.equal(named.size, 10, `named person on every lead: ${[...named].join(',')}`)
})

test('#1037 the same leads read one at a time and four at a time give the same results', async () => {
  const one = await setup(6, { concurrency: 1 }), four = await setup(6, { concurrency: 4 })
  assert.equal(one.maxSites, 1)
  assert.deepEqual(four.domains, one.domains)
  const key = (x: { lead_id: string; value: string }[]) => x.map(p => `${p.lead_id}:${p.value}`).sort()
  assert.deepEqual(key(four.people), key(one.people))
})

test('#1037 two leads on the same site never crawl it twice at once: one read, both leads get the site', async () => {
  const r = await setup(3, { sameSite: true, concurrency: 4 })
  assert.equal(r.fetched.filter(f => f === 'bloordentalgroup.example/').length, 1, JSON.stringify(r.fetched))
  for (const d of r.domains) assert.equal(d.company_domain, 'bloordentalgroup.example')
})

// Ziggy review 1290-F1: a queued evidence fetch must re-check the deadline when it reaches the front of its host queue, and must carry the
// crawl's signal to the transport. Hold the first board fetch, let more leads queue behind it, abort, release: no queued request may start.
async function abortWhileQueued(honorsSignal: boolean) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
  for (let i = 0; i < 4; i++) ins.run(`L${i}`, job, `Bloor Dental ${'ABCD'[i]}${'ABCD'[i]}`, null, 'Hiring a dental receptionist in Toronto', `https://${BOARD}/jobs/${i}`, 'Bloor Dental is hiring a dental receptionist in Toronto, Ontario', 90, 90 - i, null)
  const ctl = new AbortController()
  let release!: () => void; const held = new Promise<void>(r => { release = r })
  const started: { url: string; afterAbort: boolean; signal: boolean }[] = []
  let firstArrived!: () => void; const arrived = new Promise<void>(r => { firstArrived = r })
  const get: Get = async (url, opts) => {
    started.push({ url, afterAbort: ctl.signal.aborted, signal: opts?.signal === ctl.signal })
    if (honorsSignal && opts?.signal?.aborted) return null
    if (new URL(url).hostname === BOARD && started.length === 1) { firstArrived(); await held }
    return { status: 404, body: '', finalUrl: url }
  }
  const run = crawlJob(db, 'A', job, { get, gapMs: 0, env: {}, now: Date.parse('2026-11-15T12:00:00Z'), redirectOf: async () => null, concurrency: 4, signal: ctl.signal })
  await arrived; await sleep(20)            // the other three leads have entered readLead and queued behind the held board fetch
  ctl.abort(); release()
  await run
  return started
}
for (const honors of [true, false]) {
  test(`1290-F1 abort while evidence fetches are queued on one host (${honors ? 'transport honours the signal' : 'injected Get ignores options'}): no queued request starts after the deadline`, async () => {
    const started = await abortWhileQueued(honors)
    assert.equal(started.filter(s => new URL(s.url).hostname === BOARD).length, 1, JSON.stringify(started))
    assert.deepEqual(started.filter(s => s.afterAbort), [], JSON.stringify(started))
    assert.ok(started[0].signal, 'the evidence fetch carries the crawl signal to the transport')
  })
}

// Ziggy review 1290-F2: evidence reads and site crawls share ONE per-host schedule. Lead L0's crawl holds a request on acme.example while
// lead L2 (picked up once L1 finishes) queues its evidence page on that same host: never two requests on one host at once, the polite gap
// holds between them, and after an abort nothing queued on the host starts.
async function mixedHost(opts: { abortAtMs?: number } = {}) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', where: ['Toronto, Ontario'] }), job)
  const ins = db.prepare('INSERT INTO leads (id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence,score,review_reason) VALUES (?,?,?,?,?,?,?,?,?,?)')
  ins.run('L0', job, 'Acme Dental', null, 'Hiring a dental receptionist in Toronto', `https://${BOARD}/jobs/0`, 'Acme Dental is hiring a dental receptionist in Toronto, Ontario', 90, 90, null)
  ins.run('L1', job, 'Other Dental', null, 'Hiring a dental receptionist in Toronto', `https://${BOARD}/jobs/1`, 'Other Dental is hiring a dental receptionist in Toronto, Ontario', 90, 89, null)
  ins.run('L2', job, 'Acme Dental', null, 'Hiring a dental receptionist in Toronto', 'https://acme.example/news/hiring', 'Acme Dental is hiring a dental receptionist in Toronto, Ontario', 90, 88, null)
  const GAP = 40
  const t0 = Date.now()
  const acme: { start: number; end: number; path: string }[] = []
  let inFlightAcme = 0, maxAcme = 0
  const ctrl = new AbortController()
  let abortedAt = Infinity
  if (opts.abortAtMs !== undefined) setTimeout(() => { abortedAt = Date.now() - t0; ctrl.abort() }, opts.abortAtMs)
  const get: Get = async (url, o) => {
    const u = new URL(url)
    if (u.hostname === BOARD) {
      await sleep(5)
      const [co, host] = u.pathname.endsWith('/0') ? ['Acme Dental', 'acme.example'] : ['Other Dental', 'other.example']
      return { status: 200, body: html(`<p>${co} is hiring in Toronto.</p><a href="https://${host}/">${co}</a>`), finalUrl: url }
    }
    if (u.hostname !== 'acme.example') { await sleep(2); return { status: 404, body: '', finalUrl: url } }
    const rec = { start: Date.now() - t0, end: -1, path: u.pathname }; acme.push(rec)
    inFlightAcme++; maxAcme = Math.max(maxAcme, inFlightAcme)
    try {
      // the homepage is the held company-site request (150 ms, or until the abort)
      const ms = u.pathname === '/' ? 150 : 10
      await new Promise<void>(res => { const t = setTimeout(res, ms); o?.signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true }) })
      if (o?.signal?.aborted) return null
      if (u.pathname === '/robots.txt') return { status: 200, body: 'User-agent: *\nAllow: /', finalUrl: url }
      if (u.pathname === '/') return { status: 200, body: HOME('Acme Dental'), finalUrl: url }
      if (u.pathname === '/news/hiring') return { status: 200, body: html('<p>Acme Dental is hiring in Toronto.</p>'), finalUrl: url }
      return { status: 404, body: '', finalUrl: url }
    } finally { inFlightAcme--; rec.end = Date.now() - t0 }
  }
  await crawlJob(db, 'A', job, { get, gapMs: GAP, env: {}, now: Date.parse('2026-11-15T12:00:00Z'), redirectOf: async () => null, concurrency: 2, ...(opts.abortAtMs !== undefined ? { signal: ctrl.signal } : {}) })
  return { acme, maxAcme, GAP, abortedAt }
}

test('1290-F2 an evidence read and a site crawl on the same host never overlap, and the polite gap holds between them', async () => {
  const { acme, maxAcme, GAP } = await mixedHost()
  assert.ok(acme.some(r => r.path === '/news/hiring'), `the evidence page on the crawled host was read: ${JSON.stringify(acme)}`)
  assert.ok(acme.some(r => r.path === '/'), 'the company site was crawled')
  assert.equal(maxAcme, 1, `one request at a time on acme.example: ${JSON.stringify(acme)}`)
  const starts = acme.map(r => r.start).sort((a, b) => a - b)
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= GAP - 5, `gap ${starts[i] - starts[i - 1]}ms < ${GAP}ms: ${JSON.stringify(acme)}`)
})

test('1290-F2 after an abort no request queued on the shared host starts', async () => {
  const { acme, abortedAt } = await mixedHost({ abortAtMs: 100 })
  assert.ok(Number.isFinite(abortedAt), 'the abort fired')
  const late = acme.filter(r => r.start > abortedAt)
  assert.deepEqual(late, [], `no acme.example request started after the abort at ${abortedAt}ms: ${JSON.stringify(acme)}`)
})
