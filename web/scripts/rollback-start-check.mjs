// Rollback proof with the previous release's real production build (issue #362; release-gate.yml, migrations job).
// scripts/migration-gate.mts --keep DIR leaves DIR/app.db (seeded by the previous release, migrated by the new one, then
// by the previous one again) and DIR/gate.env (its synthetic master key and demo password). This starts the previous
// release's `next start` on that database and requires, over HTTP:
//   - /api/health/live serves the expected commit (when given) and /api/ready answers 200 ok;
//   - the seeded demo account signs in through /api/auth/signin with its password;
//   - its scans list (/api/scan/jobs) and each scan's leads (/api/leads) come back with the seeded data;
//   - /app/leads renders for that session (server-side rendering on the migrated store).
// The server runs under this checkout's test network fence (nothing leaves the machine) with generated test-mode values.
//   node scripts/rollback-start-check.mjs <previous release web dir, built> <DIR> [<expected commit>]
// Exit 0 = the previous release is usable on the new database; 1 = a check failed (named); 2 = not run (no build).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [prevArg, dirArg, commit] = process.argv.slice(2)
if (!prevArg || !dirArg) { console.error('usage: rollback-start-check.mjs <previous release web dir> <gate --keep dir> [<expected commit>]'); process.exit(2) }
const prev = path.resolve(prevArg), dir = path.resolve(dirArg)
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(path.join(prev, '.next/BUILD_ID'))) { console.log(`NOT RUN: ${prev} has no production build`); process.exit(2) }
const gate = Object.fromEntries(readFileSync(path.join(dir, 'gate.env'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const EMAIL = process.env.GATE_DEMO_EMAIL ?? 'demo@staging.dazl.test'

const port = await new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', DB_PATH: gate.DB_PATH, DAZL_ENV: 'staging', PUBLIC_BASE_URL: base,
  SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0', STRIPE_PRICE_PRO: 'price_gate',
  // the fence deletes *KEY*/*SECRET* variables; test/smoke/stripe-test-env.mjs puts these neutral names back
  SMOKE_MASTER_B64: gate.DAZL_MASTER_KEY, SMOKE_STRIPE_SK: 'sk_test_gate' + randomBytes(6).toString('hex'), SMOKE_STRIPE_WHSEC: 'whsec_' + randomBytes(12).toString('hex'),
  NODE_OPTIONS: `--experimental-strip-types --import ${path.join(here, 'test/helpers/net-fence.ts')} --import ${path.join(here, 'test/smoke/stripe-test-env.mjs')}`,
}
const server = spawn(process.execPath, [path.join(prev, 'node_modules/next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: prev, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; server.stdout.on('data', d => { log += d }); server.stderr.on('data', d => { log += d })
const failures = []
const ok = m => console.log(`ok   ${m}`)
const get = (p, cookie) => fetch(base + p, { redirect: 'manual', headers: cookie ? { cookie } : {} }).then(async r => ({ status: r.status, body: await r.text() }))
try {
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/api/health/live`); break } catch { if (i > 150 || server.exitCode !== null) throw new Error(`the previous release did not start\n${log.slice(-2000)}`) }
    await new Promise(r => setTimeout(r, 200))
  }
  const live = JSON.parse((await get('/api/health/live')).body)
  if (commit && live.commit !== commit) failures.push(`serves commit ${live.commit}, expected ${commit}`); else ok(`previous release started (commit ${live.commit})`)
  const ready = await get('/api/ready')
  if (ready.status !== 200 || JSON.parse(ready.body).ok !== true) failures.push(`/api/ready HTTP ${ready.status}: ${ready.body.slice(0, 300)}`); else ok('/api/ready ok on the migrated database')

  const signin = await fetch(base + '/api/auth/signin', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: EMAIL, password: gate.STAGING_DEMO_PASSWORD }) })
  const token = /dazl_session=([^;]+)/.exec(signin.headers.get('set-cookie') ?? '')?.[1]
  if (signin.status !== 200 || !token) throw new Error(`the demo account does not sign in (HTTP ${signin.status})`)
  const cookie = `dazl_session=${token}`
  ok('the demo account signs in with its password')

  const jobs = await get('/api/scan/jobs', cookie)
  const ids = [...new Set(jobs.body.match(/\b[0-9a-f]{24}\b/g) ?? [])]
  if (jobs.status !== 200 || (!jobs.body.includes('(demo)') && !jobs.body.includes('Dental practices')) || ids.length === 0) failures.push(`/api/scan/jobs HTTP ${jobs.status} without the seeded scans`)
  let leads = ''
  for (const id of ids) leads += (await get(`/api/leads?job_id=${id}`, cookie)).body
  const companies = (leads.match(/[A-Z][A-Za-z ]+ \(demo\)/g) ?? []).length
  if (!companies) failures.push('no seeded lead comes back from /api/leads'); else ok(`${ids.length} seeded scan(s) and their leads read back (${companies} demo company mentions)`)
  const page = await get('/app/leads', cookie)
  if (page.status !== 200) failures.push(`/app/leads HTTP ${page.status}`); else ok('/app/leads renders for the session')
} catch (e) {
  failures.push(e.message)
} finally {
  server.kill('SIGTERM')
}
if (failures.length) { for (const f of failures) console.log(`FAIL ${f}`); process.exit(1) }
console.log('rollback-start-check: the previous release starts, signs in and reads its data on the migrated database')
