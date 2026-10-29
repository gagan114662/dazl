// Multi-tenant on Postgres, table by table, with two app instances (test/helpers/pg-table-sweep-instance.mts): two
// processes, each with its own pool on one Postgres schema, each signs up its own tenant and writes one marked row into
// EVERY tenant-scoped table. Then each, in turn, calls every session route in tenant-isolation-manifest.ts with the
// other tenant's ids (path, query and body; reads, lists, updates, deletes and exports), while the other watches its
// rows. Proved for every table: nothing of the other tenant's comes back from either instance, and its rows stay
// byte-identical. Also reported, per table: the routes that return it to its owner on Postgres (the seed is visible
// through the API), and whether the modules that use it are on the Db layer or still on the raw SQLite handle
// (lib/db/pg-port-status.ts). Stubbed: no outbound fetch is possible, no Stripe, no paid call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { pgDb } from '../lib/db/client.ts'
import { runPgMigrations } from '../lib/db/migrate-pg.ts'
import { RAW_SQLITE_MODULES } from '../lib/db/pg-port-status.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'
import { tenantTables } from './helpers/tenant-seed.ts'

const run = promisify(execFile)
const web = fileURLToPath(new URL('../', import.meta.url))
type Result = { tag: string; tenant: string; seeded: string[]; failed: Record<string, string>; reads: Record<string, string[]>; status: Record<string, string>; violations: string[]; changed: string[]; calls: { total: number } }

const instance = async (schema: string, tag: string, otherTag: string, first: boolean, pw: string) => {
  const e: NodeJS.ProcessEnv = { ...process.env, PT_SCHEMA: schema, PT_TAG: tag, PT_OTHER_TAG: otherTag, PT_FIRST: first ? '1' : '0', PT_PW: pw }
  delete e.NODE_TEST_CONTEXT; delete e.DATABASE_URL
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/pg-session-loader.mjs', './test/helpers/pg-table-sweep-instance.mts'],
    { cwd: web, env: e, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Result
}

// The app modules (outside tests) that run SQL on a table, and on which store. Per statement: SQL handed to
// prepare()/exec() runs on the raw SQLite handle; SQL handed to run/get/all (a Db or a transaction) runs on the Db
// layer, so on Postgres too. A statement built elsewhere (a constant) takes its module's status from
// lib/db/pg-port-status.ts.
const sources = (() => {
  const out: [string, string][] = []
  const walk = (d: string) => { for (const f of readdirSync(path.join(web, d))) { const p = path.join(d, f); if (statSync(path.join(web, p)).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && !p.includes('migrat')) out.push([p, readFileSync(path.join(web, p), 'utf8')]) } }
  walk('app'); walk('lib')
  return out
})()
export function tableModules(table: string): { pg: string[]; sqlite: string[] } {
  // data statements only: a module's CREATE TABLE (its SQLite migration) does not make it a user of the table
  const re = new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'gi')
  const pg = new Set<string>(), sqlite = new Set<string>()
  for (const [p, src] of sources) {
    for (const m of src.matchAll(re)) {
      const before = src.slice(Math.max(0, m.index! - 400), m.index!)
      const raw = Math.max(before.lastIndexOf('prepare('), before.lastIndexOf('.exec('))
      const layer = Math.max(...['.run(', '.get(', '.all(', '.get<', '.all<'].map(k => before.lastIndexOf(k)))
      if (raw > layer) sqlite.add(p)
      else if (layer > raw) pg.add(p)
      else (p in RAW_SQLITE_MODULES ? sqlite : pg).add(p)
    }
  }
  return { pg: [...pg].sort(), sqlite: [...sqlite].sort() }
}

test('[pg] two instances, every tenant-scoped table: no route returns, changes or exports the other tenant\'s rows', { skip: pgSkip, timeout: 1_800_000 }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try {
    await runPgMigrations(db.pool)
    await db.run('CREATE TABLE pt_barrier (phase TEXT NOT NULL, tag TEXT NOT NULL, value TEXT, PRIMARY KEY (phase, tag))')
    const tables = [...(await tenantTables(db)).keys()].sort()
    const ta = `ta${randomBytes(3).toString('hex')}`, tb = `tb${randomBytes(3).toString('hex')}`, pw = randomBytes(6).toString('hex')
    const [a, b] = await Promise.all([instance(s.schema, ta, tb, true, pw), instance(s.schema, tb, ta, false, pw)])

    for (const r of [a, b]) {
      assert.deepEqual(r.failed, {}, `${r.tag}: tables not seeded`)
      assert.deepEqual(r.seeded, tables, `${r.tag}: every tenant-scoped table holds a row of its own`)
      assert.deepEqual(r.violations, [], `${r.tag} received the other tenant's data:\n${r.violations.join('\n')}`)
      assert.deepEqual(r.changed, [], `${r.tag}'s rows changed while the other instance swept: ${r.changed.join(', ')}`)
    }
    // the per-table report: where each table is read on Postgres through the API, and where its modules live
    const readBy = new Map<string, Set<string>>()
    for (const r of [a, b]) for (const [route, ts] of Object.entries(r.reads)) for (const t of ts) readBy.set(t, (readBy.get(t) ?? new Set()).add(route))
    const rows = tables.map(t => {
      const m = tableModules(t)
      const reads = readBy.get(t)
      // postgres: every module that uses it is on the Db layer; mixed: some still on raw SQLite; sqlite only: all are,
      // and no route reads it on Postgres
      const store = m.sqlite.length === 0 ? 'postgres' : m.pg.length === 0 && !reads ? 'sqlite only' : 'mixed'
      return { table: t, store, api_reads_on_pg: [...(readBy.get(t) ?? [])].sort(), sqlite_modules: m.sqlite }
    })
    const routeStatus = Object.entries(a.status).sort()
    console.log('PG_TABLE_ISOLATION ' + JSON.stringify({ calls: a.calls.total + b.calls.total, tables: rows.length,
      routes: { ok: routeStatus.filter(([, v]) => v === 'ok').length, sqlite: routeStatus.filter(([, v]) => v === 'sqlite').map(([k]) => k), error: routeStatus.filter(([, v]) => v === 'error').map(([k]) => k) } }))
    for (const r of rows) console.log(`PG_TABLE ${r.table.padEnd(28)} ${r.store.padEnd(12)} reads:${r.api_reads_on_pg.length ? r.api_reads_on_pg.join(',') : '-'} ${r.sqlite_modules.length ? 'sqlite:' + r.sqlite_modules.join(',') : ''}`)
  } finally { await db.close(); await s.drop() }
})
