import { test } from 'node:test'
import { sqliteDb } from '../lib/db/client.ts'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateSequences, approveSequence } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateWarm } from '../lib/warm/connections.ts'
import { migrateReplies } from '../lib/outreach/replies.ts'
import { setTestAddresses } from '../lib/outreach/sequences.ts'
import { TEST_INBOX, leadEvidenceState, listMessages, approve, sendMessage, saveSettings } from '../lib/outreach/service.ts'
import { confirmLeadReview, unconfirmLeadReview } from '../lib/scan/review-confirm.ts'
import { createReviewDraftFixture, deleteReviewDraftFixtures } from '../lib/scan/review-draft-fixture.ts'
import { deleteVerificationFixture } from '../lib/scan/verification-fixture.ts'

const tenant='review-draft-fixture-test'
function setup(){
  const db=new Database(':memory:')
  migrateScan(db);migrateOutreach(db);migrateSequences(db);migrateConnectors(db);migrateWarm(db);migrateReplies(db)
  process.env.OUTREACH_TEST_TENANT_ID=tenant
  setTestAddresses(db,tenant,[TEST_INBOX])
  return db
}
test('supported fixture is gated, idempotent, never confirms human evidence or approves/sends',async()=>{
  const db=setup()
  assert.throws(()=>createReviewDraftFixture(db,'other'),/test_tenant_only/)
  const f=createReviewDraftFixture(db,tenant)
  assert.ok(f.created)
  assert.equal(createReviewDraftFixture(db,tenant).created,false)
  const lead=db.prepare('SELECT contact,confidence,human_confirmed_at,review_reason FROM leads WHERE id=?').get(f.leadId) as {contact:string;confidence:null;human_confirmed_at:null;review_reason:string}
  assert.match(lead.contact,/@dazl\.invalid$/)
  assert.equal(lead.confidence,null);assert.equal(lead.human_confirmed_at,null);assert.equal(lead.review_reason,'quote_unconfirmed')
  assert.equal(leadEvidenceState(db,tenant,f.leadId),'unverified')
  assert.equal(await confirmLeadReview(sqliteDb(db),tenant,f.leadId),true)
  assert.equal(leadEvidenceState(db,tenant,f.leadId),'human')
  const msg=(listMessages(db,tenant) as {lead_id:string;evidence_state:string;status:string;test:number}[]).find(m=>m.lead_id===f.leadId)!
  assert.equal(msg.evidence_state,'human');assert.equal(msg.status,'draft');assert.equal(msg.test,0)
  assert.equal(await unconfirmLeadReview(sqliteDb(db),tenant,f.leadId),true)
  assert.equal(leadEvidenceState(db,tenant,f.leadId),'unverified')
  assert.equal((db.prepare('SELECT count(*) n FROM sequence_steps WHERE approved_hash IS NOT NULL').get() as {n:number}).n,0)
  let network=0
  await assert.rejects(sendMessage(db,tenant,f.messageId!,{fetchImpl:(async()=>{network++;throw new Error('no network')}) as typeof fetch}),/lead_evidence_withdrawn/)
  assert.equal(network,0)
  db.close()
})
test('confirmed display fixture remains suppressed, and cleanup removes its exact drafts/steps but never unsuppresses',async () =>{
  const db=setup(),f=createReviewDraftFixture(db,tenant)
  const email=(db.prepare('SELECT contact FROM leads WHERE id=?').get(f.leadId) as {contact:string}).contact
  await confirmLeadReview(sqliteDb(db),tenant,f.leadId)
  saveSettings(db,tenant,{sender_name:'Test',postal_address:'Synthetic test mailing address'})
  db.prepare("INSERT INTO gmail_accounts(tenant_id,email,refresh_ct) VALUES(?,?,'not-a-token')").run(tenant,'test@example.invalid')
  assert.throws(()=>approve(db,tenant,f.messageId!,true),/suppressed/)
  assert.throws(()=>approveSequence(db,tenant,f.sequenceId!,()=>{throw new Error('must not approve')}),/reading_not_enabled|suppressed/)
  const ids=[f.messageId,f.sequenceId,f.leadId]
  deleteReviewDraftFixtures(db,'other')
  assert.ok(db.prepare('SELECT 1 FROM leads WHERE id=?').get(f.leadId))
  deleteReviewDraftFixtures(db,tenant);deleteVerificationFixture(db,tenant)
  assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE id=?').get(ids[0]),undefined)
  assert.equal(db.prepare('SELECT 1 FROM sequence_steps WHERE sequence_id=?').get(ids[1]),undefined)
  assert.equal(db.prepare('SELECT 1 FROM leads WHERE id=?').get(ids[2]),undefined)
  assert.ok(db.prepare('SELECT 1 FROM suppressions WHERE tenant_id=? AND email=?').get(tenant,email))
  assert.equal(db.prepare('SELECT 1 FROM gmail_accounts WHERE tenant_id=?').get(tenant)!==undefined,true)
  db.close()
})
