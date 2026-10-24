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
    assert.match(body(db,id), /contact address published on Buyer's page/)
    assert.match(body(db,id), /https:\/\/buyer.invalid\/careers/)
    assert.doesNotMatch(body(db,id), /\(https?:/, 'source URL is on its own line, not parenthesised')
    assert.match(body(db,id), /could you point me to the right one\?/)
    assert.doesNotMatch(body(db,id), /researching businesses|pain|struggl|noticed|congrat/i, 'no stock research claim and no invented need')
    const row = db.prepare('SELECT status,approved_hash,sent_at FROM outreach_messages WHERE id=?').get(id) as {status:string;approved_hash:null;sent_at:null}
    assert.deepEqual(row, {status:'draft',approved_hash:null,sent_at:null})
    // Edits apply only to new drafts. Already prepared words never change silently.
    saveMemory(db, 'A', { positioning: 'Updated seller description.' })
    assert.match(body(db,id), /Find leads from public signals/)
    assert.match(body(db,createDraft(db,'A','two','dazl')), /Updated seller description/)
  } finally { db.close() }
})

test('missing saved offer or seller name rejects: manual path inserts nothing',()=>{
  for (const memory of [true,false]) {
    const db=setup(memory)
    try {
      if (memory) saveMemory(db,'B',{positioning:'Other tenant offer'})
      assert.throws(()=>createDraft(db,'A','one','dazl'),/seller_offer_required/)
      assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as {n:number}).n,0)
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


test('internal QA signal and fabricated event claims cannot enter initial draft',()=>{
 const db=setup();saveMemory(db,'A',{positioning:'Sales prospecting software for B2B sales teams'})
 db.prepare("UPDATE leads SET signal='OPERATOR QA ONLY - recently raised $10M. No outreach authorized.'").run()
 const text=body(db,createDraft(db,'A','one','dazl'))
 assert.match(text,/About dazl: Sales prospecting software for B2B sales teams/)
 assert.doesNotMatch(text,/OPERATOR QA|raised|No outreach|About :|We offer|hiring/)
 assert.equal((db.prepare('SELECT signal FROM leads WHERE id=?').get('one') as {signal:string}).signal,'OPERATOR QA ONLY - recently raised $10M. No outreach authorized.')
})
test('no seller context fails before saving words and never fabricates an offer',()=>{
 const db=setup();assert.throws(()=>createDraft(db,'A','one','  '),/seller_context_required/)
 assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as {n:number}).n,0)
})

test('blank seller name fails with no draft; no anonymous fallback',()=>{
 for (const name of ['','  ']){
  const db=setup(); saveMemory(db,'A',{positioning:'Real offer'})
  assert.throws(()=>createDraft(db,'A','one',name),/seller_context_required/)
  assert.equal((db.prepare('SELECT count(*) n FROM outreach_messages').get() as {n:number}).n,0)
 }
})

test('send preview footer is exactly what composeBody appends, and absent when sender identity is missing', async () => {
  const { sendFooter, composeBody } = await import('../lib/outreach/service.ts')
  const s = { sender_name: 'Sam Seller', postal_address: '1 Main St, Toronto ON M5V 1A1' }
  const f = sendFooter('Hello body.\n', s)!
  assert.match(f, /^--\nSam Seller\n1 Main St, Toronto ON M5V 1A1\n\nIf you would rather not get emails like this, unsubscribe here: \[your unsubscribe link/)
  assert.equal(composeBody('Hello body.\n', s, 'URL').startsWith('Hello body.\n\n--\nSam Seller\n1 Main St'), true)
  assert.equal(sendFooter('x', undefined), null)
})

import { draftTemplate } from '../lib/outreach/service.ts'
const lead = (o: Record<string, unknown> = {}) => ({ id: 'l', company: 'Kyro AI', name: '', contact: 'contact@kyro.ai', signal: 's', source_url: 'https://weworkremotely.com/remote-jobs/kyro-ai-sdr', evidence_excerpt: 'Sales Development Representative at Kyro AI', confidence: 60, fit: null, intent: null, human_confirmed_at: 1, ...o }) as never
test('draft keeps address provenance and source context separate, with no meaning claim', () => {
  const t = draftTemplate(lead(), 'Dazl', 'Sales prospecting software', 'https://kyro.ai/')
  assert.match(t.body, /contact address published on Kyro AI's page:\nhttps:\/\/kyro\.ai\/\n\nSaved excerpt from this public page: "Sales Development Representative at Kyro AI"\nhttps:\/\/weworkremotely\.com\/remote-jobs\/kyro-ai-sdr\n\nAbout Dazl:/)
  assert.doesNotMatch(t.body, /hiring|need|looking for|struggl|pain/i)
  assert.doesNotMatch(draftTemplate(lead({ source_url: 'https://kyro.ai/' }), 'Dazl', 'x', 'https://kyro.ai/').body, /Separately/)
  assert.doesNotMatch(draftTemplate(lead({ evidence_excerpt: null }), 'Dazl', 'x', 'https://kyro.ai/').body, /Separately/)
  const long = draftTemplate(lead({ evidence_excerpt: 'word '.repeat(100) + '\n\nINJECT' }), 'Dazl', 'x', 'https://kyro.ai/')
  const q = long.body.match(/Saved excerpt from this public page: "([^"]*)"/)![1]
  assert.ok(!/INJECT/.test(long.body) && q.endsWith('word...') && q.length <= 163 && !/\s\.\.\.$/.test(q), 'cut at a word boundary with an explicit ellipsis')
  const exact = draftTemplate(lead({ evidence_excerpt: 'y'.repeat(160) }), 'Dazl', 'x', 'https://kyro.ai/')
  assert.ok(exact.body.includes('"' + 'y'.repeat(160) + '"') && !exact.body.includes('y...'), 'a 160-char excerpt is shown whole, no ellipsis')
  const noSpace = draftTemplate(lead({ evidence_excerpt: 'z'.repeat(300) }), 'Dazl', 'x', 'https://kyro.ai/')
  assert.ok(noSpace.body.includes('"' + 'z'.repeat(160) + '..."'), 'no usable word boundary: hard cut with ellipsis')
})
