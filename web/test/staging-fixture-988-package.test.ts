// #988 operator package (ops/staging/fixture-988/): the shipped copies are byte-identical to the reviewed sources, SHA256SUMS matches them, and the host script is bound to the installed layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const pkg = (p: string) => readFileSync(`${root}ops/staging/fixture-988/${p}`)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const PAIRS: [string, string][] = [['scripts/staging-fixture-988.mts', 'web/scripts/staging-fixture-988.mts'], ['scripts/staging-fixture-988-checks.mts', 'web/scripts/staging-fixture-988-checks.mts'], ['lib/staging.ts', 'web/lib/staging.ts']]

test('#988 package: every shipped file is byte-identical to its reviewed source (no drift), and SHA256SUMS lists exactly them', () => {
  for (const [a, b] of PAIRS) assert.equal(sha(pkg(a)), sha(readFileSync(root + b)), `${a} == ${b}`)
  const sums = new Map(pkg('SHA256SUMS').toString().trim().split('\n').map(l => { const [h, f] = l.split(/\s+/); return [f, h] as const }))
  assert.deepEqual([...sums.keys()].sort(), PAIRS.map(p => p[0]).sort())
  for (const [f, h] of sums) assert.equal(sha(pkg(f)), h, `${f} matches SHA256SUMS`)
  assert.ok(!existsSync(`${root}ops/staging/fixture-988.sh`), 'the superseded wrapper (wrong lock, assumed git checkout) is gone')
})
test('#988 package: lib/staging.ts is self-contained (the package ships no web/ tree, so it must import nothing)', () => {
  assert.doesNotMatch(pkg('lib/staging.ts').toString(), /^import /m)
  for (const f of ['scripts/staging-fixture-988.mts', 'scripts/staging-fixture-988-checks.mts']) for (const m of pkg(f).toString().matchAll(/from '(\.[^']+)'/g)) assert.match(m[1], /^\.\/staging-fixture-988\.mts$|^\.\.\/lib\/staging\.ts$/, `${f} imports only package files`)
})
test('#988 package: the host script is bound to the installed layout, asserts the real service, and never writes into the release', () => {
  const s = pkg('fixture-988.sh').toString()
  assert.equal(spawnSync('bash', ['-n', `${root}ops/staging/fixture-988/fixture-988.sh`]).status, 0, 'bash -n')
  for (const needle of ['LOCK=/srv/dazl-staging/.deploy.lock', 'CURRENT=/srv/dazl-staging/current', 'RELEASE_ENV=/srv/dazl-staging/release.env', 'EXPECT_BUILD=${FIXTURE_EXPECT_BUILD:-}', 'EXPECT_INSTANCE=${FIXTURE_EXPECT_INSTANCE:-}', 'STAGING_DB=/var/lib/dazl-staging/app.db', 'SERVICE=dazl-staging.service', 'sha256sum --check', '--preserve-symlinks --preserve-symlinks-main', '/proc/$pid/environ', 'install -d -m 0700 -o "$RUN_AS" -g "$RUN_AS" "$OUT_ROOT"', 'flock -n 9'])
    assert.ok(s.includes(needle), needle)
  assert.doesNotMatch(s, /var\/lib\/dazl-staging-deploy\/\.deploy\.lock/, 'not the wrong lock'); assert.doesNotMatch(s, /\$ROOT\/web|git -C/, 'no source-checkout assumption')
  const code = s.replace(/^\s*#.*$/gm, '').replace(/ #[^\n"']*$/gm, '').replace(/"(\\.|[^"\\])*"/g, '""')   // comments and message strings removed: what is left is what executes
  assert.doesNotMatch(code, /\bkill|pkill|killall|-9\b|rm -rf|systemctl kill/, 'no hard kill, no broad cleanup')
  assert.doesNotMatch(s, /(>|>>|tee|cp|mv|rm|ln -s\S* \S+) +"?\$REL\b|\$CURRENT"? *(>|=\$)/, 'nothing is written into the release or current')
  // preflight is read-only: everything that stops, locks or creates durable state sits after the preflight exit
  const afterPre = s.slice(s.indexOf('if [ "$MODE" = preflight ]; then\n  note "WOULD DO'))
  const beforePre = s.slice(0, s.indexOf('if [ "$MODE" = preflight ]; then\n  note "WOULD DO'))
  for (const w of ['systemctl stop', 'systemctl start', 'flock -n 9', 'exec 9>>']) { assert.ok(!beforePre.includes(w) || /note "WOULD DO|^#/m.test(w), w); }
  assert.ok(!/systemctl (stop|start|restart)/.test(beforePre.replace(/#.*$/gm, '').replace(/note "[^"]*"/g, '')), 'no stop/start before the preflight exit')
  assert.ok(afterPre.includes('trap finish EXIT') && (code.match(/systemctl start/g) ?? []).length === 1, 'exactly one start, in the exit handler')
  assert.ok(!/(until|while) .*systemctl start/.test(s), 'no retry loop around start')
})
test('#988 package: running the script without root, or from a mode it does not know, refuses before touching anything', () => {
  const run = (...a: string[]) => spawnSync('bash', [`${root}ops/staging/fixture-988/fixture-988.sh`, ...a], { encoding: 'utf8', env: { ...process.env, FIXTURE_EXPECT_BUILD: 'c17bcb2af431e642c6be6452a5cab2f1ddc6810e', FIXTURE_EXPECT_INSTANCE: '6517513f7b26' } })
  assert.equal(run().status, 2); assert.equal(run('nonsense').status, 2)
  if (process.getuid && process.getuid() !== 0) { const r = run('preflight'); assert.equal(r.status, 3); assert.match(r.stderr, /run as root/) }
})

// ---- operator-package safety gaps found in review: the stop must be CONFIRMED, and a failed data check must never restart the service ----
const SCRIPT = fileURLToPath(new URL('../../ops/staging/fixture-988/fixture-988.sh', import.meta.url))
const bash = (cmd: string) => spawnSync('bash', ['-c', `FIXTURE_988_SOURCE_ONLY=1 source "${SCRIPT}"; ${cmd}`], { encoding: 'utf8' })
test('#988 package: stop_confirmed needs inactive/dead, no main pid, no control pid, no pending job, and a cgroup that was READ and is empty; an unreadable cgroup or a pending job never passes', () => {
  const sc = (...a: string[]) => bash(`stop_confirmed ${a.map(v => `'${v}'`).join(' ')}`).status === 0
  assert.equal(sc('inactive', 'dead', '0', '0', '', 'ok', ''), true); assert.equal(sc('inactive', 'dead', '0', '0', '0', 'ok', ''), true, 'Job=0 is no job')
  for (const a of [['active', 'running', '123', '0', '', 'ok', ''], ['deactivating', 'stop-sigterm', '0', '0', '', 'ok', ''], ['deactivating', 'dead', '0', '0', '', 'ok', ''], ['failed', 'failed', '0', '0', '', 'ok', ''],
    ['inactive', 'dead', '0', '0', '', 'ok', '4242'], ['inactive', 'dead', '77', '0', '', 'ok', ''], ['inactive', 'dead', '0', '88', '', 'ok', ''], ['inactive', 'dead', '0', '0', '1234', 'ok', ''], ['inactive', 'dead', '0', '0', 'listed', 'ok', ''],
    ['inactive', 'dead', '0', '0', '', 'unreadable', ''], ['inactive', 'dead', '0', '0', '', '', ''], ['inactive', 'dead', '0', '0', '', 'error', ''], ['', '', '', '', '', '', ''], ['inactive', '', '0', '0', '', 'ok', ''], ['activating', 'start', '0', '0', '', 'ok', '']])
    assert.equal(sc(...a), false, `${JSON.stringify(a)} is not stopped`)
})
test('#988 package: restart_proven needs EVERY proof: running as a new process, a new instance, local health + readiness, public HTTPS health with the same commit and instance, the staging banner, staging environment, the same release and database', () => {
  const GOOD: Record<string, string> = { R_ACTIVE: 'active', R_SUB: 'running', R_MAINPID: '555', R_OLD_MAINPID: '111', R_CONTROLPID: '0', R_JOB: '', R_BUILD: 'c17b', R_LOCAL_OK: '1', R_LOCAL_COMMIT: 'c17b', R_READY_OK: '1', R_READY_COMMIT: 'c17b',
    R_PUBLIC_OK: '1', R_PUBLIC_COMMIT: 'c17b', R_PUBLIC_INSTANCE: 'bbbbbbbbbbbb', R_INSTANCE: 'bbbbbbbbbbbb', R_OLD_INSTANCE: 'aaaaaaaaaaaa', R_BANNER: '1', R_ENV_STAGING: '1', R_GMAIL_OFF: '1', R_SAME_RELEASE: '1', R_SAME_DB: '1' }
  const proven = (over: Record<string, string>) => bash(Object.entries({ ...GOOD, ...over }).map(([k, v]) => `${k}='${v}'`).join('; ') + '; restart_proven').status === 0
  assert.equal(proven({}), true)
  for (const [k, v] of [['R_ACTIVE', 'activating'], ['R_SUB', 'start'], ['R_MAINPID', '0'], ['R_MAINPID', '111'], ['R_CONTROLPID', '9'], ['R_JOB', '55'], ['R_LOCAL_OK', '0'], ['R_LOCAL_COMMIT', 'old'], ['R_READY_OK', '0'], ['R_READY_COMMIT', 'old'],
    ['R_PUBLIC_OK', '0'], ['R_PUBLIC_COMMIT', 'old'], ['R_PUBLIC_INSTANCE', 'cccccccccccc'], ['R_INSTANCE', 'aaaaaaaaaaaa'], ['R_BANNER', '0'], ['R_ENV_STAGING', '0'], ['R_GMAIL_OFF', '0'], ['R_SAME_RELEASE', '0'], ['R_SAME_DB', '0']])
    assert.equal(proven({ [k]: v }), false, `${k}=${v}`)
  assert.equal(bash('restart_proven').status === 0, false, 'with nothing set, nothing is proven')
})
test('#988 package: jfield returns the FIRST (top-level) field, so a nested passing check can never make a failing health look ok', () => {
  const body = '{"ok":false,"commit":"c17b","instance":"6517513f7b26","db":"sqlite","checks":{"sqlite":{"ok":false,"ms":0},"postgres":{"ok":true,"skipped":"not_configured"}}}'
  const r = bash(`h='${body}'; echo "$(jfield ok "$h")|$(jfield commit "$h")|$(jfield instance "$h")"`); assert.equal(r.stdout.trim(), 'false|c17b|6517513f7b26')
})
test('#988 package: should_start restarts only to restore a known-good state; a failed or unverified data check, or an unconfirmed stop, never restarts', () => {
  const ss = (stop: number, touched: number, verified: number) => bash(`should_start ${stop} ${touched} ${verified}`).status === 0
  assert.equal(ss(1, 1, 1), true, 'every check passed: start')
  assert.equal(ss(1, 0, 0), true, 'stopped and the database was never handed to the tool: start restores the original state')
  assert.equal(ss(1, 1, 0), false, 'the data check failed or is unverified: stay stopped')
  for (const touched of [0, 1]) for (const verified of [0, 1]) assert.equal(ss(0, touched, verified), false, `stop not confirmed (touched=${touched} verified=${verified}): never start`)
})
test('#988 package: the script wires those decisions in, and every failure path after the database is handed over leaves VERIFIED=0', () => {
  const s = readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '').replace(/ #[^\n"']*$/gm, '')   // executable lines only
  assert.ok(s.includes('if should_start "$STOP_OK" "$DB_TOUCHED" "$VERIFIED"; then'), 'the exit handler asks should_start')
  assert.ok(s.includes('stop_confirmed "$(sv ActiveState)" "$(sv SubState)" "$(sv MainPID)" "$(sv ControlPID)" "$JOBS" "$CGS" "$CGP"'), 'continues only after the stop is confirmed from systemd')
  assert.equal((s.match(/VERIFIED=1/g) ?? []).length, 1, 'VERIFIED is set in exactly one place, after the last check')
  assert.ok(s.indexOf('STOP_OK=1') < s.indexOf('DB_TOUCHED=1') && s.indexOf('DB_TOUCHED=1') < s.indexOf('VERIFIED=1'))
  assert.ok(/LEFT STOPPED ON PURPOSE/.test(s), 'a deliberate stop is announced')
  assert.doesNotMatch(s.replace(/#.*$/gm, '').replace(/"(\\.|[^"\\])*"/g, '""'), /systemctl is-active/, 'no inferring a stop from is-active')
})

test('#988 package: the release under test is an explicit input: no baked-in build, and a missing or malformed build or instance refuses before anything else', () => {
  const s = readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '')
  assert.doesNotMatch(s, /\b[0-9a-f]{40}\b/, 'no commit baked into the executable lines'); assert.doesNotMatch(s, /EXPECT_INSTANCE=[0-9a-f]{12}/)
  const run = (env: Record<string, string | undefined>) => spawnSync('bash', [SCRIPT, 'preflight'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv })
  for (const env of [{}, { FIXTURE_EXPECT_BUILD: 'abc', FIXTURE_EXPECT_INSTANCE: '6517513f7b26' }, { FIXTURE_EXPECT_BUILD: 'c17bcb2af431e642c6be6452a5cab2f1ddc6810e' }, { FIXTURE_EXPECT_BUILD: 'c17bcb2af431e642c6be6452a5cab2f1ddc6810e', FIXTURE_EXPECT_INSTANCE: 'xyz' }]) {
    const r = run(env); assert.equal(r.status, 3, JSON.stringify(env)); assert.match(r.stderr, /FIXTURE_EXPECT_/)
  }
  const r = run({ FIXTURE_EXPECT_BUILD: 'c17bcb2af431e642c6be6452a5cab2f1ddc6810e', FIXTURE_EXPECT_INSTANCE: '6517513f7b26' }); if (process.getuid && process.getuid() !== 0) assert.match(r.stderr, /run as root/)
})

test('#988 package: the wrapper uses the installed release.env, re-asserts everything under the lock, and keeps its instructions honest about the guarded restart', () => {
  const raw = readFileSync(SCRIPT, 'utf8'), s = raw.replace(/^\s*#.*$/gm, '').replace(/ #[^\n"']*$/gm, '')
  assert.ok(!raw.includes('/var/lib/dazl-staging-deploy/release.env'), 'not the repository-default path'); assert.ok(s.includes('RELEASE_ENV=/srv/dazl-staging/release.env') && s.includes('service does not read $RELEASE_ENV'))
  assert.ok(s.indexOf('flock -n 9') < s.indexOf('assert_state locked') && s.indexOf('assert_state locked') < s.indexOf('timeout "$STOP_WAIT" systemctl stop'), 'lock, then re-assert, then stop')
  assert.ok(s.includes('assert_state preflight') && s.includes('changed between the preflight and the lock'), 'preflight and locked facts are compared')
  for (const check of ['instance', 'MAINPID', 'RELENV_ID', 'LOCK_ID', 'S_ID', 'REL']) assert.ok(s.includes(`$${check}`) || s.includes(`${check}=`), check)
  assert.ok(s.includes('find "$dir" -name cgroup.procs') && s.includes('echo unreadable'), 'the whole cgroup tree is read; a failed read is unreadable')
  assert.ok(s.includes('sv ControlPID') && s.includes('list_jobs_unit') && s.includes('echo error'), 'control pid and pending jobs are checked, and a failed job listing is an error')
  for (const url of ['$LOCAL/api/health', '$LOCAL/api/ready', '$PUBLIC/api/health', '$PUBLIC/']) assert.ok(s.includes(url), url)
  assert.ok(s.includes("PUBLIC=https://staging.dazl.ai") && s.includes("BANNER='Staging - test data'"))
  // the instructions do not promise an unconditional restart
  assert.ok(/GUARDED RESTART/.test(raw) && /LEFT STOPPED ON PURPOSE/.test(raw)); assert.doesNotMatch(raw, /ALWAYS (systemctl )?start/i)
})
