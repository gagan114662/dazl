import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import Database from 'better-sqlite3'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import type { DiscoverResult } from '../lib/discover/agent.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { createQueryJob } from '../lib/scan/store.ts'

async function completedSearch(query: string, searches: number) {
  const db = new Database(':memory:')
  try {
    const master = randomBytes(32)
    migrateAllSqlite(db)
    saveKey(db, 'workspace', 'anthropic', 'sk-ant-test', master)
    const id = createQueryJob(db, 'workspace', { query, runBudget: JSON.stringify({ max_usd: 0.3 }) })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const reply: DiscoverResult = {
      leads: [], seen: [], model: 'offline-discovery',
      stop: 'end_turn', note: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches, requests: 1, usd: 0.01 },
    }
    const result = await runJob(db, job, {
      master, discover: true, enrichImpl: null,
      discoverImpl: async input => {
        assert.equal(input.query, query)
        return reply
      },
    })
    assert.equal(result, 'done')
    const status = await readScanStatus(sqliteDb(db), 'workspace', id)
    assert.ok(status)
    assert.equal(status.lead_count, 0)
    assert.equal(status.outcome.kind, 'none_extracted')
    return { id, status }
  } finally {
    db.close()
  }
}

test('#1726 the completed roofing search explains what Discovery actually did', async () => {
  const { id, status } = await completedSearch(
    'I run a residential roofing company in Calgary. Find homeowners and property managers in Calgary who need a roof replacement or roof repair now.',
    3,
  )
  assert.equal(status.outcome.detail, 'Discovery ran 6 web searches but returned no candidates. Try rewording the request with a clear buyer and one sign they need your service.')
  assert.deepEqual(status.outcome.next, { text: 'See what the scan read', href: `/app/leads?job_id=${id}` })
})

test('an unrelated search without recorded web searches does not claim a source searched', async () => {
  const { status } = await completedSearch('Independent bookshops in Lyon planning a new location', 0)
  assert.equal(status.outcome.detail, 'search:claude_discover was unavailable, not run or has no recorded counts (unknown, not zero), so the other sources returning nothing does not show that no company matches.')
})
