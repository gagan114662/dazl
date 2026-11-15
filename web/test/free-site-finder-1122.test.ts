// #1122: a lead's company website from free public data (Wikidata's official website, OpenStreetMap's website tag), no paid search.
// Stubbed Wikidata / Nominatim answers and synthetic sites: no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { crawlJob, type Get } from '../lib/connectors/sitecrawl.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { freeSiteFinderFor, siteFinderFor, FREE_SITE_LOOKUPS_PER_SCAN } from '../lib/scan/runner.ts'
import { freeCompanySites, osmSites, resetFreeSiteFinderPacing, sameCompanyName, wikidataSites, FREE_SITE_UA } from '../lib/connectors/free-site-finder.ts'

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
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Mercury - banking for startups</body></html>', 'mercury.io': '<html><body>Mercury Plumbing, Leeds</body></html>' }), gapMs: 0, env: {}, findSites: (c, w) => findSites(c, w), recordSite: findSites.recordSite })
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
  await crawlJob(db, 't1', 'j1', { get: site({ 'mercury.com': '<html><body>Domain for sale</body></html>' }), gapMs: 0, env: {}, findSites: (c, w) => findSites(c, w), recordSite: findSites.recordSite })
  assert.equal((db.prepare('SELECT company_domain AS d FROM leads').get() as { d: string | null }).d, null)
})
