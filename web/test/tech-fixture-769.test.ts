// #769 live-check fixture (lib/scan/tech-fixture.ts): the switchable staging homepage, crawled through the REAL site crawl
// (crawlJob -> crawlSite -> recordTechObservation -> techChanges). Only the fetch is local; no network (net-fence).
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { crawlTechFixture, deleteTechFixture, techFixtureGet, techFixtureHtml, techFixtureFalseChange, TECH_FIXTURE_SITE, TECH_FIXTURE_COMPANY, TECH_FIXTURE_PAGES, type TechFixturePage } from '../lib/scan/tech-fixture.ts'
import { decodeScan, techChanges, type TechScan } from '../lib/signals/tech-observations.ts'
import { detectTech, observability } from '../lib/connectors/techstack.ts'
import { listLeads } from '../lib/scan/store.ts'

const STAGING = { DAZL_ENV: 'staging', SITECRAWL_ENABLED: '1' }
function setup() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  let t = 1_794_600_000_000
  const now = () => (t += 1000) // each crawl is one second after the last: a new dated observation
  const crawl = (tenant: string, p: TechFixturePage) => crawlTechFixture(db, tenant, p, { env: STAGING, now })
  return { db, crawl, now }
}
const values = (r: { changes: { value: string }[] }) => r.changes.map(c => c.value)
const deleteTechFixtureFresh = async (db: Database.Database) => { assert.deepEqual(deleteTechFixture(db, 'A', STAGING), { deleted: true }) }

test('#769 fixture is staging-only: refused in production and without DAZL_ENV, and when the site crawl or its technology branch is off', async () => {
  const { db } = setup()
  for (const env of [{}, { DAZL_ENV: 'production', SITECRAWL_ENABLED: '1' }, { DAZL_ENV: 'Staging' }, { DAZL_STAGING_TECH_FIXTURE: '1' }] as Record<string, string>[]) {
    await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env }), /staging_only/)
    assert.throws(() => deleteTechFixture(db, 'A', env), /staging_only/)
  }
  await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env: { DAZL_ENV: 'staging', SITECRAWL_ENABLED: '0' } }), /crawl_disabled/)
  await assert.rejects(crawlTechFixture(db, 'A', 'hubspot', { env: { ...STAGING, TECH_SCAN_ENABLED: '0' } }), /tech_scan_disabled/)
  await assert.rejects(crawlTechFixture(db, 'A', 'nope' as TechFixturePage, { env: STAGING }), /unknown_page/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, 0)
})

test('#769 adoption after one readable change; an outage, a consent wall and a challenge page never imply removal; removal only after two readable absences', async () => {
  const { db, crawl } = setup()
  const a = await crawl('A', 'plain')
  assert.equal(a.crawl.tech, 'observed ok: 0 technologies, 0 changes; pages 1')
  assert.deepEqual(a.observations.map(o => [o.readability, o.technologies]), [['ok', []]])
  assert.deepEqual(a.changes, [])

  const b = await crawl('A', 'hubspot')
  assert.equal(b.crawl.tech, 'observed ok: 1 technologies, 1 changes; pages 1')
  assert.deepEqual(b.crawl.new_changes, ['HubSpot added'])
  assert.equal(b.changes.length, 1)
  assert.match(b.changes[0].label ?? '', /^not seen \d{4}-\d\d-\d\d, seen \d{4}-\d\d-\d\d; same page, detector v1, homepage HTML only \(static signatures\)$/)

  // The site goes down: nothing is observed, nothing is claimed.
  const c = await crawl('A', 'outage_503')
  assert.equal(c.crawl.new_observation, false)
  assert.equal(c.crawl.tech, 'no_observation: no homepage verdict; pages 0')
  assert.equal(c.crawl.status, 'robots_error')
  assert.deepEqual(values(c), ['HubSpot added'])
  // Only the homepage is down (robots.txt still answers): the crawl reaches the homepage, reads nothing, records nothing.
  const c2 = await crawl('A', 'home_503')
  assert.equal(c2.crawl.status, 'site_unreachable')
  assert.equal(c2.crawl.tech, null)
  assert.equal(c2.crawl.new_observation, false)
  assert.equal(c2.observations.length, 2)
  assert.deepEqual(values(c2), ['HubSpot added'])
  // A cookie wall: the page loads but shows none of the site's scripts. Recorded as unreadable, never as "HubSpot gone".
  const d = await crawl('A', 'consent_wall')
  // ('1 changes' in the crawl's ledger line is the count the history still confirms, the earlier adoption: nothing new was written)
  assert.equal(d.crawl.tech, 'observed thin_page: 0 technologies, 1 changes; pages 1')
  assert.deepEqual(d.crawl.new_changes, [])
  assert.deepEqual(d.observations.at(-1) && [d.observations.at(-1)!.readability, d.observations.at(-1)!.technologies], ['thin_page', []])
  assert.deepEqual(values(d), ['HubSpot added'])
  const e = await crawl('A', 'challenge')
  assert.equal(e.crawl.tech, 'observed blocked: 0 technologies, 1 changes; pages 1')
  assert.deepEqual(e.crawl.new_changes, [])
  assert.deepEqual(values(e), ['HubSpot added'])
  // Two unreadable pages in a row are still not two readable absences.
  assert.deepEqual(values(await crawl('A', 'consent_wall')), ['HubSpot added'])

  // One readable page without it: could be a template variant or a bad deploy. Not a removal yet.
  const f = await crawl('A', 'plain')
  assert.deepEqual(f.crawl.new_changes, [])
  assert.deepEqual(values(f), ['HubSpot added'])
  // The second readable absence confirms it.
  const g = await crawl('A', 'plain')
  assert.deepEqual(g.crawl.new_changes, ['HubSpot removed'])
  assert.match(g.changes.find(x => x.value === 'HubSpot removed')!.label ?? '', /^seen \d{4}-\d\d-\d\d, not seen \d{4}-\d\d-\d\d and \d{4}-\d\d-\d\d; same page, detector v1/)

  // Measured against the pages actually served: 9 crawls, 5 of them unreadable or failed, 2 changes claimed, none false.
  assert.deepEqual(g.measured, { crawls: 9, unreadable_or_failed_crawls: 5, changes_claimed: 2, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })

  // The rows are the lead's own enrichment rows, the ones the Leads card lists ("a change between dated checks of the same company web page").
  const rows = db.prepare("SELECT kind, value FROM lead_enrichments WHERE tenant_id = 'A' AND lead_id = ? AND kind IN ('tech_change', 'domain') ORDER BY kind, value").all(g.lead_id) as { kind: string; value: string }[]
  assert.deepEqual(rows, [{ kind: 'domain', value: `${TECH_FIXTURE_SITE}|evidence_own_domain` }, { kind: 'tech_change', value: 'HubSpot added' }, { kind: 'tech_change', value: 'HubSpot removed' }])
  const leads = listLeads(db, 'A', g.job_id, 200, false) as { company: string; source_kind: string; contact: string | null }[]
  assert.deepEqual(leads.map(l => [l.company, l.source_kind, l.contact]), [[TECH_FIXTURE_COMPANY, 'test', null]])
})

test('#769 an outage between two readable pages with the same stack changes nothing', async () => {
  const { crawl } = setup()
  await crawl('A', 'hubspot')
  await crawl('A', 'outage_503')
  await crawl('A', 'challenge')
  await crawl('A', 'consent_wall')
  const r = await crawl('A', 'hubspot')
  assert.deepEqual(r.changes, [])
  assert.deepEqual(r.observations.map(o => o.readability), ['ok', 'blocked', 'thin_page', 'ok'])
  assert.deepEqual(r.measured, { crawls: 5, unreadable_or_failed_crawls: 3, changes_claimed: 0, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })
})

test('#769 one history shows one adoption and one removal: the technology coming back is the same install, nothing new is claimed; a second crawl at once is refused', async () => {
  const { db, crawl } = setup()
  for (const p of ['plain', 'hubspot', 'plain', 'plain'] as const) await crawl('A', p)
  const again = await crawl('A', 'hubspot')
  assert.deepEqual(again.crawl.new_changes, [])
  assert.deepEqual(values(again), ['HubSpot added', 'HubSpot removed'])
  assert.deepEqual(again.measured, { crawls: 5, unreadable_or_failed_crawls: 0, changes_claimed: 2, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })
  // two calls at once for one workspace: the second is refused and counts nothing; another workspace is not held up
  const [a, b, c] = await Promise.allSettled([crawl('A', 'plain'), crawl('A', 'plain'), crawl('B', 'plain')])
  assert.equal(a.status, 'fulfilled'); assert.equal(c.status, 'fulfilled')
  assert.equal(b.status, 'rejected'); assert.match(String((b as PromiseRejectedResult).reason), /crawl_in_flight/)
  assert.equal((await crawl('A', 'plain')).measured.crawls, 7)
  // cleanup while a crawl is running is refused (its rows would land under deleted ids); afterwards it removes everything
  const running = crawl('A', 'plain')
  assert.throws(() => deleteTechFixture(db, 'A', STAGING), /crawl_in_flight/)
  await running
  assert.deepEqual(deleteTechFixture(db, 'A', STAGING), { deleted: true })
  assert.equal((db.prepare("SELECT count(*) AS n FROM connector_audit WHERE tenant_id = 'A'").get() as { n: number }).n, 0)
})

test('#769 a clock that does not move past the last observation is refused, and nothing is written', async () => {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const frozen = () => 1_794_600_000_000
  await crawlTechFixture(db, 'A', 'plain', { env: STAGING, now: frozen })
  const rows = () => (db.prepare('SELECT count(*) AS n FROM lead_enrichments').get() as { n: number }).n + (db.prepare('SELECT count(*) AS n FROM connector_audit').get() as { n: number }).n
  const before = rows()
  await assert.rejects(crawlTechFixture(db, 'A', 'hubspot', { env: STAGING, now: frozen }), /clock_not_advancing/)
  assert.equal(rows(), before)
  // the refusal released the workspace: the next crawl on a moving clock runs
  assert.deepEqual((await crawlTechFixture(db, 'A', 'hubspot', { env: STAGING, now: () => 1_794_600_002_000 })).crawl.new_changes, ['HubSpot added'])
})

test('#769 a crawl that was cut short or failed inside is refused as incomplete, never reported as "nothing changed"', async () => {
  const { db, crawl } = setup()
  await crawl('A', 'hubspot')
  const counts = () => db.prepare("SELECT (SELECT count(*) FROM lead_enrichments) AS e, (SELECT count(*) FROM connector_audit WHERE connector = 'staging:tech-fixture') AS f").get()
  const before = counts()
  let t = 1_794_700_000_000
  await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env: STAGING, now: () => (t += 1000), signal: AbortSignal.abort() }), /crawl_incomplete/)
  await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env: STAGING, now: () => (t += 1000), get: async () => { throw new Error('boom') } }), /crawl_incomplete/)
  assert.deepEqual(counts(), before)
})

test('#769 a failed technology branch is refused as incomplete; a change the served page could not carry is counted as false', async () => {
  const { db, crawl, now } = setup()
  await crawl('A', 'plain')
  // the observation write fails inside the technology branch: refused, and no fixture crawl is counted
  db.exec("CREATE TRIGGER fail_scan BEFORE INSERT ON lead_enrichments WHEN NEW.kind = 'tech_scan' BEGIN SELECT RAISE(ABORT, 'boom'); END")
  await assert.rejects(crawlTechFixture(db, 'A', 'hubspot', { env: STAGING, now }), /crawl_incomplete/)
  db.exec('DROP TRIGGER fail_scan')
  // the step fails half-way: the observation is written, the change row is not. The refused attempt leaves neither behind, so the
  // retry is the crawl that claims the adoption and is counted for it.
  db.exec("CREATE TRIGGER fail_change BEFORE INSERT ON lead_enrichments WHEN NEW.kind = 'tech_change' BEGIN SELECT RAISE(ABORT, 'boom'); END")
  await assert.rejects(crawlTechFixture(db, 'A', 'hubspot', { env: STAGING, now }), /crawl_incomplete/)
  db.exec('DROP TRIGGER fail_change')
  assert.equal((db.prepare("SELECT count(*) AS n FROM lead_enrichments WHERE tenant_id = 'A' AND kind IN ('tech_scan', 'tech_change')").get() as { n: number }).n, 1)
  const retry = await crawl('A', 'hubspot')
  assert.deepEqual(retry.crawl.new_changes, ['HubSpot added'])
  assert.deepEqual(retry.observations.map(o => o.technologies), [[], ['HubSpot']])
  assert.deepEqual(retry.measured, { crawls: 2, unreadable_or_failed_crawls: 0, changes_claimed: 1, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })
  await deleteTechFixtureFresh(db)
  await crawl('A', 'plain')
  assert.equal((await crawl('A', 'plain')).measured.crawls, 2)
  // The measure is not zero by construction: the caller says the page is `plain`, the crawl is handed a page WITH HubSpot, so the
  // detector's (correct) adoption is a change the declared page could not carry and is counted as false.
  const hubspot = techFixtureHtml('hubspot')
  const lying = await crawlTechFixture(db, 'A', 'plain', { env: STAGING, now, get: async (url) => (new URL(url).pathname === '/' ? { ...hubspot, finalUrl: url } : { status: 404, body: '', finalUrl: url }) })
  assert.deepEqual(lying.crawl.new_changes, ['HubSpot added'])
  assert.deepEqual(lying.measured, { crawls: 3, unreadable_or_failed_crawls: 0, changes_claimed: 1, false_changes: 1, changes_claimed_on_unreadable_or_failed: 0 })
})

test('#769 the false-change measure counts a change the served page could not carry', () => {
  for (const p of ['consent_wall', 'challenge', 'outage_503', 'home_503'] as const) for (const v of ['HubSpot added', 'HubSpot removed']) assert.equal(techFixtureFalseChange(p, v), true)
  assert.equal(techFixtureFalseChange('hubspot', 'HubSpot added'), false)
  assert.equal(techFixtureFalseChange('hubspot', 'HubSpot removed'), true)
  assert.equal(techFixtureFalseChange('plain', 'HubSpot removed'), false)
  assert.equal(techFixtureFalseChange('plain', 'HubSpot added'), true)
  assert.equal(techFixtureFalseChange('plain', 'Intercom added'), true)
})

test('#769 one fixture per workspace; cleanup removes every row it wrote and nothing of another workspace', async () => {
  const { db, crawl } = setup()
  const a1 = await crawl('A', 'plain'), a2 = await crawl('A', 'hubspot')
  assert.equal(a1.job_id, a2.job_id); assert.equal(a1.lead_id, a2.lead_id)
  // B's first readable page shows HubSpot. Compared with A's earlier page without it, that would read as an adoption: it must not.
  const b = await crawl('B', 'hubspot')
  assert.notEqual(b.lead_id, a1.lead_id)
  assert.deepEqual(b.changes, [])
  assert.equal(b.observations.length, 1)
  assert.equal(b.measured.crawls, 1)
  // and A's history is A's alone: B's HubSpot page does not stand in for a readable page of A's
  assert.deepEqual((await crawl('A', 'plain')).crawl.new_changes, [])
  assert.deepEqual(deleteTechFixture(db, 'A', STAGING), { deleted: true })
  assert.deepEqual(deleteTechFixture(db, 'A', STAGING), { deleted: false })
  const n = (sql: string, ...a: string[]) => (db.prepare(sql).get(...a) as { n: number }).n
  for (const t of ['lead_enrichments', 'connector_audit', 'crawl_pages']) assert.equal(n(`SELECT count(*) AS n FROM ${t} WHERE tenant_id = ?`, 'A'), 0, t)
  assert.equal(n('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?', 'A'), 0)
  assert.equal(n('SELECT count(*) AS n FROM leads'), 1)
  assert.ok(n('SELECT count(*) AS n FROM lead_enrichments WHERE tenant_id = ?', 'B') > 0)
  // a fresh fixture starts from nothing: the old observations are gone
  assert.deepEqual((await crawl('A', 'hubspot')).changes, [])
})

test('#769 the fixture fetcher answers only its own reserved-TLD site, and each page reads as its variant says', async () => {
  assert.ok(TECH_FIXTURE_SITE.endsWith('.test'))
  const get = techFixtureGet('hubspot')
  for (const url of ['https://example.com/', `http://${TECH_FIXTURE_SITE}/`, `https://www.${TECH_FIXTURE_SITE}/`, `https://${TECH_FIXTURE_SITE}.evil.example/`, 'not a url']) assert.equal(await get(url), null, url)
  assert.equal((await get(`https://${TECH_FIXTURE_SITE}/`))?.status, 200)
  const read = (p: TechFixturePage) => { const h = techFixtureHtml(p); return [h.status, observability(h.status, h.body), detectTech(h.body).map(t => t.name)] }
  assert.deepEqual(TECH_FIXTURE_PAGES.map(read), [[200, 'ok', []], [200, 'ok', ['HubSpot']], [200, 'thin_page', []], [200, 'blocked', []], [503, 'http_error', []], [503, 'http_error', []]])
  // home_503: robots.txt answers (404 = no rules), only the homepage is down
  assert.equal((await techFixtureGet('home_503')(`https://${TECH_FIXTURE_SITE}/robots.txt`))?.status, 404)
  assert.equal((await techFixtureGet('home_503')(`https://${TECH_FIXTURE_SITE}/`))?.status, 503)
  assert.equal((await techFixtureGet('outage_503')(`https://${TECH_FIXTURE_SITE}/robots.txt`))?.status, 503)
})

// Real rows: every tech_scan observation on staging.dazl.ai on 2026-11-13, with its stored label and time exactly as written by the
// crawl. Only the scanned sites' names are replaced (site01..site20), one name per real domain, so no workspace's targets are in the repo.
// Six repeat comparisons of four real sites, one blocked first visit: the rule must claim no change from any of them.
const STAGING_ROWS = `site01.example.test|1794594505 tech-scan-v1|1|/|ok|
site02.example.test|1794594679 tech-scan-v1|1|/|ok|ga,wordpress
site03.example.test|1794526482 tech-scan-v1|1|/|ok|wix
site03.example.test|1794526716 tech-scan-v1|1|/|ok|wix
site04.example.test|1794594703 tech-scan-v1|1|/|ok|wordpress
site05.example.test|1794595045 tech-scan-v1|1|/|ok|ga,wordpress
site05.example.test|1794595256 tech-scan-v1|1|/|ok|ga,wordpress
site06.example.test|1794576477 tech-scan-v1|1|/|ok|webflow
site06.example.test|1794576687 tech-scan-v1|1|/|ok|webflow
site07.example.test|1794582909 tech-scan-v1|1|/|ok|nextjs
site08.example.test|1794581752 tech-scan-v1|1|/|ok|hubspot,jquery
site09.example.test|1794562208 tech-scan-v1|1|/|ok|
site10.example.test|1794562189 tech-scan-v1|1|/|blocked|
site11.example.test|1794594689 tech-scan-v1|1|/|ok|wordpress
site12.example.test|1794594642 tech-scan-v1|1|/|ok|
site13.example.test|1794594491 tech-scan-v1|1|/|ok|ga
site14.example.test|1794594521 tech-scan-v1|1|/|ok|ga
site15.example.test|1794562175 tech-scan-v1|1|/|ok|drupal
site15.example.test|1794581808 tech-scan-v1|1|/|ok|drupal
site15.example.test|1794582856 tech-scan-v1|1|/|ok|drupal
site15.example.test|1794595780 tech-scan-v1|1|/|ok|drupal
site16.example.test|1794584923 tech-scan-v1|1|/|ok|ga,webflow
site17.example.test|1794593109 tech-scan-v1|1|/|ok|ga
site18.example.test|1794595794 tech-scan-v1|1|/|ok|drupal
site19.example.test|1794582870 tech-scan-v1|1|/|ok|nextjs
site20.example.test|1794266651 tech-scan-v1|1|/|ok|nextjs`
test('#769 real staging observations (26 rows, 2026-11-13): every row decodes, 6 repeat comparisons, 0 changes claimed', () => {
  const scans = STAGING_ROWS.split('\n').map(l => { const [value, label] = l.split(' '); return decodeScan(value, label, `https://${value.split('|')[0]}/`) })
  assert.equal(scans.filter(Boolean).length, 26)
  const all = scans as TechScan[]
  const domains = [...new Set(all.map(s => s.domain))]
  assert.equal(domains.length, 20)
  let comparisons = 0
  for (const d of domains) {
    comparisons += Math.max(0, all.filter(s => s.domain === d && s.obs === 'ok').length - 1)
    assert.deepEqual(techChanges(all, d), [], d)
  }
  assert.equal(comparisons, 6)
  // The real blocked page (the one site that refused the crawl) followed by a readable page WITH a technology must not read as an adoption, and a readable
  // page followed by that blocked page must not read as a removal.
  const flex = all.find(s => s.domain === 'site10.example.test')!
  assert.equal(flex.obs, 'blocked')
  const ok = (at: number, present: string[]): TechScan => ({ ...flex, at, obs: 'ok', present })
  assert.deepEqual(techChanges([flex, ok(flex.at + 3600, ['HubSpot'])], 'site10.example.test'), [])
  assert.deepEqual(techChanges([ok(flex.at - 7200, ['HubSpot']), ok(flex.at - 3600, ['HubSpot']), flex, { ...flex, at: flex.at + 60 }], 'site10.example.test'), [])
})
