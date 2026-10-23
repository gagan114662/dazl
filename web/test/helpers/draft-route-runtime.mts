import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb } from './sequence-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateKeys, saveKey } from '../../lib/llm/key-store.ts'
import { providers } from '../../lib/llm/provider.ts'
import { confirmLeadReview, unconfirmLeadReview } from '../../lib/scan/review-confirm.ts'
import { POST as draftPOST, GET as draftGET } from '../../app/api/outreach/route.ts'
import { POST as sequencePOST } from '../../app/api/outreach/sequences/route.ts'

// Local mechanics only: synthetic stored contact, never public-contact discovery
// or real buying-need proof. No approval or send route is invoked.
process.env.DAZL_MASTER_KEY = randomBytes(32).toString('base64')
const providerCalls: string[] = [], fetchCalls: string[] = []
for (const [name, p] of Object.entries(providers)) {
  if (p.complete) p.complete = async () => { providerCalls.push(name); throw new Error('Unexpected provider call') }
}
globalThis.fetch = (async (url: unknown) => { fetchCalls.push(String(url)); throw new Error('Unexpected network call') }) as typeof fetch
const request = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('review refusal -> explicit synthetic confirmation -> route draft -> route sequence -> withdrawal', async () => {
  const db = new Database(':memory:')
  try {
    migrateScan(db); migrateOutreach(db); migrateSequences(db); migrateMemory(db); migrateKeys(db)
    saveKey(db, 'A', 'anthropic', 'sk-ant-synthetic-test-key')
    setScanDb(db)
    const job = createJob(db, 'A', { business_name: 'Synthetic test company', industry: 'test', location: 'test' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    const lead = randomBytes(12).toString('hex')
    const signal = 'Synthetic mechanics fixture only, not a real buyer or verified quote.'
    db.prepare('INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,review_reason,source_kind) VALUES(?,?,?,?,?,?,?,\'quote_unconfirmed\',\'test\')').run(
      lead, job, 'Synthetic test company', 'fixture@dazl.invalid', signal, 'https://dazl.invalid/test-only', signal)

    const refused = await draftPOST(request('/api/outreach', { lead_id: lead }))
    assert.equal(refused.status, 422)
    assert.equal((await refused.json()).code, 'lead_not_verified')
    assert.equal(db.prepare('SELECT 1 FROM outreach_messages WHERE lead_id=?').get(lead), undefined)
    assert.equal(confirmLeadReview(db, 'A', lead), true)
    const created = await draftPOST(request('/api/outreach', { lead_id: lead }))
    assert.equal(created.status, 201)
    const { id } = await created.json() as { id: string }
    const message = db.prepare('SELECT status,approved_hash,sent_at,test,body,to_email FROM outreach_messages WHERE id=?').get(id) as {status:string;approved_hash:null;sent_at:null;test:number;body:string;to_email:string}
    assert.equal(message.status, 'draft'); assert.equal(message.approved_hash, null)
    assert.equal(message.sent_at, null); assert.equal(message.test, 0)
    assert.equal(message.to_email, 'fixture@dazl.invalid'); assert.ok(message.body.includes(signal))
    const duplicate = await draftPOST(request('/api/outreach', { lead_id: lead }))
    assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'already_drafted')

    const sequence = await sequencePOST(request('/api/outreach/sequences', { action: 'create', message_id: id }))
    assert.equal(sequence.status, 200)
    const { id: sequenceId } = await sequence.json() as { id: string }
    const steps = db.prepare('SELECT status,approved_hash,body FROM sequence_steps WHERE sequence_id=? ORDER BY step').all(sequenceId) as {status:string;approved_hash:null;body:string}[]
    assert.equal(steps.length, 3)
    for (const step of steps) { assert.equal(step.status, 'draft'); assert.equal(step.approved_hash, null) }
    assert.equal(steps[0].body, message.body)
    const human = await draftGET()
    assert.equal((await human.json()).messages.find((m: {id:string}) => m.id === id).evidence_state, 'human')
    assert.equal(unconfirmLeadReview(db, 'A', lead), true)
    const withdrawn = await draftGET()
    assert.equal((await withdrawn.json()).messages.find((m: {id:string}) => m.id === id).evidence_state, 'unverified')
    const evidence = db.prepare('SELECT confidence,human_confirmed_at,review_reason FROM leads WHERE id=?').get(lead) as {confidence:null;human_confirmed_at:null;review_reason:string}
    assert.equal(evidence.confidence, null); assert.equal(evidence.human_confirmed_at, null)
    assert.equal(evidence.review_reason, 'quote_unconfirmed')
    assert.deepEqual(providerCalls, []); assert.deepEqual(fetchCalls, [])
  } finally { db.close() }
})
