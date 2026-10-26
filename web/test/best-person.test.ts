import { test } from 'node:test'
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

test('best person follows the scan buyer roles; link and source in words; leads without people stay empty', () => {
  const { db } = setup(['Practice manager'])
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string; why: string | null }[]
  const m = bestPeople(db, 'A', rows)
  assert.deepEqual(m.get('L1'), { best_person: 'Jane Doe', best_person_title: 'Practice Manager', best_person_link: 'https://www.linkedin.com/in/jane-doe-1', best_person_found_via: 'a public LinkedIn search result (not verified as current)' })
  assert.deepEqual(m.get('L2'), { best_person: '', best_person_title: '', best_person_link: '', best_person_found_via: '' })
  assert.equal(rows.find(r => r.lead_id === 'L1')!.why, 'Opening a second clinic in Toronto next month.')
})

test('different buyer roles pick a different person; a company-page person links to its source page', () => {
  const { db } = setup(['CEO', 'Owner'])
  const m = bestPeople(db, 'A', exportLeads(db, 'A') as { lead_id: string; job_id: string }[])
  assert.deepEqual(m.get('L1'), { best_person: 'Dana Lee', best_person_title: 'CEO', best_person_link: 'https://acmedental.com/team', best_person_found_via: 'the company website (listed with this title)' })
})

test('older schema without lead_enrichments and an empty export do not throw', () => {
  assert.equal(bestPeople(new Database(':memory:'), 'A', []).size, 0)
  const db = new Database(':memory:'); migrateScan(db)
  const job = createJob(db, 'A', { business_name: 'S', industry: 'x', location: 'y' })
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(job)
  db.prepare('INSERT INTO leads (id,scan_job_id,company,signal,source_url,score,fit) VALUES (?,?,?,?,?,?,?)').run('L1', job, 'Acme', 's', 'https://n.example/a', 80, 5)
  assert.equal(bestPeople(db, 'A', exportLeads(db, 'A') as { lead_id: string; job_id: string }[]).get('L1')!.best_person, '')
})

test('another tenant\'s enrichment row, or a lead it does not own, is never selected', () => {
  const { db } = setup(['Practice manager'])
  const rows = exportLeads(db, 'A') as { lead_id: string; job_id: string }[]
  db.prepare("UPDATE lead_enrichments SET tenant_id = 'B'").run()
  assert.equal(bestPeople(db, 'A', rows).get('L1')!.best_person, '')
  db.prepare("UPDATE lead_enrichments SET tenant_id = 'A'").run()
  assert.equal(bestPeople(db, 'B', rows).get('L1')!.best_person, '')
})

test('a quarantined lead and a former/previous role are never the best person', () => {
  const { db } = setup(['Practice manager'])
  addEnrichment(db, 'A', 'L1', { connector: 'search:people', kind: 'person', value: 'Old Timer, Former Practice Manager', label: 'x', confidence: null, source_url: 'https://www.linkedin.com/in/old', source_date: '2026-10-26', retrieved_at: 1 })
  db.prepare("DELETE FROM lead_enrichments WHERE value LIKE 'Jane%'").run()
  const rows = [{ lead_id: 'L1', job_id: (db.prepare('SELECT scan_job_id j FROM leads WHERE id = ?').get('L1') as { j: string }).j }]
  assert.equal(bestPeople(db, 'A', rows).get('L1')!.best_person, 'Dana Lee')
  db.prepare("UPDATE leads SET quarantined_at = 1 WHERE id = 'L1'").run()
  assert.equal(bestPeople(db, 'A', rows).get('L1')!.best_person, '')
})

test('CSV neutralises formulas in every person/title/link/source/why field', () => {
  const f = '=HYPERLINK("x")'
  const csv = toCsv([{ best_person: f, best_person_title: '+1', best_person_link: '@a', best_person_found_via: '-b', why: '=1' }],
    ['best_person', 'best_person_title', 'best_person_link', 'best_person_found_via', 'why'].map(key => ({ key, label: key })))
  const body = csv.split('\r\n')[1]
  assert.ok(!/(^|,)"?[=+@-]/.test(body), body)
})
