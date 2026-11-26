import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const TENANTS = 20
const USERS_PER_TENANT = 5
const hex = (bytes: number) => randomBytes(bytes).toString('hex')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function postgresTarget(value: string): URL {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^\/dazl_load_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('LOAD_PG_URL must target a dedicated loopback dazl_load_* Postgres database with no query options')
  }
  return url
}

type Probe = { own?: string; foreign: readonly string[] }
export function checkIsolation(status: number, body: string, probe: Probe, foreignRead = false) {
  let leak = probe.foreign.some(value => body.includes(value))
  if (foreignRead) {
    // The foreign-ID routes must return only the normal denial envelope. Also
    // classify a returned row as a leak when it carries no seeded canary.
    let object: Record<string, unknown> | null = null
    try { object = JSON.parse(body) } catch { /* an unreadable body cannot pass */ }
    leak ||= !!object && (Object.hasOwn(object, 'job_id') || (Array.isArray(object.leads) && object.leads.length > 0))
    return { leak, correct: !leak && status === 404 && object?.error === 'Not found' && Object.keys(object).length === 1 }
  }
  return { leak, correct: !leak && status === 200 && (!probe.own || body.includes(probe.own)) }
}

interface Tenant { id: string; job: string; lead: string; mark: string; users: User[] }
interface User { email: string; password: string; ip: string; cookie?: string }
type Sample = { ms: number; kind: 'api' | 'page' | 'completion'; ok: boolean }

async function listenPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a loopback port')
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  return address.port
}

function percentile(values: number[], percent: number): number {
  values.sort((a, b) => a - b)
  return values.length ? Math.round(values[Math.ceil(values.length * percent) - 1]) : 0
}

export async function runPostgresLoad(web: string): Promise<number> {
  const require = createRequire(path.join(web, 'package.json'))
  const target = postgresTarget(process.env.LOAD_PG_URL ?? '')
  const expectedSha = process.env.LOAD_STAGING_SHA ?? ''
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('LOAD_STAGING_SHA must be the full SHA of the staging build')
  const { RAW_SQLITE_MODULES } = await import('../web/lib/db/pg-port-status.ts')
  if (Object.keys(RAW_SQLITE_MODULES).length) throw new Error(`Postgres split-store gate closed: ${Object.keys(RAW_SQLITE_MODULES).length} raw SQLite modules`)
  const { pgDb } = await import('../web/lib/db/client.ts')
  const { runPgMigrations } = await import('../web/lib/db/migrate-pg.ts')
  const { writeKey } = await import('../web/lib/llm/key-store.ts')
  const admin = pgDb({ connectionString: target.href })
  const schema = `load_${hex(8)}`
  const dbUrl = new URL(target)
  dbUrl.searchParams.set('options', `-c search_path=${schema}`)
  const db = pgDb({ connectionString: dbUrl.href })
  const tmp = mkdtempSync(path.join(tmpdir(), 'dazl-pg-load-'))
  const key = randomBytes(32)
  const trace = path.join(tmp, 'provider-calls')
  writeFileSync(trace, '')
  let server: ChildProcess | undefined
  let created = false
  try {
    await admin.run(`CREATE SCHEMA ${schema}`)
    created = true
    await runPgMigrations(db.pool)
    const now = Math.floor(Date.now() / 1000)
    const tenants: Tenant[] = []
    for (let t = 0; t < TENANTS; t++) {
      const tenant: Tenant = { id: hex(16), job: hex(12), lead: hex(12), mark: `LTMARK${hex(8)}Q`, users: [] }
      for (let u = 0; u < USERS_PER_TENANT; u++) {
        const id = u === 0 ? tenant.id : hex(16)
        const email = `${id}@load.invalid`, password = hex(24), salt = hex(16)
        await db.run('INSERT INTO users (id, email, password_hash, salt, business_name, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, email, scryptSync(password, salt, 64).toString('hex'), salt, tenant.mark, now, now])
        if (u === 0) {
          await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, ?, 'team', ?, ?)",
            [tenant.id, tenant.mark, id, now])
        }
        await db.run('INSERT INTO memberships (tenant_id, member_id, role, created_at) VALUES (?, ?, ?, ?)',
          [tenant.id, id, u === 0 ? 'owner' : 'operator', now])
        tenant.users.push({ email, password, ip: `192.0.2.${t * USERS_PER_TENANT + u + 1}` })
      }
      await db.run("INSERT INTO tenant_plans (tenant_id, plan) VALUES (?, 'pro')", [tenant.id])
      await writeKey(db, tenant.id, 'anthropic', 'load-synthetic-provider-key', key)
      await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, attempts) VALUES (?, ?, ?, 'services', '-', ?, 'running', 1)",
        [tenant.job, tenant.id, tenant.mark, tenant.mark])
      await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, score, confidence) VALUES (?, ?, '', ?, 'Expansion', 'https://load.invalid/proof', 80, 80)",
        [tenant.lead, tenant.job, tenant.mark])
      await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [now, tenant.job])
      tenants.push(tenant)
    }
    const port = await listenPort()
    const base = `http://127.0.0.1:${port}`
    const preload = path.join(web, '..', 'load', 'app-load-postgres-preload.ts')
    server = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--import', preload,
      require.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: web, stdio: 'ignore',
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DAZL_ENV: 'staging', LOAD_PG_SCENARIO_URL: dbUrl.href,
        LOAD_PG_SCENARIO_MASTER: key.toString('base64'), LOAD_PG_SCENARIO_TRACE: trace, DB_PATH: path.join(tmp, 'no-fallback', 'app.db'), PUBLIC_BASE_URL: base },
    })
    let ready: Response | undefined
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null) throw new Error('Local build did not start')
      try { ready = await fetch(base + '/api/ready', { signal: AbortSignal.timeout(2000) }); break } catch { await sleep(250) }
    }
    if (!ready) throw new Error('Local build did not answer readiness')
    const health = await ready.json()
    if (!ready.ok || health.commit !== expectedSha || health.store?.engine !== 'pg' || health.store.raw_sqlite_modules !== 0 ||
        health.checks?.split?.ok !== true || health.store.migrations?.applied !== health.store.migrations?.shipped) {
      throw new Error('Candidate must match the staging SHA and report ready Postgres with migrations current and zero split-store dependencies')
    }

    const scenarioStart = performance.now()
    const byRoute = new Map<string, Sample[]>()
    const record = (name: string, sample: Sample) => {
      const samples = byRoute.get(name) ?? []
      samples.push(sample); byRoute.set(name, samples)
    }
    async function request(user: User, route: string, body?: object) {
      const start = performance.now()
      try {
        const response = await fetch(base + route, { method: body ? 'POST' : 'GET', redirect: 'manual',
          headers: { 'x-forwarded-for': user.ip, ...(user.cookie ? { cookie: user.cookie } : {}),
            ...(body ? { origin: base, 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
        const text = await response.text()
        return { status: response.status, text, cookie: response.headers.get('set-cookie'), ms: performance.now() - start }
      } catch { return { status: 0, text: '', cookie: null, ms: performance.now() - start } }
    }
    const foreignTokens = (tenant: Tenant) => tenants.filter(other => other !== tenant).flatMap(other => [other.id, other.job, other.lead, other.mark])
    let foreignAttempts = 0, foreignFailures = 0, leaks = 0, incorrect = 0, signedIn = 0, submitted = 0, completed = 0
    const vUsers = tenants.flatMap((tenant, index) => tenant.users.map(user => ({ user, tenant, other: tenants[(index + 1) % tenants.length] })))
    await Promise.all(vUsers.map(async ({ user, tenant, other }) => {
      const sign = await request(user, '/api/auth/signin', { email: user.email, password: user.password })
      const cookie = /(?:^|[, ]+)dazl_session=[^;]+/.exec(sign.cookie ?? '')?.[0].trim()
      const foreign = foreignTokens(tenant)
      const signOk = sign.status === 200 && !!cookie
      record('sign-in', { ms: sign.ms, kind: 'api', ok: signOk })
      if (foreign.some(token => sign.text.includes(token))) leaks++
      if (!signOk) return
      signedIn++
      user.cookie = cookie
      await Promise.all([
        ['/app', 'home', 'page', false, ''],
        ['/app/leads', 'leads-page', 'page', false, ''],
        ['/api/scan/jobs', 'home-jobs', 'api', false, tenant.job],
        [`/api/leads?job_id=${tenant.job}`, 'own-leads', 'api', false, tenant.mark],
        [`/api/scan/status?job_id=${tenant.job}&readonly=1`, 'own-scan', 'api', false, tenant.job],
        [`/api/leads?job_id=${other.job}`, 'foreign-leads', 'api', true, ''],
        [`/api/scan/status?job_id=${other.job}&readonly=1`, 'foreign-scan', 'api', true, ''],
      ].map(async ([route, name, kind, isForeign, own]) => {
        const res = await request(user, String(route))
        const check = checkIsolation(res.status, res.text, { own: String(own), foreign }, Boolean(isForeign))
        if (isForeign) {
          foreignAttempts++
          if (!check.correct) foreignFailures++
        }
        if (check.leak) leaks++
        if (!check.correct && (res.status === 200 || res.status === 404)) incorrect++
        record(String(name), { ms: res.ms, kind: kind === 'page' ? 'page' : 'api', ok: check.correct })
      }))
    }))

    // The product admits one active search per workspace. Workspace lanes run
    // concurrently; users in a lane take turns until their own fresh job finishes.
    await Promise.all(tenants.map(async tenant => {
      for (const user of tenant.users) {
        if (!user.cookie) continue
        const query = 'Companies announcing a new site'
        const res = await request(user, '/api/scan', { query, offer: 'Commercial operations consulting', icp: { summary: query } })
        let job = ''
        try { job = JSON.parse(res.text)?.job_id ?? '' } catch { /* an unreadable response cannot pass */ }
        if (foreignTokens(tenant).some(token => res.text.includes(token))) leaks++
        const ok = res.status === 202 && /^[a-f0-9]{24}$/.test(job) && job !== tenant.job
        record('search-submit', { ms: res.ms, kind: 'api', ok })
        if (!ok) continue
        submitted++
        const started = performance.now()
        let done = false
        while (performance.now() - started < 120_000) {
          const poll = await request(user, `/api/scan/status?job_id=${job}`)
          const foreign = foreignTokens(tenant)
          if (foreign.some(token => poll.text.includes(token))) leaks++
          record('search-status', { ms: poll.ms, kind: 'api', ok: poll.status === 200 })
          let status = ''
          try { status = JSON.parse(poll.text)?.status ?? '' } catch { /* report the failed sample */ }
          if (status === 'done') { completed++; done = true; break }
          if (poll.status !== 200 || status === 'failed' || status === 'cancelled') break
          await sleep(350)
        }
        record('search-completion', { ms: performance.now() - started, kind: 'completion', ok: done })
      }
    }))
    const samples = [...byRoute.values()].flat()
    const requests = samples.filter(s => s.kind !== 'completion')
    const errors = requests.filter(s => !s.ok).length
    const errorRate = requests.length ? errors / requests.length : 1
    const correctness = requests.length ? 1 - incorrect / requests.length : 0
    const api = requests.filter(s => s.kind === 'api').map(s => s.ms)
    const pages = requests.filter(s => s.kind === 'page').map(s => s.ms)
    const apiP95 = percentile(api, .95), apiP99 = percentile(api, .99), pageP95 = percentile(pages, .95)
    const mockSearchCalls = readFileSync(trace, 'utf8').split('\n').filter(line => line === 'search').length
    const pass = mockSearchCalls >= completed && signedIn === vUsers.length && submitted === vUsers.length && completed === vUsers.length &&
      foreignAttempts === vUsers.length * 2 && foreignFailures === 0 && leaks === 0 && errorRate < .01 && correctness > .999 &&
      apiP95 < 1000 && apiP99 < 3000 && pageP95 < 2000
    const routes = Object.fromEntries([...byRoute].map(([name, items]) => [name, {
      samples: items.length, errors: items.filter(s => !s.ok).length,
      p95_ms: percentile(items.map(s => s.ms), .95), p99_ms: percentile(items.map(s => s.ms), .99),
    }]))
    const report = { pass, sha: expectedSha, backend: health.store.engine, tenants: tenants.length, users: vUsers.length,
      signedIn, submitted, completed, mockSearchCalls, foreignAttempts, foreignFailures, leaks, errorRate, correctness, apiP95, apiP99, pageP95, routes,
      duration_ms: Math.round(performance.now() - scenarioStart),
      provider: 'local deterministic network stub', concurrentSearchPolicy: 'one active search per tenant' }
    console.log(JSON.stringify(report, null, 2))
    if (process.env.LOAD_JSON) writeFileSync(process.env.LOAD_JSON, JSON.stringify(report, null, 2))
    return pass ? 0 : 1
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit')
      server.kill('SIGTERM')
      await Promise.race([exited, sleep(3000)])
      if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
    }
    await db.close()
    try { if (created) await admin.run(`DROP SCHEMA ${schema} CASCADE`) } finally { await admin.close(); rmSync(tmp, { recursive: true, force: true }) }
  }
}
