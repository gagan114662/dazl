import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { threadMetrics } from '../lib/replies/thread-metrics.ts'
import { migrateThreadReplies } from '../lib/replies/threads.ts'

function db(): Database.Database {
  const d = new Database(':memory:')
  migrateThreadReplies(d)
  return d
}

function addThread(d: Database.Database, id: string, tenant: string, platform: string, query: string, verdict: string | null) {
  d.prepare('INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, buyer_intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tenant, platform, `https://example.com/${id}`, `t${id}`, `q${id}`, query, verdict)
}

test('threadMetrics counts each verdict bucket, NULL stays ungraded, tenant-isolated', () => {
  const d = db()
  addThread(d, 'a1', 't1', 'reddit', 'crm hiring', 'yes')
  addThread(d, 'a2', 't1', 'reddit', 'crm hiring', 'yes')
  addThread(d, 'a3', 't1', 'reddit', 'crm hiring', 'no')
  addThread(d, 'a4', 't1', 'reddit', 'crm hiring', null)
  addThread(d, 'b1', 't1', 'x', 'sales ops', 'uncertain')
  addThread(d, 'z1', 't2', 'reddit', 'crm hiring', 'yes') // other tenant
  const rows = threadMetrics(d, 't1')
  assert.equal(rows.length, 2)
  const reddit = rows.find(r => r.platform === 'reddit')!
  assert.deepEqual({ total: reddit.total, buyer_yes: reddit.buyer_yes, uncertain: reddit.uncertain, not_buyer: reddit.not_buyer, ungraded: reddit.ungraded }, { total: 4, buyer_yes: 2, uncertain: 0, not_buyer: 1, ungraded: 1 })
  const x = rows.find(r => r.platform === 'x')!
  assert.equal(x.buyer_yes, 0)
  assert.equal(x.uncertain, 1)
  assert.equal(rows[0].platform, 'reddit') // buyer_yes desc ordering
})
