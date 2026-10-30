// The follow-ups page paginated and filtered on the server (lib/outreach/followups.ts followupOverview, #369), on both
// engines. Synthetic tenants, plays and threads; nothing is fetched or sent.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { followupOverview, FollowupQueryError, parseFollowupQuery, type FollowupQuery } from '../lib/outreach/followups.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = 1_800_000_000
async function seed(db: Db, tenant: string, play: string, n: number, base: number, prefix: string, stoppedEvery = 0) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'Biz', 'test', 'test', 'running')", [play, tenant])
  for (let i = 0; i < n; i++) {
    const lead = `${prefix}-lead-${i}`, thread = `${prefix}-t-${String(i).padStart(3, '0')}`
    await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, 'Pat', ?, 'signal', 'https://n.example/a')", [lead, play, `${prefix} Co ${i}`])
    // Three threads share each second, so ties on the ordering key are covered.
    await db.run('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent, stopped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenant, thread, lead, `p${i}@${prefix}.example`, 'r', base - Math.floor(i / 3), base - 86400, 1, stoppedEvery && i % stoppedEvery === 0 ? 'replied' : null])
    await db.run("INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, 0, 'sent', ?)", [tenant, thread, base - Math.floor(i / 3)])
  }
}
async function all(db: Db, tenant: string, q: FollowupQuery, key: 'threads' | 'sent' = 'threads') {
  const out: string[] = []
  let cursor: string | null = null
  for (let i = 0; i < 200; i++) {
    const p = await followupOverview(db, tenant, { ...q, now: NOW, ...(key === 'threads' ? { cursor } : { sentCursor: cursor }) })
    out.push(...(key === 'threads' ? p.threads.map(t => t.thread_id) : p.sent.map(m => `${m.thread_id}#${m.step}`)))
    cursor = key === 'threads' ? p.next_cursor : p.sent_next_cursor
    if (!cursor) return out
  }
  throw new Error('pagination did not end')
}

bothEngines('an older play\'s threads stay reachable behind 120 newer ones in another play; pages are stable, counts exact', async ({ db }) => {
  await seed(db, 'T', 'play-a', 120, NOW, 'a', 4)
  await seed(db, 'T', 'play-b', 10, NOW - 30 * 86400, 'b')
  // Before #369 the page read the newest 100 account-wide: play B's threads were cut off.
  const b = await followupOverview(db, 'T', { jobId: 'play-b', now: NOW })
  assert.deepEqual([b.threads.length, b.next_cursor, b.counts], [10, null, { threads: 10, active: 10, stopped: 0 }])
  assert.ok(b.threads.every(t => t.thread_id.startsWith('b-')))
  assert.equal(b.sent.length, 10, 'the play\'s sent follow-ups too')
  // The whole account, page by page at several sizes: every thread once, newest activity first, ties by thread id.
  for (const limit of [1, 7, 50, 100]) {
    const ids = await all(db, 'T', { limit })
    assert.equal(ids.length, 130, `limit ${limit}`)
    assert.equal(new Set(ids).size, 130, `no duplicates at limit ${limit}`)
  }
  const first = await followupOverview(db, 'T', { limit: 4, now: NOW })
  assert.deepEqual(first.threads.map(t => t.thread_id), ['a-t-000', 'a-t-001', 'a-t-002', 'a-t-003'])
  // Counts are over every matching thread, whatever the page.
  assert.deepEqual(first.counts, { threads: 130, active: 100, stopped: 30 })
  assert.deepEqual((await followupOverview(db, 'T', { limit: 100, now: NOW })).counts, first.counts)
  assert.equal((await all(db, 'T', { status: 'stopped', limit: 9 })).length, 30)
  assert.deepEqual((await followupOverview(db, 'T', { status: 'active', now: NOW })).counts, { threads: 100, active: 100, stopped: 0 })
  // Sent follow-ups page on their own cursor.
  const sent = await all(db, 'T', { limit: 11 }, 'sent')
  assert.equal(sent.length, 130); assert.equal(new Set(sent).size, 130)
})

bothEngines('tenant scope: another tenant\'s threads, plays and sent follow-ups never show or count', async ({ db }) => {
  await seed(db, 'T', 'play-t', 5, NOW, 't')
  await seed(db, 'U', 'play-u', 7, NOW, 'u')
  const t = await followupOverview(db, 'T', { now: NOW })
  assert.deepEqual([t.threads.length, t.sent.length, t.counts.threads], [5, 5, 5])
  assert.ok(t.threads.every(x => x.thread_id.startsWith('t-')))
  const cross = await followupOverview(db, 'T', { jobId: 'play-u', now: NOW })
  assert.deepEqual([cross.threads, cross.sent, cross.counts], [[], [], { threads: 0, active: 0, stopped: 0 }])
})

bothEngines('a malformed cursor or status is refused, never guessed', async ({ db }) => {
  for (const c of ['nope', Buffer.from('[1]').toString('base64url'), Buffer.from('["x","t"]').toString('base64url')]) {
    await assert.rejects(followupOverview(db, 'T', { cursor: c, now: NOW }), (e: unknown) => e instanceof FollowupQueryError && e.code === 'bad_cursor')
    await assert.rejects(followupOverview(db, 'T', { sentCursor: c, now: NOW }), (e: unknown) => e instanceof FollowupQueryError && e.code === 'bad_cursor')
  }
  assert.throws(() => parseFollowupQuery(new URLSearchParams('status=everything')), (e: unknown) => e instanceof FollowupQueryError && e.code === 'bad_status')
  assert.deepEqual(parseFollowupQuery(new URLSearchParams('job_id=p1&status=active&limit=20')), { jobId: 'p1', status: 'active', cursor: null, sentCursor: null, limit: 20 })
})
