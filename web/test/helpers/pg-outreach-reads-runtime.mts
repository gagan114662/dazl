// Runs /api/outreach/followups and /api/replies/thread-metrics on a fresh Postgres schema with two tenants (see
// test/pg-outreach-reads.test.ts). Read-only routes; stubbed: no network call is allowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setUser } from './tenant-route-db.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call to ${String(u)}`) }) as typeof fetch
const A = 'a'.repeat(32), B = 'b'.repeat(32)

test('follow-ups and thread metrics on Postgres, two tenants', async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    setDb(db)
    const now = 1_800_000_000
    const lead: Record<string, string> = {}
    for (const [t, tag] of [[A, 'a'], [B, 'b']]) {
      const job = `${tag}1`.padEnd(24, '0'), id = `${tag}2`.padEnd(24, '0')
      await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, 'b', 'i', 'l', 'running')", [job, t])
      await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url) VALUES (?, ?, ?, ?, 's', ?)", [id, job, `Pat ${tag}`, `SECRET-${tag}-CO`, `https://${tag}.example`])
      lead[tag] = id
      // Gmail connected, follow-ups on for A only
      await db.run("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES (?, ?, 'ct', 'active')", [t, `${tag}@mail.example`])
      await db.run('INSERT INTO autopilot_settings (tenant_id, followups_enabled) VALUES (?, ?)', [t, tag === 'a' ? 1 : 0])
      await db.run('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, last_lead_reply_at, followups_sent) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        [t, `th-${tag}`, id, `buyer@${tag}.example`, `root-${tag}`, now, now])
      await db.run("INSERT INTO followup_messages (tenant_id, thread_id, step, status, created_at) VALUES (?, ?, 0, 'sent', ?)", [t, `th-${tag}`, now + 1])
      for (const [q, verdict] of [['q1', 'yes'], ['q1', 'no'], ['q2', null]] as const)
        await db.run("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, buyer_intent) VALUES (?, ?, 'reddit', ?, 't', 'q', ?, ?)",
          [`rt-${tag}-${q}-${verdict}`, t, `https://reddit.example/${tag}/${q}/${verdict}`, `SECRET-${tag}-${q}`, verdict])
    }
    // a thread of A's that names B's lead (inconsistent data): A must not see B's company through it
    await db.run('INSERT INTO followup_threads (tenant_id, thread_id, lead_id, to_email, root_message_id, last_activity_at, followups_sent) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [A, 'th-a-cross', lead.b, 'x@a.example', 'root-x', now - 10])

    const followups = await import('../../app/api/outreach/followups/route.ts')
    const metrics = await import('../../app/api/replies/thread-metrics/route.ts')
    const seen: Record<string, { f: { enabled: boolean; account: string | null; threads: { thread_id: string; company: string }[]; sent: { thread_id: string; company: string }[] }; m: { rows: { query: string; total: number; buyer_yes: number; not_buyer: number; ungraded: number }[] } }> = {}
    for (const [t, tag] of [[A, 'a'], [B, 'b']]) {
      setUser({ id: t, business_name: tag })
      seen[tag] = { f: await (await followups.GET()).json(), m: await (await metrics.GET()).json() }
    }
    const a = seen.a, b = seen.b
    assert.deepEqual([a.f.enabled, a.f.account], [true, 'a@mail.example'])
    assert.deepEqual([b.f.enabled, b.f.account], [false, 'b@mail.example'])
    assert.deepEqual(a.f.threads.map(x => [x.thread_id, x.company]), [['th-a', 'SECRET-a-CO'], ['th-a-cross', '']])
    assert.deepEqual(b.f.threads.map(x => [x.thread_id, x.company]), [['th-b', 'SECRET-b-CO']])
    assert.deepEqual(a.f.sent.map(x => [x.thread_id, x.company]), [['th-a', 'SECRET-a-CO']])
    assert.deepEqual(b.f.sent.map(x => [x.thread_id, x.company]), [['th-b', 'SECRET-b-CO']])
    assert.deepEqual(a.m.rows.map(r => [r.query, r.total, r.buyer_yes, r.not_buyer, r.ungraded]), [['SECRET-a-q1', 2, 1, 1, 0], ['SECRET-a-q2', 1, 0, 0, 1]])
    assert.deepEqual(b.m.rows.map(r => r.query), ['SECRET-b-q1', 'SECRET-b-q2'])
    for (const [me, other] of [['a', 'b'], ['b', 'a']]) {
      const text = JSON.stringify(seen[me])
      for (const leak of [`SECRET-${other}-`, `${other}@mail.example`, `th-${other}`, `buyer@${other}.example`]) assert.ok(!text.includes(leak), `${me} saw ${leak}`)
    }
    console.log('PG_OUTREACH_READS ok')
  } finally { await db.close(); await s.drop() }
})
