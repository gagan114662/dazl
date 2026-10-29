// scripts/ops/scheduler-check.mts against a loopback stand-in for /api/health/scheduler: a problem alerts once per
// interval, recovery is announced once, an app that does not answer alerts, and nothing but counts is forwarded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
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
