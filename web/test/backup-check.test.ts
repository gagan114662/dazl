// scripts/backup/backup-check.mts alert delivery (issue #360; review hold on a5be0b74): a throttle stamp is a delivery
// receipt, never an attempted-send receipt. A failed alert command, a webhook error or non-2xx, or no destination
// leaves no stamp, so the next run retries at once; a delivered alert is throttled for BACKUP_ALERT_EVERY_S. The
// same contract as scripts/ops/scheduler-check.mts (test/scheduler-check.test.ts). Real backup-check on a synthetic
// backup (test/helpers/recovery-fixture.mts), a stale condition (--max-age-s -1), a loopback TLS webhook. No age needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureBackup } from './helpers/recovery-fixture.mts'

const web = fileURLToPath(new URL('../', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'backup-check-alert-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

// the real checker, on a backup that is always too old, with only the alert destination this run sets. Async, so the
// loopback webhook server in this process can answer while the child runs.
const check = (dir: string, state: string, env: Record<string, string>) => new Promise<{ code: number; out: string }>(resolve => {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/backup/backup-check.mts', '--dir', dir, '--state-dir', state, '--max-age-s', '-1'],
    { cwd: web, env: { PATH: process.env.PATH!, HOME: process.env.HOME!, BACKUP_ALERT_CMD: '', OPS_ALERT_WEBHOOK_URL: '', ...env } as unknown as NodeJS.ProcessEnv, timeout: 60_000 })
  let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
  p.on('close', code => resolve({ code: code ?? -1, out }))
})
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
  let status = 500; const got: { type: string; problems: string[] }[] = []
  const server = https.createServer({ key, cert }, (q, s) => { let b = ''; q.on('data', c => { b += c }); q.on('end', () => { if (status < 300) got.push(JSON.parse(b)); s.statusCode = status; s.end() }) })
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
    r = await check(dir, path.join(T, 'hook-state-http'), { OPS_ALERT_WEBHOOK_URL: hook.replace('https:', 'http:') })
    assert.equal(r.code, 1); assert.match(r.out, /no alert destination/); assert.equal(got.length, 1, 'a plain-http webhook is not a destination')
  } finally { server.close() }
})

test('no alert destination: exit 1 with the problem in the output, never a receipt, never "already sent"', async () => {
  const fx = await fixtureBackup(path.join(T, 'none')), dir = path.dirname(fx.backup), state = path.join(T, 'none-state')
  for (let i = 0; i < 2; i++) {
    const r = await check(dir, state, {})
    assert.equal(r.code, 1); assert.match(r.out, /"ok":false/); assert.match(r.out, /no alert destination/); assert.doesNotMatch(r.out, /already sent/)
    assert.deepEqual(stamps(state), [], 'nothing was sent, so nothing is stamped as sent')
  }
})
