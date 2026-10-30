import { test } from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createJob, exportLeads } from '../lib/scan/store.ts'
import { migrateConnectors, addEnrichment } from '../lib/connectors/store.ts'
import { toCsv } from '../lib/scan/csv.ts'
import { bestPeople } from '../lib/people/best-person.ts'

// Export: the one person to reach first per lead, ranked by the scan's own buyer roles. TEST-ONLY fixture.
function setup(icpWho: string[]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(JSON.stringify({ summary: 's', who: icpWho }), job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit,why) VALUES (?,?,?,?,?,?,?,?)').run('L1', job, 'Acme Dental', 'Opening a second clinic', 'https://news.example/a', 80, 5, 'Opening a second clinic in Toronto next month.')
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L2', job, 'Beta', 'Raised a seed round', 'https://news.example/b', 70, 4)
  const add = (connector: string, value: string, url: string) => addEnrichment(db, 'A', 'L1', { connector, kind: 'person', value, label: 'x', confidence: null, source_url: url, source_date: '2026-10-26', retrieved_at: 1 })
  add('sitecrawl', 'Dana Lee, CEO', 'https://acmedental.com/team')
  add('search:people', 'Jane Doe, Practice Manager', 'https://www.linkedin.com/in/jane-doe-1')
  return { db, job }
}

test('best person follows the scan buyer roles; link and source in words; leads without people stay empty', async () => {
  const { db } = setup(['Practice manager'])
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string; why: string | null }[]
  const m = await bestPeople(sqliteDb(db), 'A', rows)
  assert.deepEqual(m.get('L1'), { best_person: 'Jane Doe', best_person_title: 'Practice Manager', best_person_link: 'https://www.linkedin.com/in/jane-doe-1', best_person_found_via: 'a public LinkedIn search result (not verified as current)' })
  assert.deepEqual(m.get('L2'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' })
  assert.equal(rows.find(r => r.lead_id === 'L1')!.why, 'Opening a second clinic in Toronto next month.')
})

test('different buyer roles pick a different person; a company-page person links to its source page', async () => {
  const { db } = setup(['CEO', 'Owner'])
  const m = await bestPeople(sqliteDb(db), 'A', exportLeads(db, 'A') as { lead_id: string; job_id: string }[])
  assert.deepEqual(m.get('L1'), { best_person: 'Dana Lee', best_person_title: 'CEO', best_person_link: 'https://acmedental.com/team', best_person_found_via: 'the company website (listed with this title)' })
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
  addEnrichment(db, 'A', 'L1', { connector: 'search:people', kind: 'person', value: 'Old Timer, Former Practice Manager', label: 'x', confidence: null, source_url: 'https://www.linkedin.com/in/old', source_date: '2026-10-26', retrieved_at: 1 })
  db.prepare("DELETE FROM lead_enrichments WHERE value LIKE 'Jane%'").run()
  const rows = [{ lead_id: 'L1', job_id: (db.prepare('SELECT scan_job_id j FROM leads WHERE id = ?').get('L1') as { j: string }).j }]
  assert.equal((await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!.best_person, 'Dana Lee')
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
import { recommendedPerson, contactsFromEnrichments } from '../lib/people/rank.ts'
async function oneLead(who: string[], people: [string, string, string][]) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running', icp = ? WHERE id = ?").run(who.length ? JSON.stringify({ summary: 's', who }) : null, job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L1', job, 'Acme', 's', 'https://n.example/a', 80, 5)
  for (const [connector, value, url] of people) addEnrichment(db, 'A', 'L1', { connector, kind: 'person', value, label: 'x', confidence: null, source_url: url, source_date: '2026-10-26', retrieved_at: 1 })
  const rows = [{ lead_id: 'L1', job_id: job }]
  const enr = (db.prepare("SELECT kind, value, label, source_url, connector FROM lead_enrichments WHERE lead_id = 'L1'").all()) as Parameters<typeof contactsFromEnrichments>[0]
  const roles = who.join('; ')
  const card = recommendedPerson(contactsFromEnrichments(enr, roles), roles)
  return { csv: (await bestPeople(sqliteDb(db), 'A', rows)).get('L1')!, card, db, rows }
}
test('card and CSV agree: a sole contradicted stored person (any connector) is nobody; valid-role controls', async () => {
  for (const connector of ['sitecrawl', 'search:people', 'enrich:apollo', 'adv:linkedin']) {
    for (const t of ['Not Practice Manager', 'Assistant to Practice Manager', 'Former Practice Manager', 'Retired Practice Manager']) {
      const { csv, card } = await oneLead(['Practice manager'], [[connector, `Eli Novak, ${t}`, 'https://acme.example/team']])
      assert.equal(csv.best_person, '', `${connector} ${t}`); assert.equal(card, null, `${connector} ${t}`)
    }
    const ok = await oneLead(['Practice manager'], [[connector, 'Eli Novak, Practice Manager', 'https://acme.example/team']])
    assert.equal(ok.csv.best_person, 'Eli Novak'); assert.equal(ok.card?.name, 'Eli Novak')
  }
})
test('card and CSV agree when a valid row sits beside contradicted ones, with no ICP, and when assistants are requested', async () => {
  const mixed = await oneLead(['Practice manager'], [['sitecrawl', 'Eli Novak, Not Practice Manager', 'https://a.example/t'], ['search:people', 'Dana Lee, Practice Manager', 'https://www.linkedin.com/in/dana-lee'], ['enrich:apollo', 'Bo Ray, Assistant to Practice Manager', 'https://a.example/t']])
  assert.equal(mixed.csv.best_person, 'Dana Lee'); assert.equal(mixed.card?.name, 'Dana Lee')
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
