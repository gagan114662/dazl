import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migratePlans } from '../lib/plans.ts'
import { migratePlatform } from '../lib/db/platform-tables.ts'

// #913 acceptance: two separate PROCESSES, each with its own connection to one database FILE, race the real POST /api/scan handler.
// Each child stops AT the admission fence (after the route's early checks passed); the parent sees both there and releases them together. Synthetic tenant and key, network fenced in the children, no runner, no provider call.
const web = fileURLToPath(new URL('../', import.meta.url))
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
interface Out { pid: number; status: number; error: string | null; job_id: string | null; ms: number }

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dazl-admit-')); const file = path.join(dir, 'app.db')
  const env = { ...process.env, DAZL_MASTER_KEY: randomBytes(32).toString('base64') }
  const db = new Database(file); migrateScan(db); migrateKeys(db); migratePlans(db); migratePlatform(db)
  const saved = process.env.DAZL_MASTER_KEY; process.env.DAZL_MASTER_KEY = env.DAZL_MASTER_KEY
  for (const t of ['TA', 'TB']) saveKey(db, t, 'anthropic', 'sk-ant...AAAA')
  if (saved === undefined) delete process.env.DAZL_MASTER_KEY; else process.env.DAZL_MASTER_KEY = saved
  return { dir, file, db, env }
}
function child(s: ReturnType<typeof setup>, tenant: string, tag: string) {
  const env = { ...s.env, DB_FILE: s.file, TENANT: tenant, READY_FILE: path.join(s.dir, `ready-${tag}`), GO_FILE: path.join(s.dir, 'go') } as NodeJS.ProcessEnv
  delete env.NODE_TEST_CONTEXT
  const p = spawn(process.execPath, ['--experimental-strip-types', '--import', './test/helpers/net-fence.ts', '--loader', './test/helpers/scan-route-loader.mjs', './test/helpers/scan-admission-child.mts'], { cwd: web, env })
  let out = '', err = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  const done = new Promise<Out>((resolve, reject) => {
    p.on('close', code => { const m = /RESULT (.*)/.exec(out); if (code === 0 && m) resolve(JSON.parse(m[1]) as Out); else reject(new Error(`child ${tag} exit ${code}: ${out}${err}`)) })
    setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child ${tag} timed out: ${out}${err}`)) }, 60000).unref()
  })
  return { ready: env.READY_FILE as string, done }
}
async function race(s: ReturnType<typeof setup>, tenants: [string, string]) {
  const a = child(s, tenants[0], 'a'), b = child(s, tenants[1], 'b')
  for (let i = 0; i < 1500 && !(existsSync(a.ready) && existsSync(b.ready)); i++) await wait(20)
  assert.ok(existsSync(a.ready) && existsSync(b.ready), 'both children reached the admission fence (their early checks passed with nothing active)')
  assert.equal((s.db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, 0, 'at the fence nothing is written yet')
  writeFileSync(path.join(s.dir, 'go'), '1')                          // released together: only the fence itself can separate them
  return Promise.all([a.done, b.done])
}
const jobs = (db: Database.Database, t: string) => db.prepare('SELECT id, status FROM scan_jobs WHERE user_id = ?').all(t) as { id: string; status: string }[]

test('two processes, one tenant, one shared file: exactly one 202, the other the documented scan_active, with both parked at the fence until released together', async () => {
  const s = setup()
  try {
    const out = await race(s, ['TA', 'TA'])
    assert.deepEqual(out.map(o => o.status).sort(), [202, 409], JSON.stringify(out))
    assert.equal(out.find(o => o.status === 409)!.error, 'scan_active')
    const rows = jobs(s.db, 'TA'); assert.equal(rows.length, 1, 'one job row, no orphan'); assert.equal(rows[0].id, out.find(o => o.status === 202)!.job_id)
    assert.equal((s.db.prepare('SELECT count(*) AS n FROM scan_jobs').get() as { n: number }).n, 1, 'nothing else was written anywhere')
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }) }
})

test('two processes, two different tenants, one shared file: both admitted (tenant isolation holds under lock contention)', async () => {
  const s = setup()
  try {
    const out = await race(s, ['TA', 'TB'])
    assert.deepEqual(out.map(o => o.status), [202, 202], JSON.stringify(out))
    assert.deepEqual([jobs(s.db, 'TA').length, jobs(s.db, 'TB').length], [1, 1])
  } finally { s.db.close(); rmSync(s.dir, { recursive: true, force: true }) }
})
