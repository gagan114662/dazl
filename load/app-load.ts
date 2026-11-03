// Multi-tenant HTTP load against a LOCAL production build of the app: N synthetic tenants, each virtual user signed in
// as one of them, doing what an open Home page does (the /app page, then its API reads). Every response is checked: the
// right status, the tenant's own marker where the route returns tenant data, and NO other tenant's marker anywhere.
// Local only: the servers run under web/test/helpers/net-fence.ts (no outbound network), on a throwaway SQLite file
// seeded here; nothing paid, nothing external, no real data.
//
//   cd web && npm run build && cd .. && node --experimental-strip-types load/app-load.ts
//
// Knobs (env): LOAD_TENANTS=200 LOAD_VUS=100 LOAD_DURATION_S=60 LOAD_WARMUP_S=5 LOAD_THINK_MS=0
//   LOAD_PROCESSES=1   number of `next start` processes; >1 puts them behind a local round-robin proxy (the
//                      multi-instance candidate: they share the one SQLite file, so this measures the CPU ceiling of a
//                      single Node process, not a supported production topology)
//   LOAD_JSON=path     also write the report there
//   LOAD_SERVER_NODE_OPTIONS  extra node flags for the servers (e.g. --cpu-prof --cpu-prof-dir=/tmp/prof)
// Thresholds (the isolated-host test's): unexpected < 1%, correctness > 99.9%, zero tenant leaks, API p95 < 1 s and
// p99 < 3 s, page p95 < 2 s. Exit 0 = all hold, 1 = a threshold failed (named in the report), 2 = could not run.
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const num = (n: string, d: number) => { const v = Number(process.env[n]); return Number.isFinite(v) && v >= 0 && process.env[n] !== '' && process.env[n] !== undefined ? v : d }
const TENANTS = num('LOAD_TENANTS', 200), VUS = num('LOAD_VUS', 100), DURATION_S = num('LOAD_DURATION_S', 60)
const WARMUP_S = num('LOAD_WARMUP_S', 5), THINK_MS = num('LOAD_THINK_MS', 0), PROCESSES = Math.max(1, num('LOAD_PROCESSES', 1))
export const THRESHOLDS = { unexpectedRate: 0.01, correctness: 0.999, leaks: 0, apiP95: 1000, apiP99: 3000, pageP95: 2000 }

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const require = createRequire(path.join(web, 'package.json'))
if (!existsSync(path.join(web, '.next/BUILD_ID'))) { console.error('no production build: cd web && npm run build'); process.exit(2) }

// ---- seed ----
const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-app-load-'))
const DB_PATH = path.join(tmp, 'app.db')
const marker = (t: number) => `LTMARK${String(t).padStart(5, '0')}Q`
interface Tenant { id: string; cookie: string; job: string; mark: string }
async function seed(): Promise<Tenant[]> {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3').default
  const { migrateAllSqlite } = await import('../web/lib/db/sqlite-migrations.ts')
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  migrateAllSqlite(db)
  const out: Tenant[] = []
  const tx = db.transaction(() => {
    for (let t = 0; t < TENANTS; t++) {
      const id = randomBytes(16).toString('hex'), mark = marker(t), token = randomBytes(32).toString('hex'), job = randomBytes(12).toString('hex')
      db.prepare("INSERT INTO users (id, email, password_hash, salt, business_name, created_at) VALUES (?, ?, 'x', 'x', ?, ?)").run(id, `t${t}@load.example`, `Biz ${mark}`, 1_700_000_000)
      db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), id, Math.floor(Date.now() / 1000) + 86400)
      db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, attempts) VALUES (?, ?, ?, 'dental', 'Toronto', ?, 'running', 1)").run(job, id, `Biz ${mark}`, `find ${mark} buyers`)
      for (let l = 0; l < 3; l++) {
        db.prepare("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, evidence_excerpt, confidence) VALUES (?, ?, 'Pat', ?, 'Hiring', 'https://lead.example/a', 70, ?, 80)")
          .run(randomBytes(12).toString('hex'), job, `${mark} Co ${l}`, `${mark} Co ${l} is hiring`)
      }
      db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), job)
      out.push({ id, cookie: `dazl_session=${token}`, job, mark })
    }
  })
  tx()
  db.close()
  return out
}

// ---- servers ----
const procs: ChildProcess[] = []
async function startServers(): Promise<string> {
  const base = 3400 + Math.floor(Math.random() * 400)
  const ports = Array.from({ length: PROCESSES }, (_, i) => base + 1 + i)
  for (const port of ports) {
    procs.push(spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: web, stdio: 'ignore',
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DB_PATH, DAZL_MASTER_KEY: randomBytes(32).toString('base64'), PUBLIC_BASE_URL: 'http://127.0.0.1', SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', NODE_OPTIONS: `--experimental-strip-types --import ${path.join(web, 'test/helpers/net-fence.ts')}${process.env.LOAD_SERVER_NODE_OPTIONS ? ' ' + process.env.LOAD_SERVER_NODE_OPTIONS : ''}` },
    }))
  }
  for (const port of ports) {
    for (let i = 0; ; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health/live`); break } catch { if (i > 300) throw new Error(`server on ${port} did not start`); await new Promise(r => setTimeout(r, 200)) } }
  }
  if (PROCESSES === 1) return `http://127.0.0.1:${ports[0]}`
  // Round-robin proxy in front of the processes (a stand-in for Caddy / a load balancer).
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 })
  let next = 0
  const proxy = http.createServer((req, res) => {
    const port = ports[next++ % ports.length]
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers, agent }, r => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res) })
    up.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(up)
  })
  await new Promise<void>(r => proxy.listen(base, '127.0.0.1', r))
  return `http://127.0.0.1:${base}`
}

// ---- scenario ----
// One Home page view: the page, then the reads its client components make (app/app/*.tsx).
const STEPS: { name: string; kind: 'page' | 'api'; path: (t: Tenant) => string; own: boolean }[] = [
  { name: 'GET /app', kind: 'page', path: () => '/app', own: false },
  { name: 'GET /api/settings/profile', kind: 'api', path: () => '/api/settings/profile', own: true },
  { name: 'GET /api/scan/jobs', kind: 'api', path: () => '/api/scan/jobs', own: true },
  { name: 'GET /api/usage', kind: 'api', path: () => '/api/usage', own: false },
  { name: 'GET /api/leads', kind: 'api', path: t => `/api/leads?job_id=${t.job}`, own: true },
  { name: 'GET /api/scan/status', kind: 'api', path: t => `/api/scan/status?job_id=${t.job}&passive=1`, own: true },
]
interface Rec { lat: number[]; ttfb: number[]; n: number; unexpected: number; incorrect: number; leaks: number; statuses: Record<string, number> }
const per = new Map<string, Rec>(STEPS.map(s => [s.name, { lat: [], ttfb: [], n: 0, unexpected: 0, incorrect: 0, leaks: 0, statuses: {} }]))
const LEAK = /LTMARK\d{5}Q/g
let measuring = false, stop = false

async function vu(i: number, base: string, tenants: Tenant[]) {
  while (!stop) {
    const t = tenants[(i + Math.floor(Math.random() * tenants.length)) % tenants.length]
    for (const s of STEPS) {
      if (stop) return
      const t0 = performance.now()
      let status = 0, body = '', ttfb = 0
      try {
        const res = await fetch(base + s.path(t), { headers: { cookie: t.cookie }, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
        ttfb = performance.now() - t0
        body = await res.text(); status = res.status
      } catch { status = 0 }
      const ms = performance.now() - t0
      if (!measuring) continue
      const r = per.get(s.name)!
      r.n++; r.lat.push(ms); r.statuses[status || 'timeout/error'] = (r.statuses[status || 'timeout/error'] ?? 0) + 1
      if (status) r.ttfb.push(ttfb)
      if (status !== 200) { r.unexpected++; continue }
      const others = (body.match(LEAK) ?? []).filter(m => m !== t.mark)
      if (others.length) r.leaks++
      if (s.own && !body.includes(t.mark)) r.incorrect++
    }
    if (THINK_MS) await new Promise(r => setTimeout(r, THINK_MS))
  }
}

const pct = (s: number[], p: number) => s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0
async function main() {
  const tenants = await seed()
  const base = await startServers()
  const vus = Array.from({ length: VUS }, (_, i) => vu(i, base, tenants))
  await new Promise(r => setTimeout(r, WARMUP_S * 1000))
  measuring = true
  const t0 = Date.now()
  await new Promise(r => setTimeout(r, DURATION_S * 1000))
  measuring = false; stop = true
  const secs = (Date.now() - t0) / 1000
  await Promise.all(vus)
  const routes: Record<string, unknown> = {}
  const all = { n: 0, unexpected: 0, incorrect: 0, leaks: 0 }, api: number[] = [], page: number[] = []
  for (const s of STEPS) {
    const r = per.get(s.name)!, sorted = [...r.lat].sort((a, b) => a - b)
    ;(s.kind === 'api' ? api : page).push(...r.lat)
    all.n += r.n; all.unexpected += r.unexpected; all.incorrect += r.incorrect; all.leaks += r.leaks
    const tt = [...r.ttfb].sort((a, b) => a - b)
    routes[s.name] = { statuses: r.statuses, ttfb_p95: Math.round(pct(tt, 95)), requests: r.n, rps: +(r.n / secs).toFixed(1), p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)), max: Math.round(sorted.at(-1) ?? 0), unexpected: r.unexpected, incorrect: r.incorrect, leaks: r.leaks }
  }
  api.sort((a, b) => a - b); page.sort((a, b) => a - b)
  const checked = all.n - all.unexpected
  const summary = {
    requests: all.n, rps: +(all.n / secs).toFixed(1),
    unexpected_rate: all.n ? all.unexpected / all.n : 1, correctness: checked ? (checked - all.incorrect) / checked : 0, leaks: all.leaks,
    api_p95: Math.round(pct(api, 95)), api_p99: Math.round(pct(api, 99)), page_p95: Math.round(pct(page, 95)), page_max: Math.round(page.at(-1) ?? 0),
  }
  const failed = [
    summary.unexpected_rate >= THRESHOLDS.unexpectedRate && 'unexpected >= 1%',
    summary.correctness <= THRESHOLDS.correctness && 'correctness <= 99.9%',
    summary.leaks > THRESHOLDS.leaks && 'tenant leak',
    summary.api_p95 >= THRESHOLDS.apiP95 && 'API p95 >= 1s',
    summary.api_p99 >= THRESHOLDS.apiP99 && 'API p99 >= 3s',
    summary.page_p95 >= THRESHOLDS.pageP95 && 'page p95 >= 2s',
  ].filter(Boolean)
  const report = { config: { tenants: TENANTS, vus: VUS, duration_s: DURATION_S, processes: PROCESSES, think_ms: THINK_MS }, summary, thresholds: THRESHOLDS, pass: failed.length === 0, failed, routes,
    caveat: 'Local production build on a throwaway SQLite file, every outbound call fenced. Measures this machine and this topology only; not a capacity claim for production.' }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.LOAD_JSON) writeFileSync(process.env.LOAD_JSON, JSON.stringify(report, null, 2))
  return failed.length ? 1 : 0
}

let code = 2
try { code = await main() } catch (e) { console.error(e) } finally {
  for (const p of procs) p.kill('SIGINT')
  await new Promise(r => setTimeout(r, 3000))
  rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
