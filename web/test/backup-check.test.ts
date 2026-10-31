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
const stamps = (state: string) => existsSync(state) ? readdirSync(state).filter(f => f.startsWith('alert-')) : []

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

test('a non-numeric age limit or alert interval is refused (exit 2), never a check that cannot flag staleness', async () => {
  const fx = await fixtureBackup(path.join(T, 'nan')), dir = path.dirname(fx.backup), state = path.join(T, 'nan-state')
  const { cmd, delivered } = recorder('nan-alert')
  for (const args of [['--max-age-s', '2h'], ['--max-age-s', 'Infinity'], ['--offhost-max-age-s', 'x', '--offhost', dir], ['--drill-max-age-s', 'NaN', '--drill-report', path.join(T, 'none.json')]]) {
    const r = await run(['--dir', dir, '--state-dir', state, ...args], { BACKUP_ALERT_CMD: cmd })
    assert.equal(r.code, 2, JSON.stringify(args) + r.out); assert.match(r.out, /must be a number of seconds/)
  }
  let r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', ''], { BACKUP_ALERT_CMD: cmd })
  assert.equal(r.code, 0, 'an empty limit (an unexpanded variable) is the default, and this backup is fresh'); assert.equal(delivered().length, 0)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: 'abc' })
  assert.equal(r.code, 2); assert.match(r.out, /BACKUP_ALERT_EVERY_S must be a number of seconds/); assert.equal(delivered().length, 0)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '' })
  assert.equal(r.code, 1, 'an empty interval is the default'); assert.equal(delivered().length, 1)
  r = await run(['--dir', dir, '--state-dir', state, '--max-age-s', '-1'], { BACKUP_ALERT_CMD: cmd, BACKUP_ALERT_EVERY_S: '' })
  assert.equal(r.code, 1); assert.match(r.out, /already sent/); assert.equal(delivered().length, 1, 'and it throttles')
})
