import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { createDraft } from '../lib/outreach/service.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateMemory, saveMemory } from '../lib/memory.ts'

function setup(memory = true) {
  const db = new Database(':memory:')
  migrateScan(db); migrateOutreach(db)
  if (memory) migrateMemory(db)
  db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES('job','A','Request','test','test','running')").run()
  for (const id of ['one','two']) db.prepare("INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES(?,'job','Buyer','sales@buyer.invalid','Buyer is hiring an SDR','https://buyer.invalid/careers','Buyer is hiring an SDR',70)").run(id)
  // Test baseline is explicitly human-reviewed; no machine timing inference.
  db.prepare("UPDATE leads SET human_confirmed_at=1800000000, human_confirmed_from='test_review' WHERE confidence IS NOT NULL AND evidence_excerpt IS NOT NULL").run()
  return db
}
const body = (db: Database.Database, id: string) => (db.prepare('SELECT body FROM outreach_messages WHERE id=?').get(id) as {body:string}).body

test('template uses only this tenant saved positioning, literally and without provider calls', () => {
  const db = setup()
  try {
    saveMemory(db, 'A', { positioning: 'Find leads from public signals, with source links and quotes.' })
    saveMemory(db, 'B', { positioning: 'Unrelated tenant consulting service' })
    const id = createDraft(db, 'A', 'one', 'dazl')
    assert.match(body(db,id), /About dazl: Find leads from public signals, with source links and quotes\./)
    assert.doesNotMatch(body(db,id), /Unrelated tenant|consulting/)
    assert.match(body(db,id), /I saw this reported about Buyer: Buyer is hiring an SDR/)
    assert.match(body(db,id), /https:\/\/buyer.invalid\/careers/)
    const row = db.prepare('SELECT status,approved_hash,sent_at FROM outreach_messages WHERE id=?').get(id) as {status:string;approved_hash:null;sent_at:null}
    assert.deepEqual(row, {status:'draft',approved_hash:null,sent_at:null})
    // Edits apply only to new drafts. Already prepared words never change silently.
    saveMemory(db, 'A', { positioning: 'Updated seller description.' })
    assert.match(body(db,id), /Find leads from public signals/)
    assert.match(body(db,createDraft(db,'A','two','dazl')), /Updated seller description/)
  } finally { db.close() }
})

test('missing, empty and older no-memory databases retain conservative template with no invented offer', () => {
  for (const memory of [true,false]) {
    const db=setup(memory)
    try {
      if (memory) saveMemory(db,'B',{positioning:'Other tenant offer'})
      const text=body(db,createDraft(db,'A','one','dazl'))
      assert.match(text,/I run dazl\./)
      assert.doesNotMatch(text,/About dazl:|Other tenant offer/)
    } finally { db.close() }
  }
})


test('saved onboarding offer is fallback, never another user or website inference; Memory wins', () => {
  const db=setup()
  try {
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,sells TEXT,website TEXT)')
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('A','Public-source lead finding software.','https://seller.invalid')
    db.prepare('INSERT INTO users VALUES(?,?,?)').run('B','Other user consulting.','https://other.invalid')
    assert.match(body(db,createDraft(db,'A','one','dazl')), /About dazl: Public-source lead finding software/)
    saveMemory(db,'A',{positioning:'Explicit Memory positioning.'})
    const text=body(db,createDraft(db,'A','two','dazl'))
    assert.match(text,/Explicit Memory positioning/)
    assert.doesNotMatch(text,/Other user consulting|seller.invalid/)
  } finally { db.close() }
})
