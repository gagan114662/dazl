// #1088: ops/uptime/probe.mjs, the external uptime probe, against a local stand-in for the health endpoints. Alerts go to
// UPTIME_ALERT_CMD (a script that appends its JSON argument to a file). No outside network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const probe = fileURLToPath(new URL('../../ops/uptime/probe.mjs', import.meta.url))
const T = mkdtempSync(path.join(tmpdir(), 'uptime-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

// the stand-in: /health and /scheduler answer whatever `mode` says
const mode = { health: 'ok' as 'ok' | '500' | 'notok' | 'hang', scheduler: 'fresh' }
const server = createServer((req, res) => {
  if (req.url === '/health') {
    if (mode.health === 'hang') return   // never answers
    if (mode.health === '500') { res.writeHead(500); res.end('{"ok":false,"secret":"SHOULD-NOT-LEAK"}'); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: mode.health === 'ok', commit: 'abc' })); return
  }
  if (req.url === '/scheduler') { res.writeHead(mode.scheduler === 'fresh' ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, operational: { state: mode.scheduler }, problems: ['1 tenant(s) with stale reply sync'] })); return }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
test.after(() => server.close())
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const alertLog = path.join(T, 'alerts.jsonl'), alertCmd = path.join(T, 'alert.sh'), failCmd = path.join(T, 'fail.sh')
writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${alertLog}\n`); chmodSync(alertCmd, 0o755)
writeFileSync(failCmd, '#!/bin/sh\nexit 3\n'); chmodSync(failCmd, 0o755)
const alerts = () => existsSync(alertLog) ? readFileSync(alertLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
// spawnSync would block this process's own server: run the probe async
const run = async (state: string, extra: string[] = [], env: Record<string, string> = {}) => {
  const { spawn } = await import('node:child_process')
  return await new Promise<{ code: number | null; out: string }>(resolve => {
    // a generous default timeout: a loaded CI box must not look like an outage
    const p = spawn(process.execPath, [probe, '--state', state, '--check', `web=${base}/health`, '--check', `sched=${base}/scheduler=scheduler`, ...(extra.includes('--timeout-ms') ? [] : ['--timeout-ms', '15000']), ...extra], { env: { PATH: process.env.PATH!, UPTIME_ALERT_CMD: alertCmd, ...env } as unknown as NodeJS.ProcessEnv })
    let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d }); p.on('close', code => resolve({ code, out }))
  })
}

test('up: exit 0, no alert; the scheduler rule reads the state, not the 503 for tenant-level problems', async () => {
  const st = path.join(T, 'a.json')
  const r = await run(st); assert.equal(r.code, 0, r.out); assert.match(r.out, /"ok":true/); assert.deepEqual(alerts(), [])
})

test('down after 2 failures in a row: one alert, a reminder only after the interval, one recovery notice', async () => {
  const st = path.join(T, 'b.json'); mode.health = '500'
  let r = await run(st); assert.equal(r.code, 1); assert.equal(alerts().length, 0, 'one failure is not an outage yet')
  r = await run(st); assert.equal(r.code, 1); let a = alerts(); assert.equal(a.length, 1)
  assert.deepEqual([a[0].check, a[0].state, a[0].reason, a[0].consecutive_failures, a[0].level], ['web', 'down', 'HTTP 500', 2, 'error'])
  assert.match(a[0].text, /dazl web is DOWN: HTTP 500/); assert.ok(!JSON.stringify(a[0]).includes('SHOULD-NOT-LEAK'), 'no response body in the alert')
  r = await run(st); assert.equal(alerts().length, 1, 'still down: no repeat inside the reminder interval')
  // the reminder: make the last alert look older than --remind-s
  const s = JSON.parse(readFileSync(st, 'utf8')); s.web.alerted_at -= 61_000; writeFileSync(st, JSON.stringify(s))
  r = await run(st, ['--remind-s', '60']); a = alerts(); assert.equal(a.length, 2); assert.equal(a[1].state, 'still_down'); assert.match(a[1].text, /STILL DOWN/)
  mode.health = 'ok'
  r = await run(st); assert.equal(r.code, 0, r.out); a = alerts(); assert.equal(a.length, 3); assert.deepEqual([a[2].check, a[2].state, a[2].level], ['web', 'recovered', 'info']); assert.match(a[2].text, /back UP/)
  r = await run(st); assert.equal(alerts().length, 3, 'recovered once')
})

test('a single blip between two good runs never alerts', async () => {
  const st = path.join(T, 'c.json'), before = alerts().length
  mode.health = 'notok'; let r = await run(st); assert.equal(r.code, 1); assert.match(r.out, /HTTP 200 but not/)
  mode.health = 'ok'; r = await run(st); assert.equal(r.code, 0)
  mode.health = '500'; r = await run(st); assert.equal(r.code, 1)
  mode.health = 'ok'; r = await run(st); assert.equal(alerts().length, before)
})

test('no answer, and a scheduler that is not fresh, are each reported with a reason built by the probe', async () => {
  const st = path.join(T, 'd.json'), before = alerts().length
  mode.health = 'hang'; mode.scheduler = 'stale'
  await run(st, ['--timeout-ms', '400']); const r = await run(st, ['--timeout-ms', '400']); assert.equal(r.code, 1)
  const a = alerts().slice(before); assert.deepEqual(a.map(x => [x.check, x.reason]).sort(), [['sched', 'scheduler state stale'], ['web', 'no answer in 400 ms']])
  mode.health = 'ok'; mode.scheduler = 'fresh'; await run(st)
})

test('an alert that was not delivered is retried on the next run; a recovery notice too', async () => {
  const st = path.join(T, 'e.json'), before = alerts().length
  mode.health = '500'
  await run(st, [], { UPTIME_ALERT_CMD: failCmd }); let r = await run(st, [], { UPTIME_ALERT_CMD: failCmd }); assert.equal(r.code, 1)
  assert.equal(JSON.parse(readFileSync(st, 'utf8')).web.down, false, 'not delivered: not recorded as alerted')
  r = await run(st); assert.equal(alerts().length, before + 1, 'delivered on the next run')
  mode.health = 'ok'
  r = await run(st, [], { UPTIME_ALERT_CMD: failCmd }); assert.equal(JSON.parse(readFileSync(st, 'utf8')).web.down, true, 'recovery not delivered: still owed')
  r = await run(st); const a = alerts().slice(before); assert.deepEqual(a.map(x => x.state), ['down', 'recovered'])
})

test('no destination: the outage is still counted and printed, and the alert is owed until one is set', async () => {
  const st = path.join(T, 'f.json'); mode.health = '500'
  await run(st, [], { UPTIME_ALERT_CMD: '' }); const r = await run(st, [], { UPTIME_ALERT_CMD: '' })
  assert.equal(r.code, 1); assert.match(r.out, /no usable alert destination/); assert.equal(JSON.parse(readFileSync(st, 'utf8')).web.down, false)
  mode.health = 'ok'
})

test('an outage whose DOWN alert never got through is still reported when the check comes back', async () => {
  const st = path.join(T, 'h.json'), before = alerts().length
  mode.health = '500'
  await run(st, [], { UPTIME_ALERT_CMD: failCmd }); await run(st, [], { UPTIME_ALERT_CMD: failCmd })
  mode.health = 'ok'
  const r = await run(st); assert.equal(r.code, 0, r.out)
  const a = alerts().slice(before); assert.equal(a.length, 1); assert.deepEqual([a[0].state, a[0].down_alert_delivered], ['recovered', false]); assert.match(a[0].text, /was DOWN .*HTTP 500.* back UP.*could not be delivered/)
  await run(st); assert.equal(alerts().length, before + 1, 'once')
})

test('a state file that cannot be written is exit 3, said in words', async () => {
  const blocker = path.join(T, 'not-a-dir'); writeFileSync(blocker, '')
  const r = await run(path.join(blocker, 'state.json')); assert.equal(r.code, 3, r.out); assert.match(r.out, /cannot write the state file/)
})

test('usage: a plain-http outside URL, a bad name and a missing --state are refused', () => {
  const sh = (args: string[]) => spawnSync(process.execPath, [probe, ...args], { encoding: 'utf8' })
  assert.equal(sh(['--check', 'a=https://x.example/h']).status, 2)
  assert.equal(sh(['--state', path.join(T, 'g.json'), '--check', 'a=http://example.com/h']).status, 2)
  assert.equal(sh(['--state', path.join(T, 'g.json'), '--check', 'Bad Name=https://x.example/h']).status, 2)
  assert.equal(sh(['--state', path.join(T, 'g.json'), '--fail-after', '0']).status, 2)
})
