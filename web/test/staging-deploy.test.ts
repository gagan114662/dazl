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
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {} s.end(JSON.stringify({ ok: true, commit: c })) }).listen(${port}, '127.0.0.1')`)
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
      STAGING_BUILD: 'true', STAGING_HEALTH_TRIES: '2', PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1',
    } as unknown as NodeJS.ProcessEnv })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const current = () => existsSync(path.join(root, 'current')) ? path.basename(readlinkSync(path.join(root, 'current'))) : null
  const releaseEnv = () => existsSync(path.join(root, 'release.env')) ? readFileSync(path.join(root, 'release.env'), 'utf8').trim() : null
  const releases = () => readdirSync(path.join(root, 'releases')).sort()
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
    assert.equal(r.code, 1); assert.match(r.out, /never reported commit/); assert.match(r.out, /is live again/)
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
