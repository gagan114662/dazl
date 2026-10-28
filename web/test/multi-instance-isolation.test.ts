// Tenant isolation across app instances on one Postgres (docs/PLATFORM.md step 4 on the shared store). Two instances,
// each a separate process with its own pool, write tenant A's and tenant B's data through every Db-layer write path
// (sign-up and sessions, billing, scan jobs and leads, SEO audits/briefs/drafts, the work queue). Then each instance
// reads as the tenant the OTHER instance wrote, and as itself with the other tenant's ids, through every Db-layer
// read, list, export and action path. Nothing of the other tenant may come back, and no action may touch it.
// Modules still on raw SQLite (campaigns, most settings, outreach) cannot run on Postgres yet; their routes are
// covered on SQLite by tenant-isolation-manifest.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const run = promisify(execFile)
const A = 'a'.repeat(32), B = 'b'.repeat(32)
const instance = async (env: Record<string, string>) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env }; delete e.NODE_TEST_CONTEXT
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', './test/helpers/isolation-instance.mts'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env: e, encoding: 'utf8', timeout: 120_000 })
  return JSON.parse(r.stdout)
}

test('[pg] two instances, two tenants: no read, list, export or action path returns or touches the other tenant', { skip: pgSkip }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    // instance 1 writes A, instance 2 writes B, at the same time
    const [wa, wb] = await Promise.all([instance({ ISO_MODE: 'write', ISO_TENANT: A, ISO_SCHEMA: s.schema }), instance({ ISO_MODE: 'write', ISO_TENANT: B, ISO_SCHEMA: s.schema })])
    // then crossed: instance 1 reads as B (written by instance 2), instance 2 reads as A
    const [ra, rb] = await Promise.all([
      instance({ ISO_MODE: 'read', ISO_TENANT: A, ISO_SCHEMA: s.schema, ISO_OTHER: JSON.stringify({ ...wb, tenant: B }) }),
      instance({ ISO_MODE: 'read', ISO_TENANT: B, ISO_SCHEMA: s.schema, ISO_OTHER: JSON.stringify({ ...wa, tenant: A }) }),
    ])
    for (const [me, r, mine, theirs] of [[A, ra, wa, wb], [B, rb, wb, wa]] as const) {
      const tag = me.slice(0, 1), other = tag === 'a' ? 'b' : 'a', otherT = me === A ? B : A
      // with the other tenant's ids: nothing comes back, nothing changes
      assert.equal(r.otherJob, null, `${tag} read ${other}'s job`)
      assert.deepEqual(r.otherLeads, [])
      assert.equal(r.otherHidden, 0)
      assert.deepEqual(r.otherExport, [])
      assert.deepEqual(r.cancelOther, { ok: false, reason: 'not_found' })
      assert.equal(r.approveOtherNews, false)
      assert.equal(r.otherSessionAsMe, otherT) // the other tenant's token resolves to that tenant, never to this one
      // own lists and exports: only own rows
      assert.deepEqual(r.jobs.map((j: { id: string }) => j.id).sort(), [mine.job, mine.query].sort())
      assert.deepEqual(r.exportAll.map((l: { company: string }) => l.company), [`SECRET-${tag}-CO`])
      assert.equal(r.exportAll[0].timing_note, `note ${tag}`)
      assert.equal(r.latestJob, mine.query)
      assert.equal(r.latestQuery.query, `SECRET-${tag}-QUERY`)
      assert.equal(r.active, 1) // own pending query scan only; the other's cancel attempt changed nothing
      assert.equal(r.plan, 'pro')
      assert.equal(r.login, me)
      assert.deepEqual(r.audits.map((x: { id: string }) => x.id), [`audit-${tag}`])
      assert.deepEqual(r.briefs.map((x: { topic: string }) => x.topic), [`SECRET-${tag}-TOPIC`])
      assert.deepEqual(r.news.map((x: { draft: string; status: string }) => [x.draft, x.status]), [[`SECRET-${tag}-DRAFT`, 'draft']])
      assert.equal(r.queueDepth, 1)
      assert.equal(r.claim, me)
      assert.ok(r.portal.includes(`cus_${tag}`) && !r.portal.includes(`cus_${other}`))
      assert.ok(r.stripeBodies.every((b: string) => b.includes(`cus_${tag}`) && !b.includes(`cus_${other}`)), r.stripeBodies.join(' | '))
      assert.equal(r.rate, true) // the other tenant's traffic spent none of this tenant's allowance
      // and no marker of the other tenant appears anywhere in what this tenant got
      const all = JSON.stringify({ ...r, otherSessionAsMe: null })
      for (const leak of [`SECRET-${other}-`, `cus_${other}`, `${other}@example.test`, `${other}.example/`, `note ${other}`, theirs.job, theirs.query]) assert.ok(!all.includes(leak), `${tag} saw ${leak}`)
    }
    // the cross attempts changed nothing in the store
    assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM scan_jobs WHERE status = 'pending'"))!.n), 2)
    assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM newsjacks WHERE status = 'draft'"))!.n), 2)
  } finally { await db.close(); await s.drop() }
})
