// #836: ops/staging/deploy.sh and the staging scan worker (ops/staging/dazl-staging-worker.service). The real deploy
// script runs here with its DEFAULT stop and restart commands against a stand-in systemctl (STAGING_SYSTEMCTL) that
// records every call, so what is asserted is the order the script itself issues: the worker is stopped, by name, before
// the app is stopped for the recovery point; it never runs across the cutover; it is started after the app when
// enabled; and a box without the unit sees exactly the two commands it saw before.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../ops/staging/deploy.sh', import.meta.url))
const unit = readFileSync(new URL('../../ops/staging/dazl-staging-worker.service', import.meta.url), 'utf8')
const example = readFileSync(new URL('../../ops/staging/env.example', import.meta.url), 'utf8')

test('#836 the worker unit: the app\'s release, env file and user; the real worker script; stopped and restarted with the app; a memory limit; no port', () => {
  const app = readFileSync(new URL('../../ops/staging/dazl-staging.service', import.meta.url), 'utf8')
  for (const key of ['User', 'WorkingDirectory', 'EnvironmentFile']) {
    const of = (s: string) => s.split('\n').filter(l => l.startsWith(key + '=')).sort()
    assert.deepEqual(of(unit), of(app), `${key} is the app's`)
  }
  const exec = unit.split('\n').find(l => l.startsWith('ExecStart='))!
  assert.match(exec, /^ExecStart=\/usr\/bin\/node --experimental-strip-types --no-warnings --max-old-space-size=\d+ scripts\/scan-worker\.mts$/)
  assert.ok(existsSync(new URL('../scripts/scan-worker.mts', import.meta.url)), 'the script the unit starts exists in the release')
  assert.match(unit, /^PartOf=dazl-staging\.service$/m)
  assert.match(unit, /^WantedBy=dazl-staging\.service$/m)
  assert.match(unit, /^MemoryMax=\d+M$/m)
  assert.match(unit, /^SuccessExitStatus=143$/m, 'the worker\'s SIGTERM exit is a normal stop, so Restart=on-failure does not fight a stop')
  assert.doesNotMatch(unit, /next start|-p \d+/)
})

test('#836 deploy.sh with its default stop and restart: the worker is stopped by name before the recovery point and started after the app; not installed, nothing about it runs', async () => {
  const port = await new Promise<number>(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  const T = mkdtempSync(path.join(tmpdir(), 'staging-worker-'))
  const root = path.join(T, 'root'), repo = path.join(T, 'repo'), calls = path.join(T, 'calls'), served = path.join(T, 'served')
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_CONFIG_'))) as NodeJS.ProcessEnv
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv }).trim()
  mkdirSync(path.join(repo, 'web'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv })
  writeFileSync(path.join(repo, 'web', 'package-lock.json'), '{}')
  const commit = (n: string) => { writeFileSync(path.join(repo, 'README.md'), n); git('add', '-A'); git('commit', '-qm', n); return git('rev-parse', 'HEAD') }
  const prodDir = path.join(T, 'prod-data'); mkdirSync(prodDir); const prodDb = path.join(prodDir, 'app.db'); writeFileSync(prodDb, 'production')
  const stagingDir = path.join(T, 'staging-data'); mkdirSync(stagingDir)
  const env = path.join(T, 'env')
  writeFileSync(env, example.replace('DAZL_MASTER_KEY=', 'DAZL_MASTER_KEY=AAAA').replace('STRIPE_SECRET_KEY=sk_test_', 'STRIPE_SECRET_KEY=sk_test_abc').replace('DB_PATH=/var/lib/dazl-staging/app.db', `DB_PATH=${stagingDir}/app.db`))
  writeFileSync(path.join(T, 'health.mjs'), `import http from 'node:http'; import fs from 'node:fs'
http.createServer((q, s) => { let c = ''; try { c = fs.readFileSync(${JSON.stringify(served)}, 'utf8').trim() } catch {}
  s.end(JSON.stringify({ ok: true, commit: c, checks: { sqlite: { ok: true } } })) }).listen(${port}, '127.0.0.1')`)
  const server = spawn(process.execPath, [path.join(T, 'health.mjs')], { stdio: 'ignore' })
  // systemctl: records each call; the worker unit exists when T/installed does, is enabled when T/enabled does, and its
  // start or stop fails when T/fail-start or T/fail-stop does. Restarting the app serves the release `current` names.
  const systemctl = path.join(T, 'systemctl')
  writeFileSync(systemctl, `#!/usr/bin/env bash
echo "$*" >> ${calls}
W=dazl-staging-worker.service
case "$1 $2 $3" in
  "cat $W "*) [ -e ${T}/installed ];;
  "is-enabled --quiet $W") [ -e ${T}/enabled ];;
  "is-active $W "*) if [ -e ${T}/worker-up ]; then echo active; else echo inactive; exit 3; fi;;
  "stop $W "*) [ -e ${T}/fail-stop ] && exit 1; rm -f ${T}/worker-up;;
  "start $W "*) [ -e ${T}/fail-start ] && exit 1; touch ${T}/worker-up;;
  "stop dazl-staging.service "*) [ -e ${T}/worker-up ] && echo "APP STOPPED WITH THE WORKER RUNNING" >> ${calls}; echo stopped > ${served};;
  "restart dazl-staging.service "*) [ -e ${T}/worker-up ] && echo "APP RESTARTED WITH THE WORKER RUNNING" >> ${calls}; basename "$(readlink -f ${root}/current)" > ${served};;
  *) echo "unexpected: $*" >> ${calls}; exit 1;;
esac\n`)
  execFileSync('chmod', ['+x', systemctl])
  // the real recovery helper, from a directory only this user can write (deploy.sh refuses a looser one; a checkout
  // made under a group-writable umask is one)
  const helperDir = path.join(T, 'helper'); mkdirSync(helperDir, { mode: 0o755 }); execFileSync('chmod', ['755', helperDir])
  const helper = path.join(helperDir, 'recovery_point.py')
  writeFileSync(helper, readFileSync(new URL('../../ops/staging/recovery_point.py', import.meta.url))); execFileSync('chmod', ['755', helper])
  const flag = (name: string, on: boolean) => { if (on) writeFileSync(path.join(T, name), ''); else rmSync(path.join(T, name), { force: true }) }
  const deploy = () => {
    writeFileSync(calls, '')
    const r = spawnSync('bash', [script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STAGING_ROOT: root, STAGING_ENV_FILE: env, STAGING_PORT: String(port), STAGING_SYSTEMCTL: systemctl, STAGING_RECOVERY: helper,
      STAGING_USER: execFileSync('id', ['-un'], { encoding: 'utf8' }).trim(), STAGING_REPO_URL: `file://${repo}`,
      STAGING_MIGRATE: 'true', STAGING_BUILD: 'true', STAGING_HEALTH_TRIES: '2', STAGING_RECOVERY_ROOT: path.join(T, 'recovery'), STAGING_STATE_ROOT: path.join(T, 'state'), PROD_DB_PATH: prodDb, MIN_FREE_BYTES: '1', FIRST_RELEASE_BYTES: '1',
    } as unknown as NodeJS.ProcessEnv })
    // the calls that change something, in order (the reads: cat, is-enabled, is-active, are left out)
    const order = readFileSync(calls, 'utf8').trim().split('\n').filter(l => !/^(cat|is-enabled|is-active) /.test(l))
    return { code: r.status, out: r.stdout + r.stderr, order }
  }
  const W = 'dazl-staging-worker.service', A = 'dazl-staging.service'
  try {
    mkdirSync(root)
    // no worker unit on the box: exactly the two commands the script issued before, and no word about a worker
    commit('one')
    let r = deploy()
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.order, [`stop ${A}`, `restart ${A}`])
    assert.doesNotMatch(r.out, /scan worker/)

    // installed, enabled and running: stopped by name before the app is stopped for the recovery point, still stopped
    // across the cutover, started after the app
    flag('installed', true); flag('enabled', true); flag('worker-up', true)
    const s2 = commit('two')
    r = deploy()
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.order, [`stop ${W}`, `stop ${A}`, `stop ${W}`, `restart ${A}`, `start ${W}`])
    assert.match(r.out, new RegExp(`live: ${s2}`))
    assert.match(r.out, /scan worker: active \(dazl-staging-worker\.service\)/)
    assert.ok(existsSync(path.join(T, 'worker-up')), 'the worker runs again on the new release')

    // the worker does not start: reported as an alert, the deploy stands (the app runs every scan itself)
    flag('fail-start', true)
    const s3 = commit('three')
    r = deploy()
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /ALERT scan worker dazl-staging-worker\.service did not start/)
    assert.match(r.out, /ALERT scan worker: inactive \(dazl-staging-worker\.service is enabled but not running/)
    assert.match(r.out, new RegExp(`live: ${s3}`))
    flag('fail-start', false)

    // installed but not enabled (the operator switched it off): stopped with the app, not started
    flag('enabled', false); flag('worker-up', true)
    commit('four')
    r = deploy()
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(r.order, [`stop ${W}`, `stop ${A}`, `stop ${W}`, `restart ${A}`])
    assert.match(r.out, /scan worker: inactive \(dazl-staging-worker\.service is installed but not enabled\)/)

    // the worker cannot be stopped: nothing is migrated (no recovery point is taken while something may still write)
    flag('enabled', true); flag('worker-up', true); flag('fail-stop', true)
    const before = readFileSync(served, 'utf8').trim()
    commit('five')
    r = deploy()
    assert.equal(r.code, 1)
    assert.match(r.out, /could not stop the service for a recovery point; nothing migrated/)
    assert.equal(r.order[0], `stop ${W}`)
    assert.ok(!r.order.includes(`stop ${A}`), 'the app is not stopped once the worker stop failed')
    assert.equal(readFileSync(path.join(T, 'state', 'current-sha'), 'utf8').trim(), before, 'the live release is unchanged')
    assert.doesNotMatch(readFileSync(calls, 'utf8'), /WITH THE WORKER RUNNING|unexpected/)
  } finally { server.kill(); rmSync(T, { recursive: true, force: true }) }
})
