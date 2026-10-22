import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migratePlans } from '../lib/plans.ts'
import { commenterBatchStatus, createCommenterBatch, deriveName, migrateCommenterImport, normalizeProfileUrl, parseProfiles, queuePendingCommenters, MAX_PROFILES } from '../lib/scan/commenter-import.ts'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migratePlans(db); migrateCommenterImport(db)
  return db
}

test('normalizeProfileUrl: accepts only linkedin.com/in profiles; posts, companies and other paths rejected; non-linkedin rejected', () => {
  const ok = normalizeProfileUrl('https://www.linkedin.com/in/jane-doe-8a4b2112/')
  assert.deepEqual(ok, { url: 'https://www.linkedin.com/in/jane-doe-8a4b2112', slug: 'jane-doe-8a4b2112' })
  assert.deepEqual(normalizeProfileUrl('linkedin.com/in/janedoe'), { url: 'https://www.linkedin.com/in/janedoe', slug: 'janedoe' })
  for (const bad of [
    'https://www.linkedin.com/posts/jane-doe_great-post-123',
    'https://www.linkedin.com/company/acme',
    'https://www.linkedin.com/feed/update/urn:li:activity:1',
    'https://example.com/in/jane-doe',
    'https://notlinkedin.com/in/jane',
  ]) assert.ok('reason' in normalizeProfileUrl(bad), bad)
})

test('deriveName: slug to display name, member-id suffix dropped, always a guess', () => {
  assert.equal(deriveName('jane-doe-8a4b2112'), 'Jane Doe')
  assert.equal(deriveName('janedoe'), 'Janedoe')
  assert.equal(deriveName('john-smith-phd'), 'John Smith Phd')
})

test('parseProfiles: dedupes, flags invalid, caps at 100 with overflow counted', () => {
  const lines = ['https://www.linkedin.com/in/a-b', 'https://www.linkedin.com/in/a-b/', 'not a url', 'https://www.linkedin.com/posts/x']
    .concat(Array.from({ length: 120 }, (_, i) => `https://www.linkedin.com/in/person-${i}`))
  const p = parseProfiles(lines.join('\n'))
  assert.equal(p.valid.length, MAX_PROFILES)
  assert.equal(p.overflow, 21) // 121 unique profiles minus 100
  assert.equal(p.invalid.length, 2)
  assert.equal(p.valid[0].derived_name, 'A B')
})

test('queue: one job per row, carries person_name, quota stop leaves rows pending, status labels names derived', () => {
  const db = setup()
  db.prepare("INSERT INTO tenant_plans (tenant_id, plan) VALUES ('A', 'pro')").run()
  const parsed = parseProfiles(['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/in/john-roe-9z'].join('\n'))
  const batch = createCommenterBatch(db, 'A', parsed.valid)
  const q = queuePendingCommenters(db, 'A', batch)
  assert.equal(q.queued, 2)
  const job = db.prepare('SELECT person_name, business_name, csv_domain FROM scan_jobs').all() as { person_name: string; business_name: string; csv_domain: string | null }[]
  assert.equal(job.length, 2)
  assert.equal(job[0].person_name, 'Jane Doe')
  assert.equal(job[0].csv_domain, null)
  const st = commenterBatchStatus(db, 'A', batch)!
  assert.equal(st.rows[0].name_source, 'derived')
  assert.equal(st.rows[0].status, 'queued')
  assert.equal(commenterBatchStatus(db, 'B', batch), undefined) // tenant isolation
  assert.equal(queuePendingCommenters(db, 'A', batch).queued, 0) // no double-queue
})
