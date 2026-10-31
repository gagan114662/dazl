// scripts/backup/backup-check.mts alert delivery (issue #360; review hold on a5be0b74): a throttle stamp is a delivery
// receipt, never an attempted-send receipt. A failed alert command, a webhook error or non-2xx, or no destination
// leaves no stamp, so the next run retries at once; a delivered alert is throttled for BACKUP_ALERT_EVERY_S. The
// same contract as scripts/ops/scheduler-check.mts (test/scheduler-check.test.ts). Real backup-check on a synthetic
// backup (test/helpers/recovery-fixture.mts), a stale condition (--max-age-s -1), a loopback TLS webhook. No age needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'backup-check-alert-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

// the real checker with only the alert destination this run sets. Async, so the loopback webhook server in this process
// can answer while the child runs. check(): a backup that is always too old, with a state dir.
const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number; out: string }>(resolve => {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', ...args],
    { cwd: web, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: '', OPS_ALERT_WEBHOOK_URL: '', ...env } as unknown as NodeJS.ProcessEnv, timeout: 60_000 })
  let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
  p.on('close', code => resolve({ code: code ?? -1, out }))
})
const check = (dir: string, state: string, env: Record<string, string>) => run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], env)
// an alert command that records each delivered body
const recorder = (name: string) => {
  const cmd = path.join(T, name + '.sh'), log = path.join(T, name + '.log')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> ${log}\n`); chmodSync(cmd, 0o755)
  return { cmd, delivered: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string; problems: string[] }) : [] }
}
const root = process.getuid?.() === 0
const firstJson = (out: string) => JSON.parse(out.split('\n').find(l => l.startsWith('{"level"')) ?? '{}') as Record<string, unknown>
const stamps = (state: string) => existsSync(state) ? readdirSync(state).filter(f => f.startsWith('backup-alert-')) : []

test('alert command exits 1, then works: the retry inside the interval delivers; only a delivered alert is throttled', async () => {
  const fx = await fixtureBackup(path.join(T, 'cmd')), dir = path.dirname(fx.backup), state = path.join(T, 'cmd-state')
  const cmd = path.join(T, 'alert.sh'), log = path.join(T, 'cmd-sent')
  const command = (ok: boolean) => { writeFileSync(cmd, ok ? `#!/bin/sh\necho "$1" >> ${log}\n` : '#!/bin/sh\nexit 1\n'); chmodSync(cmd, 0o755) }
  const delivered = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  command(false)
  let r = await check(dir, state, { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.match(r.out, /alert command failed/); assert.equal(delivered().length, 0)
  assert.deepEqual(stamps(state), [], 'a failed delivery leaves no receipt')
  command(true)
  r = await check(dir, state, { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1, 'the backup problem is still unresolved')
  assert.doesNotMatch(r.out, /already sent/, 'a failed attempt is not "already sent"')
  assert.equal(delivered().length, 1, 'the retry delivers at once'); assert.equal(delivered()[0].type, 'backup_check'); assert.match(delivered()[0].problems.join(), /newest backup is \d+s old/)
  assert.equal(stamps(state).length, 1, 'a delivered alert is receipted')
  r = await check(dir, state, { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.match(r.out, /already sent/); assert.equal(delivered().length, 1, 'the same delivered problem is throttled')
  // a command that cannot run is a failed delivery, not a receipt
  const absent = path.join(T, 'cmd-state-absent')
  r = await check(dir, absent, { BACKUP_ALERT_CMD: path.join(T, 'no-such-command') })
  assert.equal(r.code, 1); assert.match(r.out, /alert command failed/); assert.deepEqual(stamps(absent), [])
  // a hanging command is bounded and counts as failed, so the next run retries
  const hang = path.join(T, 'hang.sh'); writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n'); chmodSync(hang, 0o755)
  const hung = path.join(T, 'cmd-state-hang'), t0 = Date.now()
  r = await check(dir, hung, { BACKUP_ALERT_CMD: hang })
  assert.equal(r.code, 1); assert.match(r.out, /alert command failed/); assert.deepEqual(stamps(hung), [])
  assert.ok(Date.now() - t0 < 25_000, 'the command timeout is bounded well under the hang')
  // and one that ignores SIGTERM (probe P2): still bounded, the timeout kills
  const deaf = path.join(T, 'deaf.sh'); writeFileSync(deaf, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n"); chmodSync(deaf, 0o755)
  const deafState = path.join(T, 'cmd-state-deaf'), t1 = Date.now()
  r = await check(dir, deafState, { BACKUP_ALERT_CMD: deaf })
  assert.equal(r.code, 1); assert.match(r.out, /alert command failed/); assert.deepEqual(stamps(deafState), [])
  assert.ok(Date.now() - t1 < 20_000, 'a command that ignores SIGTERM is still bounded (SIGKILL)')
})

// a self-signed loopback certificate the child trusts through NODE_EXTRA_CA_CERTS: the https-only webhook control stays
const tls = () => {
  const key = path.join(T, 'hook.key'), cert = path.join(T, 'hook.crt'), cfg = path.join(T, 'hook.cnf')
  writeFileSync(cfg, '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-config', cfg, '-extensions', 'v3'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `openssl is needed for the loopback webhook: ${r.stderr}`)
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert }
}

test('webhook HTTP 500, then unreachable, then 200: each failure retries at once; the delivered alert is throttled', async () => {
  const fx = await fixtureBackup(path.join(T, 'hook')), dir = path.dirname(fx.backup), state = path.join(T, 'hook-state')
  const { key, cert, certPath } = tls()
  let status = 500, plain = 0; const got: { type: string; problems: string[] }[] = []
  const http = (await import('node:http')).default
  const target = http.createServer((_q, s) => { plain++; s.statusCode = 200; s.end() })
  await new Promise<void>(r => target.listen(0, '127.0.0.1', () => r()))
  const server = https.createServer({ key, cert }, (q, s) => { let b = ''; q.on('data', c => { b += c }); q.on('end', () => { if (status < 300) got.push(JSON.parse(b)); if (status === 302) s.setHeader('location', `http://127.0.0.1:${(target.address() as { port: number }).port}/plain`); s.statusCode = status; s.end() }) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const hook = `https://localhost:${(server.address() as { port: number }).port}/hook`
  try {
    let r = await check(dir, state, { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /alert webhook HTTP 500/); assert.equal(got.length, 0)
    assert.deepEqual(stamps(state), [], 'a non-2xx answer leaves no receipt')
    r = await check(dir, state, { OPS_ALERT_WEBHOOK_URL: 'https://127.0.0.1:1/hook', NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /alert webhook failed \(/); assert.deepEqual(stamps(state), [], 'a transport error leaves no receipt')
    status = 200
    r = await check(dir, state, { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1, 'the backup problem is still unresolved'); assert.doesNotMatch(r.out, /already sent/)
    assert.equal(got.length, 1, 'the retry delivers at once'); assert.equal(got[0].type, 'backup_check'); assert.match(got[0].problems.join(), /newest backup is \d+s old/)
    assert.equal(stamps(state).length, 1)
    r = await check(dir, state, { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /already sent/); assert.equal(got.length, 1, 'the delivered alert is throttled')
    status = 302
    r = await check(dir, path.join(T, 'hook-state-redirect'), { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /alert webhook failed \(/); assert.deepEqual(stamps(path.join(T, 'hook-state-redirect')), [], 'a redirect (to plain http) is not followed and not a receipt')
    assert.equal(got.length, 1); assert.equal(plain, 0, 'nothing reached the http target of the redirect')
    status = 200
    r = await check(dir, path.join(T, 'hook-state-http'), { OPS_ALERT_WEBHOOK_URL: hook.replace('https:', 'http:') })
    assert.equal(r.code, 1); assert.match(r.out, /no alert destination/); assert.equal(got.length, 1, 'a plain-http webhook is not a destination')
    const state1 = path.join(T, 'hook-state-1s')
    r = await check(dir, state1, { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath, BACKUP_ALERT_EVERY_S: '1' }); assert.equal(got.length, 2)
    await new Promise(res => setTimeout(res, 1200))
    r = await check(dir, state1, { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath, BACKUP_ALERT_EVERY_S: '1' })
    assert.doesNotMatch(r.out, /already sent/); assert.equal(got.length, 3, 'the webhook is delivered again after the interval')
  } finally { server.close(); target.close() }
})

test('no alert destination: exit 1 with the problem in the output, never a receipt, never "already sent"', async () => {
  const fx = await fixtureBackup(path.join(T, 'none')), dir = path.dirname(fx.backup), state = path.join(T, 'none-state')
  for (let i = 0; i < 2; i++) {
    const r = await check(dir, state, {})
    assert.equal(r.code, 1); assert.match(r.out, /"ok":false/); assert.match(r.out, /no alert destination/); assert.doesNotMatch(r.out, /already sent/)
    assert.deepEqual(stamps(state), [], 'nothing was sent, so nothing is stamped as sent')
  }
})

// Review round 1 (council on 3d855fc1): two paths threw before send(), so the monitor died with no alert in the very
// case it exists for. The shipped service passes no --state-dir, so the state dir defaults to inside BACKUP_DIR.
test('BACKUP_DIR gone under a read-only parent, no --state-dir: the alert is still delivered (unthrottled), exit 1', async () => {
  const parent = path.join(T, 'ro-parent'); mkdirSync(parent); chmodSync(parent, 0o555)
  const gone = path.join(parent, 'backups'), { cmd, delivered } = recorder('ro-alert')
  try {
    let r = await run(['--dir', gone], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.doesNotMatch(r.out, /EACCES: permission denied, mkdir|at .*backup-check\.mts/, 'no uncaught error')
    assert.equal(delivered().length, 1, 'exactly one delivered alert'); assert.match(delivered()[0].problems.join(), /^no backup with a sidecar in backups$/)
    assert.match(r.out, /state dir .* unusable \(EACCES\); alerting without throttle/)
    r = await run(['--dir', gone], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1); assert.equal(delivered().length, 2, 'with no usable state dir every run alerts: better than silence')
    assert.ok(!existsSync(gone))
  } finally { chmodSync(parent, 0o755) }
})

test('newest local backup unreadable: a named problem and a delivered alert, not an uncaught error', async () => {
  const fx = await fixtureBackup(path.join(T, 'unreadable')), dir = path.dirname(fx.backup), state = path.join(T, 'unreadable-state')
  const { cmd, delivered } = recorder('unreadable-alert')
  chmodSync(fx.backup, 0o000)
  try {
    const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '3600'], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.doesNotMatch(r.out, /at .*backup-check\.mts/, 'no uncaught error')
    assert.equal(delivered().length, 1); assert.match(delivered()[0].problems.join(), /newest backup dazl-backup-\S+\.db unreadable \(EACCES\)/)
    assert.equal(stamps(state).length, 1)
  } finally { chmodSync(fx.backup, 0o600) }
})

test('a non-numeric age limit is refused (exit 2), never a check that cannot flag staleness; an empty one is the default', async () => {
  const fx = await fixtureBackup(path.join(T, 'nan')), dir = path.dirname(fx.backup), state = path.join(T, 'nan-state')
  const { cmd, delivered } = recorder('nan-alert')
  for (const args of [['--max-age-s', '2h'], ['--max-age-s', 'Infinity'], ['--max-age-s', '0x10'], ['--max-age-s', '1e3'], ['--offhost-max-age-s', 'x', '--offhost', dir], ['--drill-max-age-s', 'NaN', '--drill-report', path.join(T, 'none.json')]]) {
    const r = await run(['--dir', dir, '--state-dir', state, ...args], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 2, JSON.stringify(args) + r.out); assert.match(r.out, /must be a number of seconds/)
  }
  let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 2, 'a flag as the last argument has no value'); assert.match(r.out, /--max-age-s needs a value/); assert.equal(delivered().length, 0)
  r = await run(['--dir', dir, '--state-dir', state, '--offhost', ''], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 2, 'an empty --offhost is a mistake, not "not configured"'); assert.match(r.out, /--offhost needs a value/)
  r = await run(['--dir', dir, '--state-dir', state], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 0); assert.match(r.out, /off-host copy not configured \(OFFHOST_DEST empty, OFFHOST_REQUIRED=0\)/, 'an unconfigured destination is said out loud')
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', ''], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 0, 'an empty limit (an unexpanded variable) is the default, and this backup is fresh'); assert.equal(delivered().length, 0)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '' })
  assert.equal(r.code, 1, 'an empty interval is the default'); assert.equal(delivered().length, 1)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '' })
  assert.equal(r.code, 1); assert.match(r.out, /already sent/); assert.equal(delivered().length, 1, 'and it throttles')
})

// Review round 1, reviewer 3 (fixtures in scratchpad/r438): silent drops that let an older backup or copy stand in for
// a newer one, an I/O error that ended the process before the alert, the interval paths, and untested delivery cells.
test('a newer backup with a truncated sidecar is a problem, not silently replaced by the older good one', async () => {
  const fx = await fixtureBackup(path.join(T, 'side')), dir = path.dirname(fx.backup), state = path.join(T, 'side-state')
  const { cmd, delivered } = recorder('side-alert')
  writeFileSync(path.join(dir, 'newer.db'), 'not a database'); writeFileSync(path.join(dir, 'newer.db.json'), '{"createdAt":"2026-10')
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1, r.out); assert.equal(delivered().length, 1)
  assert.match(delivered()[0].problems.join(), /unreadable sidecar for newer\.db/)
  assert.equal(firstJson(r.out).newest_backup, path.basename(fx.backup), 'the good backup is still the newest reported')
})

test('an unreadable or truncated off-host manifest is a problem, not silently replaced by the older copy', async () => {
  const fx = await fixtureBackup(path.join(T, 'man')), dir = path.dirname(fx.backup), state = path.join(T, 'man-state')
  const dest = path.join(T, 'man-dest'); mkdirSync(dest)
  const ct = Buffer.from('ciphertext stand-in'); writeFileSync(path.join(dest, 'old.db.age'), ct)
  writeFileSync(path.join(dest, 'old.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date(Date.now() - 60_000).toISOString(), ciphertext: 'old.db.age', ciphertext_sha256: createHash('sha256').update(ct).digest('hex'), bytes: ct.length }))
  writeFileSync(path.join(dest, 'new.db.age.json'), '{"tool":"dazl-offhost-copy","copied_at":"2026')
  writeFileSync(path.join(dest, 'other-tool.json.age.json'), JSON.stringify({ tool: 'something-else' }))
  writeFileSync(path.join(dest, 'nodate.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', ciphertext: 'nodate.db.age' }))
  const locked = path.join(dest, 'locked.db.age.json'); writeFileSync(locked, '{}'); chmodSync(locked, 0o000)
  const { cmd, delivered } = recorder('man-alert')
  try {
    const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.equal(delivered().length, 1); const p = delivered()[0].problems.join('\n')
    assert.match(p, /off-host manifest new\.db\.age\.json unreadable \(not JSON\)/)
    if (!root) assert.match(p, /off-host manifest locked\.db\.age\.json unreadable \(EACCES on open\)/)
    assert.doesNotMatch(p, /other-tool/, "another tool's file is not ours and not a problem")
    assert.match(p, /off-host manifest nodate\.db\.age\.json has no copied_at/)
    assert.equal(firstJson(r.out).newest_offhost_verified, true, 'the readable copy is still verified'); assert.equal(firstJson(r.out).offhost_copies, 1)
  } finally { chmodSync(locked, 0o600) }
})

test('backup directory unreadable (mode 000): a named problem and a delivered alert, not an uncaught error', { skip: root ? 'root reads everything' : false }, async () => {
  const dir = path.join(T, 'locked-dir'); mkdirSync(dir); chmodSync(dir, 0o000)
  const { cmd, delivered } = recorder('locked-alert')
  try {
    const r = await run(['--dir', dir, '--state-dir', path.join(T, 'locked-state')], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.doesNotMatch(r.out, /at .*backup-check\.mts/, 'no uncaught error')
    assert.equal(delivered().length, 1); assert.match(delivered()[0].problems.join(), /backup directory locked-dir unreadable \(EACCES\)/)
  } finally { chmodSync(dir, 0o755) }
})

test('interval: an invalid BACKUP_ALERT_EVERY_S is the default (logged, one delivery); a 1 s interval expires; a new problem alerts at once', async () => {
  const fx = await fixtureBackup(path.join(T, 'every')), dir = path.dirname(fx.backup), state = path.join(T, 'every-state')
  const { cmd, delivered } = recorder('every-alert')
  const stale = (st: string, extra: string[] = []) => ['--dir', dir, '--state-dir', st, '--max-age-s', '-1', ...extra]
  let r = await run(stale(state), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: 'abc' })
  assert.equal(r.code, 1); assert.match(r.out, /BACKUP_ALERT_EVERY_S is not a number of seconds \("abc"\); using 3600/); assert.equal(delivered().length, 1)
  r = await run(stale(state), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: 'abc' })
  assert.equal(r.code, 1); assert.match(r.out, /already sent/); assert.equal(delivered().length, 1, 'abc twice: one delivery, not two')
  r = await run(stale(state), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '-5' })
  assert.match(r.out, /using 3600/); assert.equal(delivered().length, 1, 'a negative interval is not "never throttle"')
  r = await run(stale(state), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '0x10' })
  assert.match(r.out, /using 3600/); assert.equal(delivered().length, 1, 'only decimal integers are intervals')
  const state0 = path.join(T, 'every-state-0')
  for (let i = 0; i < 2; i++) r = await run(stale(state0), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '0' })
  assert.equal(delivered().length, 3, '0 means no throttle (documented): every run delivers')
  const state2 = path.join(T, 'every-state-2')
  r = await run(stale(state2), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '1' }); assert.equal(delivered().length, 4)
  await new Promise(res => setTimeout(res, 1200))
  r = await run(stale(state2), { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '1' })
  assert.equal(r.code, 1); assert.doesNotMatch(r.out, /already sent/); assert.equal(delivered().length, 5, 'the interval expired: delivered again')
  r = await run(stale(state, ['--offhost', path.join(T, 'nowhere')]), { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.doesNotMatch(r.out, /already sent/); assert.equal(delivered().length, 6, 'a new problem joining an already-alerted set is a new set: delivered at once')
  assert.match(delivered().at(-1)!.problems.join(), /unreadable: directory not found/)
})

test('webhook that never answers: TimeoutError and no stamp; command and webhook both set: the command wins and the webhook is never tried', async () => {
  const fx = await fixtureBackup(path.join(T, 'hang')), dir = path.dirname(fx.backup), state = path.join(T, 'hang-state'), state2 = path.join(T, 'both-state')
  const { key, cert, certPath } = tls()
  let hits = 0; const server = https.createServer({ key, cert }, () => { hits++ /* never answers */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const hook = `https://localhost:${(server.address() as { port: number }).port}/hook`
  try {
    const t0 = Date.now()
    let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /alert webhook failed \(TimeoutError\)/); assert.deepEqual(stamps(state), [], 'a hung webhook is not a receipt')
    assert.ok(Date.now() - t0 < 25_000, 'bounded'); assert.equal(hits, 1)
    const { cmd, delivered } = recorder('both-alert')
    r = await run(['--dir', dir, '--state-dir', state2, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.equal(delivered().length, 1); assert.equal(stamps(state2).length, 1); assert.equal(hits, 1, 'the webhook was never tried')
    const failing = path.join(T, 'both-failing.sh'); writeFileSync(failing, '#!/bin/sh\nexit 1\n'); chmodSync(failing, 0o755)
    r = await run(['--dir', dir, '--state-dir', path.join(T, 'both-failing-state'), '--max-age-s', '-1'], { BACKUP_ALERT_CMD: failing, OPS_ALERT_WEBHOOK_URL: hook, NODE_EXTRA_CA_CERTS: certPath })
    assert.equal(r.code, 1); assert.match(r.out, /alert command failed/); assert.equal(hits, 1, 'a failing command does not fall back to the webhook'); assert.deepEqual(stamps(path.join(T, 'both-failing-state')), [])
  } finally { server.closeAllConnections(); server.close() }
})

// Adversarial probe on 3d855fc1 (scratchpad/attack-438.md): paths in the alert body, the state dir shared with
// scheduler-check, a stamp that cannot be written after delivery.
test('alert body carries file names and error codes only: no directory path, even from a forwarded I/O error', async () => {
  const fx = await fixtureBackup(path.join(T, 'paths')), dir = path.dirname(fx.backup), state = path.join(T, 'paths-state')
  const dest = path.join(T, 'paths-dest-secret-name'); mkdirSync(dest)
  const ct = Buffer.from('ciphertext stand-in'); writeFileSync(path.join(dest, 'x.db.age'), ct); chmodSync(path.join(dest, 'x.db.age'), 0o000)
  writeFileSync(path.join(dest, 'x.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.db.age', ciphertext_sha256: createHash('sha256').update(ct).digest('hex'), bytes: ct.length }))
  const { cmd, delivered } = recorder('paths-alert')
  try {
    const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.equal(delivered().length, 1)
    const body = JSON.stringify(delivered()[0])
    if (!root) assert.match(body, /off-host destination paths-dest-secret-name unreadable: EACCES on open/)
    assert.ok(!body.includes(T), `no directory path in the alert body: ${body}`)
    assert.ok(!body.includes(path.dirname(dir)), 'not the backup dir path either')
    for (const p of delivered()[0].problems) assert.doesNotMatch(p, /\//, `no "/" in any problem string: ${p}`)
  } finally { chmodSync(path.join(dest, 'x.db.age'), 0o600) }
  // the destination directory itself unreadable (scandir): code and syscall, no path
  if (!root) {
    const shut = path.join(T, 'paths-dest-shut'); mkdirSync(shut); chmodSync(shut, 0o000)
    try {
      const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', shut], { BACKUP_ALERT_CMD: cmd })
      assert.equal(r.code, 1); const ps = delivered().at(-1)!.problems
      assert.match(ps.join(), /off-host destination paths-dest-shut unreadable: EACCES on scandir/)
      for (const p of ps) assert.doesNotMatch(p, /\//, `no "/" in any problem string: ${p}`)
    } finally { chmodSync(shut, 0o700) }
  }
  // the no-backup message names the directory by its base name only
  const empty = path.join(T, 'paths-empty-dir'); mkdirSync(empty)
  const r2 = await run(['--dir', empty, '--state-dir', state], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r2.code, 1); assert.match(delivered().at(-1)!.problems.join(), /^no backup with a sidecar in paths-empty-dir$/); assert.ok(!JSON.stringify(delivered().at(-1)).includes(T))
})

test('a healthy run removes only its own stamps: another tool\'s files in a shared --state-dir survive; a recurring problem alerts at once', async () => {
  const fx = await fixtureBackup(path.join(T, 'shared')), dir = path.dirname(fx.backup), state = path.join(T, 'shared-state'); mkdirSync(state)
  writeFileSync(path.join(state, 'alert-0123456789abcdef'), ''); writeFileSync(path.join(state, 'other-tool.json'), '{}'); writeFileSync(path.join(state, 'latest.json'), '{}')
  const { cmd, delivered } = recorder('shared-alert')
  let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.equal(delivered().length, 1); assert.equal(stamps(state).length, 1)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 0, r.out); assert.deepEqual(stamps(state), [], 'its own stamp is gone')
  assert.deepEqual(readdirSync(state).sort(), ['alert-0123456789abcdef', 'latest.json', 'other-tool.json'], "scheduler-check's stamp and other tools' files are untouched, the directory stays")
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.doesNotMatch(r.out, /already sent/); assert.equal(delivered().length, 2, 'resolved then recurring: alerted again at once')
})

test('stamp not writable after a delivered alert (read-only state dir): delivered, logged, exit 1, no crash; the next run alerts again', { skip: root ? 'root writes everything' : false }, async () => {
  const fx = await fixtureBackup(path.join(T, 'rostate')), dir = path.dirname(fx.backup), state = path.join(T, 'rostate-state'); mkdirSync(state); chmodSync(state, 0o500)
  const { cmd, delivered } = recorder('rostate-alert')
  try {
    let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1, r.out); assert.equal(delivered().length, 1); assert.doesNotMatch(r.out, /at .*backup-check\.mts/, 'no stack trace')
    assert.match(r.out, /alert delivered, throttle stamp not written \(EACCES\)/); assert.deepEqual(stamps(state), [])
    r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 1); assert.equal(delivered().length, 2, 're-alert over silence')
  } finally { chmodSync(state, 0o700) }
})

test('rclone that hangs on cat is bounded by RCLONE_TIMEOUT_S: a named problem, no path, not a hung check', async () => {
  const fx = await fixtureBackup(path.join(T, 'rchang')), dir = path.dirname(fx.backup), state = path.join(T, 'rchang-state')
  const store = path.join(T, 'rchang-remote'); mkdirSync(store)
  writeFileSync(path.join(store, 'x.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.db.age', ciphertext_sha256: '0'.repeat(64), bytes: 1 }))
  const slow = path.join(T, 'slow-rclone'); writeFileSync(slow, `#!/bin/sh\ncase "$1" in lsf) ls -1 ${store} ;; cat) sleep 30 ;; *) exit 9 ;; esac\n`); chmodSync(slow, 0o755)
  const { cmd, delivered } = recorder('rchang-alert'); const t0 = Date.now()
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', 'rclone:remote:bucket'], { BACKUP_ALERT_CMD: cmd, RCLONE_BIN: slow, RCLONE_TIMEOUT_S: '1' })
  assert.equal(r.code, 1, r.out); assert.ok(Date.now() - t0 < 20_000, 'bounded'); assert.equal(delivered().length, 1)
  const ps = delivered()[0].problems; assert.match(ps.join(), /off-host destination remote: unreadable: rclone cat timed out \(1s\)/)
  for (const p of ps) assert.doesNotMatch(p, /\//, `no "/" in any problem string: ${p}`)
  // 0 is not "no bound" (spawnSync would take it as none): it and every other non-positive form fall back to 120, logged
  const quick = path.join(T, 'quick-rclone'); writeFileSync(quick, `#!/bin/sh\ncase "$1" in lsf) ls -1 ${store} ;; cat) cat ${store}/x.db.age.json ;; *) exit 9 ;; esac\n`); chmodSync(quick, 0o755)
  // a wrapper that forks without exec (probe V1): the orphan must not hold the pipe past the bound, in either path
  const forking = path.join(T, 'forking-rclone'); writeFileSync(forking, `#!/bin/sh\np=\${2#remote:bucket/}\ncase "$1" in lsf) ls -1 ${store} ;; cat) case "$p" in *.json) ;; *) sleep 30 & ;; esac; cat "${store}/$p" ;; *) exit 9 ;; esac\n`); chmodSync(forking, 0o755)
  const good = Buffer.from('ciphertext stand-in'); writeFileSync(path.join(store, 'y.db.age'), good)
  writeFileSync(path.join(store, 'y.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'y.db.age', ciphertext_sha256: createHash('sha256').update(good).digest('hex'), bytes: good.length }))
  rmSync(path.join(store, 'x.db.age.json'))
  let t1 = Date.now(); let r3 = await run(['--dir', dir, '--state-dir', path.join(T, 'rc-fork-ok'), '--max-age-s', '7200', '--offhost', 'rclone:remote:bucket'], { BACKUP_ALERT_CMD: 'true', RCLONE_BIN: forking, RCLONE_TIMEOUT_S: '2' })
  assert.equal(r3.code, 0, r3.out); assert.equal(firstJson(r3.out).newest_offhost_verified, true, 'the bytes the wrapper wrote are all hashed'); assert.ok(Date.now() - t1 < 15_000, `a forked orphan does not hold the check: ${Date.now() - t1} ms`)
  const forkHang = path.join(T, 'forkhang-rclone'); writeFileSync(forkHang, `#!/bin/sh\np=\${2#remote:bucket/}\ncase "$1" in lsf) ls -1 ${store} ;; cat) case "$p" in *.json) cat "${store}/$p" ;; *) sleep 30 & sleep 30 ;; esac ;; *) exit 9 ;; esac\n`); chmodSync(forkHang, 0o755)
  t1 = Date.now(); r3 = await run(['--dir', dir, '--state-dir', path.join(T, 'rc-fork-hang'), '--max-age-s', '7200', '--offhost', 'rclone:remote:bucket'], { BACKUP_ALERT_CMD: cmd, RCLONE_BIN: forkHang, RCLONE_TIMEOUT_S: '2' })
  assert.equal(r3.code, 1); assert.match(delivered().at(-1)!.problems.join(), /rclone cat timed out \(2s\)/); assert.ok(Date.now() - t1 < 15_000, `the whole process group is killed at the bound: ${Date.now() - t1} ms`)
  writeFileSync(path.join(store, 'x.db.age.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date().toISOString(), ciphertext: 'x.db.age', ciphertext_sha256: '0'.repeat(64), bytes: 1 })); rmSync(path.join(store, 'y.db.age')); rmSync(path.join(store, 'y.db.age.json'))
  for (const v of ['0', '-1', 'abc', '1.5']) {
    const r2 = await run(['--dir', dir, '--state-dir', path.join(T, 'rc-limit-' + v), '--max-age-s', '7200', '--offhost', 'rclone:remote:bucket'], { BACKUP_ALERT_CMD: 'true', RCLONE_BIN: quick, RCLONE_TIMEOUT_S: v })
    assert.match(r2.out, new RegExp(`RCLONE_TIMEOUT_S must be a positive number of seconds \\(${JSON.stringify(v).replace(/[.]/g, '\\$&')}\\); using 120`), r2.out)
    assert.doesNotMatch(r2.out, /ERR_OUT_OF_RANGE|timed out/, 'the fallback is in force: no range error, no spurious timeout'); assert.equal(r2.code, 1, 'the stand-in copy is still judged (its ciphertext is missing)')
  }
})

// Probe round 2 (scratchpad/attack-438-r2.md): a future timestamp must not win the newest selection, and listing order
// must not decide which of two equally new manifests is judged.
const manifestFor = (dest: string, name: string, copiedAt: string, ct: Buffer | null) => {
  if (ct) writeFileSync(path.join(dest, name), ct)
  writeFileSync(path.join(dest, name + '.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: copiedAt, ciphertext: name, ciphertext_sha256: createHash('sha256').update(ct ?? Buffer.from('x')).digest('hex'), bytes: (ct ?? Buffer.from('x')).length }))
}
test('a future copied_at or createdAt is a problem and never the newest: the real, stale copy is what gets judged', async () => {
  const fx = await fixtureBackup(path.join(T, 'future')), dir = path.dirname(fx.backup), state = path.join(T, 'future-state')
  const dest = path.join(T, 'future-dest'); mkdirSync(dest)
  const year = 365 * 86_400_000, ct = Buffer.from('ciphertext stand-in')
  manifestFor(dest, 'real.db.age', new Date(Date.now() - 90_000_000).toISOString(), ct)
  manifestFor(dest, 'skewed.db.age', new Date(Date.now() + year).toISOString(), ct)
  const { cmd, delivered } = recorder('future-alert')
  let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1, r.out); const p = delivered()[0].problems.join('\n')
  assert.match(p, /off-host manifest skewed\.db\.age\.json has a future timestamp/); assert.match(p, /newest off-host copy is 9000\ds old \(limit 7200s\)/)
  const j = firstJson(r.out); assert.ok((j.newest_offhost_age_s as number) >= 90_000, 'the stale real copy is the newest, with a non-negative age')
  // a local sidecar from the future
  writeFileSync(path.join(dir, 'skewed.db'), 'x'); writeFileSync(path.join(dir, 'skewed.db.json'), JSON.stringify({ createdAt: new Date(Date.now() + year).toISOString(), sha256: '0'.repeat(64) }))
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.match(delivered().at(-1)!.problems.join(), /backup skewed\.db has a future timestamp/)
  assert.equal(firstJson(r.out).newest_backup, path.basename(fx.backup)); assert.ok((firstJson(r.out).newest_backup_age_s as number) < 60, 'the real backup, seconds old')
  // a directory holding only the future-stamped backup: "no usable backup", not "no backup with a sidecar"
  const only = path.join(T, 'future-only'); mkdirSync(only); writeFileSync(path.join(only, 'skewed.db'), 'x'); writeFileSync(path.join(only, 'skewed.db.json'), readFileSync(path.join(dir, 'skewed.db.json')))
  r = await run(['--dir', only, '--state-dir', state], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); assert.match(delivered().at(-1)!.problems.join('\n'), /^no usable backup in future-only$/m)
  // a clock a few seconds ahead is not a problem, and its age is 0, not negative
  writeFileSync(path.join(dir, 'skewed.db.json'), JSON.stringify({ createdAt: new Date(Date.now() + 60_000).toISOString(), sha256: createHash('sha256').update('x').digest('hex') }))
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200'], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 0, r.out); assert.equal(firstJson(r.out).newest_backup, 'skewed.db'); assert.equal(firstJson(r.out).newest_backup_age_s, 0)
})

test('two manifests with the same copied_at: every one of them is judged, whichever the listing order', async () => {
  const fx = await fixtureBackup(path.join(T, 'tied')), dir = path.dirname(fx.backup), state = path.join(T, 'tied-state')
  const at = new Date(Date.now() - 60_000).toISOString(), ct = Buffer.from('ciphertext stand-in')
  for (const [good, broken] of [['a', 'b'], ['b', 'a']]) {
    const dest = path.join(T, `tied-dest-${good}${broken}`); mkdirSync(dest)
    manifestFor(dest, `${good}.db.age`, at, ct); manifestFor(dest, `${broken}.db.age`, at, null)
    const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: 'true' })
    assert.equal(r.code, 1, r.out); const j = firstJson(r.out)
    assert.match((j.problems as string[]).join(), new RegExp(`newest off-host copy ${broken}\\.db\\.age is missing`)); assert.notEqual(j.newest_offhost_verified, true)
  }
  const dest = path.join(T, 'tied-dest-good'); mkdirSync(dest); manifestFor(dest, 'a.db.age', at, ct); manifestFor(dest, 'b.db.age', at, ct)
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: 'true' })
  assert.equal(r.code, 0, r.out); assert.equal(firstJson(r.out).newest_offhost_verified, true, 'both verified')
})

test('the problem set is order-independent: the same problems in another discovery order share one stamp', async () => {
  const fx = await fixtureBackup(path.join(T, 'order')), dir = path.dirname(fx.backup), state = path.join(T, 'order-state')
  const { cmd, delivered } = recorder('order-alert')
  // discovery order is local, off-host, drill; the drill problem sorts first ("last recovery drill" < "newest backup")
  const report = path.join(T, 'order-drill.json'); writeFileSync(report, JSON.stringify({ ok: true, started_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), steps: [] }))
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1', '--offhost', path.join(T, 'nowhere'), '--drill-report', report], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1); const ps = delivered()[0].problems; assert.equal(ps.length, 3)
  assert.match(ps[0], /^last recovery drill is \d+s old/); assert.match(ps[1], /^newest backup is/); assert.match(ps[2], /^off-host destination nowhere unreadable/)
  assert.deepEqual(ps, [...ps].sort(), 'problems are emitted sorted, not in discovery order')
})

// Confirmation round, reviewer 1 (R11): copies accrue hourly with no retention, so the number of rclone calls per run
// must not grow with the number of manifests, or the unit's 5-minute backstop eventually kills every run before it alerts.
test('300 off-host manifests behind a slow rclone: the check reads only the newest few and finishes fast', async () => {
  const fx = await fixtureBackup(path.join(T, 'many')), dir = path.dirname(fx.backup), state = path.join(T, 'many-state')
  const store = path.join(T, 'many-remote'); mkdirSync(store)
  const ct = Buffer.from('ciphertext stand-in'), sha = createHash('sha256').update(ct).digest('hex')
  for (let i = 1; i <= 300; i++) {
    const name = `dazl-backup-2026${String(i).padStart(3, '0')}.db.age`
    writeFileSync(path.join(store, name + '.json'), JSON.stringify({ tool: 'dazl-offhost-copy', copied_at: new Date(Date.now() - (301 - i) * 3600_000).toISOString(), ciphertext: name, ciphertext_sha256: sha, bytes: ct.length }))
  }
  writeFileSync(path.join(store, 'dazl-backup-2026300.db.age'), ct) // only the newest ciphertext exists; older ones are not judged
  const calls = path.join(T, 'many-calls.log')
  const slow = path.join(T, 'slow-many-rclone'); writeFileSync(slow, `#!/bin/sh\necho "$1 $3" >> ${calls}\ncase "$1" in lsf) ls -1 ${store} ;; cat) sleep 0.5; p=\${2#remote:bucket/}; cat "${store}/$p" ;; *) exit 9 ;; esac\n`); chmodSync(slow, 0o755)
  const { cmd, delivered } = recorder('many-alert'); const t0 = Date.now()
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', 'rclone:remote:bucket'], { BACKUP_ALERT_CMD: cmd, RCLONE_BIN: slow })
  const elapsed = Date.now() - t0, made = readFileSync(calls, 'utf8').trim().split('\n')
  assert.equal(r.code, 0, r.out); assert.equal(delivered().length, 0)
  const j = firstJson(r.out); assert.equal(j.offhost_manifests_listed, 300); assert.equal(j.offhost_copies, 5); assert.equal(j.offhost_manifests_read, 5); assert.equal(j.newest_offhost_verified, true)
  assert.ok(made.length <= 1 + 10 + 5, `at most lsf + READ_MAX manifest reads + digests, got ${made.length}`); assert.ok(elapsed < 60_000, `finished in ${elapsed} ms`)
})

test('the window is by backup timestamp, not by raw name: copies under other names cannot hide a broken newest dazl backup', async () => {
  const fx = await fixtureBackup(path.join(T, 'window')), dir = path.dirname(fx.backup), state = path.join(T, 'window-state')
  const dest = path.join(T, 'window-dest'); mkdirSync(dest)
  const ct = Buffer.from('ciphertext stand-in')
  for (let i = 1; i <= 5; i++) manifestFor(dest, `pre-migration-${i}.db.age`, new Date(Date.now() - 60_000 * i).toISOString(), ct) // "p" sorts above "d"
  manifestFor(dest, 'dazl-backup-20261031T170000Z-abcd1234.db.age', new Date().toISOString(), null) // the real newest, ciphertext missing
  const { cmd, delivered } = recorder('window-alert')
  const r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '7200', '--offhost', dest], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 1, r.out); assert.equal(delivered().length, 1)
  assert.match(delivered()[0].problems.join(), /newest off-host copy dazl-backup-20261031T170000Z-abcd1234\.db\.age is missing/)
  assert.equal(firstJson(r.out).offhost_manifests_read, 5); assert.notEqual(firstJson(r.out).newest_offhost_verified, true)
})
