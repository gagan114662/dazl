import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { TEST_INBOX } from './service.ts'
import { testAddresses } from './sequences.ts'

// Test-only fixture for the operator-designated own-inbox sequence test.
//
// This creates the exact three-step verification set the owner approved word-for-word,
// addressed only to the owner's own test inbox, so the sequence scheduler can be verified
// end-to-end without contacting any real prospect. It is available ONLY to the tenant named
// by OUTREACH_TEST_TENANT_ID, and only after that tenant has allowlisted the test inbox.
//
// The fixture lead is deliberately NOT a verified prospect: no evidence_excerpt, no
// confidence, no ICP grade. It never pretends dazl found or verified anyone. Its signal and
// source URL are labelled test-only. The three step texts are fixed constants here - no LLM,
// no templates - so what the owner approved is byte-for-byte what the fixture creates.

const STEP1_SUBJECT = 'dazl sequence test - step 1 of 3'
const RE_SUBJECT = `Re: ${STEP1_SUBJECT}`
export const FIXTURE_STEPS: { step: 1 | 2 | 3; subject: string; body: string }[] = [
  { step: 1, subject: STEP1_SUBJECT, body: 'Hi Gagan,\n\nThis is the initial message in the dazl own-inbox sequence test. Its purpose is only to verify step 1 of 3.\n\nThanks,' },
  { step: 2, subject: RE_SUBJECT, body: 'Hi Gagan,\n\nThis is the no-reply follow-up check in the dazl own-inbox sequence test. Its purpose is only to verify step 2 of 3.\n\nThanks,' },
  { step: 3, subject: RE_SUBJECT, body: 'Hi Gagan,\n\nThis is the final check in the dazl own-inbox sequence test. Its purpose is only to verify step 3 of 3.\n\nThanks,' },
]
const FIXTURE_COMPANY = 'dazl sequence test fixture (test only)'
const FIXTURE_SIGNAL = 'Test-only fixture for verifying the 3-step sequence against the owner\'s own inbox. Not a real prospect. dazl did not find, scrape or verify this lead and claims no evidence for it.'
const FIXTURE_SOURCE_URL = 'https://dazl.ai/test-only-sequence-fixture'

export class FixtureError extends Error {
  code: string
  constructor(code: string) { super(code); this.code = code }
}

// True when this tenant may see the fixture trigger: operator-designated test tenant that
// has explicitly allowlisted the designated test inbox.
export const fixtureAvailable = (db: Database.Database, tenantId: string): boolean =>
  !!process.env.OUTREACH_TEST_TENANT_ID && process.env.OUTREACH_TEST_TENANT_ID === tenantId &&
  testAddresses(db, tenantId).includes(TEST_INBOX)

export interface FixtureResult { jobId: string; leadId: string; messageId: string; sequenceId: string; created: boolean }

// Creates the fixture set in draft state (nothing approved, nothing sent) or returns the
// existing one unchanged. Idempotent: at most one fixture sequence per tenant.
export function createSequenceTestFixture(db: Database.Database, tenantId: string): FixtureResult {
  if (!process.env.OUTREACH_TEST_TENANT_ID || process.env.OUTREACH_TEST_TENANT_ID !== tenantId) throw new FixtureError('test_tenant_only')
  if (!testAddresses(db, tenantId).includes(TEST_INBOX)) throw new FixtureError('test_inbox_not_allowlisted')

  const existing = db.prepare(`SELECT s.id AS sequence_id, s.lead_id, s.message_id, l.scan_job_id AS job_id
                               FROM sequences s JOIN outreach_messages m ON m.id = s.message_id AND m.tenant_id = s.tenant_id
                               JOIN leads l ON l.id = s.lead_id
                               WHERE s.tenant_id = ? AND m.to_email = ? AND m.test = 1 AND m.subject = ?`)
    .get(tenantId, TEST_INBOX, STEP1_SUBJECT) as { sequence_id: string; lead_id: string; message_id: string; job_id: string } | undefined
  if (existing) return { jobId: existing.job_id, leadId: existing.lead_id, messageId: existing.message_id, sequenceId: existing.sequence_id, created: false }

  const jobId = randomBytes(12).toString('hex')
  const leadId = randomBytes(12).toString('hex')
  const messageId = randomBytes(12).toString('hex')
  const sequenceId = randomBytes(12).toString('hex')
  db.transaction(() => {
    db.prepare('INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, ?, ?, ?)').run(jobId, tenantId, FIXTURE_COMPANY, 'test only', 'test only')
    // The leads table only accepts rows while its job is running; the job finishes immediately after.
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ? AND status = 'pending'").run(jobId)
    db.prepare('INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(leadId, jobId, 'Gagan', FIXTURE_COMPANY, TEST_INBOX, FIXTURE_SIGNAL, FIXTURE_SOURCE_URL)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(jobId)
    const step1 = FIXTURE_STEPS[0]
    db.prepare('INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, test) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(messageId, tenantId, leadId, TEST_INBOX, step1.subject, step1.body)
    db.prepare('INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email) VALUES (?, ?, ?, ?, ?)').run(sequenceId, tenantId, leadId, messageId, TEST_INBOX)
    const ins = db.prepare('INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body) VALUES (?, ?, ?, ?, ?)')
    for (const st of FIXTURE_STEPS) ins.run(tenantId, sequenceId, st.step, st.subject, st.body)
  })()
  return { jobId, leadId, messageId, sequenceId, created: true }
}
