// scripts/ops/scheduler-check.mts against a loopback stand-in for /api/health/scheduler: a problem alerts once per
// interval, recovery is announced once, an app that does not answer alerts, and nothing but counts is forwarded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('../', import.meta.url))
test('scheduler-check: alerts on problems (throttled), on an app that does not answer, and once on recovery', async () => {
  const T = mkdtempSync(path.join(tmpdir(), 'sched-check-'))
  let health: { status: number; body: object } = { status: 200, body: { ok: true, problems: [], operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0, held: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } } }
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
    health = { status: 200, body: { ok: true, problems: [], operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0, held: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } } }
    assert.equal(await run(), 0); assert.equal(sent().at(-1).type, 'scheduler_recovered')
    assert.equal(await run(), 0); assert.equal(sent().length, 2, 'recovery is announced once')
    assert.equal(await run('http://127.0.0.1:1/api/health/scheduler'), 1); assert.match(sent().at(-1).problems[0], /not answering/)
  } finally { server.close(); rmSync(T, { recursive: true, force: true }) }
})

test('failed alert delivery is retried, and failed recovery delivery keeps the original receipt', async () => {
  const t = mkdtempSync(path.join(tmpdir(), 'sched-retry-'))
  let healthy = false
  const server = http.createServer((_q, r) => { r.statusCode = healthy ? 200 : 503; r.end(JSON.stringify({ ok: healthy, problems: healthy ? [] : ['scheduler stale 3000s'], operational: { state: healthy ? 'fresh' : 'stale' }, tenants: { tracked: 1, blocked: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } })) })
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
  // A health endpoint that (wrongly) leaks identifiers, a token and extra fields: the payload is built at the send boundary from allowlisted counts and states only.
  let healthy = false
  const LEAK = 'sk-live-ABCDEF123456 jane.doe@example.com 0b0e7c1a-1111-4222-8333-444455556666'
  const app = http.createServer((_q, s) => { s.statusCode = healthy ? 200 : 503; s.end(JSON.stringify({ ok: healthy, problems: healthy ? [] : [`token ${LEAK}`, 42, null], operational: { state: healthy ? 'fresh' : 'stale', last_completed_age_s: 3000, last_error: LEAK }, tenants: { tracked: 2, blocked: healthy ? 0 : 1, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null, tenant_ids: [LEAK], note: LEAK } })) })
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
    assert.equal(typeof a.text, 'string'); assert.match(a.text as string, /^dazl scheduler problem/); assert.match(a.text as string, /scheduler stale: last completed run 3000s ago/); assert.match(a.text as string, /1 tenant\(s\) blocked by repeated failures/); assert.deepEqual(a.tenants, { tracked: 2, blocked: 1, reply_sync_stale: 0, overdue: 0 }, 'extra tenant fields are dropped')
    assert.equal(a.type, 'scheduler_check'); assert.equal(a.ok, false); assert.ok(Array.isArray(a.problems), 'the structured fields stay beside the text')
    assert.doesNotMatch(JSON.stringify(a), /sk-live|ABCDEF|0b0e7c1a|jane\.doe|@|tenant_ids|note/, 'no token, id, email or extra field anywhere in the payload, text or structured fields')
    r = await run(); assert.equal(r.code, 1); assert.equal(got.length, 1, 'the same problem is not re-sent within the interval')
    healthy = true; status = 500
    r = await run(); assert.equal(r.code, 1, 'a failed recovery delivery is not success'); assert.equal(got.length, 1); assert.equal(stamps().length, 1, 'the receipt stays until recovery is delivered')
    status = 200
    r = await run(); assert.equal(r.code, 0); assert.equal(got.length, 2); assert.equal(got[1].type, 'scheduler_recovered'); assert.match(got[1].text as string, /^dazl scheduler recovered/); assert.deepEqual(stamps(), [])
    r = await run(); assert.equal(r.code, 0); assert.equal(got.length, 2, 'recovery is announced once')
  } finally { hook.close(); app.close(); rmSync(T, { recursive: true, force: true }) }
})

test('the send boundary: tokens, arbitrary states, extra fields, malformed problem entries and non-JSON bodies never reach the alert and never crash the check', async () => {
  const T = mkdtempSync(path.join(tmpdir(), 'sched-bound-'))
  const LEAK = 'sk-live-ABCDEF123456 jane.doe@example.com 0b0e7c1a-1111-4222-8333-444455556666'
  const cases: { name: string; status: number; raw: string; expectProblem: RegExp }[] = [
    { name: 'token in problems', status: 503, raw: JSON.stringify({ ok: false, problems: [LEAK], operational: { state: 'stale', last_completed_age_s: 5 }, tenants: { tracked: 1 } }), expectProblem: /^scheduler stale: last completed run 5s ago$/ },
    { name: 'arbitrary state', status: 503, raw: JSON.stringify({ ok: false, problems: ['x'], operational: { state: LEAK }, tenants: { tracked: 1, blocked: 2 } }), expectProblem: /^2 tenant\(s\) blocked by repeated failures$/ },
    { name: 'non-string problems', status: 503, raw: JSON.stringify({ ok: false, problems: [1, null, { a: LEAK }, [LEAK]], operational: LEAK, tenants: LEAK }), expectProblem: /^HTTP 503, not ok$/ },
    { name: 'extra tenant fields and string numbers', status: 503, raw: JSON.stringify({ ok: false, operational: { state: 'crashed', last_completed_age_s: LEAK }, tenants: { tracked: LEAK, blocked: -1, overdue: 1.5, secret: LEAK } }), expectProblem: /^scheduler crashed: no completed run$/ },
    { name: 'not an object', status: 200, raw: JSON.stringify([LEAK]), expectProblem: /^HTTP 200, not ok$/ },
    { name: 'not JSON', status: 502, raw: `<html>${LEAK}</html>`, expectProblem: /^HTTP 502, not ok$/ },
    { name: 'ok must be literally true', status: 200, raw: JSON.stringify({ ok: 'yes', problems: [] }), expectProblem: /^HTTP 200, not ok$/ },
  ]
  try {
    for (const [i, c] of cases.entries()) {
      const server = http.createServer((_q, s) => { s.statusCode = c.status; s.end(c.raw) })
      await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
      const out = path.join(T, `out${i}`), cmd = path.join(T, `cmd${i}.sh`)
      writeFileSync(cmd, `#!/bin/sh\necho "$1" >> ${out}\n`); chmodSync(cmd, 0o755)
      const r = await new Promise<{ code: number | null; err: string }>(res => { let err = ''; const ch = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health/scheduler`, '--state-dir', path.join(T, `s${i}`)], { cwd: web, env: { ...process.env, SCHEDULER_ALERT_CMD: cmd, OPS_ALERT_WEBHOOK_URL: '' } }); ch.stderr.on('data', d => { err += d }); ch.on('close', code => res({ code, err })) })
      server.close()
      assert.equal(r.code, 1, `${c.name}: reported as a problem, not a crash (${r.err.slice(0, 200)})`); assert.doesNotMatch(r.err, /TypeError|at .*\.mts/, `${c.name}: no crash trace`)
      const sent = readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      assert.equal(sent.length, 1, c.name)
      assert.doesNotMatch(JSON.stringify(sent[0]), /sk-live|ABCDEF|0b0e7c1a|jane|@|secret/, `${c.name}: nothing from the response is copied`)
      assert.match(sent[0].problems[0], c.expectProblem, c.name)
      assert.deepEqual(Object.keys(sent[0].tenants ?? {}).filter(k => !['tracked', 'blocked', 'held', 'reply_sync_stale', 'overdue', 'oldest_overdue_s'].includes(k)), [], c.name)
    }
  } finally { rmSync(T, { recursive: true, force: true }) }
})

test('a prior alert is cleared only by a real recovery: 503 or contradictory or unreadable "ok:true" keeps the receipt and announces nothing', async () => {
  const T = mkdtempSync(path.join(tmpdir(), 'sched-recov-'))
  const healthy = { ok: true, problems: [], operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0, held: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } }
  const cases: { name: string; status: number; body: object | string; code: number; cleared: boolean; match?: RegExp }[] = [
    { name: '503 with ok:true, stale and a blocked tenant', status: 503, body: { ok: true, problems: [], operational: { state: 'stale', last_completed_age_s: 4000 }, tenants: { tracked: 2, blocked: 1 } }, code: 1, cleared: false, match: /^scheduler stale: last completed run 4000s ago$/ },
    { name: 'bare ok:true on 503', status: 503, body: { ok: true }, code: 1, cleared: false, match: /^HTTP 503, not ok$/ },
    { name: 'ok:true on 503 even with healthy-looking fields', status: 503, body: healthy, code: 1, cleared: false, match: /^HTTP 503, not ok$/ },
    { name: '200 ok:true but stale and blocked', status: 200, body: { ok: true, operational: { state: 'stale' }, tenants: { tracked: 1, blocked: 1 } }, code: 1, cleared: false },
    { name: '200 ok:true with no usable fields', status: 200, body: { ok: true }, code: 1, cleared: false, match: /^scheduler health unreadable \(HTTP 200\)$/ },
    { name: '200 ok:true with an unknown state', status: 200, body: { ok: true, operational: { state: 'whatever' }, tenants: { tracked: 1 } }, code: 1, cleared: false, match: /^scheduler health unreadable/ },
    { name: '200 fresh with blocked as a string, negative stale, null overdue', status: 200, body: { ok: true, operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: '0', reply_sync_stale: -1, overdue: null, oldest_overdue_s: null } }, code: 1, cleared: false, match: /^scheduler health unreadable \(HTTP 200\)$/ },
    { name: '200 fresh with a safety count missing (no overdue)', status: 200, body: { ok: true, operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0, reply_sync_stale: 0 } }, code: 1, cleared: false, match: /^scheduler health unreadable/ },
    { name: '200 fresh with a fractional count', status: 200, body: { ok: true, operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0.5, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } }, code: 1, cleared: false, match: /^scheduler health unreadable/ },
    { name: '200 fresh with oldest_overdue_s of the wrong type', status: 200, body: { ok: true, operational: { state: 'fresh' }, tenants: { tracked: 2, blocked: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: 'soon' } }, code: 1, cleared: false, match: /^scheduler health unreadable/ },
    { name: 'a legitimate idle scheduler with nothing tracked recovers', status: 200, body: { ok: true, operational: { state: 'never_ran' }, tenants: { tracked: 0, blocked: 0, held: 0, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } }, code: 0, cleared: true },
    { name: 'a running scheduler with a tenant on hold recovers', status: 200, body: { ok: true, operational: { state: 'running' }, tenants: { tracked: 3, blocked: 0, held: 1, reply_sync_stale: 0, overdue: 0, oldest_overdue_s: null } }, code: 0, cleared: true },
    { name: 'a real recovery', status: 200, body: healthy, code: 0, cleared: true },
  ]
  try {
    for (const [i, c] of cases.entries()) {
      const server = http.createServer((_q, s) => { s.statusCode = c.status; s.end(JSON.stringify(c.body)) })
      await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
      const state = path.join(T, `s${i}`), out = path.join(T, `out${i}`), cmd = path.join(T, `cmd${i}.sh`)
      mkdirSync(state, { recursive: true }); writeFileSync(path.join(state, 'alert-seeded0123456789'), '')   // a prior alert receipt
      writeFileSync(cmd, `#!/bin/sh\necho "$1" >> ${out}\n`); chmodSync(cmd, 0o755)
      const code = await new Promise<number | null>(res => { const ch = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/ops/scheduler-check.mts', '--url', `http://127.0.0.1:${(server.address() as { port: number }).port}/api/health/scheduler`, '--state-dir', state], { cwd: web, env: { ...process.env, SCHEDULER_ALERT_CMD: cmd, OPS_ALERT_WEBHOOK_URL: '' } }); ch.on('close', res) })
      server.close()
      const sent = existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
      assert.equal(code, c.code, c.name)
      assert.equal(existsSync(path.join(state, 'alert-seeded0123456789')), !c.cleared, `${c.name}: the prior receipt is ${c.cleared ? 'cleared' : 'kept'}`)
      assert.ok(!sent.some(m => m.type === 'scheduler_recovered') === !c.cleared, `${c.name}: recovery is ${c.cleared ? '' : 'not '}announced`)
      if (c.match) assert.match(sent[0].problems[0], c.match, c.name)
    }
  } finally { rmSync(T, { recursive: true, force: true }) }
})
