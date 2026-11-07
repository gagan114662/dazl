// ops/staging/deploy.sh refuses an env file that is not a staging one (docs/STAGING.md):
// - DAZL_ENV must be staging, and DATABASE_URL must be unset;
// - DB_PATH is never production's database, compared by canonical path (symlinks and .. resolved), by the
//   production database's directory, and by device:inode (a hard link);
// - Stripe test mode only, the staging URL, and no Google credentials.
// Production's DB path must be given (PROD_DB_PATH or PROD_ENV_FILE), or the check fails closed. Only the --check-env
// mode runs here: nothing is cloned, built or restarted. The full deploy is exercised by ops/staging/e2e-test.sh.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../ops/staging/deploy.sh', import.meta.url))
const example = readFileSync(new URL('../../ops/staging/env.example', import.meta.url), 'utf8')
const dir = mkdtempSync(path.join(tmpdir(), 'staging-env-'))
// a production database and a staging directory, with an alias (symlink) and a hard link of production's file
const prodDir = path.join(dir, 'prod-data'), stagingDir = path.join(dir, 'staging-data')
mkdirSync(prodDir); mkdirSync(stagingDir)
const prodDb = path.join(prodDir, 'app.db')
writeFileSync(prodDb, 'production')
symlinkSync(prodDir, path.join(dir, 'alias'))
linkSync(prodDb, path.join(stagingDir, 'hardlink.db'))
const prodEnv = path.join(dir, 'prod.env'); writeFileSync(prodEnv, `DB_PATH=${prodDb}\n`)
const check = (body: string, prod: Record<string, string> = { PROD_DB_PATH: prodDb }) => {
  const f = path.join(dir, `env${Math.random().toString(36).slice(2)}`)
  writeFileSync(f, body)
  const r = spawnSync('bash', [script, '--check-env', f], { encoding: 'utf8', env: { PATH: process.env.PATH, ...prod } as unknown as NodeJS.ProcessEnv })
  return { ok: r.status === 0, out: r.stdout + r.stderr }
}
const good = example.replace('DAZL_MASTER_KEY=', 'DAZL_MASTER_KEY=AAAA').replace('STRIPE_SECRET_KEY=sk_test_', 'STRIPE_SECRET_KEY=sk_test_abc')
  .replace('DB_PATH=/var/lib/dazl-staging/app.db', `DB_PATH=${stagingDir}/app.db`)
const db = (p: string) => good.replace(`DB_PATH=${stagingDir}/app.db`, `DB_PATH=${p}`)

test('deploy.sh is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', script]).status, 0)
})

test('a staging env file passes; anything that could touch production or send for real is refused', () => {
  assert.deepEqual(check(good), { ok: true, out: 'env ok\n' })
  assert.deepEqual(check(good, { PROD_ENV_FILE: prodEnv }), { ok: true, out: 'env ok\n' }, 'production path read from its env file')
  // production's path unknown, or its env file unreadable: fail closed
  assert.match(check(good, {}).out, /production's DB_PATH is unknown/)
  assert.equal(check(good, {}).ok, false)
  assert.equal(check(good, { PROD_ENV_FILE: path.join(dir, 'missing.env') }).ok, false)
  // the same file reached by another name
  for (const [p, why] of [
    [prodDb, /is the production database/],
    [path.join(dir, 'alias', 'app.db'), /is the production database/],                   // through a symlinked directory
    [path.join(stagingDir, '..', 'prod-data', 'app.db'), /is the production database/], // through ..
    [path.join(dir, 'alias', 'other.db'), /inside the production database's directory/],
    [path.join(prodDir, 'sub', 'x.db'), /inside the production database's directory/],
    [path.join(stagingDir, 'hardlink.db'), /same file/],                                  // a hard link of production's file
    [dir + '/app.db', /production's database is inside/],                               // a parent of production's directory
    ['relative/app.db', /must be absolute/],
  ] as const) {
    const r = check(db(p))
    assert.equal(r.ok, false, p); assert.match(r.out, why)
  }
  const refused: [string, RegExp][] = [
    [good.replace('DAZL_ENV=staging', 'DAZL_ENV=production'), /DAZL_ENV must be staging/],
    [good.replace(/^DAZL_ENV=staging\n/m, ''), /DAZL_ENV must be staging/],
    [good.replace(/^DB_PATH=.*\n/m, ''), /DB_PATH is required/],
    [good + 'DATABASE_URL=postgres://u:p@db.example.test/dazl\n', /no DATABASE_URL/],
    [good.replace('STRIPE_SECRET_KEY=sk_test_abc', 'STRIPE_SECRET_KEY=sk_live_abc'), /test-mode key/],
    [good.replace('STRIPE_SECRET_KEY=sk_test_abc', 'STRIPE_SECRET_KEY="rk_live_abc"'), /test-mode key/],
    [good.replace('PUBLIC_BASE_URL=https://staging.dazl.ai', 'PUBLIC_BASE_URL=https://dazl.ai'), /staging URL/],
    [good + 'GOOGLE_CLIENT_SECRET=abc\n', /no Google credentials/],
  ]
  for (const [body, why] of refused) {
    const r = check(body)
    assert.equal(r.ok, false, String(why))
    assert.match(r.out, why)
    assert.ok(!r.out.includes('sk_live_abc') && !r.out.includes('AAAA'), 'values are never printed')
  }
})

// The cutover (review hold): the real deploy.sh, as the current user, against a local repo, with a stub build, a stub
// restart and a tiny health server standing in for the service. Faults are injected per commit:
//   fail-restart-<sha>  the restart command exits non-zero while <sha> is current
//   unready-<sha>       the service never reports <sha> on /api/health
//   sick-<sha>          the service reports <sha>, but 503 with ok: false (a database not answering)
// The first commit predates ops/health-smoke.mjs (its release is checked by commit alone, as a rollback target); every
// later commit carries the real smoke script, which deploy.sh runs from the release it checks.
// After any failed cutover the previous complete release must be current, release.env must name it, it must be
// serving again, and the failed release must be gone. A failed first deployment must leave no current pointer.
test('cutover: a failed restart or readiness restores and re-checks the previous release; a failed first deploy leaves no live pointer', async () => {
  const { execFileSync, spawn } = await import('node:child_process')
  const { existsSync, readlinkSync, readdirSync, rmSync } = await import('node:fs')
  const net = await import('node:net')
  const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  const T = mkdtempSync(path.join(tmpdir(), 'staging-cutover-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo')
  // git with no inherited GIT_CONFIG_* (the test fence strips *KEY* variables and can leave a dangling count)
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  const commit = (n: string) => { writeFileSync(path.join(repo, 'README.md'), n); git('add', '-A'); git('commit', '-qm', n); return git('rev-parse', 'HEAD') }
  const env = path.join(T, 'env'); writeFileSync(env, good)
  // the "service": serves the commit the last successful restart started
  const served = path.join(T, 'served')
  writeFileSync(path.join(T, 'health.mjs'), `import http from 'node:http'; import fs from 'node:fs'
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {}
  const sick = c && fs.existsSync(${JSON.stringify(T)} + '/sick-' + c)
  s.statusCode = sick ? 503 : 200
  s.end(JSON.stringify({ ok: !sick, commit: c, checks: { sqlite: { ok: !sick } } })) }).listen(${port}, '127.0.0.1')`)
  const server = spawn(process.execPath, [path.join(T, 'health.mjs')], { stdio: 'ignore' })
  const restart = path.join(T, 'restart.sh')
  writeFileSync(restart, `#!/usr/bin/env bash
sha=$(basename "$(readlink -f ${root}/current)")
[ -e ${T}/fail-restart-$sha ] && exit 1
if [ -e ${T}/unready-$sha ]; then echo starting > ${served}; else echo "$sha" > ${served}; fi\n`)
  execFileSync('chmod', ['+x', restart])
  const deploy = () => {
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: String(port),
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: restart,
      STAGING_STOP: 'true', STAGING_MIGRATE: 'true', STAGING_BUILD: 'true', STAGING_HEALTH_TRIES: '2', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'), STAGING_STATE_ROOT: path.join(T, 'state'), PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1',
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const current = () => existsSync(path.join(root, 'current')) ? path.basename(readlinkSync(path.join(root, 'current'))) : null
  const releaseEnv = () => existsSync(path.join(T, 'state', 'release.env')) ? readFileSync(path.join(T, 'state', 'release.env'), 'utf8').trim() : null
  const releases = () => readdirSync(path.join(root + '-releases')).sort()
  const servedNow = () => readFileSync(served, 'utf8').trim()
  try {
    mkdirSync(root)
    // a failed FIRST deployment: nothing to go back to, and no pointer left at the failed release
    const s0 = commit('first')
    writeFileSync(path.join(T, `fail-restart-${s0}`), '')
    let r = deploy()
    assert.equal(r.code, 1); assert.match(r.out, /first deployment failed: NO LIVE STAGING SERVICE/)
    assert.deepEqual([current(), releaseEnv(), releases()], [null, null, []])
    rmSync(path.join(T, `fail-restart-${s0}`))

    // the first deployment that works
    r = deploy(); assert.equal(r.code, 0, r.out); assert.match(r.out, /live: /)
    assert.deepEqual([current(), releaseEnv(), servedNow()], [s0, `DAZL_COMMIT_SHA=${s0}`, s0])
    // from here on every commit carries the smoke check
    mkdirSync(path.join(repo, 'ops'))
    writeFileSync(path.join(repo, 'ops', 'health-smoke.mjs'), readFileSync(new URL('../../ops/health-smoke.mjs', import.meta.url)))

    // the restart command fails at once for the new release (the earlier code exited here, current left on it)
    const s1 = commit('restart fails')
    writeFileSync(path.join(T, `fail-restart-${s1}`), '')
    r = deploy()
    assert.equal(r.code, 1); assert.match(r.out, /the restart command failed/); assert.match(r.out, new RegExp(`rolled back: ${s0} is live again`))
    assert.deepEqual([current(), releaseEnv(), servedNow(), releases()], [s0, `DAZL_COMMIT_SHA=${s0}`, s0, [s0]])

    // the new release starts but never becomes ready
    const s2 = commit('never ready')
    writeFileSync(path.join(T, `unready-${s2}`), '')
    r = deploy()
    assert.equal(r.code, 1); assert.match(r.out, /never answered ok with commit/); assert.match(r.out, /is live again/)
    assert.match(r.out, /health-smoke: serves commit "starting", expected/)
    assert.deepEqual([current(), releaseEnv(), servedNow(), releases()], [s0, `DAZL_COMMIT_SHA=${s0}`, s0, [s0]])

    // the new release serves its commit, but /api/health is 503, not ok (its database does not answer): rolled back
    const s2b = commit('database down')
    writeFileSync(path.join(T, `sick-${s2b}`), '')
    r = deploy()
    assert.equal(r.code, 1); assert.match(r.out, new RegExp(`never answered ok with commit ${s2b}`))
    assert.match(r.out, /health-smoke: HTTP 503, not ok \(sqlite not answering\)/)
    assert.match(r.out, new RegExp(`rolled back: ${s0} is live again`))
    assert.deepEqual([current(), releaseEnv(), servedNow(), releases()], [s0, `DAZL_COMMIT_SHA=${s0}`, s0, [s0]])

    // the new release fails AND the rollback's own restart fails: reported as no live service, not as recovered
    const s3 = commit('rollback fails too')
    writeFileSync(path.join(T, `fail-restart-${s3}`), ''); writeFileSync(path.join(T, `fail-restart-${s0}`), '')
    r = deploy()
    assert.equal(r.code, 1); assert.match(r.out, /did not come up healthy: NO LIVE STAGING SERVICE/)
    assert.doesNotMatch(r.out, /is live again/)
    assert.deepEqual([current(), releases()], [s0, [s0]])
    rmSync(path.join(T, `fail-restart-${s0}`))

    // and a good commit after all that deploys normally
    const s4 = commit('good')
    r = deploy(); assert.equal(r.code, 0, r.out)
    assert.deepEqual([current(), servedNow(), releases()], [s4, s4, [s0, s4].sort()])
  } finally { server.kill() }
})

// Low-disk protection (review hold before enabling staging): below the floor, or when a release would not fit above
// it, the deploy SKIPS (exit 0, nothing fetched, built or deleted) and alerts, at most once per reason per interval;
// when the floor is reached during a build, the build is stopped, its release removed, and an alert sent. The staging
// directory may not be inside or contain production's data directory.
test('low disk: skip and alert (throttled), stop a build at the floor, never touch anything outside the staging root', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync, readdirSync } = await import('node:fs')
  const T = mkdtempSync(path.join(tmpdir(), 'staging-disk-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), alerts = path.join(T, 'alerts')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  mkdirSync(path.join(repo, 'web'), { recursive: true }); mkdirSync(root)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'add', '-A'], { env: gitEnv })
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'one'], { env: gitEnv })
  const env = path.join(T, 'env'); writeFileSync(env, good)
  writeFileSync(path.join(T, 'alert.sh'), `echo "$1" >> ${alerts}\n`)
  const free = () => Number(execFileSync('df', ['-B1', '--output=avail', root], { encoding: 'utf8' }).trim().split('\n').at(-1))
  const run = (over: Record<string, string>) => {
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: '1',
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: 'true',
      STAGING_STOP: 'true', STAGING_MIGRATE: 'true', STAGING_BUILD: 'true', STAGING_HEALTH_TRIES: '1', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'), STAGING_STATE_ROOT: path.join(T, 'state'), PROD_DB_PATH: prodDb, FIRST_RELEASE_BYTES: '1', STAGING_ALERT_CMD: `bash ${path.join(T, 'alert.sh')}`,
      ...over,
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const sent = () => existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  const releases = () => existsSync(path.join(root + '-releases')) ? readdirSync(path.join(root + '-releases')) : []

  // 1. below the floor: skipped with exit 0 before anything is fetched; one alert, then throttled
  const huge = String(1e15)
  let r = run({ MIN_FREE_BYTES: huge })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /ALERT low_disk: skipped: \d+ bytes free, below the floor/)
  assert.equal(existsSync(path.join(root, 'repo')), false, 'nothing fetched'); assert.deepEqual(releases(), [])
  assert.deepEqual(sent().map(a => [a.type, a.reason, a.floor_bytes]), [['staging_deploy', 'low_disk', 1e15]])
  r = run({ MIN_FREE_BYTES: huge })
  assert.equal(r.code, 0); assert.match(r.out, /already sent within 3600s/); assert.equal(sent().length, 1, 'throttled')
  r = run({ MIN_FREE_BYTES: huge, STAGING_ALERT_EVERY_S: '0' })
  assert.equal(sent().length, 2, 'alerts again once the interval has passed')

  // 2. above the floor, but the release would not fit above it: skipped, alerted, nothing built
  r = run({ MIN_FREE_BYTES: String(free() - 50_000_000), FIRST_RELEASE_BYTES: '200000000', DISK_RESERVE_BYTES: '0' })
  assert.equal(r.code, 0, r.out); assert.match(r.out, /ALERT low_disk_for_release: skipped [0-9a-f]{40}: \d+ bytes free, a release needs about 200000000/)
  assert.deepEqual(releases(), []); assert.equal(sent().at(-1).reason, 'low_disk_for_release'); assert.equal(sent().at(-1).needed_bytes, 200000000)

  // 3. the floor is reached while the build runs: stopped, release removed, alerted, exit 1, no live pointer created
  r = run({ MIN_FREE_BYTES: String(free() - 40_000_000), DISK_RESERVE_BYTES: '0', STAGING_BUILD: 'head -c 80000000 /dev/zero > fill.bin && sleep 6' })
  assert.equal(r.code, 1, r.out); assert.match(r.out, /ALERT low_disk_during_build: stopped the build/)
  assert.deepEqual(releases(), [], 'the stopped release is removed'); assert.equal(existsSync(path.join(root, 'current')), false)
  assert.equal(sent().at(-1).reason, 'low_disk_during_build')

  // 4. enough disk again: deploys, and the low-disk throttles are cleared so the next low disk alerts at once
  r = run({ MIN_FREE_BYTES: '1' })
  assert.equal(r.code, 1, 'the stub service never reports health, so the cutover rolls back; the deploy itself ran')
  assert.match(r.out, /deploying [0-9a-f]{40}/)
  assert.deepEqual(readdirSync(path.join(T, 'state')).filter(f => f.startsWith('.alert-low_disk')), [])
  assert.deepEqual(readdirSync(root).filter(f => f.startsWith('.alert')), [], 'no alert stamp in the service account\'s home')

  // 5. the staging root may not be inside, or contain, production's data directory
  for (const bad of [path.join(prodDir, 'staging'), dir]) {
    const x = run({ MIN_FREE_BYTES: '1', STAGING_ROOT: bad })
    assert.equal(x.code, 1); assert.match(x.out, /STAGING_ROOT .* (inside|contains) production's data directory/)
  }
})

// Review repro (#314): a successful build that ends low AFTER the watcher's last poll. With a fake df reading its value
// from a file, the build flips free space to 1 byte just before it exits; the deploy must not go live. Also: the reserve
// is kept above the floor (no build starts, and a running one stops, before the floor itself is reached), and the
// watcher reacts within its 0.5 s cadence.
test('low disk after or near the end of a build: never put live; the reserve above the floor is enforced', async () => {
  const { execFileSync } = await import('node:child_process')
  const { existsSync, readdirSync, readlinkSync, symlinkSync } = await import('node:fs')
  const T = mkdtempSync(path.join(tmpdir(), 'staging-final-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), bin = path.join(T, 'bin'), availFile = path.join(T, 'avail'), alerts = path.join(T, 'alerts')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true }); mkdirSync(bin)
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}'); g('add', '-A'); g('commit', '-qm', 'new')
  const sha = g('rev-parse', 'HEAD')
  // a fake df: "avail" for every path, read from a file the test (and the stub build) control
  writeFileSync(path.join(bin, 'df'), `#!/usr/bin/env bash\necho Avail\ncat ${availFile}\n`); execFileSync('chmod', ['+x', path.join(bin, 'df')])
  writeFileSync(path.join(T, 'alert.sh'), `echo "$1" >> ${alerts}\n`)
  // an existing live release (complete), which must stay live
  const old = 'a'.repeat(40)
  mkdirSync(root, { recursive: true }); mkdirSync(path.join(root + '-releases', old, 'web'), { recursive: true }); writeFileSync(path.join(root + '-releases', old, '.complete'), '')
  symlinkSync(path.join(root + '-releases', old), path.join(root, 'current')); mkdirSync(path.join(T, 'state'), { mode: 0o700 }); writeFileSync(path.join(T, 'state', 'current-sha'), old + '\n')
  const env = path.join(T, 'env'); writeFileSync(env, good)
  const FLOOR = 2147483648, RESERVE = 268435456
  const run = (build: string, avail: number) => {
    writeFileSync(availFile, String(avail))
    const t0 = Date.now()
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: '1',
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: 'true',
      STAGING_STOP: 'true', STAGING_MIGRATE: 'true', STAGING_BUILD: build, STAGING_HEALTH_TRIES: '1', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'), STAGING_STATE_ROOT: path.join(T, 'state'), PROD_DB_PATH: prodDb, MIN_FREE_BYTES: String(FLOOR),
      STAGING_ALERT_CMD: `bash ${path.join(T, 'alert.sh')}`, STAGING_ALERT_EVERY_S: '0',
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr, ms: Date.now() - t0 }
  }
  const live = () => [path.basename(readlinkSync(path.join(root, 'current'))), readFileSync(path.join(T, 'state', 'current-sha'), 'utf8').trim()]
  const lastAlert = () => JSON.parse(readFileSync(alerts, 'utf8').trim().split('\n').at(-1)!)

  // 1. the build succeeds, then free space is 1 byte, between watcher polls: not put live, release removed
  let r = run(`sleep 0.25 && echo 1 > ${availFile}`, 10e9)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /ALERT low_disk_after_build: did not put [0-9a-f]{40} live: 1 bytes free after its build/)
  assert.doesNotMatch(r.out, /live: [0-9a-f]{40}$/m)
  assert.doesNotMatch(r.out, /cutover of/, 'no cutover was even attempted')
  assert.deepEqual(live(), [old, old], 'the live release is unchanged')
  assert.deepEqual(readdirSync(path.join(root + '-releases')), [old], 'the failed release is removed')
  assert.equal(existsSync(path.join(root + '-releases', sha)), false)
  assert.equal(lastAlert().reason, 'low_disk_after_build')

  // 2. above the floor but inside the reserve: no build starts at all
  r = run(`touch ${path.join(T, 'built')}`, FLOOR + RESERVE / 2)
  assert.equal(r.code, 0, r.out); assert.match(r.out, /ALERT low_disk_for_release: skipped .* plus a reserve of 268435456/)
  assert.equal(existsSync(path.join(T, 'built')), false, 'no build ran'); assert.deepEqual(live(), [old, old])

  // 3. free space drops into the reserve while a long build runs: stopped within the watcher cadence, before the floor
  r = run(`echo ${FLOOR + 1000} > ${availFile} && sleep 20`, 10e9)
  assert.equal(r.code, 1, r.out); assert.match(r.out, /ALERT low_disk_during_build: stopped the build/)
  assert.ok(r.ms < 8000, `stopped promptly (${r.ms} ms), not after the 20 s build`)
  assert.deepEqual(live(), [old, old]); assert.deepEqual(readdirSync(path.join(root + '-releases')), [old])
  assert.ok(lastAlert().free_bytes >= FLOOR, 'stopped while still above the protected floor')
})

// Sign in with Google on staging: a dedicated, identity-only client is allowed; the Gmail client and production's
// client (or secret) are refused, and so is a sign-in client when production's env file is not there to compare with.
test('staging sign-in client: a dedicated one passes; production\'s, the Gmail client, half a pair or an unverifiable one is refused', () => {
  const SID = 'staging-signin-123.apps.googleusercontent.com', SSEC = 'GOCSPX-staging-only-secret'
  const withSignin = good.replace('GOOGLE_SIGNIN_CLIENT_ID=', `GOOGLE_SIGNIN_CLIENT_ID=${SID}`).replace('GOOGLE_SIGNIN_CLIENT_SECRET=', `GOOGLE_SIGNIN_CLIENT_SECRET=${SSEC}`)
  const prodWith = (extra: string) => { const f = path.join(dir, `prod${Math.random().toString(36).slice(2)}.env`); writeFileSync(f, `DB_PATH=${prodDb}\n${extra}`); return { PROD_ENV_FILE: f } }
  const prodGoogle = prodWith('GOOGLE_CLIENT_ID=prod-gmail-9.apps.googleusercontent.com\nGOOGLE_CLIENT_SECRET=GOCSPX-production-secret\n')
  assert.deepEqual(check(withSignin, prodGoogle), { ok: true, out: 'env ok\n' })
  assert.deepEqual(check(good, prodGoogle), { ok: true, out: 'env ok\n' }, 'no sign-in client: unchanged')
  const refused: [string, Record<string, string>, RegExp][] = [
    [withSignin, { PROD_DB_PATH: prodDb }, /needs PROD_ENV_FILE/],                                     // nothing to compare with
    [withSignin, prodWith(`GOOGLE_CLIENT_ID=${SID}\n`), /is production's Google client/],               // production's Gmail client id
    [withSignin, prodWith(`GOOGLE_SIGNIN_CLIENT_ID=${SID}\n`), /is production's Google client/],        // production's sign-in client id
    [withSignin, prodWith(`GOOGLE_CLIENT_SECRET=${SSEC}\n`), /secret is production's/],
    [withSignin, prodWith(`GOOGLE_SIGNIN_CLIENT_SECRET="${SSEC}"\n`), /secret is production's/],
    [good.replace('GOOGLE_SIGNIN_CLIENT_ID=', `GOOGLE_SIGNIN_CLIENT_ID=${SID}`), prodGoogle, /go together/],
    [withSignin.replace(SID, 'not-a-client-id'), prodGoogle, /not a Google OAuth client id/],
    [withSignin + 'GOOGLE_CLIENT_ID=staging-gmail.apps.googleusercontent.com\n', prodGoogle, /no Google credentials/], // the Gmail client, id alone
    [withSignin + 'GOOGLE_CLIENT_SECRET=x\n', prodGoogle, /no Google credentials/],
  ]
  for (const [body, prod, why] of refused) {
    const r = check(body, prod)
    assert.equal(r.ok, false, String(why)); assert.match(r.out, why)
    for (const v of [SSEC, 'GOCSPX-production-secret', SID]) assert.ok(!r.out.includes(v), 'values are never printed')
  }
})

test('staging Gmail (#413): Gmail credentials need the flag and the full config; GOOGLE_CLIENT_* stays refused', () => {
  const real = { DAZL_STAGING_REAL_GMAIL: '1', GMAIL_STAGING_CLIENT_ID: 'stg.apps.googleusercontent.com', GMAIL_STAGING_CLIENT_SECRET: 'stg-secret', DAZL_STAGING_GMAIL_ALLOWLIST: 'a@owner.example, b@owner.example' }
  const withEnv = (kv: Record<string, string>) => good + '\n' + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  assert.deepEqual(check(withEnv(real)), { ok: true, out: 'env ok\n' })
  assert.equal(check(good).ok, true, 'stub default unchanged')
  for (const [why, kv] of [
    ['credentials without the flag', { GMAIL_STAGING_CLIENT_ID: real.GMAIL_STAGING_CLIENT_ID, GMAIL_STAGING_CLIENT_SECRET: 'x' }],
    ['allowlist without the flag', { DAZL_STAGING_GMAIL_ALLOWLIST: 'a@owner.example' }],
    ['flag without credentials', { DAZL_STAGING_REAL_GMAIL: '1', DAZL_STAGING_GMAIL_ALLOWLIST: 'a@owner.example' }],
    ['flag without allowlist', { ...real, DAZL_STAGING_GMAIL_ALLOWLIST: '' }],
    ['wildcard allowlist', { ...real, DAZL_STAGING_GMAIL_ALLOWLIST: '*@owner.example' }],
    ['domain allowlist', { ...real, DAZL_STAGING_GMAIL_ALLOWLIST: 'owner.example' }],
    ['not a google client id', { ...real, GMAIL_STAGING_CLIENT_ID: 'nope' }],
    ['legacy GOOGLE_CLIENT_ID even with the flag', { ...real, GOOGLE_CLIENT_ID: 'x' }],
    ['legacy GOOGLE_CLIENT_SECRET even with the flag', { ...real, GOOGLE_CLIENT_SECRET: 'x' }],
    ['a flag value other than 1', { ...real, DAZL_STAGING_REAL_GMAIL: 'yes' }],
  ] as const) assert.equal(check(withEnv(kv)).ok, false, why)
  // production's Gmail client may not be reused on staging
  const pe = path.join(dir, 'prod2.env'); writeFileSync(pe, `DB_PATH=${prodDb}\nGOOGLE_CLIENT_ID=stg.apps.googleusercontent.com\n`)
  assert.match(check(withEnv(real), { PROD_ENV_FILE: pe }).out, /production's Google client/)
})

// #908: the schema change happens only behind a verified pre-migration recovery point, with the service stopped, and every rollback
// puts the matching database back BEFORE the old code starts. Real deploy.sh, scratch SQLite database, stub stop/restart/health.
test('recovery point: migration failure, partial seed, failed new service, refused backup, failed stop, leftover migration process, failed restore on both paths', async () => {
  const { execFileSync, spawn } = await import('node:child_process')
  const { existsSync, readdirSync, readlinkSync, rmSync } = await import('node:fs')
  const net = await import('node:net')
  const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  const T = mkdtempSync(path.join(tmpdir(), 'staging-rp-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), sdir = path.join(T, 'sdata'), sdb = path.join(sdir, 'app.db'), log = path.join(T, 'order.log')
  const rroot = path.join(T, 'recovery'), pendingFile = path.join(rroot, 'pending')
  mkdirSync(sdir)
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  const commit = (n: string) => { writeFileSync(path.join(repo, 'README.md'), n); git('add', '-A'); git('commit', '-qm', n); return git('rev-parse', 'HEAD') }
  const env = path.join(T, 'env'); writeFileSync(env, good.replace(`DB_PATH=${stagingDir}/app.db`, `DB_PATH=${sdb}`))
  const served = path.join(T, 'served')
  writeFileSync(path.join(T, 'health.mjs'), `import http from 'node:http'; import fs from 'node:fs'
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {}
  s.end(JSON.stringify({ ok: true, commit: c, checks: {} })) }).listen(${port}, '127.0.0.1')`)
  const server = spawn(process.execPath, [path.join(T, 'health.mjs')], { stdio: 'ignore' })
  const restart = path.join(T, 'restart.sh'), stop = path.join(T, 'stop.sh')
  writeFileSync(restart, `#!/usr/bin/env bash
sha=$(basename "$(readlink -f ${root}/current)"); echo "restart $sha" >> ${log}
if [ -e ${T}/unready-$sha ]; then echo starting > ${served}; else echo "$sha" > ${served}; fi\n`)
  writeFileSync(stop, `#!/usr/bin/env bash\necho stop >> ${log}; [ -e ${T}/fail-stop ] && exit 1; echo stopped > ${served}; exit 0\n`)
  execFileSync('chmod', ['+x', restart, stop])
  const sql = (q: string) => execFileSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); r=c.execute(sys.argv[2]).fetchall(); c.commit(); print(r)`, sdb, q], { encoding: 'utf8' }).trim()
  // the "migration": adds a column and a row (a partial seed when it then fails)
  const MIGRATE = `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('CREATE TABLE IF NOT EXISTS t(v)'); c.execute('INSERT INTO t VALUES (\\'seeded\\')'); c.commit()" && { [ ! -e ${T}/fail-migrate ] || exit 7; } && python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('ALTER TABLE t ADD COLUMN x'); c.commit()"`
  const deploy = (extra: Record<string, string> = {}) => {
    writeFileSync(log, '')
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: String(port),
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: restart, STAGING_STOP: stop,
      STAGING_BUILD: 'true', STAGING_MIGRATE: MIGRATE, STAGING_HEALTH_TRIES: '2', STAGING_RECOVERY_ROOT: rroot, STAGING_STATE_ROOT: path.join(T, 'state'), PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1', ...extra,
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr, order: readFileSync(log, 'utf8').trim().split('\n') }
  }
  const current = () => existsSync(path.join(root, 'current')) ? path.basename(readlinkSync(path.join(root, 'current'))) : null
  const cols = () => sql('SELECT name FROM pragma_table_info(\'t\')')
  try {
    mkdirSync(root)
    const s0 = commit('first')
    const realHelper = path.resolve(path.dirname(script), 'recovery_point.py')
    const wrapper = (name: string, failOn: string) => { // the real helper, except that one action fails
      const f = path.join(T, name)
      writeFileSync(f, `import sys, runpy\nif sys.argv[1] == '${failOn}': sys.exit(1)\nsys.argv[0] = ${JSON.stringify(realHelper)}\nrunpy.run_path(sys.argv[0], run_name='__main__')\n`)
      execFileSync('chmod', ['755', f]); return f
    }
    const noCreate = wrapper('rp-nocreate.py', 'create'), noRestore = wrapper('rp-norestore.py', 'restore')
    // 0a. FIRST deployment, the recovery point cannot be made: nothing claims a previous release restarted (xhawk 5)
    let r = deploy({ STAGING_RECOVERY: noCreate })
    assert.equal(r.code, 1, r.out); assert.match(r.out, /no verified recovery point on a first deployment; nothing migrated, NO LIVE STAGING SERVICE/)
    assert.doesNotMatch(r.out, /restarted unchanged|is live again/); assert.deepEqual(r.order, ['stop']); assert.equal(current(), null)
    // 0b. FIRST deployment, the migration fails after a partial seed: the database goes back to absent, reported as no live service
    writeFileSync(path.join(T, 'fail-migrate'), '')
    r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, /on a first deployment; database restored, NO LIVE STAGING SERVICE/)
    assert.doesNotMatch(r.out, /is live again/); assert.equal(existsSync(sdb), false, 'the database the failed first migration created is gone')
    assert.equal(existsSync(pendingFile), false)
    rmSync(path.join(T, 'fail-migrate'))
    r = deploy(); assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.order, ['stop', 'migrate', `restart ${s0}`], 'stopped before the recovery point; migrated only after it')
    assert.match(r.out, /recovery point for none verified before migrating/)
    sql("DELETE FROM t"); sql("INSERT INTO t VALUES ('user-row', NULL)")
    const base = [sql('SELECT v FROM t ORDER BY v'), cols()]
    assert.deepEqual(base, ["[('user-row',)]", "[('v',), ('x',)]"])
    // a no-op migration release becomes the baseline every case below must return to
    const s0b = commit('baseline')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}` }); assert.equal(r.code, 0, r.out); assert.equal(current(), s0b)

    // 1. migration fails after a partial seed: the database is restored, the previous release (unchanged) is live again
    const s1 = commit('migration fails'); writeFileSync(path.join(T, 'fail-migrate'), '')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('INSERT INTO t VALUES (\\'partial\\', 1)'); c.commit()"; exit 7` })
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`migration or seed of ${s1} failed \\(exit 7\\); database restored, ${s0b} is live again`))
    assert.deepEqual([sql('SELECT v FROM t ORDER BY v'), cols(), current()], [base[0], base[1], s0b])
    assert.deepEqual(r.order, ['stop', 'migrate', `restart ${s0b}`])
    rmSync(path.join(T, 'fail-migrate'))

    // 2. the migration succeeds but the new service never becomes ready: stop it, restore the pre-migration database, then old code
    const s2 = commit('never ready'); writeFileSync(path.join(T, `unready-${s2}`), '')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('CREATE TABLE new_schema(id)'); c.execute('INSERT INTO t VALUES (\\'by-new\\', 2)'); c.commit()"` })
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`rolled back: ${s0b} is live again`))
    assert.deepEqual(r.order, ['stop', 'migrate', `restart ${s2}`, 'stop', `restart ${s0b}`], 'the restore happens between stopping the new release and starting the old one')
    assert.deepEqual([sql('SELECT v FROM t ORDER BY v'), sql("SELECT count(*) FROM sqlite_master WHERE name = 'new_schema'"), current()], [base[0], '[(0,)]', s0b])

    // 3. the recovery helper is not installed (xhawk 4): refused BEFORE anything is stopped; the live release keeps serving
    commit('backup refused')
    r = deploy({ STAGING_RECOVERY: path.join(T, 'missing-recovery.py') })
    assert.equal(r.code, 1, r.out); assert.match(r.out, /recovery helper .* is not installed .*nothing stopped or changed/)
    assert.deepEqual(r.order.filter(Boolean), [], 'nothing stopped, migrated or restarted'); assert.equal(current(), s0b)
    // 3b. a helper writable by another user, or a recovery root that is not private: also refused before stopping
    const loose = path.join(T, 'loose'); mkdirSync(loose); execFileSync('cp', [realHelper, loose]); execFileSync('chmod', ['775', loose])
    r = deploy({ STAGING_RECOVERY: path.join(loose, 'recovery_point.py') })
    assert.equal(r.code, 1, r.out); assert.match(r.out, /writable by another user; nothing stopped/); assert.deepEqual(r.order.filter(Boolean), [])
    execFileSync('chmod', ['755', rroot]); r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, /recovery root .* is not private/); assert.deepEqual(r.order.filter(Boolean), [])
    execFileSync('chmod', ['700', rroot])
    // 3c. the recovery point cannot be made or verified: nothing migrated, the old release restarted unchanged
    r = deploy({ STAGING_RECOVERY: noCreate })
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`no verified recovery point; nothing migrated, ${s0b} restarted unchanged`))
    assert.ok(!r.order.includes('migrate')); assert.deepEqual([current(), sql('SELECT v FROM t ORDER BY v')], [s0b, base[0]])

    // 4. the service cannot be stopped (writes could continue): fail closed, nothing migrated
    writeFileSync(path.join(T, 'fail-stop'), '')
    r = deploy(); assert.equal(r.code, 1, r.out); assert.match(r.out, /could not stop the service for a recovery point; nothing migrated/)
    assert.ok(!r.order.includes('migrate')); assert.equal(current(), s0b)
    rmSync(path.join(T, 'fail-stop'))

    // 4b. a migration that leaves a process running in its group: reaped before the restore, never outlives the step
    const pidf = path.join(T, 'orphan.pid')
    commit('migration leaves an orphan')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}; sleep 300 >/dev/null 2>&1 & echo $! > ${pidf}; exit 3` })
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`database restored, ${s0b} is live again`))
    const orphan = Number(readFileSync(pidf, 'utf8').trim())
    // gone, or a zombie no one has reaped yet (dead either way; the test host's init may not reap promptly)
    const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false } }
    assert.equal(alive(orphan), false, 'the migration step\'s leftover process was stopped')
    assert.equal(current(), s0b)

    // 5. the restore itself fails: reported as no live service; old code is NOT started against the migrated database
    const wrap = noRestore
    const rps = () => readdirSync(rroot).filter(f => !f.startsWith('.') && f !== 'pending').sort()
    r = deploy({ STAGING_RECOVERY: wrap, STAGING_MIGRATE: `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('INSERT INTO t VALUES (\\'partial5\\', 5)'); c.commit()"; exit 3` })
    assert.equal(r.code, 1, r.out); assert.match(r.out, /database restore failed: NO LIVE STAGING SERVICE/)
    assert.ok(!r.order.some(l => l === `restart ${s0b}`), 'old code never restarted against an unrestored database')
    // 5b. the retry (xhawk 3): the pending marker names the ONLY pre-migration copy; the next run restores THAT one first
    // (checked against its recorded manifest checksum), restarts the old release and takes no new recovery point
    assert.ok(existsSync(pendingFile), 'a failed restore leaves the pending marker')
    const pendingRp = readFileSync(pendingFile, 'utf8').match(/^rp=(.*)$/m)![1], before5 = rps()
    r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`recovered the interrupted deploy of [0-9a-f]{40}: database restored, ${s0b} is live again`))
    assert.deepEqual(r.order, ['stop', `restart ${s0b}`], 'restored before the old code started; nothing migrated')
    assert.deepEqual([sql('SELECT v FROM t ORDER BY v'), cols(), current()], [base[0], base[1], s0b])
    assert.deepEqual(rps(), before5, 'no new recovery point taken over the migrated database')
    assert.ok(existsSync(path.join(pendingRp, 'manifest.json')), 'the pre-migration recovery point is kept')
    assert.equal(existsSync(pendingFile), false)

    // 6. the same refusal on the CUTOVER-failure path: the migration succeeded, the new release never became ready, and the
    // restore fails. The deploy must refuse: old code is NOT restarted against the migrated database, nothing claims live.
    const s6 = commit('never ready, restore fails'); writeFileSync(path.join(T, `unready-${s6}`), '')
    r = deploy({ STAGING_RECOVERY: wrap, STAGING_MIGRATE: `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('CREATE TABLE IF NOT EXISTS migrated6(id)'); c.commit()"` })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /database restore failed: NO LIVE STAGING SERVICE \(old code not started against a migrated database/)
    assert.doesNotMatch(r.out, /rolled back|is live again/)
    assert.deepEqual(r.order, ['stop', 'migrate', `restart ${s6}`, 'stop'], 'stopped the failed release, then refused: no restart of the old code')
    assert.notEqual(current(), s0b, 'current is not switched back to the old release over a migrated database')
    // 6b. the next run finishes that restore first, then puts the old release back
    r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`recovered the interrupted deploy of ${s6}: database restored, ${s0b} is live again`))
    assert.deepEqual([sql("SELECT count(*) FROM sqlite_master WHERE name = 'migrated6'"), sql('SELECT v FROM t ORDER BY v'), current()], ['[(0,)]', base[0], s0b])

    // 7. the deploy itself is killed (SIGKILL) right after the migration: nothing ran its rollback. The retry must restore the
    // ORIGINAL pre-migration recovery point (never back up the migrated database and call that the recovery point)
    const s7 = commit('deploy killed mid-migration')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}; python3 -c "import sqlite3; c=sqlite3.connect('${sdb}'); c.execute('CREATE TABLE migrated7(id)'); c.execute('INSERT INTO t VALUES (\\'by-killed\\', 7)'); c.commit()"; kill -KILL $PPID; sleep 1` })
    assert.notEqual(r.code, 0); assert.doesNotMatch(r.out, /live: /)
    assert.ok(existsSync(pendingFile), 'the killed deploy left its pending marker')
    const killedRp = readFileSync(pendingFile, 'utf8').match(/^rp=(.*)$/m)![1], before7 = rps()
    r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, new RegExp(`recovered the interrupted deploy of ${s7}: database restored, ${s0b} is live again`))
    assert.deepEqual([sql("SELECT count(*) FROM sqlite_master WHERE name = 'migrated7'"), sql('SELECT v FROM t ORDER BY v'), current()], ['[(0,)]', base[0], s0b])
    assert.deepEqual(rps(), before7); assert.ok(existsSync(path.join(killedRp, 'manifest.json')))
    // 7b. a recovery point swapped while pending is refused, not restored: the service stays down, the marker stays
    commit('deploy killed again'); r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}; kill -KILL $PPID; sleep 1` })
    const swapRp = readFileSync(pendingFile, 'utf8').match(/^rp=(.*)$/m)![1]
    execFileSync('python3', [realHelper, 'create', '--db', sdb, '--dir', swapRp + '.forged'], { stdio: 'ignore' })
    rmSync(swapRp, { recursive: true, force: true }); execFileSync('mv', [swapRp + '.forged', swapRp])
    r = deploy()
    assert.equal(r.code, 1, r.out); assert.match(r.out, /was replaced/); assert.match(r.out, /NO LIVE STAGING SERVICE/)
    assert.deepEqual(r.order, ['stop']); assert.ok(existsSync(pendingFile), 'the marker stays until a real restore succeeds')
    rmSync(pendingFile) // (the operator's call after investigating; the database is unchanged by the refusal)

    // 8. after all that a good commit deploys, commits (no pending marker) and keeps at most three recovery points
    const s8 = commit('good after recoveries')
    r = deploy({ STAGING_MIGRATE: `echo migrate >> ${log}` }); assert.equal(r.code, 0, r.out)
    assert.equal(current(), s8); assert.equal(existsSync(pendingFile), false); assert.ok(rps().length <= 3, rps().join())
  } finally { server.kill() }
})

test('recovery_point.py scratch-database checks (WAL capture, orphaned WAL/SHM/journal, absent database, tamper, wrong database, corrupt source)', () => {
  const r = spawnSync('python3', ['-W', 'ignore', '-m', 'unittest', 'test_recovery_point'], { cwd: path.dirname(script), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

// #972 review: root must never write through a name the service account controls. Its home (STAGING_ROOT) is planted with
// symlinks at every path an older deploy.sh wrote as root (.deploy.lock, release.env, current-sha, alert stamps), a
// symlink inside the releases directory pointing at a victim directory, a `current` pointing outside it, and a build that plants
// its release's .complete as a symlink to a file that does not exist yet. A full deploy must leave every victim unchanged
// (and never create the dangling target), keep its own state in the root-only state directory, and refuse a symlinked
// releases directory or state directory before stopping anything.
test('deploy state lives in a root-only directory; planted symlinks in the service home are never written through', async () => {
  const { execFileSync, spawn } = await import('node:child_process')
  const { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } = await import('node:fs')
  const net = await import('node:net')
  const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  const T = mkdtempSync(path.join(tmpdir(), 'staging-symlink-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), victims = path.join(T, 'victims'), state = path.join(T, 'state')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}'); git('add', '-A'); git('commit', '-qm', 'one')
  const sha = git('rev-parse', 'HEAD')
  const env = path.join(T, 'env'); writeFileSync(env, good)
  const served = path.join(T, 'served')
  writeFileSync(path.join(T, 'health.mjs'), `import http from 'node:http'; import fs from 'node:fs'
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {}
  s.end(JSON.stringify({ ok: true, commit: c, checks: {} })) }).listen(${port}, '127.0.0.1')`)
  const server = spawn(process.execPath, [path.join(T, 'health.mjs')], { stdio: 'ignore' })
  const restart = path.join(T, 'restart.sh')
  writeFileSync(restart, `#!/usr/bin/env bash\nbasename "$(readlink -f ${root}/current)" > ${served}\n`); execFileSync('chmod', ['+x', restart])
  const deploy = (extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: String(port),
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: restart,
      STAGING_STOP: 'true', STAGING_MIGRATE: 'true', STAGING_HEALTH_TRIES: '3', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'), STAGING_STATE_ROOT: state,
      PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1',
      // the build (run as the service account) plants its release's .complete as a symlink to a file that does not exist
      STAGING_BUILD: `ln -s ${path.join(victims, 'created-by-root')} ../.complete`, ...extra,
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  try {
    mkdirSync(root, { recursive: true }); mkdirSync(path.join(root + '-releases'), { recursive: true }); mkdirSync(path.join(victims, 'dir'), { recursive: true })
    const names = ['.deploy.lock', 'release.env', 'current-sha', '.alert-low_disk', '.alert-low_disk_for_release']
    for (const n of names) { writeFileSync(path.join(victims, n), `victim ${n}\n`); symlinkSync(path.join(victims, n), path.join(root, n)) }
    writeFileSync(path.join(victims, 'dir', 'keep'), 'victim dir file\n')
    symlinkSync(path.join(victims, 'dir'), path.join(root + '-releases', 'evil'))        // an incomplete-looking "release" that is a symlink
    symlinkSync(path.join(victims, 'dir'), path.join(root, 'current'))                  // `current` outside releases/
    const r = deploy()
    assert.equal(r.code, 0, r.out); assert.match(r.out, /live: [0-9a-f]{40}/)
    for (const n of names) {
      assert.equal(readFileSync(path.join(victims, n), 'utf8'), `victim ${n}\n`, `${n} written through a planted symlink`)
      assert.ok(lstatSync(path.join(root, n)).isSymbolicLink(), `${n} left alone`)
    }
    assert.equal(readFileSync(path.join(victims, 'dir', 'keep'), 'utf8'), 'victim dir file\n', 'the directory behind a planted releases/ symlink is untouched')
    assert.equal(existsSync(path.join(root + '-releases', 'evil')), false, 'a symlink in releases/ is removed, not followed')
    assert.equal(existsSync(path.join(victims, 'created-by-root')), false, 'root never creates a file through a planted .complete symlink')
    const done = lstatSync(path.join(root + '-releases', sha, '.complete'))
    assert.ok(done.isFile() && !done.isSymbolicLink(), '.complete is a fresh regular file')
    assert.equal(path.basename(readlinkSync(path.join(root, 'current'))), sha)
    // the deploy's own state: root-only directory, never in the home
    assert.equal(statSync(state).mode & 0o777, 0o700)
    assert.equal(readFileSync(path.join(state, 'current-sha'), 'utf8').trim(), sha)
    assert.equal(readFileSync(path.join(state, 'release.env'), 'utf8').trim(), `DAZL_COMMIT_SHA=${sha}`)
    assert.ok(existsSync(path.join(state, '.deploy.lock')))
    assert.deepEqual(readdirSync(victims).sort(), [...names, 'dir'].sort(), 'nothing new beside the victims')

    // the same commit again: nothing to do (current-sha read from the state directory, not the planted one)
    const again = deploy(); assert.equal(again.code, 0, again.out); assert.doesNotMatch(again.out, /deploying/)

    // upgrade path: no current-sha in the state directory; the validated complete live release names the deployed commit
    rmSync(path.join(state, 'current-sha'))
    const up = deploy(); assert.equal(up.code, 0, up.out); assert.doesNotMatch(up.out, /deploying/, 'no redeploy after the upgrade')

    // refused before anything is stopped: a symlinked releases directory, a state directory open to others, a symlinked state directory
    const stopLog = path.join(T, 'stopped')
    const keepRels = root + '-releases.kept'; execFileSync('mv', [root + '-releases', keepRels]); symlinkSync(path.join(victims, 'dir'), root + '-releases')
    let x = deploy({ STAGING_STOP: `touch ${stopLog}` })
    assert.equal(x.code, 1); assert.match(x.out, /the releases directory .* is a symlink/); assert.equal(existsSync(stopLog), false)
    rmSync(root + '-releases'); execFileSync('mv', [keepRels, root + '-releases'])
    execFileSync('chmod', ['755', state])
    x = deploy({ STAGING_STOP: `touch ${stopLog}` })
    assert.equal(x.code, 1); assert.match(x.out, /deploy state directory .* is not private/); assert.equal(existsSync(stopLog), false)
    execFileSync('chmod', ['700', state])
    const alt = path.join(T, 'state-link'); symlinkSync(state, alt)
    x = deploy({ STAGING_STOP: `touch ${stopLog}`, STAGING_STATE_ROOT: alt })
    assert.equal(x.code, 1); assert.match(x.out, /deploy state directory .* (is a symlink|is not private)/); assert.equal(existsSync(stopLog), false)
  } finally {
    server.kill()
  }
})

// #908 releases-directory race: releases live in a root-owned directory BESIDE the service home (STAGING_RELEASES,
// default `${STAGING_ROOT}-releases`, mode 750), so the service account cannot rename or replace a release path between
// root's check and its use. Here the build (which runs as the service account) does what that account can still do in its
// own home mid-deploy: it renames the old in-home `releases` directory away and puts a symlink to a victim directory in its
// place, a victim holding a directory named for the release being built plus four complete-looking old "releases". Whether
// the build then fails (root removes the failed release) or succeeds (root prunes old releases), every victim stays. The
// deploy refuses, before stopping anything: a `current` still pointing into the old in-home releases (the upgrade step),
// a releases directory inside the home, writable by others, under a parent others can change, or not a plain directory.
// Release contents are only read, linked or run as the service account.
test('releases race: releases live in a root-owned directory outside the service home; mid-deploy swaps in the home reach nothing', async () => {
  const { execFileSync, spawn } = await import('node:child_process')
  const { existsSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync } = await import('node:fs')
  const net = await import('node:net')
  const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  const T = mkdtempSync(path.join(tmpdir(), 'staging-race-'))
  const root = path.join(T, 'root'), rels = root + '-releases', repo = path.join(T, 'repo'), victims = path.join(T, 'victims'), state = path.join(T, 'state')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  const commit = (n: string) => { writeFileSync(path.join(repo, 'README.md'), n); git('add', '-A'); git('commit', '-qm', n); return git('rev-parse', 'HEAD') }
  const env = path.join(T, 'env'); writeFileSync(env, good)
  const served = path.join(T, 'served')
  writeFileSync(path.join(T, 'health.mjs'), `import http from 'node:http'; import fs from 'node:fs'
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {}
  s.end(JSON.stringify({ ok: true, commit: c, checks: {} })) }).listen(${port}, '127.0.0.1')`)
  const server = spawn(process.execPath, [path.join(T, 'health.mjs')], { stdio: 'ignore' })
  const restart = path.join(T, 'restart.sh')
  writeFileSync(restart, `#!/usr/bin/env bash\nbasename "$(readlink -f ${root}/current)" > ${served}\n`); execFileSync('chmod', ['+x', restart])
  const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
  const stopLog = path.join(T, 'stopped')
  const deploy = (extra: Record<string, string> = {}) => {
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: String(port),
      STAGING_USER: me, STAGING_REPO_URL: `file://${repo}`, STAGING_RESTART: restart,
      STAGING_STOP: `touch ${stopLog}`, STAGING_MIGRATE: 'true', STAGING_BUILD: 'true', STAGING_HEALTH_TRIES: '3', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'),
      STAGING_STATE_ROOT: state, PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1', ...extra,
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  // the victim behind the swapped name: a directory named for the release being built, and four old complete "releases"
  const plantVictims = (sha: string) => {
    rmSync(path.join(victims, 'rels'), { recursive: true, force: true })
    mkdirSync(path.join(victims, 'rels', sha), { recursive: true }); writeFileSync(path.join(victims, 'rels', sha, 'keep'), 'victim\n')
    for (const n of ['o1', 'o2', 'o3', 'o4']) {
      mkdirSync(path.join(victims, 'rels', n), { recursive: true }); writeFileSync(path.join(victims, 'rels', n, '.complete'), '')
      utimesSync(path.join(victims, 'rels', n), new Date(2000, 0, 1), new Date(2000, 0, 1))
    }
  }
  const victimsIntact = (sha: string) => readdirSync(path.join(victims, 'rels')).sort().join() === [sha, 'o1', 'o2', 'o3', 'o4'].sort().join()
    && readFileSync(path.join(victims, 'rels', sha, 'keep'), 'utf8') === 'victim\n'
  // the build, as the service account: swap the in-home name for a symlink to the victim, then succeed or fail
  const swapBuild = (ok: boolean) => `mv ${root}/releases ${root}/releases.moved 2>/dev/null; ln -sfn ${path.join(victims, 'rels')} ${root}/releases; ${ok ? 'true' : 'exit 3'}`
  try {
    mkdirSync(path.join(root, 'releases'), { recursive: true }); mkdirSync(victims)
    // 1. a first deploy creates the releases directory: the deploy user's, mode 750, the service account's group, outside the home
    const s1 = commit('one')
    let r = deploy()
    assert.equal(r.code, 0, r.out); assert.match(r.out, /live: [0-9a-f]{40}/)
    const st = statSync(rels)
    assert.equal(st.mode & 0o777, 0o750); assert.equal(st.uid, process.getuid!())
    assert.equal(st.gid, Number(execFileSync('id', ['-g', me], { encoding: 'utf8' }).trim()))
    assert.equal(readlinkSync(path.join(root, 'current')), path.join(rels, s1))
    assert.deepEqual(readdirSync(path.join(root, 'releases')), [], 'nothing is created in the old in-home releases directory')

    // 2. the build swaps the in-home name mid-deploy, then fails: the failed release is removed from the releases directory only
    const s2 = commit('two'); plantVictims(s2)
    r = deploy({ STAGING_BUILD: swapBuild(false) })
    assert.equal(r.code, 1, r.out); assert.match(r.out, /build or seed of [0-9a-f]{40} failed/)
    assert.ok(victimsIntact(s2), 'the victim behind the swapped in-home name is untouched by the failed-release removal')
    assert.deepEqual(readdirSync(rels), [s1]); assert.equal(readlinkSync(path.join(root, 'current')), path.join(rels, s1))

    // 3. the same swap, and the build succeeds: going live and pruning old releases never reach the victim
    for (const n of ['three', 'four', 'five']) {
      const s = commit(n); plantVictims(s)
      rmSync(path.join(root, 'releases'), { force: true }); rmSync(path.join(root, 'releases.moved'), { recursive: true, force: true }); mkdirSync(path.join(root, 'releases'))
      r = deploy({ STAGING_BUILD: swapBuild(true) })
      assert.equal(r.code, 0, r.out); assert.match(r.out, /live: [0-9a-f]{40}/)
      assert.ok(victimsIntact(s), `the victim is untouched by deploying and pruning (${n})`)
      assert.equal(readlinkSync(path.join(root, 'current')), path.join(rels, s))
    }
    assert.equal(readdirSync(rels).length, 3, 'old releases are pruned in the releases directory: the live one and two before it')

    // 4. refused before anything is stopped
    const refuse = (why: RegExp, extra: Record<string, string> = {}) => {
      rmSync(stopLog, { force: true }); commit(`refuse-${Math.random()}`)
      const x = deploy(extra)
      assert.equal(x.code, 1, x.out); assert.match(x.out, why); assert.equal(existsSync(stopLog), false, `nothing stopped (${why})`)
    }
    // a box upgraded without moving its releases: `current` still points into the old in-home releases directory
    const live = readlinkSync(path.join(root, 'current'))
    mkdirSync(path.join(root, 'releases', 'x'), { recursive: true }); rmSync(path.join(root, 'releases'), { recursive: true }); mkdirSync(path.join(root, 'releases', 'x'), { recursive: true })
    rmSync(path.join(root, 'current')); symlinkSync(path.join(root, 'releases', 'x'), path.join(root, 'current'))
    refuse(/current points into the old in-home releases directory; move the releases to .* first/)
    rmSync(path.join(root, 'current')); symlinkSync('releases/x', path.join(root, 'current'))
    refuse(/current points into the old in-home releases directory/)
    // `current` replaced by a real directory root would write into
    rmSync(path.join(root, 'current')); mkdirSync(path.join(root, 'current'))
    refuse(/current is not a symlink/)
    rmSync(path.join(root, 'current'), { recursive: true }); symlinkSync(live, path.join(root, 'current'))
    // a releases directory inside the service home, or containing it
    refuse(/the releases directory .* is inside the service home/, { STAGING_RELEASES: path.join(root, 'rels') })
    refuse(/the releases directory .* contains the service home/, { STAGING_RELEASES: T })
    // writable by others (group or world), or not a plain directory
    for (const mode of ['770', '757']) {
      execFileSync('chmod', [mode, rels]); refuse(/the releases directory .* is writable by another user/)
    }
    execFileSync('chmod', ['750', rels])
    const loose = path.join(T, 'loose'); mkdirSync(loose); execFileSync('chmod', ['777', loose])
    refuse(/the releases directory's parent .* can be changed by another user/, { STAGING_RELEASES: path.join(loose, 'rels') })
    assert.equal(existsSync(path.join(loose, 'rels')), false, 'not created under a parent others can change')
    const notDir = path.join(T, 'not-a-dir'); writeFileSync(notDir, '')
    refuse(/the releases directory .* is not a plain directory/, { STAGING_RELEASES: notDir })
    // a sticky world-writable parent owned by root (like /tmp) is fine: that is where this test's own directories live
    assert.ok((statSync(tmpdir()).mode & 0o1000) !== 0 || statSync(tmpdir()).uid === process.getuid!())
  } finally {
    server.kill()
  }
})

test('releases race: inside a release, root only deletes whole releases; reading, linking and running its files is the service account\'s', () => {
  const src = readFileSync(script, 'utf8')
  // every command that reads, links or runs a release's contents goes through `as` (the service account)
  for (const re of [/\bdu -sb\b[^\n]*"\$live\/web/g, /\bcp -al "\$live\/web\/node_modules"/g, /\bnode "\$smoke"/g, /\bnode "\$rel\/ops\/release-manifest\.mjs"/g]) {
    const hits = [...src.matchAll(re)]
    assert.ok(hits.length > 0, String(re))
    for (const h of hits) assert.match(src.slice(Math.max(0, h.index! - 3), h.index!), /as $/, `not run as the service account: ${h[0]}`)
  }
  // and no path under the service home's old releases directory is ever used as a release path
  assert.doesNotMatch(src.replace(/"\$ROOT\/releases\/"\*\|releases\/\*\)/, ''), /\$ROOT\/releases/)
})
