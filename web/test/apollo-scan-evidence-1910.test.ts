import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { addEnrichment } from '../lib/connectors/store.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { collectApolloScanEvidence } from '../lib/enrich/apollo-scan-evidence.ts'
import { createQueryJob } from '../lib/scan/store.ts'

test('#1910 Apollo evidence comes only from owned, dated Discovery rows with completed crawl and no published buyer address', () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const job = createQueryJob(db, 'tenant', { query: 'Find companies' })
    const otherJob = createQueryJob(db, 'other', { query: 'Find companies' })
    db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id IN (?, ?)").run(job, otherJob)
    const host = 'example.test'
    const source = `https://${host}/news`
    const add = (id: string, kind: string, value: string, connector = 'discover') =>
      addEnrichment(db, id === 'foreign' ? 'other' : 'tenant', id, {
        connector, kind, value, label: '', confidence: null, source_url: source, source_date: '2026-11-20', retrieved_at: 1795132800,
      })
    for (const id of ['eligible', 'unread', 'undated', 'held', 'unconfirmed', 'published', 'foreign']) {
      db.prepare(`INSERT INTO leads (id,scan_job_id,company,company_domain,source_kind,source_url,signal,
        event_date,event_date_proof,fit,intent,confidence,review_reason) VALUES (?,?,?,?,'discover',?,'Expansion',?,?,4,4,90,?)`)
        .run(id, id === 'foreign' ? otherJob : job, 'Example', host, source, '2026-11-20',
          id === 'undated' ? null : 'page_bound', id === 'held' ? 'quote_unconfirmed' : null)
      add(id, 'person', 'Casey Olsen, Owner')
      if (id !== 'unconfirmed') add(id, 'domain', host + '|evidence_own_domain', 'sitecrawl')
      if (id === 'published') add(id, 'email', 'casey.olsen@example.test', 'sitecrawl')
    }
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id IN (?, ?)").run(job, otherJob)
    const ids = ['eligible', 'undated', 'held', 'unconfirmed', 'published', 'foreign', 'eligible']
    const now = new Date('2026-11-26T00:00:00Z')
    const planned = collectApolloScanEvidence(db, 'tenant', job, ids, now)
    assert.deepEqual(planned.map(row => row.leadId), ['eligible'])
    assert.equal(planned[0]?.evidence.confirmedDomain, host)
    assert.deepEqual(collectApolloScanEvidence(db, 'other', job, ids, now), [])
  } finally { db.close() }
})
