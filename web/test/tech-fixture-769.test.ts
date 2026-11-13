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

test('#769 fixture is staging-only: refused in production and without DAZL_ENV, and when the site crawl is off', async () => {
  const { db } = setup()
  for (const env of [{}, { DAZL_ENV: 'production', SITECRAWL_ENABLED: '1' }, { DAZL_ENV: 'Staging' }, { DAZL_STAGING_TECH_FIXTURE: '1' }] as Record<string, string>[]) {
    await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env }), /staging_only/)
    assert.throws(() => deleteTechFixture(db, 'A', env), /staging_only/)
  }
  await assert.rejects(crawlTechFixture(db, 'A', 'plain', { env: { DAZL_ENV: 'staging', SITECRAWL_ENABLED: '0' } }), /crawl_disabled/)
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

  // Measured against the pages actually served: 8 crawls, 4 of them unreadable or failed, 2 changes claimed, none false.
  assert.deepEqual(g.measured, { crawls: 8, unreadable_or_failed_crawls: 4, changes_claimed: 2, false_changes: 0, changes_claimed_on_unreadable_or_failed: 0 })

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

test('#769 the false-change measure counts a change the served page could not carry', () => {
  for (const p of ['consent_wall', 'challenge', 'outage_503'] as const) for (const v of ['HubSpot added', 'HubSpot removed']) assert.equal(techFixtureFalseChange(p, v), true)
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
  const b = await crawl('B', 'plain')
  assert.notEqual(b.lead_id, a1.lead_id)
  assert.deepEqual(b.changes, []) // B's first readable page is not compared with A's observations
  assert.equal(b.measured.crawls, 1)
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
  assert.deepEqual(TECH_FIXTURE_PAGES.map(read), [[200, 'ok', []], [200, 'ok', ['HubSpot']], [200, 'thin_page', []], [200, 'blocked', []], [503, 'http_error', []]])
})

// Real rows: every tech_scan observation on staging.dazl.ai, read through the ops door on 2026-11-13 (value | label, as stored).
// Six repeat comparisons of four real sites, one blocked first visit: the rule must claim no change from any of them.
const STAGING_ROWS = `apparate.com.au|1794594505 tech-scan-v1|1|/|ok|
armstrongteasdale.com|1794594679 tech-scan-v1|1|/|ok|ga,wordpress
balsamdental.com|1794526482 tech-scan-v1|1|/|ok|wix
balsamdental.com|1794526716 tech-scan-v1|1|/|ok|wix
beneschlaw.com|1794594703 tech-scan-v1|1|/|ok|wordpress
dealermatix.com|1794595045 tech-scan-v1|1|/|ok|ga,wordpress
dealermatix.com|1794595256 tech-scan-v1|1|/|ok|ga,wordpress
dentistryonking.net|1794576477 tech-scan-v1|1|/|ok|webflow
dentistryonking.net|1794576687 tech-scan-v1|1|/|ok|webflow
docusign.com|1794582909 tech-scan-v1|1|/|ok|nextjs
dozuki.com|1794581752 tech-scan-v1|1|/|ok|hubspot,jquery
dynatrace.com|1794562208 tech-scan-v1|1|/|ok|
flexport.com|1794562189 tech-scan-v1|1|/|blocked|
mcguirewoods.com|1794594689 tech-scan-v1|1|/|ok|wordpress
milbank.com|1794594642 tech-scan-v1|1|/|ok|
nousucollective.com|1794594491 tech-scan-v1|1|/|ok|ga
qagency.com.au|1794594521 tech-scan-v1|1|/|ok|ga
qualtrics.com|1794562175 tech-scan-v1|1|/|ok|drupal
qualtrics.com|1794581808 tech-scan-v1|1|/|ok|drupal
qualtrics.com|1794582856 tech-scan-v1|1|/|ok|drupal
qualtrics.com|1794595780 tech-scan-v1|1|/|ok|drupal
rapidious.com|1794584923 tech-scan-v1|1|/|ok|ga,webflow
roofroyale.com|1794593109 tech-scan-v1|1|/|ok|ga
smartsheet.com|1794595794 tech-scan-v1|1|/|ok|drupal
stripe.com|1794582870 tech-scan-v1|1|/|ok|nextjs
vercel.com|1794266651 tech-scan-v1|1|/|ok|nextjs`
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
  // The real blocked page (flexport.com) followed by a readable page WITH a technology must not read as an adoption, and a readable
  // page followed by that blocked page must not read as a removal.
  const flex = all.find(s => s.domain === 'flexport.com')!
  assert.equal(flex.obs, 'blocked')
  const ok = (at: number, present: string[]): TechScan => ({ ...flex, at, obs: 'ok', present })
  assert.deepEqual(techChanges([flex, ok(flex.at + 3600, ['HubSpot'])], 'flexport.com'), [])
  assert.deepEqual(techChanges([ok(flex.at - 7200, ['HubSpot']), ok(flex.at - 3600, ['HubSpot']), flex, { ...flex, at: flex.at + 60 }], 'flexport.com'), [])
})
