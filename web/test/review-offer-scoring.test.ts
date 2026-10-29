// Reviewer's finding on PR #374 (synthetic data, no model calls): buyer-fit scoring and follow-up drafts for a play must
// not carry the tenant-wide Memory positioning when the play sells something else. Scoring is assembled by
// scoringSellerContext (the expression lib/scan/runner.ts uses); follow-ups and sequence steps by memoryForLead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { getMemory, migrateMemory, saveMemory, memoryPromptBlock } from '../lib/memory.ts'
import { offerBlockFor, scoringSellerContext } from '../lib/scan/runner.ts'
import { memoryForLead } from '../lib/outreach/play-memory.ts'

const DENTAL = 'Dental appointment software', CRM = 'CRM consulting'
function db() {
  const d = new Database(':memory:')
  migrateScan(d); migrateMemory(d)
  d.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, sells TEXT); INSERT INTO users VALUES('A', '${DENTAL}');
    INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status,query,seller,offer) VALUES
      ('play','A','Request','test','London','running','London startups','${DENTAL}','${CRM}'),
      ('contested','A','Request','test','London','running','Selling ${CRM} to London startups','${DENTAL}',NULL),
      ('dental','A','Request','test','NYC','running','NYC dental practices','${DENTAL}',NULL),
      ('old','A','Request','test','NYC','running','NYC dental practices',NULL,NULL)`)
  for (const j of ['play', 'contested', 'dental', 'old']) d.prepare("INSERT INTO leads(id,scan_job_id,company,contact,signal,source_url,evidence_excerpt,confidence) VALUES(?,?,'Buyer','a@buyer.invalid','s','https://buyer.invalid','s',70)").run(`lead-${j}`, j)
  saveMemory(d, 'A', { positioning: DENTAL, tone: 'Plain and short' })
  return d
}

test('REVIEW scoring for a reviewed CRM play does not retain the conflicting global dental positioning', () => {
  const d = db()
  try {
    // the reviewer's expression, with the runner's assembly in place of Memory's own block
    const actual = scoringSellerContext(d, 'A', 'play', getMemory(d, 'A'))
    assert.match(actual, /CRM consulting/); assert.doesNotMatch(actual, /Dental appointment software/)
    assert.match(actual, /Plain and short/, 'the other Memory fields stay')
    assert.match(scoringSellerContext(d, 'A', 'play', null), /CRM consulting/)
    // contested: no offer at all, and still no global positioning
    const contested = scoringSellerContext(d, 'A', 'contested', getMemory(d, 'A'))
    assert.doesNotMatch(contested, /Dental appointment software|CRM consulting/); assert.match(contested, /Plain and short/)
    // the dental play keeps dental; a play from before snapshots falls back to the Memory positioning
    assert.match(scoringSellerContext(d, 'A', 'dental', getMemory(d, 'A')), /Dental appointment software/)
    assert.match(offerBlockFor(d, 'A', 'old'), /Dental appointment software/)
    // the runner assembles the scoring text with this function, not Memory's own positioning
    const runner = readFileSync(new URL('../lib/scan/runner.ts', import.meta.url), 'utf8')
    assert.match(runner, /\+ scoringSellerContext\(db, job\.user_id, job\.id, memory \?\? null\)/)
    assert.doesNotMatch(runner, /memoryPromptBlock\(memory \?\? null\) \+ offerBlockFor/)
  } finally { d.close() }
})

test('follow-up and sequence drafts state the lead\'s play offer, none while contested, and dental plays keep dental', () => {
  const d = db()
  try {
    const block = (lead: string) => memoryPromptBlock(memoryForLead(d, 'A', lead))
    assert.match(block('lead-play'), /Seller's positioning: CRM consulting/); assert.doesNotMatch(block('lead-play'), /Dental/)
    assert.doesNotMatch(block('lead-contested'), /positioning/); assert.match(block('lead-contested'), /Plain and short/)
    assert.match(block('lead-dental'), /Seller's positioning: Dental appointment software/)
    assert.match(block('lead-old'), /Seller's positioning: Dental appointment software/)
    assert.equal(memoryForLead(d, 'B', 'lead-play')?.positioning ?? null, null, 'another tenant: not this play, and no Memory')
    for (const f of ['../lib/outreach/draft-llm.ts', '../lib/outreach/sequences.ts']) assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /memoryPromptBlock\(lead\.lead_id \? memoryForLead\(db, tenantId, lead\.lead_id\)/)
  } finally { d.close() }
})

