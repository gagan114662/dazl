// #899: storage remains isolated even with feature-flag-ON fixtures and verified-looking candidate metadata.
// Real production contact/draft gates, synthetic SQLite only. No provider, send handoff or network request.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { createJob } from '../lib/scan/store.ts'
import { recordEmailGuesses, verifyCandidates, verifierFromEnv } from '../lib/people/email-pattern.ts'
import { createDraft, draftBlockReason, OutreachError } from '../lib/outreach/service.ts'
import { publishedEmail } from '../lib/outreach/published-email.ts'

function fixture() {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  const job = createJob(db, 'A', { business_name: 'test', industry: 'software', location: 'Austin' })
  db.prepare("UPDATE scan_jobs SET status = 'running', offer = 'Warehouse planning software' WHERE id = ?").run(job)
  db.prepare("INSERT INTO leads (id, scan_job_id, company, name, contact, signal, source_url, evidence_excerpt, confidence, human_confirmed_at) VALUES ('lead', ?, 'Acme', 'Cara Diaz', NULL, 'hiring', 'https://news.example/a', 'Acme hiring', 80, 1)").run(job)
  const args = ['acme.example', ['dana.lee', 'ben.ortiz'], ['Dana Lee, CEO', 'Ben Ortiz, CFO', 'Cara Diaz, COO']] as const
  const context = { env: { EMAIL_GUESS_ENABLED: '1' }, homeText: '100 Main St, Austin, TX 78701', seen: [
    { address: 'dana.lee@acme.example', url: 'https://acme.example/team' },
    { address: 'ben.ortiz@acme.example', url: 'https://acme.example/team' },
  ] }
  const recorded = recordEmailGuesses(db, 'A', 'lead', args[0], [...args[1]], [...args[2]], context)
  assert.equal(recorded?.candidates, 1); assert.equal(recorded?.published, 2)
  return db
}

for (const verification of ['none', 'pending', 'verified', 'catch_all', 'undeliverable', 'uncertain', 'refused'] as const) {
  test(`flag-on candidate ${verification} never supplies a UI contact or production draft recipient`, () => {
    const db = fixture()
    try {
      db.prepare("UPDATE email_candidates SET verification = ?, checked_at = 1800000000, verifier = 'synthetic-check' WHERE tier = 'guessed'").run(verification)
      assert.equal((db.prepare('SELECT count(*) AS n FROM email_candidates').get() as { n: number }).n, 3)
      assert.equal((db.prepare('SELECT contact FROM leads WHERE id = ?').get('lead') as { contact: string | null }).contact, null)
      const enrichments = db.prepare("SELECT connector, kind, value FROM lead_enrichments WHERE lead_id = 'lead'").all() as { connector: string; kind: string; value: string }[]
      assert.equal(publishedEmail({ contact: null, enrichments }), null, 'neither guessed nor published-tier storage is a published contact')
      assert.equal(draftBlockReason(db, 'A', 'lead'), 'no_email_contact')
      assert.throws(() => createDraft(db, 'A', 'lead', 'Seller'), (e: unknown) => e instanceof OutreachError && e.code === 'no_email_contact')
      assert.equal((db.prepare('SELECT count(*) AS n FROM outreach_messages').get() as { n: number }).n, 0, 'no candidate message can enter approval/sending')
      assert.equal(draftBlockReason(db, 'B', 'lead'), 'not_found', 'another tenant cannot consume candidate storage either')
    } finally { db.close() }
  })
}

test('control: independent published lead contact still drafts, not the verified-looking guessed candidate', () => {
  const db = fixture()
  try {
    db.prepare("UPDATE email_candidates SET verification = 'verified', verifier = 'synthetic-check', checked_at = 1800000000").run()
    db.prepare("UPDATE leads SET contact = 'sales@acme.example' WHERE id = 'lead'").run()
    const id = createDraft(db, 'A', 'lead', 'Seller')
    assert.equal((db.prepare('SELECT to_email FROM outreach_messages WHERE id = ?').get(id) as { to_email: string }).to_email, 'sales@acme.example')
  } finally { db.close() }
})

test('disabled verification with existing flag-on storage neither writes nor calls an injected verifier', async () => {
  const db = fixture()
  try {
    const before = db.prepare('SELECT * FROM email_candidates ORDER BY address').all()
    let calls = 0
    const result = await verifyCandidates(db, 'A', 'lead', { name: 'synthetic', async verify() { calls++; return { outcome: 'deliverable' } } }, { env: { EMAIL_GUESS_ENABLED: '0', EMAIL_VERIFY_DAILY_CAP: '100' } })
    assert.equal(calls, 0); assert.match(result.skipped ?? '', /off/)
    assert.deepEqual(db.prepare('SELECT * FROM email_candidates ORDER BY address').all(), before)
    assert.equal(verifierFromEnv({ EMAIL_VERIFY_URL: 'https://must-not-be-used.example', EMAIL_VERIFY_DAILY_CAP: '100' }), null, 'environment does not wire an operator endpoint')
  } finally { db.close() }
})
