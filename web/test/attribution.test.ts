import { migrateConnectors } from '../lib/connectors/store.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan,createJob } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { snapshotSignalContext,messageSignalContext,replySignalContexts } from '../lib/outreach/attribution.ts'
function setup() {
  const db=new Database(':memory:');migrateScan(db);migrateOutreach(db); migrateConnectors(db);migrateReplies(db)
  const job=createJob(db,'A',{business_name:'Seller',industry:'software',location:'Toronto'})
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  db.prepare(`INSERT INTO leads (id,scan_job_id,company,signal,source_url,signals,signal_kind,source_kind)
    VALUES ('l',?,'Acme','A hiring signal','https://acme.example/news','["hiring","funding"]','hiring','query')`).run(job)
  db.prepare(`INSERT INTO outreach_messages (id,tenant_id,lead_id,to_email,subject,body) VALUES ('m','A','l','a@acme.example','Hello','A message long enough to be valid')`).run()
  return db
}
test('snapshots preserve all signal types and unknown collector provenance',()=>{
  const db=setup();snapshotSignalContext(db,'A','m',100)
  const row=messageSignalContext(db,'A','m') as any
  assert.equal(row.signals_json,'["hiring","funding"]');assert.equal(row.collectors_json,null)
  db.prepare("UPDATE leads SET signal='Changed',signals='[]' WHERE id='l'").run()
  assert.equal((messageSignalContext(db,'A','m') as any).signal,'A hiring signal')
  assert.equal(messageSignalContext(db,'B','m'),null)
})
test('only stored collector provenance is copied; historical messages remain unknown',()=>{
  const db=setup();assert.equal((messageSignalContext(db,'A','m') as any).captured_at,null)
  db.exec('CREATE TABLE IF NOT EXISTS lead_sources (lead_id TEXT, collector TEXT, attempt INTEGER)')
  db.exec("INSERT INTO lead_sources VALUES ('l','adapter:rss',1),('l','adapter:rss',2),('l','search:openai',1)")
  snapshotSignalContext(db,'A','m',100)
  assert.equal((messageSignalContext(db,'A','m') as any).collectors_json,'["adapter:rss","search:openai"]')
})
test('reply association uses explicit root message, preserves classification and isolates tenant',()=>{
  const db=setup();snapshotSignalContext(db,'A','m',100)
  db.exec("INSERT INTO inbound_messages VALUES ('g','A','thread','l','a@acme.example','short','auto',200,'m')")
  const row=replySignalContexts(db,'A','g') as any
  assert.equal(row.outreach_message_id,'m');assert.equal(row.classification,'auto');assert.equal(row.signal,'A hiring signal')
  assert.equal(replySignalContexts(db,'B','g'),null)
  db.exec("INSERT INTO inbound_messages VALUES ('old','A','oldthread','l','a@acme.example','short','positive',50,NULL)")
  assert.equal((replySignalContexts(db,'A','old') as any).signal,null)
})
test('snapshot refuses mismatched owner and reapproval updates only same-tenant context',()=>{
  const db=setup();snapshotSignalContext(db,'B','m',1)
  assert.equal((messageSignalContext(db,'A','m') as any).captured_at,null)
  snapshotSignalContext(db,'A','m',100)
  db.prepare("UPDATE leads SET signal='Latest approved signal' WHERE id='l'").run()
  snapshotSignalContext(db,'A','m',200)
  assert.equal((messageSignalContext(db,'A','m') as any).signal,'Latest approved signal')
  migrateOutreach(db); migrateConnectors(db);migrateReplies(db)
  assert.equal((messageSignalContext(db,'A','m') as any).captured_at,200)
})
