// #1471: Home (/app) and Plays (/app/plays) list the same plays for a workspace. Runs the REAL GET /api/plays and
// GET /api/scan/jobs handlers (only the session and the Db are swapped, tenant-route-db.ts / setDb) on SQLite and, when
// DAZL_TEST_PG_URL is set, on a fresh Postgres schema. Each page's own list is built with the same functions the page
// uses (lib/saved-plays.ts playsPageItems for Plays, lib/readiness.ts homePlays for Home's "Your plays", lib/journey.ts
// currentPlay for Home's play card), from those route answers.
//
// The prod shape (dazl.ai a7d77a8, 2026-11-21, wording only, no tenant data): a signed-in workspace ran one search,
// "Companies hiring ...", once on Nov 21. It has no weekly watch and no monitor. Home listed it; Plays said
// "No saved plays yet".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { setUser } from './tenant-route-db.ts'
import { setDb, sqliteDb, pgDb, type Db } from '../../lib/db/client.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { runPgMigrations } from '../../lib/db/migrate-pg.ts'
import { createWatch } from '../../lib/watch.ts'
import { createMonitor } from '../../lib/monitors.ts'
import { playsPageItems } from '../../lib/saved-plays.ts'
import { homePlays } from '../../lib/readiness.ts'
import { currentPlay } from '../../lib/journey.ts'
import { PG_URL, freshSchema } from './pg-test.ts'

globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call to ${String(u)}`) }) as typeof fetch
const plays = await import('../../app/api/plays/route.ts')
const jobsRoute = await import('../../app/api/scan/jobs/route.ts')

const A = 'a'.repeat(32), B = 'b'.repeat(32)
const DAY = 86400, NOW = Math.floor(Date.now() / 1000)
const ICP = JSON.stringify({ summary: 'Teams growing their sales staff' })
const HIRING = 'Companies hiring sales development reps in the last 30 days'

async function job(db: Db, o: { id: string; user: string; query: string | null; at: number; status?: string; watch?: string | null; csv?: string | null; fixture?: boolean }) {
  await db.run(
    'INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at, finished_at, csv_domain, watch_id, candidates, verified, needs_review, dropped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, 1, 0, 1)',
    [o.id, o.user, 'Seller', o.fixture ? 'test only' : '(from request)', o.fixture ? 'test only' : '-', o.query, o.status ?? 'done', o.at, o.at + 60, o.csv ?? null, o.watch ?? null])
}

type Body = { plays: { key: string; kind: string; id: string; query: string; runs: string[] }[]; watches: unknown[]; monitors: unknown[]; emails: boolean }

async function views(tenant: string) {
  setUser({ id: tenant, business_name: 'Seller' })
  const r = await plays.GET()
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('cache-control'), 'no-store')
  const body = await r.json() as Body
  const jobs = (await (await jobsRoute.GET()).json() as { jobs: Parameters<typeof homePlays>[1] & Parameters<typeof currentPlay>[0] }).jobs
  const page = playsPageItems(body as Parameters<typeof playsPageItems>[0]).map(p => p.key)
  const home = homePlays(body.plays as Parameters<typeof homePlays>[0], jobs, []).map(p => p.key)
  const card = currentPlay(jobs)
  return { body, page, home, card, jobs }
}

async function scenario(db: Db) {
  setDb(db)
  setUser(null)
  assert.equal((await plays.GET()).status, 401, 'signed out')

  // 1. The prod shape: one search, run once, no watch, no monitor.
  await job(db, { id: '1'.repeat(24), user: A, query: HIRING, at: NOW - 2 * DAY })
  let v = await views(A)
  assert.equal(v.page.length, 1, 'Plays lists the play Home lists (was: "No saved plays yet")')
  assert.deepEqual(v.page, v.home, 'same plays on both pages')
  assert.equal(v.body.plays[0].kind, 'once')
  assert.equal(v.body.plays[0].query, HIRING)
  assert.ok(v.card && v.body.plays.some(p => p.runs.includes(v.card!.id)), "Home's play card is one of the listed plays")

  // 2. A repeating play (weekly watch) with its runs, a monitor with a run, and a manual re-run of the watch's sentence:
  //    each is ONE play on both pages, never one row per run.
  const w = (await createWatch(db, A, 'Agencies that just raised a seed round', ICP, null, NOW - 20 * DAY)).watch!
  await job(db, { id: '2'.repeat(24), user: A, query: w.query, at: NOW - 13 * DAY, watch: w.id })
  await job(db, { id: '3'.repeat(24), user: A, query: w.query, at: NOW - 6 * DAY, watch: w.id })
  await job(db, { id: '4'.repeat(24), user: A, query: `  ${w.query} `, at: NOW - 5 * DAY })   // started by hand, same sentence
  const m = await createMonitor(db, A, { query: 'Shops that opened a second location' }, NOW - 10 * DAY)
  assert.ok('id' in m)
  await job(db, { id: '5'.repeat(24), user: A, query: 'Shops that opened a second location', at: NOW - 3 * DAY })
  await db.run('INSERT INTO monitor_runs (id, monitor_id, job_id, ran_at) VALUES (?, ?, ?, ?)', ['r1', m.id, '5'.repeat(24), NOW - 3 * DAY])
  // a second one-off search, and the same one-off sentence run twice: one play
  await job(db, { id: '6'.repeat(24), user: A, query: 'Clinics adding a new service line', at: NOW - DAY, status: 'failed' })
  await job(db, { id: '7'.repeat(24), user: A, query: HIRING, at: NOW - 12 * 3600 })
  // not plays (as Home always counted them): a CSV import, a test fixture, a scan with no sentence
  await job(db, { id: '8'.repeat(24), user: A, query: 'imported list', at: NOW - 3600, csv: 'list.csv' })
  await job(db, { id: '9'.repeat(24), user: A, query: 'fixture run', at: NOW - 1800, fixture: true })
  await job(db, { id: 'a'.repeat(24), user: A, query: null, at: NOW - 900 })
  // another workspace's search with the SAME sentence and its own watch: never in A's lists
  await job(db, { id: 'b'.repeat(24), user: B, query: HIRING, at: NOW - 600 })
  await createWatch(db, B, 'SECRET-b-WATCH', ICP, null, NOW - DAY)

  v = await views(A)
  assert.deepEqual(new Set(v.page), new Set(v.home), 'every play Home lists is on Plays, and every play on Plays is on Home')
  assert.equal(v.page.length, v.home.length)
  assert.deepEqual(v.page, v.home, 'and in the same order')
  const kinds = Object.fromEntries(v.body.plays.map(p => [p.query.trim(), p.kind]))
  assert.deepEqual(kinds, { [w.query]: 'watch', 'Shops that opened a second location': 'monitor', [HIRING]: 'once', 'Clinics adding a new service line': 'once' })
  const byQuery = Object.fromEntries(v.body.plays.map(p => [p.query.trim(), new Set(p.runs)]))
  assert.deepEqual(byQuery[w.query], new Set(['2'.repeat(24), '3'.repeat(24), '4'.repeat(24)]), "the watch's runs and the hand re-run of its sentence")
  assert.deepEqual(byQuery[HIRING], new Set(['1'.repeat(24), '7'.repeat(24)]))
  // every own search on Home's history belongs to exactly one listed play
  const own = v.jobs.filter(j => j.query && !j.csv_domain && !j.test_only).map(j => j.id)
  assert.deepEqual(own.map(id => v.body.plays.filter(p => p.runs.includes(id)).length), own.map(() => 1))
  assert.ok(v.card && v.body.plays.some(p => p.runs.includes(v.card!.id)), "Home's play card is one of the listed plays")
  const text = JSON.stringify(v.body)
  assert.ok(!text.includes('SECRET-b') && !text.includes('b'.repeat(24)), 'GET /api/plays: another workspace\'s plays never show')

  // B sees only its own: its one-off search and its watch, the same on both pages
  const vb = await views(B)
  assert.deepEqual(vb.page, vb.home)
  assert.deepEqual(vb.body.plays.map(p => p.kind).sort(), ['once', 'watch'])
}

test('#1471 Home and Plays list the same plays (SQLite)', async () => {
  const raw = new Database(':memory:'); migrateAllSqlite(raw)
  await scenario(sqliteDb(raw))
})

test('#1471 Home and Plays list the same plays (Postgres)', { skip: PG_URL ? false : 'DAZL_TEST_PG_URL not set' }, async () => {
  const s = await freshSchema()
  const db = pgDb({ connectionString: PG_URL!, searchPath: s.schema, max: 2 })
  try { await runPgMigrations(db.pool); await scenario(db) } finally { await db.close(); await s.drop() }
})
