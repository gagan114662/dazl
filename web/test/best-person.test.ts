import { test } from 'node:test'
import { tiedLabel } from '../lib/people/company-tie.ts'
import { LABEL } from '../lib/people/people-search.ts'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { toCsv } from '../lib/scan/csv.ts'
import { bestPeople } from '../lib/people/best-person.ts'
import { ownSiteBuyerRows } from './helpers/own-site-buyer.ts'

// Export: the one person to reach first per lead, ranked by the scan's own buyer roles. TEST-ONLY fixture.
function setup(icpWho: string[]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', who: icpWho }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit,why) VALUES (?,?,?,?,?,?,?,?)').run('L1', job, 'Acme Dental', 'Opening a second clinic', 'https://news.example/a', 80, 5, 'Opening a second clinic in Toronto next month.')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L2', job, 'Beta', 'Raised a seed round', 'https://news.example/b', 70, 4)
  const add = (connector: string, value: string, url: string) => addEnrichment(db, 'A', 'L1', { connector, kind: 'person', value, label: connector === 'search:people' ? TIED : 'x', confidence: null, source_url: url, source_date: '2026-10-26', retrieved_at: 1 })
  add('sitecrawl', 'Dana Lee, CEO', 'https://acmedental.com/team')
  add('search:people', 'Jane Doe, Practice Manager', 'https://www.linkedin.com/in/jane-doe-1')
  return { db, job }
}

// #1037: Best Person is the lead's buyer: a person the company's own, confirmed site lists with a title and the LinkedIn that page links.
const own = (db: Database.Database, lead: string, o: Parameters<typeof ownSiteBuyerRows>[1] = {}, host = 'acmedental.com') => { for (const r of ownSiteBuyerRows(host, o)) addEnrichment(db, 'A', lead, r) }
test('best person is the own-site buyer, never a search result; link and source in words; leads without one stay empty', async () => {
  const { db } = setup(['Practice manager'])
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string; why: string | null }[]
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, '', 'a public LinkedIn search result is never Best Person (#1037)')
  own(db, 'L1', { name: 'Jane Doe', title: 'Practice Manager' })
  const m = await bestPeople(sqliteDb(db), 'A', rows)
  assert.equal(m.get('L1')!.best_person, 'Jane Doe'); assert.equal(m.get('L1')!.best_person_title, 'Practice Manager')
  assert.equal(m.get('L1')!.best_person_link, 'https://www.linkedin.com/in/jane-doe-example', 'the LinkedIn the company page links')
  assert.match(m.get('L1')!.best_person_found_via, /^the company website \(listed with this title\); verified current: named on the company's own website/)
  assert.deepEqual(m.get('L2'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' })
  assert.equal(rows.find(r => r.lead_id === 'L1')!.why, 'Opening a second clinic in Toronto next month.')
})

test('different buyer roles pick a different own-site person; a company-page person with no LinkedIn on its page, or on an unestablished site, is nobody', async () => {
  const { db } = setup(['CEO', 'Owner'])
  // #781: with no recorded website identity the crawled page is not "the company website"; #1037: and its page links no LinkedIn
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string }[]
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, '')
  own(db, 'L1', { name: 'Jane Doe', title: 'Practice Manager' }); own(db, 'L1', { name: 'Ana Ruiz', title: 'CEO' })
  // the crawl recorded acmedental.com as the cited page's own domain: Dana Lee is on it, but her page links no LinkedIn
  const m = await bestPeople(sqliteDb(db), 'A', rows)
  assert.equal(m.get('L1')!.best_person, 'Ana Ruiz', 'the CEO role picks the own-site CEO, not the practice manager')
  assert.equal(m.get('L1')!.best_person_link, 'https://www.linkedin.com/in/ana-ruiz-example')
})

test('older schema without lead_enrichments and an empty export do not throw', async () => {
  assert.equal((await bestPeople(sqliteDb(new Database(':memory:')), 'A', [])).size, 0)
  const db = new Database(':memory:'); migrateScan(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L1', job, 'Acme', 's', 'https://n.example/a', 80, 5)
  assert.equal((await bestPeople(sqliteDb(db), 'A', exportLeads(db, 'A') as { lead_id: string; job_id: string }[])).get('L1')!.best_person, '')
})

test('another tenant\'s enrichment row, or a lead it does not own, is never selected', async () => {
  const { db } = setup(['Practice manager'])
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string }[]
  db.prepare("UPDATE lead_enrichments SET tenant_id = 'B'").run()
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, '')
  db.prepare("UPDATE lead_enrichments SET tenant_id = 'A'").run()
  assert.equal((await bestPeople(sqliteDb(db), 'B', rows)).get('L1')!.best_person, '')
})

test('a quarantined lead and a former/previous role are never the best person', async () => {
  const { db } = setup(['Practice manager'])
  addEnrichment(db, 'A', 'L1', { connector: 'search:people', kind: 'person', value: 'Old Timer, Former Practice Manager', label: TIED, confidence: null, source_url: 'https://www.linkedin.com/in/old', source_date: '2026-10-26', retrieved_at: 1 })
  db.prepare("DELETE FROM lead_enrichments WHERE value LIKE 'Jane%'").run()
  own(db, 'L1', { name: 'Ex Manager', title: 'Former Practice Manager' }); own(db, 'L1', { name: 'Jo Park', title: 'Practice Manager' })
  const rows = [{ lead_id: 'L1', job_id: (db.prepare('SELECT scan_job_id j FROM leads WHERE id = ?').get('L1') as { j: string }).j }]
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, 'Jo Park')
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'L1'").run()
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, '')
})

test('CSV neutralises formulas in every person/title/link/source/why field', async () => {
  const f = '=HYPERLINK("x")'
  const csv = toCsv([{ best_person: f, best_person_title: '+1', best_person_link: '@a', best_person_found_via: '-b', why: '=1' }],
    ['best_person', 'best_person_title', 'best_person_link', 'best_person_found_via', 'why'].map(key => ({ key, label: key })))
  const body = csv.split('\r\n')[1]
  assert.ok(!/(^|,)"?[=+@-]/.test(body), body)
})

// Instinct #196 review: the same STORED lead must give the same answer in the card and the CSV. A sole Former / Not /
// Assistant-to row is not Best Person and not the card's who, for stored rows of every connector.
import { contactsFromEnrichments } from '../lib/people/rank.ts'
import { leadPerson } from '../lib/people/lead-person.ts'
import { identityOf } from '../lib/scan/opportunity.ts'
// A search result row as the search stores it now: its label says what tied it to the company beyond the name (company-tie.ts).
const TIED = tiedLabel(LABEL, 'domain')
async function oneLead(who: string[], people: [string, string, string][]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(who.length ? JSON.stringify({ summary: 's', who }) : null, job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L1', job, 'Acme', 's', 'https://n.example/a', 80, 5)
  // a sitecrawl person is stored as the real crawl stores an own-site bio (confirmed site, the LinkedIn its page links); others as their producers do
  for (const [connector, value, url] of people) {
    if (connector === 'sitecrawl') { const [name, title] = value.split(', '); for (const r of ownSiteBuyerRows('acme.example', { name, title })) addEnrichment(db, 'A', 'L1', r); continue }
    addEnrichment(db, 'A', 'L1', { connector, kind: 'person', value, label: connector === 'search:people' ? TIED : 'x', confidence: null, source_url: url, source_date: '2026-10-26', retrieved_at: 1 })
  }
  const rows = [{ lead_id: 'L1', job_id: job }]
  const enr = (db.prepare("SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = 'L1'").all()) as Parameters<typeof contactsFromEnrichments>[0]
  const roles = who.join('; ')
  // the card's buyer (opportunityCard's who is leadPerson on the lead's site identity, #1037)
  const card = leadPerson(enr, roles, Date.now(), identityOf({ id: 'L1', contact: null }, enr as never))
  return { csv: (await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!, card, db, rows }
}
test('card and CSV agree: a sole contradicted stored person (any connector) is nobody; valid-role controls', async () => {
  for (const connector of ['sitecrawl', 'search:people', 'enrich:apollo', 'adv:linkedin']) {
    for (const t of ['Not Practice Manager', 'Assistant to Practice Manager', 'Former Practice Manager', 'Retired Practice Manager']) {
      const { csv, card } = await oneLead(['Practice manager'], [[connector, `Eli Novak, ${t}`, 'https://acme.example/team']])
      assert.equal(csv.best_person, '', `${connector} ${t}`); assert.equal(card, null, `${connector} ${t}`)
    }
    // the valid-role control: only the company's own site names a buyer (#1037); a search, provider or other row is nobody in both
    const ok = await oneLead(['Practice manager'], [[connector, 'Eli Novak, Practice Manager', 'https://acme.example/team']])
    const want = connector === 'sitecrawl' ? 'Eli Novak' : ''
    assert.equal(ok.csv.best_person, want, connector); assert.equal(ok.card?.name ?? '', want, connector)
  }
})
test('card and CSV agree when a valid row sits beside contradicted ones, with no ICP, and when assistants are requested', async () => {
  const mixed = await oneLead(['Practice manager'], [['sitecrawl', 'Eli Novak, Not Practice Manager', 'https://a.example/t'], ['search:people', 'Dana Lee, Practice Manager', 'https://www.linkedin.com/in/dana-lee'], ['enrich:apollo', 'Bo Ray, Assistant to Practice Manager', 'https://a.example/t']])
  assert.equal(mixed.csv.best_person, '', 'the valid row is a search result: nobody (#1037)'); assert.equal(mixed.card, null)
  const mixedOwn = await oneLead(['Practice manager'], [['sitecrawl', 'Eli Novak, Not Practice Manager', 'https://a.example/t'], ['sitecrawl', 'Dana Lee, Practice Manager', 'https://a.example/t'], ['enrich:apollo', 'Bo Ray, Assistant to Practice Manager', 'https://a.example/t']])
  assert.equal(mixedOwn.csv.best_person, 'Dana Lee'); assert.equal(mixedOwn.card?.name, 'Dana Lee')
  const noIcp = await oneLead([], [['sitecrawl', 'Eli Novak, Former CEO', 'https://a.example/t']])
  assert.equal(noIcp.csv.best_person, ''); assert.equal(noIcp.card, null)
  const noIcpOk = await oneLead([], [['sitecrawl', 'Eli Novak, Former CEO', 'https://a.example/t'], ['sitecrawl', 'Dana Lee, CEO', 'https://a.example/t']])
  assert.equal(noIcpOk.csv.best_person, 'Dana Lee'); assert.equal(noIcpOk.card?.name, 'Dana Lee')
  const asst = await oneLead(['Office assistant'], [['sitecrawl', 'Pat Kim, Office Assistant', 'https://a.example/t'], ['sitecrawl', 'Al Roe, Assistant to the Office Assistant', 'https://a.example/t']])
  assert.equal(asst.csv.best_person, 'Pat Kim'); assert.equal(asst.card?.name, 'Pat Kim')
})
test('tenant and quarantine controls still hold with contradicted rows present', async () => {
  const { db, rows } = await oneLead(['Practice manager'], [['sitecrawl', 'Dana Lee, Practice Manager', 'https://a.example/t'], ['sitecrawl', 'Eli Novak, Former Practice Manager', 'https://a.example/t']])
  assert.equal((await bestPeople(sqliteDb(db), 'B', rows)).get('L1')!.best_person, '')
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'L1'").run()
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, '')
})
