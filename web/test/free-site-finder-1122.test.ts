// #1122: a lead's company website from free public data (Wikidata's official website, OpenStreetMap's website tag), no paid search.
// Stubbed Wikidata / Nominatim answers and synthetic sites: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawlJob, placeTerms, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { freeSiteFinderFor, siteFinderFor, FREE_SITE_LOOKUPS_PER_SCAN } from '../lib/scan/runner.ts'
import { freeCompanySites, freeCompanySitesDetailed, siteCompanyKey, wikidataAnswer, osmAnswer, osmSites, resetFreeSiteFinderPacing, sameCompanyName, wikidataSites, FREE_SITE_UA } from '../lib/connectors/free-site-finder.ts'

const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })
type Item = { id: string; label: string; site?: string }
// A stub of the two public APIs. wikidata: items by search term; osm: rows by query. Records every URL and its User-Agent.
function publicData(opts: { wikidata?: Record<string, Item[]>; osm?: Record<string, unknown[]> }, asked: { url: string; ua: string }[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input)); asked.push({ url: u.toString(), ua: new Headers(init?.headers).get('user-agent') ?? '' })
    if (u.hostname === 'www.wikidata.org' && u.searchParams.get('action') === 'wbsearchentities') {
      const items = opts.wikidata?.[u.searchParams.get('search') ?? ''] ?? []
      return json({ search: items.map(i => ({ id: i.id, label: i.label, match: { text: i.label } })) })
    }
    if (u.hostname === 'www.wikidata.org' && u.searchParams.get('action') === 'wbgetentities') {
      const all = Object.values(opts.wikidata ?? {}).flat()
      const entities: Record<string, unknown> = {}
      for (const id of (u.searchParams.get('ids') ?? '').split('|')) {
        const it = all.find(i => i.id === id)
        entities[id] = { claims: it?.site ? { P856: [{ rank: 'normal', mainsnak: { datavalue: { value: it.site } } }] } : {} }
      }
      return json({ entities })
    }
    if (u.hostname === 'nominatim.openstreetmap.org') return json(opts.osm?.[u.searchParams.get('q') ?? ''] ?? [])
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}
const fast = { sleep: async () => {}, now: () => 0 }

test('sameCompanyName: the same name, legal tails ignored; never a longer or shorter name', () => {
  assert.ok(sameCompanyName('Mercury', 'Mercury'))
  assert.ok(sameCompanyName('Mercury Technologies, Inc.', 'Mercury Technologies'))
  assert.ok(sameCompanyName('beehiiv', 'Beehiiv'))
  assert.ok(sameCompanyName('Queen Street Dental Centre', 'Queen Street Dental Centre'))
  assert.ok(!sameCompanyName('Mercury', 'Mercury Insurance'), 'another company with the word in its name')
  assert.ok(!sameCompanyName('Mercury Insurance', 'Mercury'))
  assert.ok(!sameCompanyName('AB', 'AB'), 'too short to tell apart')
})

test('wikidataSites: the official website (P856) of the item named like the company, with the item as the source; an unrelated item is ignored', async () => {
  resetFreeSiteFinderPacing(); const asked: { url: string; ua: string }[] = []
  const f = publicData({ wikidata: { Mercury: [{ id: 'Q1', label: 'Mercury', site: 'https://mercury.com/' }, { id: 'Q2', label: 'Mercury Insurance', site: 'https://www.mercuryinsurance.com/' }, { id: 'Q3', label: 'Mercury', site: undefined }] } }, asked)
  const hits = await wikidataSites('Mercury', { fetchImpl: f })
  assert.deepEqual(hits, [{ url: 'https://mercury.com/', source: 'wikidata', ref: 'https://www.wikidata.org/wiki/Q1' }])
  assert.ok(asked.every(a => a.ua === FREE_SITE_UA), 'every request identifies itself')
  assert.ok(!asked.some(a => a.url.includes('Q2')), 'the differently named item is never even read')
})

test('osmSites: a mapped business named like the company in the request\'s place, and its website tag; other names are ignored', async () => {
  resetFreeSiteFinderPacing()
  const f = publicData({ osm: { 'Queen Street Dental Centre, Toronto, Ontario': [
    { name: 'Queen Street Dental Centre', osm_type: 'node', osm_id: 42, extratags: { website: 'https://qsdc.ca/' } },
    { name: 'Queen Street Dental Lab', osm_type: 'node', osm_id: 43, extratags: { website: 'https://qsdlab.example/' } },
    { name: 'Queen Street Dental Centre', osm_type: 'way', osm_id: 44, extratags: { 'contact:website': 'qsdc-east.ca' } },
  ] } })
  const hits = await osmSites('Queen Street Dental Centre', ['Toronto, Ontario'], { fetchImpl: f, ...fast })
  assert.deepEqual(hits.map(h => h.url), ['https://qsdc.ca/', 'https://qsdc-east.ca'])
  assert.equal(hits[0].ref, 'https://www.openstreetmap.org/node/42')
})

test('osmSites: Nominatim is asked at most once per second (its usage policy)', async () => {
  resetFreeSiteFinderPacing(); const waits: number[] = []; let t = 10_000
  const f = publicData({})
  await osmSites('Harbor Dental', ['Austin'], { fetchImpl: f, sleep: async ms => { waits.push(ms); t += ms }, now: () => t })
  await osmSites('Other Dental', ['Austin'], { fetchImpl: f, sleep: async ms => { waits.push(ms); t += ms }, now: () => t })
  assert.equal(waits.length, 1); assert.ok(waits[0] >= 1000, `waited ${waits[0]} ms between the two requests`)
})

test('free sources never throw: an error, a non-JSON answer or an abort is no answer', async () => {
  resetFreeSiteFinderPacing()
  const boom = (async () => { throw new Error('offline') }) as typeof fetch
  assert.deepEqual(await freeCompanySites('Mercury', [], { fetchImpl: boom, ...fast }), [])
  const junk = (async () => new Response('<html>', { status: 200 })) as typeof fetch
  assert.deepEqual(await freeCompanySites('Mercury', [], { fetchImpl: junk, ...fast }), [])
  let n = 0
  const counted = (async () => { n++; return json({}) }) as typeof fetch
  assert.deepEqual(await freeCompanySites('Mercury', [], { fetchImpl: counted, signal: AbortSignal.abort(), ...fast }), [])
  assert.equal(n, 0, 'nothing is sent after the deadline')
})

// ---- the runner's finder: free first, own-site hosts only, audited, capped ----
type FinderJob = Parameters<typeof siteFinderFor>[1]
function scan() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const id = createJob(db, 'tenant-A', { business_name: 'Seller', industry: 'x', location: 'x' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(id)
  const attempts = (db.prepare('SELECT attempts FROM scan_jobs WHERE id = ?').get(id) as { attempts: number }).attempts
  return { db, job: { id, user_id: 'tenant-A', attempts, funded_by: 'trial' } as unknown as FinderJob }
}
const audits = (db: Database.Database) => (db.prepare("SELECT lookup, status, results FROM connector_audit WHERE connector = 'sitecrawl' ORDER BY rowid").all() as { lookup: string; status: string; results: number }[])

test('freeSiteFinderFor: on for a free-trial scan (it costs nothing); off with DAZL_FREE_SITE_FINDER=0 or an injected crawl fetch without its own', () => {
  const { db, job } = scan()
  assert.equal(typeof freeSiteFinderFor(db, job, { env: {} }), 'function')
  assert.equal(freeSiteFinderFor(db, job, { env: { DAZL_FREE_SITE_FINDER: '0' } }), undefined)
  assert.equal(freeSiteFinderFor(db, job, { env: {}, crawlGet: () => null }), undefined)
  assert.equal(typeof siteFinderFor(db, job, { env: {} }), 'function', 'a trial scan with no paid search still gets the free finder')
})

test('freeSiteFinderFor: own-site hosts only (a platform or another company\'s host is dropped), one lookup per company, recorded with its source', async () => {
  resetFreeSiteFinderPacing(); const { db, job } = scan(); const asked: { url: string; ua: string }[] = []
  const f = publicData({ wikidata: { beehiiv: [{ id: 'Q9', label: 'beehiiv', site: 'https://www.beehiiv.com/' }], Ngenaire: [{ id: 'Q8', label: 'Ngenaire', site: 'https://ngenaire.wixsite.com/home' }] } }, asked)
  const find = freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: f, freeSiteClock: fast })!
  assert.deepEqual(await find('beehiiv', []), ['beehiiv.com'])
  const before = asked.length
  assert.deepEqual(await find('Beehiiv', []), ['beehiiv.com']); assert.equal(asked.length, before, 'a second lead on the same company asks nothing')
  assert.deepEqual(await find('Ngenaire', []), [], 'a site-builder host is never the company\'s own domain')
  assert.deepEqual(audits(db), [{ lookup: 'beehiiv', status: 'site_free_ok_wikidata', results: 1 }, { lookup: 'Ngenaire', status: 'site_free_no_match', results: 0 }])
})

test('freeSiteFinderFor: a Wikidata answer must carry the company\'s name (a same-named town is dropped); a mapped business in the place may use a short domain', async () => {
  resetFreeSiteFinderPacing(); const { db, job } = scan()
  const f = publicData({
    wikidata: { Mercury: [{ id: 'Q5', label: 'Mercury', site: 'http://www.mairie-mercury.com/' }] },
    osm: { 'Queen Street Dental Centre, Toronto, Ontario': [{ name: 'Queen Street Dental Centre', osm_type: 'node', osm_id: 42, extratags: { website: 'https://www.qsdc.ca/' } }, { name: 'Queen Street Dental Centre', osm_type: 'node', osm_id: 43, extratags: { website: 'https://www.facebook.com/qsdc' } }] },
  })
  const find = freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: f, freeSiteClock: fast })!
  assert.deepEqual(await find('Mercury', []), [], 'a town hall\'s site named only by a shared word is not the company\'s')
  assert.deepEqual(await find('Queen Street Dental Centre', ['Toronto, Ontario']), ['qsdc.ca'], 'the mapped practice\'s own site; its social page is not')
  assert.deepEqual(audits(db).map(a => a.status), ['site_free_no_match', 'site_free_ok_openstreetmap'])
})

test(`freeSiteFinderFor: at most ${FREE_SITE_LOOKUPS_PER_SCAN} companies per scan`, async () => {
  resetFreeSiteFinderPacing(); const { db, job } = scan(); let n = 0
  const f = (async () => { n++; return json({ search: [] }) }) as typeof fetch
  const find = freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: f, freeSiteClock: fast })!
  for (let i = 0; i < FREE_SITE_LOOKUPS_PER_SCAN + 3; i++) await find(`Company Number ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`, [])
  assert.equal(audits(db).length, FREE_SITE_LOOKUPS_PER_SCAN, 'the cap holds')
  assert.ok(n > 0)
})

// ---- end to end through the crawl: Mercury, a job-board lead whose page links no company site (the #1122 case) ----
function seed() {
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, signal TEXT, evidence_excerpt TEXT)')
  db.prepare("INSERT INTO leads VALUES ('l1','j1','Mercury','https://job-boards.greenhouse.io/mercury/jobs/5555',NULL,90,80,NULL,'Mercury is hiring a Sales Development Representative','Mercury is hiring a Sales Development Representative')").run()
  db.exec('CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, icp TEXT)')
  db.prepare('INSERT INTO scan_jobs (id, icp) VALUES (?, ?)').run('j1', JSON.stringify({ who: ['Head of Sales'] }))
  return db
}
const site = (homes: Record<string, string>): Get => async url => {
  const u = new URL(url); const home = homes[u.hostname]
  if (u.hostname === 'job-boards.greenhouse.io') return { status: 200, body: '<html><body>Sales Development Representative at Mercury. Apply now.</body></html>', finalUrl: url }
  if (home === undefined) return { status: 404, body: '', finalUrl: url }
  if (u.pathname === '/robots.txt') return { status: 200, body: '', finalUrl: url }
  if (u.pathname === '/') return { status: 200, body: home, finalUrl: url }
  return { status: 404, body: '', finalUrl: url }
}

test('crawlJob + the free finder: a Greenhouse lead with no linked site gets the company\'s own domain from Wikidata, read and confirmed by its homepage', async () => {
  resetFreeSiteFinderPacing(); const db = seed()
  const { db: jdb, job } = scan()
  const findSites = freeSiteFinderFor(jdb, job, { env: {}, freeSiteClock: fast, freeSiteFetch: publicData({ wikidata: { Mercury: [{ id: 'Q1', label: 'Mercury', site: 'https://mercury.com/' }] } }) })!
  // mercury.com is the real company; the name guess mercury.io is a different business that the crawl must not pick first
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Mercury - banking for startups</body></html>', 'mercury.io': '<html><body>Mercury Plumbing, Leeds</body></html>' }), gapMs: 0, env: {}, findSites })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, 'mercury.com')
})

test('crawlJob: without the public-record mark, a name-guessed site for a no-geography scan is still refused for having no place (unchanged)', async () => {
  const db = seed()
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Mercury - banking for startups</body></html>' }), gapMs: 0, env: {}, findSites: async () => ['mercury.com'] })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, null)
})

test('crawlJob + the free finder: a site the free data names but whose homepage does not name the company is still refused', async () => {
  resetFreeSiteFinderPacing(); const db = seed()
  const { db: jdb, job } = scan()
  const findSites = freeSiteFinderFor(jdb, job, { env: {}, freeSiteClock: fast, freeSiteFetch: publicData({ wikidata: { Mercury: [{ id: 'Q1', label: 'Mercury', site: 'https://mercury.com/' }] } }) })!
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Domain for sale</body></html>' }), gapMs: 0, env: {}, findSites })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, null)
})

// 1289-P1 (Hermes-PC review 5924276588): a public-record mark never overrides the lead's own evidence geography.
function seedPlaced(text: string) {
  const db = seed()
  db.prepare('UPDATE leads SET signal = ?, evidence_excerpt = ?').run(text, text)
  return db
}
test('1289-P1 crawlJob + the free finder: no scan geography, the lead\'s evidence says Austin, the Wikidata site\'s homepage says Chicago: refused, no domain saved', async () => {
  resetFreeSiteFinderPacing(); const db = seedPlaced('Mercury in Austin, TX is hiring a Sales Development Representative.')
  const { db: jdb, job } = scan()
  const findSites = freeSiteFinderFor(jdb, job, { env: {}, freeSiteClock: fast, freeSiteFetch: publicData({ wikidata: { Mercury: [{ id: 'Q1', label: 'Mercury', site: 'https://mercury.com/' }] } }) })!
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Mercury - banking for startups. Based in Chicago, IL.</body></html>' }), gapMs: 0, env: {}, findSites })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, null)
})
test('1289-P1 crawlJob + the free finder: the lead\'s evidence says Austin and the Wikidata site\'s homepage says Austin: the place check runs and passes, domain saved', async () => {
  resetFreeSiteFinderPacing(); const db = seedPlaced('Mercury in Austin, TX is hiring a Sales Development Representative.')
  const { db: jdb, job } = scan()
  const findSites = freeSiteFinderFor(jdb, job, { env: {}, freeSiteClock: fast, freeSiteFetch: publicData({ wikidata: { Mercury: [{ id: 'Q1', label: 'Mercury', site: 'https://mercury.com/' }] } }) })!
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Mercury - banking for startups. Based in Austin, TX.</body></html>' }), gapMs: 0, env: {}, findSites })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, 'mercury.com')
})

// ---- review fixes: 1289-F1 (concurrent Nominatim pacing), 1289-F2 (exemption bound to its company), 1289-F3 (failed lookup is not "no match") ----

test('1289-F1 concurrent osmSites calls (separate scans) are admitted one at a time, at least 1.1 s apart; an abort while queued sends nothing', async () => {
  resetFreeSiteFinderPacing(); let t = 10_000; const sent: number[] = []
  const base = publicData({})
  const f = (async (input: string | URL, init?: RequestInit) => { if (new URL(String(input)).hostname === 'nominatim.openstreetmap.org') sent.push(t); return base(input, init) }) as typeof fetch
  // a fake clock shared by every caller: each sleep resumes on a later tick, then moves time forward to its own wake-up point
  const clock = { sleep: async (ms: number) => { const until = t + ms; await new Promise(r => setImmediate(r)); t = Math.max(t, until) }, now: () => t }
  const queued = new AbortController()
  const runs = [
    osmSites('Harbor Dental', ['Austin'], { fetchImpl: f, ...clock }),
    osmSites('Bay Dental', ['Austin'], { fetchImpl: f, ...clock }),
    osmSites('Lake Dental', ['Austin'], { fetchImpl: f, ...clock, signal: queued.signal }),
    osmSites('Hill Dental', ['Austin'], { fetchImpl: f, ...clock }),
  ]
  queued.abort()
  await Promise.all(runs)
  assert.equal(sent.length, 3, `the call aborted while waiting its turn sends nothing (sent at ${sent.join(', ')})`)
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i - 1] >= 1_100, `requests ${i} and ${i + 1} were ${sent[i] - sent[i - 1]} ms apart`)
})

test('1289-F2 the public-record mark belongs to the company whose own lookup returned it, never to a similarly named company', async () => {
  resetFreeSiteFinderPacing(); const { db, job } = scan()
  const f = publicData({ wikidata: { 'Harbor Dental': [{ id: 'Q7', label: 'Harbor Dental', site: 'https://harbordental.com/' }] } })
  const find = freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: f, freeSiteClock: fast })!
  assert.deepEqual(await find('Harbor Dental', []), ['harbordental.com'])
  assert.deepEqual(await find('Harbor Dental Group', []), [])
  assert.equal(find.recordSite?.('harbordental.com', 'Harbor Dental'), true, 'the marked company may pass')
  assert.equal(find.recordSite?.('harbordental.com', 'Harbor Dental Group'), false, 'another company reaching the same host by name probing is not marked')
})

test('1289-F2 crawlJob: the marked company passes; the unmarked "Group" company on the same host still needs the place check', async () => {
  resetFreeSiteFinderPacing()
  const db = new Database(':memory:'); migrateConnectors(db)
  db.exec('CREATE TABLE leads (id TEXT, scan_job_id TEXT, company TEXT, source_url TEXT, review_reason TEXT, confidence INTEGER, score INTEGER, company_domain TEXT, signal TEXT, evidence_excerpt TEXT)')
  const add = db.prepare("INSERT INTO leads VALUES (?,'j1',?,?,NULL,90,80,NULL,?,?)")
  add.run('l1', 'Harbor Dental', 'https://job-boards.greenhouse.io/harbordental/jobs/1', 'Harbor Dental is hiring a Sales Development Representative', 'Harbor Dental is hiring a Sales Development Representative')
  add.run('l2', 'Harbor Dental Group', 'https://job-boards.greenhouse.io/harbordentalgroup/jobs/2', 'Harbor Dental Group is hiring a Sales Development Representative', 'Harbor Dental Group is hiring a Sales Development Representative')
  db.exec('CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, icp TEXT)')
  db.prepare('INSERT INTO scan_jobs (id, icp) VALUES (?, ?)').run('j1', JSON.stringify({ who: ['Head of Sales'] }))
  const { db: jdb, job } = scan()
  const findSites = freeSiteFinderFor(jdb, job, { env: {}, freeSiteClock: fast, freeSiteFetch: publicData({ wikidata: { 'Harbor Dental': [{ id: 'Q7', label: 'Harbor Dental', site: 'https://harbordental.com/' }] } }) })!
  const get: Get = async url => {
    const u = new URL(url)
    if (u.hostname === 'job-boards.greenhouse.io') return { status: 200, body: '<html><body>Sales Development Representative. Apply now.</body></html>', finalUrl: url }
    if (u.hostname !== 'harbordental.com') return { status: 404, body: '', finalUrl: url }
    if (u.pathname === '/') return { status: 200, body: '<html><body>Harbor Dental Group - Harbor Dental, your dentist</body></html>', finalUrl: url }
    return { status: u.pathname === '/robots.txt' ? 200 : 404, body: '', finalUrl: url }
  }
  await crawlJob(db, 't1', 'j1', { get, gapMs: 0, env: {}, findSites })
  const dom = (id: string) => (db.prepare('SELECT company_domain AS d FROM leads WHERE id = ?').get(id) as { d: string | null }).d
  assert.equal(dom('l1'), 'harbordental.com', 'the company the public record names')
  assert.equal(dom('l2'), null, 'no public record for this company: the no-place refusal still applies')
})

test('1289-F3 freeCompanySitesDetailed: each source says ok, empty, failed or cancelled; valid partial results are kept', async () => {
  resetFreeSiteFinderPacing()
  const boom = (async () => { throw new Error('offline') }) as typeof fetch
  assert.deepEqual((await freeCompanySitesDetailed('Mercury', [], { fetchImpl: boom, ...fast })).outcomes, { wikidata: 'failed', openstreetmap: 'failed' })
  const junk = (async () => new Response('<html>', { status: 200 })) as typeof fetch
  assert.deepEqual((await freeCompanySitesDetailed('Mercury', [], { fetchImpl: junk, ...fast })).outcomes, { wikidata: 'failed', openstreetmap: 'failed' })
  assert.deepEqual((await freeCompanySitesDetailed('Mercury', [], { fetchImpl: publicData({}), ...fast })).outcomes, { wikidata: 'empty', openstreetmap: 'empty' })
  const half = publicData({ osm: { 'Queen Street Dental Centre, Toronto': [{ name: 'Queen Street Dental Centre', osm_type: 'node', osm_id: 42, extratags: { website: 'https://qsdc.ca/' } }] } })
  const wdDown = (async (input: string | URL, init?: RequestInit) => new URL(String(input)).hostname === 'www.wikidata.org' ? new Response('err', { status: 503 }) : half(input, init)) as typeof fetch
  const r = await freeCompanySitesDetailed('Queen Street Dental Centre', ['Toronto'], { fetchImpl: wdDown, ...fast })
  assert.deepEqual(r.outcomes, { wikidata: 'failed', openstreetmap: 'ok' }); assert.deepEqual(r.hits.map(h => h.url), ['https://qsdc.ca/'])
  const stop = new AbortController()
  const aborting = (async () => { stop.abort(); throw new DOMException('aborted', 'AbortError') }) as typeof fetch
  assert.deepEqual((await freeCompanySitesDetailed('Mercury', [], { fetchImpl: aborting, signal: stop.signal, ...fast })).outcomes, { wikidata: 'cancelled', openstreetmap: 'cancelled' })
})

test('1289-F3 freeSiteFinderFor audits a failed or cancelled lookup as such, never as no_match; a partial answer names the source that failed', async () => {
  resetFreeSiteFinderPacing(); const { db, job } = scan()
  const boom = (async () => { throw new Error('offline') }) as typeof fetch
  assert.deepEqual(await freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: boom, freeSiteClock: fast })!('Mercury', []), [])
  const half = publicData({ osm: { 'Queen Street Dental Centre, Toronto': [{ name: 'Queen Street Dental Centre', osm_type: 'node', osm_id: 42, extratags: { website: 'https://qsdc.ca/' } }] } })
  const wdDown = (async (input: string | URL, init?: RequestInit) => new URL(String(input)).hostname === 'www.wikidata.org' ? new Response('err', { status: 503 }) : half(input, init)) as typeof fetch
  assert.deepEqual(await freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: wdDown, freeSiteClock: fast })!('Queen Street Dental Centre', ['Toronto']), ['qsdc.ca'])
  const stop = new AbortController()
  const aborting = (async () => { stop.abort(); throw new DOMException('aborted', 'AbortError') }) as typeof fetch
  assert.deepEqual(await freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: aborting, freeSiteClock: fast }, stop.signal)!('Beehiiv', []), [])
  assert.deepEqual(audits(db).map(a => a.status), [
    'site_free_failed wikidata=failed osm=failed',
    'site_free_ok_openstreetmap wikidata=failed',
    'site_free_cancelled wikidata=cancelled osm=cancelled',
  ])
})

test('1289-F2 r3 one shared company key: accents fold to their letter, never deleted; "Group" kept; Müller Dental and Mller Dental stay apart (Harbor control alongside)', async () => {
  assert.equal(siteCompanyKey('Müller Dental'), siteCompanyKey('Muller Dental'), 'an accent folds to its base letter')
  assert.notEqual(siteCompanyKey('Müller Dental'), siteCompanyKey('Mller Dental'), 'a non-ASCII letter is never deleted')
  assert.notEqual(siteCompanyKey('Harbor Dental'), siteCompanyKey('Harbor Dental Group'), '"Group" is kept')
  assert.notEqual(siteCompanyKey('Мир Dental'), siteCompanyKey('Dental'), 'a non-Latin name keeps its letters')
  assert.equal(sameCompanyName('Müller Dental', 'Mller Dental'), false, 'the source-name matcher agrees with the key')
  resetFreeSiteFinderPacing(); const { db, job } = scan()
  const f = publicData({ wikidata: { 'Müller Dental': [{ id: 'Q8', label: 'Müller Dental', site: 'https://muellerdental.de/' }], 'Harbor Dental': [{ id: 'Q7', label: 'Harbor Dental', site: 'https://harbordental.com/' }] } })
  const find = freeSiteFinderFor(db, job, { env: {}, freeSiteFetch: f, freeSiteClock: fast })!
  assert.deepEqual(await find('Müller Dental', []), ['muellerdental.de'])
  assert.deepEqual(await find('Mller Dental', []), [], 'the second company does not inherit the first company\'s cached answer')
  assert.equal(find.recordSite?.('muellerdental.de', 'Müller Dental'), true)
  assert.equal(find.recordSite?.('muellerdental.de', 'Mller Dental'), false, 'nor its public-record exemption')
  assert.deepEqual(await find('Harbor Dental', []), ['harbordental.com'])
  assert.deepEqual(await find('Harbor Dental Group', []), [])
  assert.equal(find.recordSite?.('harbordental.com', 'Harbor Dental Group'), false)
})

test('1289-F3 r3 a 200 response is checked before it can be "empty": error objects, wrong-shaped JSON and malformed entities are failed; real empties stay empty; valid partial results survive', async () => {
  resetFreeSiteFinderPacing()
  const reply = (wd: (action: string, u: URL) => unknown, osm: unknown) => (async (input: string | URL) => {
    const u = new URL(String(input))
    return json(u.hostname === 'nominatim.openstreetmap.org' ? osm : wd(u.searchParams.get('action') ?? '', u))
  }) as typeof fetch
  const hit = { search: [{ id: 'Q1', label: 'Mercury', match: { text: 'Mercury' } }] }
  const site = { claims: { P856: [{ rank: 'normal', mainsnak: { datavalue: { value: 'https://mercury.com/' } } }] } }
  // HTTP-200 error objects
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(() => ({ error: { code: 'maxlag', info: 'lagged' } }), []), ...fast })).outcome, 'failed')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { error: { code: 'internal_api_error' } }, []), ...fast })).outcome, 'failed')
  assert.equal((await osmAnswer('Mercury', [], { fetchImpl: reply(() => hit, { error: { code: 503, message: 'busy' } }), ...fast })).outcome, 'failed')
  // wrong-shaped JSON
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(() => ({ results: [] }), []), ...fast })).outcome, 'failed', 'no search array')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(() => [], []), ...fast })).outcome, 'failed', 'an array instead of an object')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(() => ({ search: 'x' }), []), ...fast })).outcome, 'failed')
  assert.equal((await osmAnswer('Mercury', [], { fetchImpl: reply(() => hit, { rows: [] }), ...fast })).outcome, 'failed', 'an object instead of an array')
  assert.equal((await osmAnswer('Mercury', [], { fetchImpl: reply(() => hit, ['x', 3]), ...fast })).outcome, 'failed', 'rows that are not records')
  // malformed entity responses
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { success: 1 }, []), ...fast })).outcome, 'failed', 'no entities envelope')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { entities: {} }, []), ...fast })).outcome, 'failed', 'the asked item is missing')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { entities: { Q1: 'x' } }, []), ...fast })).outcome, 'failed', 'the item is not a record')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { entities: { Q1: { claims: { P856: 'x' } } } }, []), ...fast })).outcome, 'failed', 'P856 is not a list')
  // genuine empties stay empty
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(() => ({ search: [] }), []), ...fast })).outcome, 'empty')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { entities: { Q1: { claims: [] } } }, []), ...fast })).outcome, 'empty', 'Wikidata writes no claims as []')
  assert.equal((await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? hit : { entities: { Q1: { id: 'Q1', missing: '' } } }, []), ...fast })).outcome, 'empty')
  assert.equal((await osmAnswer('Mercury', [], { fetchImpl: reply(() => hit, []), ...fast })).outcome, 'empty')
  // valid partial results survive a malformed neighbour
  const two = { search: [{ id: 'Q1', label: 'Mercury' }, { id: 'Q2', label: 'Mercury' }] }
  const p = await wikidataAnswer('Mercury', { fetchImpl: reply(a => a === 'wbsearchentities' ? two : { entities: { Q1: site, Q2: 'x' } }, []), ...fast })
  assert.equal(p.outcome, 'ok'); assert.deepEqual(p.hits.map(h => h.url), ['https://mercury.com/'])
  const o = await osmAnswer('Mercury', [], { fetchImpl: reply(() => hit, ['x', { name: 'Mercury', osm_type: 'node', osm_id: 1, extratags: { website: 'https://mercury.com/' } }]), ...fast })
  assert.equal(o.outcome, 'ok'); assert.deepEqual(o.hits.map(h => h.url), ['https://mercury.com/'])
  const d = await freeCompanySitesDetailed('Mercury', [], { fetchImpl: reply(() => ({ error: { code: 'x' } }), [{ name: 'Mercury', osm_type: 'node', osm_id: 1, extratags: { website: 'https://mercury.com/' } }]), ...fast })
  assert.deepEqual(d.outcomes, { wikidata: 'failed', openstreetmap: 'ok' }); assert.deepEqual(d.hits.map(h => h.url), ['https://mercury.com/'])
})

test('1289-F3 r4 a P856 claim whose value snak is malformed is failed, not empty; a real no-value statement stays empty; a valid sibling still wins', async () => {
  resetFreeSiteFinderPacing()
  const reply = (ents: unknown) => (async (input: string | URL) => {
    const u = new URL(String(input))
    return json(u.searchParams.get('action') === 'wbsearchentities' ? { search: [{ id: 'Q1', label: 'Mercury' }, { id: 'Q2', label: 'Mercury' }] } : ents)
  }) as typeof fetch
  const one = (c: unknown) => ({ entities: { Q1: { claims: { P856: [c] } }, Q2: { claims: [] } } })
  const ask = async (ents: unknown) => wikidataAnswer('Mercury', { fetchImpl: reply(ents), ...fast })
  // malformed value snaks -> failed
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'value' } }))).outcome, 'failed', 'value snak with no datavalue')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: 'https://mercury.com/' } }))).outcome, 'failed', 'datavalue is not a record')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { type: 'string' } } }))).outcome, 'failed', 'datavalue with no value')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 42 } } }))).outcome, 'failed', 'value is the wrong type')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: 'Q5' } } } }))).outcome, 'failed', 'value is an object')
  assert.equal((await ask(one({ rank: 'normal' }))).outcome, 'failed', 'no mainsnak')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: 'x' }))).outcome, 'failed', 'mainsnak is not a record')
  // legitimate no-value / unknown-value statements -> empty
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'novalue', property: 'P856' } }))).outcome, 'empty', 'novalue')
  assert.equal((await ask(one({ rank: 'normal', mainsnak: { snaktype: 'somevalue', property: 'P856' } }))).outcome, 'empty', 'somevalue')
  // a valid sibling claim keeps the answer ok
  const mixed = { entities: { Q1: { claims: { P856: [{ rank: 'normal', mainsnak: { snaktype: 'value' } }, { rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 'https://mercury.com/', type: 'string' } } }] } }, Q2: { claims: [] } } }
  const m = await ask(mixed)
  assert.equal(m.outcome, 'ok'); assert.deepEqual(m.hits.map(h => h.url), ['https://mercury.com/'])
})

test('1289-P1 r2 placeTerms: a place capture stops at a sentence end, so "at Mercury. Apply now." is no place; real places (Austin, St. Louis) are kept', () => {
  assert.deepEqual(placeTerms([], 'Sales Development Representative at Mercury. Apply now.', 'Mercury'), [])
  assert.deepEqual(placeTerms([], 'Mercury in Austin, TX is hiring a Sales Development Representative.', 'Mercury'), ['austin'])
  assert.ok(placeTerms([], 'Open at our office in St. Louis today.', 'Acme').includes('stlouis'))
})
