// #988 operator package (ops/staging/fixture-988/): the shipped copies are byte-identical to the reviewed sources, SHA256SUMS matches them, and the host script is bound to the installed layout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    R_PUBLIC_OK: '1', R_PUBLIC_COMMIT: 'c17b', R_PUBLIC_INSTANCE: 'bbbbbbbbbbbb', R_INSTANCE: 'bbbbbbbbbbbb', R_OLD_INSTANCE: 'aaaaaaaaaaaa', R_BANNER: '1', R_DB_BOUND: '1', R_ENV_STAGING: '1', R_GMAIL_OFF: '1', R_SAME_RELEASE: '1', R_SAME_DB: '1' }
  const proven = (over: Record<string, string>) => bash(Object.entries({ ...GOOD, ...over }).map(([k, v]) => `${k}='${v}'`).join('; ') + '; restart_proven').status === 0
  assert.equal(proven({}), true)
  for (const [k, v] of [['R_ACTIVE', 'activating'], ['R_SUB', 'start'], ['R_MAINPID', '0'], ['R_MAINPID', '111'], ['R_CONTROLPID', '9'], ['R_JOB', '55'], ['R_LOCAL_OK', '0'], ['R_LOCAL_COMMIT', 'old'], ['R_READY_OK', '0'], ['R_READY_COMMIT', 'old'],
    ['R_PUBLIC_OK', '0'], ['R_PUBLIC_COMMIT', 'old'], ['R_PUBLIC_INSTANCE', 'cccccccccccc'], ['R_INSTANCE', 'aaaaaaaaaaaa'], ['R_BANNER', '0'], ['R_DB_BOUND', '0'], ['R_ENV_STAGING', '0'], ['R_GMAIL_OFF', '0'], ['R_SAME_RELEASE', '0'], ['R_SAME_DB', '0']])
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

// ---- round 9: the actual shell wiring for pending jobs and open files, with stubbed systemctl / fuser ----
test('#988 package: Job=0 with a FAILED job listing is not "no job": the real wiring (pending_job_value -> stop_confirmed) refuses', () => {
  const run = (stub: string) => bash(`${stub}; v=$(pending_job_value); echo "[$v]"; stop_confirmed inactive dead 0 0 "$v" ok ''; echo "rc=$?"`).stdout.trim().split('\n')
  // Job property says 0, but `systemctl list-jobs` fails: must be an error result, never accepted
  assert.deepEqual(run('systemctl() { case "$1" in show) echo 0;; list-jobs) echo "Failed to connect" >&2; return 1;; esac; }'), ['[listed]', 'rc=1'])
  assert.deepEqual(run('systemctl() { case "$1" in show) echo "";; list-jobs) return 1;; esac; }'), ['[listed]', 'rc=1'], 'empty Job + failed listing')
  assert.deepEqual(run('systemctl() { case "$1" in show) return 1;; list-jobs) return 0;; esac; }'), ['[error]', 'rc=1'], 'a failed property read')
  assert.deepEqual(run('systemctl() { case "$1" in show) echo 0;; list-jobs) echo "123 dazl-staging.service stop running"; return 0;; esac; }'), ['[listed]', 'rc=1'], 'the manager lists a job for the unit')
  assert.deepEqual(run('systemctl() { case "$1" in show) echo 77;; list-jobs) return 0;; esac; }'), ['[77]', 'rc=1'], 'the unit reports a job id')
  // and the clean case still passes: Job=0 and a SUCCESSFUL empty listing
  assert.deepEqual(run('systemctl() { case "$1" in show) echo 0;; list-jobs) return 0;; esac; }'), ['[0]', 'rc=0'])
  assert.deepEqual(run('systemctl() { case "$1" in show) echo "";; list-jobs) echo "other.service start";  return 0;; esac; }'), ['[]', 'rc=0'], 'another unit\'s job is not this unit\'s')
})
test('#988 package: open-file inspection: only fuser\'s known no-match (exit 1, no output) means "none"; a missing tool, permission or inspection failure, any other exit code or any message is UNKNOWN and refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx988-fuser-')); const f = join(dir, 'app.db'); writeFileSync(f, 'x')
  try {
    const hs = (rc: string, out: string) => bash(`holders_state '${rc}' '${out}'`).stdout.trim()
    assert.equal(hs('0', '/x: 1234'), 'open'); assert.equal(hs('1', ''), 'none')
    for (const [rc, out] of [['1', 'Cannot open /proc/1/fd: Permission denied'], ['1', 'Specified filename /x does not exist.'], ['2', ''], ['127', ''], ['126', ''], ['', ''], ['137', '']]) assert.equal(hs(rc, out), 'unknown', `${rc} ${out}`)
    const clear = (stub: string) => bash(`${stub}; file_holders_clear '${f}' '${f}-wal'; echo "rc=$?"`).stdout.trim().split('\n').pop()
    assert.equal(clear('fuser() { return 1; }'), 'rc=0', 'no match, no output: clear')
    assert.equal(clear('fuser() { echo 1234; return 0; }'), 'rc=1', 'a holder: refuse')
    assert.equal(clear('fuser() { echo "Cannot stat file: Permission denied" >&2; return 1; }'), 'rc=1', 'exit 1 WITH a message is an inspection failure')
    assert.equal(clear('fuser() { return 2; }'), 'rc=1'); assert.equal(clear('fuser() { return 127; }'), 'rc=1')
    assert.equal(bash(`PATH=/nonexistent; file_holders_clear '${f}'; echo "rc=$?"`).stdout.trim().split('\n').pop(), 'rc=1', 'no fuser at all: refuse')
    assert.equal(clear('fuser() { [ "$2" = "' + f + '" ] && return 1; echo oops; return 1; }'), 'rc=0', 'only existing files are inspected (-wal does not exist)')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('#988 package: the main flow uses those functions (no raw fuser -s, no ad-hoc job check)', () => {
  const s = readFileSync(SCRIPT, 'utf8').replace(/^\s*#.*$/gm, '')
  assert.ok(s.includes('JOBS=$(pending_job_value)') && s.includes('file_holders_clear "$STAGING_DB" "$STAGING_DB-wal" "$STAGING_DB-shm"'))
  assert.doesNotMatch(s, /fuser -s/); assert.doesNotMatch(s, /JOBS="\$\{JOBS:-listed\}"/); assert.ok(s.includes('command -v fuser'), 'preflight requires the tool')
})

// ---- round 10: the app must actually use the database being checked ----
test('#988 package: db_binding_ok needs the running process\'s effective DB_PATH to equal the staging path, canonicalise to it, and be the same file; anything else is not the database being checked', () => {
  const ok = (...a: string[]) => bash(`db_binding_ok ${a.map(v => `'${v}'`).join(' ')}`).status === 0
  const P = '/var/lib/dazl-staging/app.db', ID = '2049:12345'
  assert.equal(ok(P, P, ID, P, ID), true)
  for (const a of [['', '', '', P, ID], ['conflict', P, ID, P, ID], ['/var/lib/dazl/app.db', '/var/lib/dazl/app.db', ID, P, ID], [P, '/var/lib/other/app.db', ID, P, ID], [P, '', ID, P, ID], [P, P, '', P, ID], [P, P, '2049:999', P, ID], ['/tmp/../var/lib/dazl-staging/app.db', P, ID, P, ID], [P + '/', P, ID, P, ID]])
    assert.equal(ok(...a), false, JSON.stringify(a))
})
test('#988 package: the effective DB_PATH is read from the process environment: a single value is returned, an override that differs is a conflict, an absent or unreadable one is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fx988-env-'))
  try {
    const env = (name: string, ...vars: string[]) => { const f = join(dir, name); writeFileSync(f, vars.join('\0') + '\0'); return f }
    const read = (f: string) => bash(`effective_db_from_environ '${f}'`).stdout.trim()
    assert.equal(read(env('a', 'PATH=/bin', 'DB_PATH=/var/lib/dazl-staging/app.db', 'X=1')), '/var/lib/dazl-staging/app.db')
    assert.equal(read(env('b', 'DB_PATH=/var/lib/dazl-staging/app.db', 'DB_PATH=/var/lib/dazl-staging/app.db')), '/var/lib/dazl-staging/app.db', 'the same value twice is not a conflict')
    assert.equal(read(env('c', 'DB_PATH=/var/lib/dazl-staging/app.db', 'DB_PATH=/var/lib/dazl/app.db')), 'conflict', 'release.env overriding the env file with another path')
    assert.equal(read(env('d', 'PATH=/bin')), '', 'absent'); assert.equal(read(join(dir, 'missing')), '', 'unreadable')
    assert.equal(read(env('e', 'XDB_PATH=/var/lib/dazl/app.db', 'MY_DB_PATH=/x')), '', 'only the exact variable counts')
    // the wiring: an effective path that is not the staging database is refused whatever the files say
    const wired = (f: string) => bash(`E=$(effective_db_from_environ '${f}'); db_binding_ok "$E" "$E" '2049:1' '/var/lib/dazl-staging/app.db' '2049:1'; echo rc=$?`).stdout.trim()
    assert.equal(wired(env('f', 'DB_PATH=/var/lib/dazl-staging/app.db')), 'rc=0'); assert.equal(wired(env('g', 'DB_PATH=/var/lib/dazl/app.db')), 'rc=1'); assert.equal(wired(env('h', 'PATH=/bin')), 'rc=1'); assert.equal(wired(env('i', 'DB_PATH=/a', 'DB_PATH=/b')), 'rc=1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('#988 package: the binding runs in assert_state (so before the stop AND again under the lock) and after the restart; conflicting file overrides refuse', () => {
  const raw = readFileSync(SCRIPT, 'utf8'), s = raw.replace(/^\s*#.*$/gm, '').replace(/ #[^\n"']*$/gm, '')
  const assertBody = s.slice(s.indexOf('assert_state() {'), s.indexOf('assert_state preflight'))
  assert.ok(assertBody.includes('db_binding_ok "$E"') && assertBody.includes('effective_db_of_pid "$MAINPID"'), 'assert_state binds the running process')
  assert.ok(assertBody.indexOf('S_ID=$(stat') < assertBody.indexOf('db_binding_ok'), 'against the staging file identity')
  assert.ok(assertBody.includes('a conflicting override of $STAGING_DB') && assertBody.includes('val DB_PATH "$f"'), 'a DB_PATH in either environment file that differs refuses')
  assert.ok(s.includes('assert_state locked'), 'assert_state is the function re-run under the lock')
  const prove = s.slice(s.indexOf('prove_restart() {'), s.indexOf('finish() {'))
  assert.ok(prove.includes('R_DB_BOUND=1') && prove.includes('effective_db_of_pid "$R_MAINPID"'), 'after the restart the NEW process is bound too')
})
