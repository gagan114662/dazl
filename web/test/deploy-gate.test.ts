// ops/deploy-gate.mjs (issue #362): a commit is deployable only with every required check green, from GitHub Actions,
// on that exact commit, and the commit on main. Everything runs against a local stub of the GitHub API: no network,
// no token, nothing deployed. The staging deploy (ops/staging/deploy.sh) is run for real against a local repo with
// that stub, to show a blocked or pending commit is never built and never goes live.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide, REQUIRED } from '../../ops/deploy-gate.mjs'

const gate = fileURLToPath(new URL('../../ops/deploy-gate.mjs', import.meta.url))
const deploySh = fileURLToPath(new URL('../../ops/staging/deploy.sh', import.meta.url))
const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)
type Run = { id: number; name: string; head_sha: string; status: string; conclusion: string | null; started_at: string; app: { slug: string } }
let nextId = 1
const run = (name: string, conclusion: string | null = 'success', over: Partial<Run> = {}): Run => ({ id: nextId++, name, head_sha: SHA, status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: '2026-10-30T03:00:00Z', app: { slug: 'github-actions' }, ...over })
const green = () => REQUIRED.map((n: string) => run(n))
const onMain = { ok: true, status: 'identical', branch: 'main' }
const d = (runs: Run[], over: Record<string, unknown> = {}) => decide({ sha: SHA, onBranch: onMain, runs, ...over })

test('decide: every required check green on the exact commit, from GitHub Actions, on main -> allowed; anything else is not', () => {
  assert.equal(d(green()).decision, 'allowed')
  assert.deepEqual(d(green()).reasons, [])
  // one still running, or not started yet (CI queued) -> pending, never allowed
  assert.equal(d([...green().slice(1), run('test-sqlite', null)]).decision, 'pending')
  assert.equal(d(green().slice(1)).decision, 'pending')
  assert.equal((d(green().slice(1)).checks as Record<string, string>)['test-sqlite'], 'missing')
  // a run that never came (an hour after the commit) blocks
  const late = d(green().slice(1), { commitAgeS: 4000, missingAfterS: 3600 })
  assert.equal(late.decision, 'blocked'); assert.match(late.reasons.join(), /test-sqlite: never_ran/)
  // every non-success conclusion blocks, even with the rest green
  for (const c of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale']) {
    const r = d([...green().filter((x: Run) => x.name !== 'migrations'), run('migrations', c)])
    assert.equal(r.decision, 'blocked', c); assert.match(r.reasons.join(), new RegExp(`migrations: ${c}`))
  }
  // a failure blocks even while another check is still pending
  assert.equal(d([run('test-sqlite', 'failure'), run('test-postgres', null), run('browser'), run('migrations')]).decision, 'blocked')
})

test('decide: same-name checks from another app or for another commit do not count; the newest re-run decides; off-main blocks', () => {
  const noBrowser = green().filter((x: Run) => x.name !== 'browser')
  const spoof = d([...noBrowser, run('browser', 'success', { app: { slug: 'some-other-app' } })])
  assert.equal(spoof.decision, 'pending', 'a foreign "browser" check is ignored'); assert.deepEqual(spoof.ignored_foreign_checks, ['browser from some-other-app'])
  assert.equal(d([...noBrowser, run('browser', 'success', { head_sha: OTHER })]).decision, 'pending', 'a green run for another commit is ignored')
  // re-runs: newest wins either way
  assert.equal(d([...noBrowser, run('browser', 'failure', { started_at: '2026-10-30T03:00:00Z' }), run('browser', 'success', { started_at: '2026-10-30T03:30:00Z' })]).decision, 'allowed')
  assert.equal(d([...noBrowser, run('browser', 'success', { started_at: '2026-10-30T03:00:00Z' }), run('browser', 'failure', { started_at: '2026-10-30T03:30:00Z' })]).decision, 'blocked')
  // all green but not on main (a PR head, or a branch that diverged)
  for (const status of ['ahead', 'diverged']) {
    const r = d(green(), { onBranch: { ok: false, status, branch: 'main' } })
    assert.equal(r.decision, 'blocked'); assert.match(r.reasons[0], new RegExp(`not on main \\(${status}\\)`))
  }
})

// A stub of the three GitHub API calls the gate makes. state.runs / state.compare / state.fail set its answers.
async function stubApi() {
  const state = { runs: [] as Run[], compare: 'identical', date: new Date().toISOString(), fail: 0, auth: [] as (string | undefined)[], paths: [] as string[] }
  const server = http.createServer((q, s) => {
    state.auth.push(q.headers.authorization); state.paths.push(q.url!)
    s.setHeader('content-type', 'application/json')
    if (state.fail) { s.statusCode = state.fail; return s.end('{}') }
    const u = new URL(q.url!, 'http://x')
    if (/\/compare\//.test(u.pathname)) return s.end(JSON.stringify({ status: state.compare }))
    if (/\/check-runs$/.test(u.pathname)) { const p = Number(u.searchParams.get('page')); const page = state.runs.slice((p - 1) * 100, p * 100); return s.end(JSON.stringify({ total_count: state.runs.length, check_runs: page })) }
    if (/\/commits\/[0-9a-f]{40}$/.test(u.pathname)) return s.end(JSON.stringify({ commit: { committer: { date: state.date } } }))
    s.statusCode = 404; s.end('{}')
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() }
}
const cli = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; out: string; json: Record<string, unknown> }>(res => {
  const p = spawn(process.execPath, [gate, ...args], { env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv })
  let out = ''; p.stdout.on('data', b => { out += b }); p.stderr.on('data', b => { out += b })
  p.on('close', code => { let json = {}; try { json = JSON.parse(out.trim().split('\n').at(-1)!) } catch { /* not json */ } res({ code, out, json }) })
})

test('CLI: exit 0 allowed / 3 pending / 1 blocked / 2 unreadable; the report file; the token is sent but never printed', async () => {
  const api = await stubApi()
  const T = mkdtempSync(path.join(tmpdir(), 'deploy-gate-'))
  try {
    const env = { DEPLOY_GATE_API: api.url }
    api.state.runs = green()
    const report = path.join(T, 'gate.json')
    let r = await cli([SHA, '--report', report], { ...env, DEPLOY_GATE_GITHUB_TOKEN: 'synthetic-token-not-real-77' })
    assert.equal(r.code, 0, r.out); assert.equal(r.json.ok, true); assert.equal(r.json.decision, 'allowed'); assert.equal(r.json.commit, SHA)
    assert.equal(r.json.tool, 'dazl-deploy-gate')
    assert.deepEqual(JSON.parse(readFileSync(report, 'utf8')), r.json); assert.equal(statSync(report).mode & 0o777, 0o600)
    assert.ok(api.state.auth.every(a => a === 'Bearer synthetic-token-not-real-77')); assert.doesNotMatch(r.out, /synthetic-token/)
    assert.ok(api.state.paths.some(p => p.includes(`/compare/main...${SHA}`)), 'checked against main')
    api.state.runs = [...green().slice(1), run('test-sqlite', null)]
    r = await cli([SHA], env); assert.equal(r.code, 3); assert.equal(r.json.decision, 'pending'); assert.equal(r.json.ok, false)
    api.state.runs = [...green().slice(1), run('test-sqlite', 'failure')]
    r = await cli([SHA, '--report', report], env); assert.equal(r.code, 1); assert.equal(r.json.decision, 'blocked')
    assert.equal(JSON.parse(readFileSync(report, 'utf8')).ok, false, 'a blocked report overwrites an allowed one')
    // missing for over an hour after the commit: blocked
    api.state.runs = green().slice(1); api.state.date = new Date(Date.now() - 2 * 3600_000).toISOString()
    r = await cli([SHA], env); assert.equal(r.code, 1); assert.match(String(r.json.reasons), /never_ran/)
    api.state.date = new Date().toISOString(); api.state.runs = green(); api.state.compare = 'ahead'
    r = await cli([SHA], env); assert.equal(r.code, 1); assert.match(String(r.json.reasons), /not on main/)
    api.state.compare = 'identical'
    // more than 100 check runs: every page is read (the required ones on page 2)
    api.state.runs = [...Array.from({ length: 120 }, (_, i) => run(`other-${i}`)), ...green()]
    r = await cli([SHA], env); assert.equal(r.code, 0, r.out)
    // the API not readable, a bad sha, a plain-http remote API: exit 2, never allowed
    api.state.fail = 404; r = await cli([SHA], env); assert.equal(r.code, 2); assert.equal(r.json.ok, false); assert.match(String(r.json.error), /HTTP 404/)
    api.state.fail = 0
    assert.equal((await cli(['abc'], env)).code, 2)
    assert.equal((await cli([SHA], { DEPLOY_GATE_API: 'http://api.example.test' })).code, 2)
    // a required list can be narrowed for a one-off (and is recorded in the report)
    api.state.runs = [run('browser')]
    r = await cli([SHA, '--require', 'browser'], env); assert.equal(r.code, 0); assert.deepEqual(r.json.required, ['browser'])
  } finally { api.close() }
})

test('staging deploy.sh runs the real gate first: blocked or pending is never built or put live; allowed proceeds', async () => {
  const api = await stubApi()
  const T = mkdtempSync(path.join(tmpdir(), 'staging-gate-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), alerts = path.join(T, 'alerts'), built = path.join(T, 'built')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true }); mkdirSync(root); mkdirSync(built)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  const commit = (n: string) => { writeFileSync(path.join(repo, 'README.md'), n); git('add', '-A'); git('commit', '-qm', n); return git('rev-parse', 'HEAD') }
  const prodDir = path.join(T, 'prod'); mkdirSync(prodDir); const prodDb = path.join(prodDir, 'app.db'); writeFileSync(prodDb, 'p')
  const example = readFileSync(new URL('../../ops/staging/env.example', import.meta.url), 'utf8')
  const env = path.join(T, 'env')
  writeFileSync(env, example.replace('DAZL_MASTER_KEY=', 'DAZL_MASTER_KEY=AAAA').replace('STRIPE_SECRET_KEY=sk_test_', 'STRIPE_SECRET_KEY=sk_test_abc')
    .replace('DB_PATH=/var/lib/dazl-staging/app.db', `DB_PATH=${T}/staging-data/app.db`) + '\nDEPLOY_GATE_GITHUB_TOKEN=synthetic-staging-token\n')
  writeFileSync(path.join(T, 'alert.sh'), `echo "$1" >> ${alerts}\n`)
  // async: the stub API lives in this process, so a synchronous spawn would starve it
  const deploy = (script = deploySh, over: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>(res => {
    const p = spawn('bash', [script], { env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: '1',
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: 'true',
      STAGING_BUILD: `touch ${built}/$(cat .build-commit)`, STAGING_HEALTH_TRIES: '1', PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1',
      STAGING_ALERT_CMD: `bash ${path.join(T, 'alert.sh')}`, STAGING_ALERT_EVERY_S: '0', DEPLOY_GATE_API: api.url, ...over,
    } as unknown as NodeJS.ProcessEnv })
    let out = ''; p.stdout.on('data', x => { out += x }); p.stderr.on('data', x => { out += x })
    p.on('close', code => res({ code, out }))
  })
  const sent = () => existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').map(l => JSON.parse(l).reason) : []
  const isBuilt = (s: string) => existsSync(path.join(built, s))
  const current = () => existsSync(path.join(root, 'current')) ? path.basename(readlinkSync(path.join(root, 'current'))) : null
  try {
    const s1 = commit('one')
    const greenFor = (sha: string) => REQUIRED.map((n: string) => run(n, 'success', { head_sha: sha }))
    // pending: nothing built, no alert, exit 0
    api.state.runs = [run('test-sqlite', null, { head_sha: s1 })]
    let r = await deploy()
    assert.equal(r.code, 0, r.out); assert.match(r.out, /waiting for CI on/); assert.equal(isBuilt(s1), false); assert.deepEqual(sent(), [])
    assert.ok(api.state.auth.includes('Bearer synthetic-staging-token'), 'the token comes from the staging env file'); assert.doesNotMatch(r.out, /synthetic-staging-token/)
    // blocked: nothing built, one alert, exit 0, nothing live
    api.state.runs = [...greenFor(s1).slice(1), run('test-sqlite', 'failure', { head_sha: s1 })]
    r = await deploy()
    assert.equal(r.code, 0, r.out); assert.match(r.out, /ALERT gate_blocked: did not deploy/); assert.equal(isBuilt(s1), false); assert.equal(current(), null)
    assert.deepEqual(sent(), ['gate_blocked'])
    // the API down: an error, exit 1, still nothing built
    api.state.fail = 500; r = await deploy(); api.state.fail = 0
    assert.equal(r.code, 1); assert.match(r.out, /ALERT gate_error/); assert.equal(isBuilt(s1), false)
    // allowed: built and cut over (the stub service never answers health, so this first deploy then fails its cutover:
    // the rollback path is covered by staging-deploy.test.ts; here only "the gate let it through" matters)
    api.state.runs = greenFor(s1)
    r = await deploy()
    assert.equal(isBuilt(s1), true, r.out); assert.match(r.out, /deploying [0-9a-f]{40}/)
    // a gate green for ANOTHER commit does not let the new main commit through
    const s2 = commit('two')
    r = await deploy(); assert.equal(r.code, 0); assert.match(r.out, /waiting for CI/); assert.equal(isBuilt(s2), false)
    // deploy.sh installed without deploy-gate.mjs beside it: refuses, does not build
    const lone = path.join(T, 'lone'); mkdirSync(lone); copyFileSync(deploySh, path.join(lone, 'deploy.sh'))
    api.state.runs = greenFor(s2)
    r = await deploy(path.join(lone, 'deploy.sh'))
    assert.equal(r.code, 1); assert.match(r.out, /deploy-gate.mjs is not installed/); assert.equal(isBuilt(s2), false)
  } finally { api.close() }
})

// The production launcher's own tests (ops/test_safe_launch.py), so CI runs them: it refuses to stop the live service
// without an allowed gate report for exactly the commit it launches, and it rolls back when the new release's readiness
// never reports that commit.
test('ops/safe_launch.py: gate report required, and its launch / rollback tests pass', { skip: spawnSync('python3', ['--version']).status !== 0 && 'no python3' }, () => {
  const ops = fileURLToPath(new URL('../../ops/', import.meta.url))
  const r = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', ops, '-p', 'test_safe_launch.py'], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } as unknown as NodeJS.ProcessEnv })
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stderr, /Ran \d+ tests[\s\S]*OK/)
  assert.match(r.stderr, /Ran (1[6-9]|[2-9]\d) tests/, 'the gate tests are included')
})

// The gate names jobs; a renamed job or a narrowed trigger would block every deploy (or, worse, nobody would notice
// which checks it relies on). Every required name is a job in a workflow that runs on pushes to main for web/ and ops/.
test('every required check is a job of a workflow that runs on main pushes touching web/ or ops/', () => {
  const wf = (f: string) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${f}`, import.meta.url)), 'utf8')
  const jobs = (y: string) => [...y.replace(/^[\s\S]*?\njobs:\n/, '').matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map(m => m[1])
  const pushPaths = (y: string) => (y.match(/push:\n\s+branches: \[main\]\n\s+paths: \[([^\]]*)\]/)?.[1] ?? '').split(',').map(s => s.trim().replace(/"/g, ''))
  const found = new Map<string, string>()
  for (const f of ['web-ci.yml', 'release-gate.yml']) {
    const y = wf(f)
    for (const j of jobs(y)) found.set(j, f)
    if (REQUIRED.some((n: string) => jobs(y).includes(n))) for (const p of ['web/**', 'ops/**']) assert.ok(pushPaths(y).includes(p), `${f} runs on main pushes touching ${p}`)
  }
  for (const n of REQUIRED) assert.ok(found.has(n), `required check ${n} is a job in web-ci.yml or release-gate.yml`)
})
