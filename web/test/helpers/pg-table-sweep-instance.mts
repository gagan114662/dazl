// One app instance for test/pg-table-isolation.test.ts: its own Postgres pool on the shared schema (PT_SCHEMA), the
// real route handlers and the real session lookup (pg-session-loader.mjs), beside a second instance serving the other
// tenant. Phases, each started by a barrier both instances reach:
//   seed  - sign up through the auth route (a real session), then write one marked row into EVERY tenant-scoped table
//           for this tenant (tenant-seed.ts)
//   own   - GET every session route as the owner, with its own ids: which tables' markers come back shows which
//           tables each route reads on Postgres (the positive control: the seed is visible through the API)
//   sweep - one instance at a time: call every session route and method as this tenant with each of the OTHER
//           tenant's row ids and stored values (a keyword, a domain, ...) in the path, the query and the body, under
//           every column name in the schema, once per action the route's source handles, plus once with nothing. No response may carry anything of the other
//           tenant's. The other instance snapshots its rows before and compares after: unchanged, byte for byte.
// Routes still on the raw SQLite handle cannot run here (DB_PATH is a trap that cannot be opened): they answer an
// error, which is recorded as 'sqlite' for that route, never as a pass. No network: every outbound fetch throws.
// Rate-limit counters are cleared between calls, so a 429 never stands in for a refusal.
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { withJar, type Jar } from './pg-session-headers.ts'
import { pgDb, setDb } from '../../lib/db/client.ts'
import { ROUTES } from '../tenant-isolation-manifest.ts'
import { seedTenant, snapshot } from './tenant-seed.ts'

process.env.DB_PATH = '/nonexistent-dazl-dir/app.db'
Object.assign(process.env, { PUBLIC_BASE_URL: 'https://app.dazl.test', DAZL_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') })
globalThis.fetch = (async (u: unknown) => { throw new Error(`Unexpected network call: ${String(u)}`) }) as typeof fetch
const db = pgDb({ connectionString: process.env.DAZL_TEST_PG_URL!, searchPath: process.env.PT_SCHEMA, max: 4 })
setDb(db)
const tag = process.env.PT_TAG!, otherTag = process.env.PT_OTHER_TAG!, first = process.env.PT_FIRST === '1'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const barrier = async (phase: string, value: unknown = null) => {
  await db.run('INSERT INTO pt_barrier (phase, tag, value) VALUES (?, ?, ?)', [phase, tag, JSON.stringify(value)])
  for (;;) {
    const rows = await db.all<{ tag: string; value: string }>('SELECT tag, value FROM pt_barrier WHERE phase = ?', [phase])
    if (rows.length === 2) return JSON.parse(rows.find(r => r.tag !== tag)!.value)
    await sleep(5)
  }
}
const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://app.dazl.test${url}`, {
  method, headers: { 'content-type': 'application/json', host: 'app.dazl.test', origin: 'https://app.dazl.test', 'x-forwarded-for': `203.0.113.${first ? 5 : 6}` },
  body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) })
const KEYS = ['id', 'ids', 'job_id', 'jobId', 'lead_id', 'leadId', 'lead', 'lead_ids', 'scan_job_id', 'batch_id', 'batch', 'thread_id', 'message_id', 'draft_id', 'sequence_id', 'campaign_id', 'monitor_id', 'watch_id', 'brief_id', 'newsjack_id', 'reply_id', 'step_id', 'connection_id', 'domain', 'slug']
// every column name of every table, so a route reading any field by name gets the value
const COLUMNS = (await db.all<{ c: string }>("SELECT DISTINCT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()")).map(r => r.c)
const NAMES = [...new Set([...KEYS, ...COLUMNS])].filter(k => k !== 'action')
const withIds = (x: string, action?: string) => ({ ...Object.fromEntries(NAMES.map(k => [k, k.endsWith('ids') ? [x] : x])), ...(action ? { action } : {}) })
const query = (x: string) => '?' + new URLSearchParams(Object.fromEntries(KEYS.map(k => [k, x]))).toString()
// the actions a route's handler switches on, read from its source
const actions = (path: string) => { const src = readFileSync(new URL(`../../app/api/${path}/route.ts`, import.meta.url), 'utf8'); return [...new Set([...src.matchAll(/case '([\w-]+)'|action === '([\w-]+)'/g)].map(m => m[1] ?? m[2]))] }
const routes = ROUTES.filter(r => r.auth === 'session')
const handlers = new Map<string, (...a: unknown[]) => Promise<Response>>()
for (const r of routes) {
  try { const m = await import(`../../app/api/${r.path}/route.ts`) as Record<string, (...a: unknown[]) => Promise<Response>>; if (m[r.method]) handlers.set(`${r.method} ${r.path}`, m[r.method]) } catch { /* recorded below as unloadable */ }
}
// what the process logged while a call ran: a route that failed on the SQLite trap says so there
let logged = ''
for (const k of ['error', 'warn'] as const) console[k] = (...a: unknown[]) => { logged += a.map(x => x instanceof Error ? `${x.message}` : String(x)).join(' ') + '\n' }
process.stderr.write = ((c: string | Uint8Array) => { logged += String(c); return true }) as typeof process.stderr.write
const SQLITE = /nonexistent-dazl-dir|SQLITE|open database|directory does not exist/i
// one call: the route's text, or the error it threw (with what it logged); at most 10 s
const call = async (jar: Jar, r: { path: string; method: string }, id: string | null, action?: string) => {
  logged = ''
  const out = await call1(jar, r, id, action)
  return { ...out, log: logged }
}
const call1 = async (jar: Jar, r: { path: string; method: string }, id: string | null, action?: string) => {
  await db.run('DELETE FROM rate_limits')
  const h = handlers.get(`${r.method} ${r.path}`)
  if (!h) return { status: -1, text: 'unloadable' }
  const params = Object.fromEntries([...r.path.matchAll(/\[(\w+)\]/g)].map(m => [m[1], id ?? 'none']))
  const url = `/api/${r.path.replace(/\[(\w+)\]/g, () => id ?? 'none')}${id ? query(id) : ''}`
  try {
    const res = await Promise.race([withJar(jar, () => h(req(url, r.method, id ? withIds(id, action) : action ? { action } : {}), { params: Promise.resolve(params) })), sleep(10_000).then(() => { throw new Error('timeout') })])
    return { status: res.status, text: await res.text() }
  } catch (e) { return { status: 0, text: e instanceof Error ? e.message : String(e) } }
}

// ---- seed ----
await barrier('start')
const jar: Jar = new Map()
const signup = await import('../../app/api/auth/signup/route.ts')
const up = await withJar(jar, () => signup.POST(req('/api/auth/signup', 'POST', { email: `${tag}@example.test`, password: `pw-${tag}-${process.env.PT_PW}`, name: tag, business_name: `Biz ${tag}` })))
if (up.status !== 200 || !jar.has('dazl_session')) throw new Error(`signup ${up.status} ${await up.text()}`)
const me = (await db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [`${tag}@example.test`]))!.id
const seeded = await seedTenant(db, me, tag)
const other = await barrier('seeded', { tenant: me, ids: seeded.ids, texts: seeded.texts }) as { tenant: string; ids: Record<string, string[]>; texts: string[] }
const ownIds = [...new Set(Object.values(seeded.ids).flat())], otherIds = [...new Set([...Object.values(other.ids).flat(), ...other.texts])]

// ---- own: which tables each route returns to their owner ----
const reads: Record<string, string[]> = {}   // route -> tables whose own marker came back
const status: Record<string, string> = {}   // route -> 'ok' | 'sqlite' | 'error <status>'
for (const r of routes.filter(x => x.method === 'GET')) {
  const key = `${r.method} ${r.path}`
  const seen = new Set<string>()
  let ran = false, sqlite = false
  for (const id of [null, ...ownIds]) {
    const res = await call(jar, r, id)
    if (SQLITE.test(res.text + res.log)) sqlite = true
    if (res.status > 0 && res.status < 500) ran = true
    for (const m of res.text.matchAll(new RegExp(`${tag}~(\\w+)`, 'g'))) seen.add(m[1])
  }
  reads[key] = [...seen].sort()
  status[key] = ran ? 'ok' : sqlite ? 'sqlite' : 'error'
}
await barrier('owned')

// ---- sweep: one instance at a time ----
const violations: string[] = []
const calls = { total: 0, refusedOrEmpty: 0 }
const sweep = async () => {
  for (const r of routes) {
    const key = `${r.method} ${r.path}`
    for (const action of r.method === 'GET' ? [undefined] : [undefined, ...actions(r.path)]) for (const id of [null, ...otherIds]) {
      const res = await call(jar, r, id, action)
      calls.total++
      if (leak(res.text, id)) violations.push(`${key}${action ? ` ${action}` : ''} ${id ?? '(no id)'} -> ${res.status}: ${res.text.slice(0, 300)}`)
      else calls.refusedOrEmpty++
      if (r.method !== 'GET' && status[key] !== 'ok') status[key] = res.status > 0 && res.status < 500 ? 'ok' : SQLITE.test(res.text + res.log) || status[key] === 'sqlite' ? 'sqlite' : 'error'
    }
  }
}
// Anything of the other tenant's in a response that the caller did not send itself: a token carrying the other tenant's
// tag, or its tenant id. A route echoing the value it was given (a domain parsed from the URL it was sent) leaks nothing.
const leak = (text: string, sent: string | null) => {
  const plain = text.replace(/\\u007e|%7E/gi, '~')
  if (plain.includes(other.tenant) && !(sent ?? '').includes(other.tenant)) return true
  return [...plain.matchAll(new RegExp(`[A-Za-z0-9_.~-]*${otherTag}[A-Za-z0-9_.~-]*`, 'g'))].some(m => !(sent ?? '').includes(m[0]))
}
const watch = async () => snapshot(db, me)
let changed: string[] = []
// the watching instance snapshots its rows before the other starts, and compares once it is done
const phase = async (sweeping: boolean, n: number) => {
  if (sweeping) { await barrier(`ready-${n}`); await sweep(); await barrier(`swept-${n}`); return }
  const before = await watch(); await barrier(`ready-${n}`); await barrier(`swept-${n}`); const after = await watch()
  changed = Object.keys(before).filter(t => before[t] !== after[t])
}
await phase(first, 1)
await phase(!first, 2)

console.log(JSON.stringify({ tag, tenant: me, seeded: Object.keys(seeded.ids).sort(), failed: seeded.failed, reads, status, violations, changed, calls }))
await db.close()
