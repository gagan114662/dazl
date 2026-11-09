// scripts/ops/scheduler-check.mts against a loopback stand-in for /api/health/scheduler: a problem alerts once per
// interval, recovery is announced once, an app that does not answer alerts, and nothing but counts is forwarded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))
test('scheduler-check: alerts on problems (throttled), on an app that does not answer, and once on recovery', async () => {
  const T = mkdtempSync(path.join(tmpdir(), 'sched-check-'))
  let health: { status: number; body: object } = { status: 200, body: { ok: true, problems: [], operational: { state: 'fresh' }, tenants: { tracked: 2 } } }
  const server = http.createServer((_q, s) => { s.statusCode = health.status; s.end(JSON.stringify(health.body)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health/scheduler`
  const alerts = path.join(T, 'alerts.log'), cmd = path.join(T, 'alert.sh')
  writeFileSync(cmd, `#!/bin/sh\necho "$1" >> ${alerts}\n`); chmodSync(cmd, 0o755)
  const sent = () => existsSync(alerts) ? readFileSync(alerts, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  const run = (u = url) => new Promise<number>(r => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', u, '--state-dir', path.join(T, 'state')], { cwd: web, env: { ...process.env, SCHEDULER_ALERT_CMD: cmd, OPS_ALERT_WEBHOOK_URL: '' }, stdio: 'ignore' }).on('exit', c => r(c ?? -1)))
  try {
    assert.equal(await run(), 0); assert.equal(sent().length, 0)
    health = { status: 503, body: { ok: false, problems: ['scheduler stale: last completed run 3000s ago', '1 tenant(s) blocked by repeated failures'], operational: { state: 'stale', last_completed_age_s: 3000, lease_generation: 4 }, tenants: { tracked: 2, blocked: 1 } } }
    assert.equal(await run(), 1); assert.equal(sent().length, 1)
    assert.equal(sent()[0].type, 'scheduler_check'); assert.equal(sent()[0].scheduler, 'stale'); assert.deepEqual(sent()[0].tenants, { tracked: 2, blocked: 1 })
    health.body = { ...health.body, problems: ['scheduler stale: last completed run 3300s ago', '1 tenant(s) blocked by repeated failures'] }
    assert.equal(await run(), 1); assert.equal(sent().length, 1, 'the same problems with new numbers are not re-sent within the interval')
    health = { status: 200, body: { ok: true, problems: [], operational: { state: 'fresh' }, tenants: { tracked: 2 } } }
    assert.equal(await run(), 0); assert.equal(sent().at(-1).type, 'scheduler_recovered')
    assert.equal(await run(), 0); assert.equal(sent().length, 2, 'recovery is announced once')
    assert.equal(await run('http://127.0.0.1:1/api/health/scheduler'), 1); assert.match(sent().at(-1).problems[0], /not answering/)
  } finally { server.close(); rmSync(T, { recursive: true, force: true }) }
})

test('failed alert delivery is retried, and failed recovery delivery keeps the original receipt', async () => {
  const t = mkdtempSync(path.join(tmpdir(), 'sched-retry-'))
  let healthy = false
  const server = http.createServer((_q, r) => { r.statusCode = healthy ? 200 : 503; r.end(JSON.stringify({ ok: healthy, problems: healthy ? [] : ['scheduler stale 3000s'], operational: { state: healthy ? 'fresh' : 'stale' }, tenants: { tracked: 1 } })) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const cmd = path.join(t, 'alert.sh'), log = path.join(t, 'sent'), state = path.join(t, 'state')
  const command = (ok: boolean) => { writeFileSync(cmd, ok ? `#!/bin/sh\necho delivered >> ${log}\n` : '#!/bin/sh\nexit 1\n'); chmodSync(cmd, 0o755) }
  const run = (destination = cmd) => new Promise<number>(r => spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health/scheduler`, '--state-dir', state], { cwd: web, env: { ...process.env, SCHEDULER_ALERT_CMD: destination, OPS_ALERT_WEBHOOK_URL: '' }, stdio: 'ignore' }).on('exit', c => r(c ?? -1)))
  const count = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0
  try {
    assert.equal(await run(''), 1); assert.equal(count(), 0)
    assert.equal(await run(path.join(t, 'absent-command')), 1); assert.equal(count(), 0)
    command(false); assert.equal(await run(), 1); assert.equal(count(), 0)
    command(true); assert.equal(await run(), 1); assert.equal(count(), 1, 'retry immediately delivers, not throttled')
    assert.equal(await run(), 1); assert.equal(count(), 1, 'successful delivery is throttled')
    healthy = true; command(false); assert.equal(await run(), 1); assert.equal(count(), 1, 'recovery failure is not success')
    command(true); assert.equal(await run(), 0); assert.equal(count(), 2, 'recovery retried until delivered')
    assert.equal(await run(), 0); assert.equal(count(), 2, 'delivered recovery clears receipt')
  } finally { server.close(); rmSync(t, { recursive: true, force: true }) }
})

// The real OPS_ALERT_WEBHOOK_URL path against a local HTTPS receiver (self-signed, loopback, trusted only for this child via NODE_EXTRA_CA_CERTS).
test('webhook payload carries a Slack-compatible text beside the structured fields; throttled, retried on failure, recovery once; nothing identifying', async () => {
  const T = mkdtempSync(path.join(tmpdir(), 'sched-hook-'))
  const key = path.join(T, 'k.pem'), cert = path.join(T, 'c.pem'), cfg = path.join(T, 'c.cnf'), state = path.join(T, 'state')
  writeFileSync(cfg, '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  const o = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-config', cfg, '-extensions', 'v3'], { encoding: 'utf8' })
  assert.equal(o.status, 0, `openssl is needed for the loopback receiver: ${o.stderr}`)
  let status = 500; const got: Record<string, unknown>[] = []
  const hook = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (q, s) => { let b = ''; q.on('data', c => { b += c }); q.on('end', () => { if (status < 300) got.push(JSON.parse(b)); s.statusCode = status; s.end() }) })
  await new Promise<void>(r => hook.listen(0, '127.0.0.1', () => r()))
  // A health endpoint that (wrongly) leaks identifiers in its problem strings: the alert text must still not carry them.
  let healthy = false
  const app = http.createServer((_q, s) => { s.statusCode = healthy ? 200 : 503; s.end(JSON.stringify({ ok: healthy, problems: healthy ? [] : ['scheduler stale: last completed run 3000s ago', 'tenant 0b0e7c1a-1111-4222-8333-444455556666 blocked, owner jane.doe@example.com'], operational: { state: healthy ? 'fresh' : 'stale' }, tenants: { tracked: 2, blocked: 1 } })) })
  await new Promise<void>(r => app.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(app.address() as { port: number }).port}/api/health/scheduler`
  const hookUrl = `https://localhost:${(hook.address() as { port: number }).port}/hook`
  const run = () => new Promise<{ code: number | null; out: string }>(r => { let out = ''; const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', url, '--state-dir', state], { cwd: web, env: { ...process.env, SCHEDULER_ALERT_CMD: '', OPS_ALERT_WEBHOOK_URL: hookUrl, NODE_EXTRA_CA_CERTS: cert } }); c.stdout.on('data', d => { out += d }); c.stderr.on('data', d => { out += d }); c.on('close', code => r({ code, out })) })
  const stamps = () => existsSync(state) ? readdirSync(state).filter(f => f.startsWith('alert-')) : []
  try {
    let r = await run(); assert.equal(r.code, 1); assert.match(r.out, /alert webhook HTTP 500/); assert.equal(got.length, 0); assert.deepEqual(stamps(), [], 'a failed delivery leaves no receipt')
    status = 200
    r = await run(); assert.equal(r.code, 1); assert.equal(got.length, 1, 'the retry delivers at once (not throttled by the failed attempt)'); assert.equal(stamps().length, 1)
    const a = got[0]
    assert.equal(typeof a.text, 'string'); assert.match(a.text as string, /^dazl scheduler problem/); assert.match(a.text as string, /scheduler stale: last completed run 3000s ago/)
    assert.equal(a.type, 'scheduler_check'); assert.equal(a.ok, false); assert.ok(Array.isArray(a.problems), 'the structured fields stay beside the text')
    assert.doesNotMatch(JSON.stringify(a), /0b0e7c1a|jane\.doe|@/, 'no id or email anywhere in the payload, text or structured fields'); assert.match(a.text as string, /\[id\]/); assert.match(a.text as string, /\[email\]/)
    r = await run(); assert.equal(r.code, 1); assert.equal(got.length, 1, 'the same problem is not re-sent within the interval')
    healthy = true; status = 500
    r = await run(); assert.equal(r.code, 1, 'a failed recovery delivery is not success'); assert.equal(got.length, 1); assert.equal(stamps().length, 1, 'the receipt stays until recovery is delivered')
    status = 200
    r = await run(); assert.equal(r.code, 0); assert.equal(got.length, 2); assert.equal(got[1].type, 'scheduler_recovered'); assert.match(got[1].text as string, /^dazl scheduler recovered/); assert.deepEqual(stamps(), [])
    r = await run(); assert.equal(r.code, 0); assert.equal(got.length, 2, 'recovery is announced once')
  } finally { hook.close(); app.close(); rmSync(T, { recursive: true, force: true }) }
})
