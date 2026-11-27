import Database from 'better-sqlite3'
import test from 'node:test'
import assert from 'node:assert/strict'
import {migrateAllSqlite} from '../lib/db/sqlite-migrations.ts'
import {leadContactContext} from '../lib/outreach/contact-purpose-db.ts'
import {sourceCheckForLead} from '../lib/scan/source-review.ts'
test('source review projections use the newest owned row and break timestamp ties by ID', t => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  migrateAllSqlite(db)
  const job=db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,query,status,candidates,created_at) VALUES (?,?,'Workspace','services','-','Find businesses','running',2,1)")
  job.run('own-job','own');job.run('foreign-job','foreign')
  const lead=db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url) VALUES (?,?,'Fixture','Expansion','https://example.test')")
  lead.run('own-lead','own-job');lead.run('foreign-lead','foreign-job');lead.run('no-review','own-job')
  const review=db.prepare("INSERT INTO source_reviews(id,tenant_id,job_id,lead_id,input_json,fetch_status,quote_match,company_named,contact_match,checked_at) VALUES (?,?,?,?,?,'ok',?,?,?,?)")
  const input=(excerpt:string)=>JSON.stringify({contact_context:{excerpt,source_url:'https://example.test'}})
  review.run('old','own','own-job','own-lead',input('older'),0,1,0,10)
  review.run('new','own','own-job','own-lead',input('latest'),1,1,1,20)
  review.run('wrong-tenant','foreign','own-job','own-lead',input('foreign marker'),0,0,0,30)
  review.run('wrong-job','own','foreign-job','own-lead',input('foreign job'),0,0,0,40)
  review.run('foreign','foreign','foreign-job','foreign-lead',input('foreign'),1,1,1,20)
  review.run('new-tie', 'own', 'own-job', 'own-lead', input('tie winner'), 1, 1, 0, 20)
  for (const id of ['foreign-lead', 'no-review']) {
    assert.equal(sourceCheckForLead(db, 'own', id), null)
    assert.equal(leadContactContext(db, 'own', id), null)
  }
  for (const reverse of ['OFF', 'ON']) {
    db.pragma(`reverse_unordered_selects = ${reverse}`)
    assert.deepEqual(sourceCheckForLead(db, 'own', 'own-lead'), {
      fetch_status: 'ok', quote_match: true, company_named: true, contact_match: false, checked_at: 20,
    }, 'source check must use the latest row and the stable tie-break')
    assert.equal(leadContactContext(db, 'own', 'own-lead')?.excerpt, 'tie winner')
  }
})
