// scripts/pg-cutover.mts end to end on synthetic data: dry run, the closed gate, copy, an idempotent re-run, a refused
// copy into a target that drifted, verify naming the tenant, and the rollback copy back into a new SQLite file.
// Loopback Postgres only (a fresh schema per run, passed through the connection URL); nothing else is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import pg from 'pg'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { PG_URL, pgSkip, freshSchema } from './helpers/pg-test.ts'

const web = fileURLToPath(new URL('../', import.meta.url))
const A = 'a'.repeat(32), B = 'b'.repeat(32)

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/pg-cutover.mts', ...args], { cwd: web, encoding: 'utf8', timeout: 120000 })
  return { code: r.status, out: r.stdout + r.stderr }
}

function seededFile(dir: string): string {
  const file = path.join(dir, 'app.db')
  const db = new Database(file)
  migrateAllSqlite(db)
  for (const [id, n] of [[A, 2], [B, 1]] as const) {
    db.prepare("INSERT INTO users (id, email, password_hash, salt) VALUES (?, ?, 'h', 's')").run(id, `${id.slice(0, 4)}@example.test`)
    for (let i = 0; i < n; i++) db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES (?, ?, 'b', 'i', 'l')").run(`${id.slice(0, 2)}${i}`.padEnd(24, '0'), id)
  }
  db.close()
  return file
}

test('dry run with no target: counts per table and tenant, the gate, and nothing written', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cutover-'))
  try {
    const file = seededFile(dir)
    const r = cli('plan', '--from', file, '--tenants')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /dry run, nothing is written/)
    assert.match(r.out, /scan_jobs\s+3\s+tenants 2/)
    assert.match(r.out, new RegExp(`user_id=${A}  2`))
    assert.match(r.out, /cutover gate: closed, \d+ modules still use the raw SQLite handle/)
    assert.equal(cli('copy', '--from', 'postgres://x@127.0.0.1/x', '--to', file).code, 2, 'copy only goes SQLite -> Postgres')
  } finally { rmSync(dir, { recursive: true }) }
})

test('copy is gated, idempotent, refuses a drifted target; verify names the tenant; rollback writes a new SQLite file', { skip: pgSkip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cutover-'))
  const s = await freshSchema()
  const url = `${PG_URL}${PG_URL!.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${s.schema}`)}`
  try {
    const file = seededFile(dir)
    assert.match(cli('plan', '--from', file, '--to', url).out, /not migrated yet/)
    const gated = cli('copy', '--from', file, '--to', url)
    assert.equal(gated.code, 3, gated.out)
    assert.match(gated.out, /refused: \d+ modules still use the raw SQLite handle/)

    const first = cli('copy', '--from', file, '--to', url, '--rehearsal')
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /copied \d+ rows in \d+ tables/)
    assert.match(first.out, /stores match/)
    const again = cli('copy', '--from', file, '--to', url, '--rehearsal')
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /already copied: .* nothing written/)
    assert.match(cli('plan', '--from', file, '--to', url).out, /already holds exactly these rows: copy would write nothing/)

    // the target takes a write the source does not have: copy refuses, verify fails and names the tenant
    const c = new pg.Client({ connectionString: url })
    await c.connect()
    await c.query("INSERT INTO scan_jobs (id, user_id, business_name, industry, location) VALUES ('extra000000000000000000', $1, 'b', 'i', 'l')", [B])
    await c.end()
    const drifted = cli('copy', '--from', file, '--to', url, '--rehearsal')
    assert.equal(drifted.code, 3, drifted.out)
    assert.match(drifted.out, /differs from the source/)
    const v = cli('verify', '--from', file, '--to', url)
    assert.equal(v.code, 1, v.out)
    assert.match(v.out, new RegExp(`DIFF scan_jobs: 3 rows vs 4 \\(tenant ${B} 1 vs 2\\)`))

    // rollback: Postgres (with that write) back into a new SQLite file, verified; never over an existing file
    const back = path.join(dir, 'rollback.db')
    const rb = cli('rollback', '--from', url, '--to', back)
    assert.equal(rb.code, 0, rb.out)
    assert.match(rb.out, /stores match/)
    const r = new Database(back, { readonly: true })
    assert.equal((r.prepare('SELECT count(*) AS n FROM scan_jobs WHERE user_id = ?').get(B) as { n: number }).n, 2)
    r.close()
    assert.equal(cli('rollback', '--from', url, '--to', back).code, 3, 'an existing file is never overwritten')
  } finally { rmSync(dir, { recursive: true }); await s.drop() }
})
