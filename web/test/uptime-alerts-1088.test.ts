// #1088 / #1090: the uptime probe's install path and what the operator runs, against local stand-ins only.
//   - a real POST to OPS_ALERT_WEBHOOK_URL (a stub https webhook with a throwaway certificate): DOWN after two failures
//     in a row, one notice on recovery;
//   - ops/uptime/send-test-alert.sh: one test message, exit 1 when the destination refuses or none is configured;
//   - stalled workspaces (#1090): one alert while any count is above zero, again only after a day, none once all are zero;
//   - ops/uptime/install.sh into a scratch root with a stand-in systemctl, and the units it installs.
// The probe's own state machine is in test/uptime-probe-1088.test.ts. No outside network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UPTIME = fileURLToPath(new URL('../../ops/uptime/', import.meta.url))
const probe = path.join(UPTIME, 'probe.mjs'), sendTest = path.join(UPTIME, 'send-test-alert.sh'), install = path.join(UPTIME, 'install.sh')
const T = mkdtempSync(path.join(tmpdir(), 'uptime-alerts-'))
test.after(() => rmSync(T, { recursive: true, force: true }))

// the app's stand-in: /health and /scheduler answer whatever `mode` says
const mode = { health: 200, stalls: { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 } as Record<string, unknown> | null }
const app = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(mode.health, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: mode.health === 200 })); return }
  if (req.url === '/scheduler') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, operational: { state: 'fresh' }, stalls: mode.stalls, tenant: 'SHOULD-NOT-LEAK' })); return }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => app.listen(0, '127.0.0.1', r))
test.after(() => app.close())
const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`

// the stub webhook: https (the probe refuses anything else), a certificate made here for localhost
const key = path.join(T, 'key.pem'), cert = path.join(T, 'cert.pem')
const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' })
const haveTls = made.status === 0 && existsSync(cert)
const hook = { status: 200, got: [] as Record<string, unknown>[] }
let hookUrl = ''
if (haveTls) {
  const srv = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    let b = ''; req.on('data', d => { b += d }); req.on('end', () => {
      // `got` is what the destination ACCEPTED
      if (hook.status === 200 && req.method === 'POST' && req.url === '/hook' && req.headers['content-type'] === 'application/json') hook.got.push(JSON.parse(b))
      res.writeHead(hook.status); res.end('{}')
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  test.after(() => srv.close())
  hookUrl = `https://localhost:${(srv.address() as { port: number }).port}/hook`
}
const tls = { skip: haveTls ? false : 'openssl is not available to make a throwaway certificate' }

// the servers above live in this process: children run async so they can be answered
const exec = (cmd: string, args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>(resolve => {
  const p = spawn(cmd, args, { env: { PATH: process.env.PATH!, NODE_EXTRA_CA_CERTS: cert, ...env } as unknown as NodeJS.ProcessEnv })
  let out = ''; p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d }); p.on('close', code => resolve({ code, out }))
})
const run = (state: string, extra: string[] = [], env: Record<string, string> = {}) =>
  exec(process.execPath, [probe, '--state', state, '--check', `web=${base}/health`, '--check', `sched=${base}/scheduler=scheduler`, '--timeout-ms', '15000', ...extra], env)

test('the webhook gets one POST when health fails twice in a row and one when it recovers', tls, async () => {
  const st = path.join(T, 'hook.json'), env = { OPS_ALERT_WEBHOOK_URL: hookUrl }
  hook.got = []; mode.health = 503
  let r = await run(st, [], env); assert.equal(r.code, 1, r.out); assert.equal(hook.got.length, 0, 'one failure is not an outage')
  r = await run(st, [], env); assert.equal(r.code, 1, r.out); assert.equal(hook.got.length, 1, r.out)
  assert.deepEqual([hook.got[0].check, hook.got[0].state, hook.got[0].reason, hook.got[0].consecutive_failures], ['web', 'down', 'HTTP 503', 2])
  assert.match(String(hook.got[0].text), /dazl web is DOWN: HTTP 503/)
  r = await run(st, [], env); assert.equal(hook.got.length, 1, 'still down: not repeated inside the reminder interval')
  mode.health = 200
  r = await run(st, [], env); assert.equal(r.code, 0, r.out); assert.equal(hook.got.length, 2)
  assert.equal(hook.got[1].state, 'recovered'); assert.match(String(hook.got[1].text), /back UP/)
  r = await run(st, [], env); assert.equal(hook.got.length, 2, 'recovered once')
  assert.ok(!r.out.includes(hookUrl), 'the alert URL is never printed')
})

test('a webhook that refuses the alert leaves it owed: it is sent again on the next run', tls, async () => {
  const st = path.join(T, 'refused.json'), env = { OPS_ALERT_WEBHOOK_URL: hookUrl }
  hook.got = []; mode.health = 503; hook.status = 500
  await run(st, [], env); const r = await run(st, [], env)
  assert.match(r.out, /alert destination answered HTTP 500/); assert.equal(JSON.parse(readFileSync(st, 'utf8')).web.down, false)
  hook.status = 200; hook.got = []
  await run(st, [], env); assert.equal(hook.got.length, 1); assert.equal(hook.got[0].state, 'down')
  mode.health = 200; await run(st, [], env)
})

test('send-test-alert.sh: one test message from the env file; exit 1 when refused, unset or unreadable', tls, async () => {
  const envFile = path.join(T, 'env'); writeFileSync(envFile, `# the alert destination\nOPS_ALERT_WEBHOOK_URL=${hookUrl}\n`, { mode: 0o600 })
  hook.got = []; hook.status = 200
  let r = await exec('bash', [sendTest, envFile]); assert.equal(r.code, 0, r.out); assert.match(r.out, /send-test-alert: delivered/)
  assert.equal(hook.got.length, 1); assert.equal(hook.got[0].state, 'test'); assert.match(String(hook.got[0].text), /^dazl test alert from .*Nothing is wrong\.$/)
  assert.ok(!r.out.includes(hookUrl), 'the alert URL is never printed')
  r = await exec('bash', [sendTest, '-'], { OPS_ALERT_WEBHOOK_URL: hookUrl }); assert.equal(r.code, 0, r.out); assert.equal(hook.got.length, 2, 'the URL from the environment')
  hook.status = 403
  r = await exec('bash', [sendTest, envFile]); assert.equal(r.code, 1); assert.match(r.out, /answered HTTP 403/); assert.match(r.out, /NOT delivered/)
  hook.status = 200
  const empty = path.join(T, 'env-empty'); writeFileSync(empty, '')
  r = await exec('bash', [sendTest, empty]); assert.equal(r.code, 1); assert.match(r.out, /no OPS_ALERT_WEBHOOK_URL/)
  r = await exec('bash', [sendTest, path.join(T, 'no-such-env')]); assert.equal(r.code, 1); assert.match(r.out, /cannot read/)
  r = await exec('bash', [sendTest, '-']); assert.equal(r.code, 1); assert.match(r.out, /no usable alert destination/)
  assert.equal(hook.got.length, 2, 'nothing else was sent')
})

// the stall alerts go through UPTIME_ALERT_CMD (a script that appends its JSON argument to a file): no TLS needed
const alertLog = path.join(T, 'alerts.jsonl'), alertCmd = path.join(T, 'alert.sh'), failCmd = path.join(T, 'fail.sh')
writeFileSync(alertCmd, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${alertLog}\n`); chmodSync(alertCmd, 0o755)
writeFileSync(failCmd, '#!/bin/sh\nexit 3\n'); chmodSync(failCmd, 0o755)
const alerts = () => existsSync(alertLog) ? readFileSync(alertLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const DAY_MS = 86_400_000

test('stalled workspaces (#1090): one alert while a count is above zero, again after a day, none once all are zero', async () => {
  const st = path.join(T, 'stalls.json'), env = { UPTIME_ALERT_CMD: alertCmd }
  const age = (ms: number) => { const s = JSON.parse(readFileSync(st, 'utf8')); s._stalls.sched -= ms; writeFileSync(st, JSON.stringify(s)) }
  mode.health = 200; mode.stalls = { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 }
  let r = await run(st, [], env); assert.equal(r.code, 0, r.out); assert.equal(alerts().length, 0, 'all zero: nothing to say')
  mode.stalls = { needs_reconnect: 2, held_over_24h: 1, scans_stuck: 0 }
  r = await run(st, [], env); assert.equal(r.code, 0, 'stalled workspaces are not an outage'); let a = alerts(); assert.equal(a.length, 1, r.out)
  assert.deepEqual([a[0].check, a[0].state, a[0].level, a[0].stalls], ['sched', 'stalled', 'warn', { needs_reconnect: 2, held_over_24h: 1, scans_stuck: 0 }])
  assert.match(a[0].text, /2 mailbox\(es\) need reconnect, 1 workspace\(s\) with autopilot on and everything held for over 24 h\. Repeats every 24 h/)
  assert.ok(!a[0].text.includes('scan'), 'a zero count is not mentioned'); assert.ok(!JSON.stringify(a[0]).includes('SHOULD-NOT-LEAK'), 'counts only')
  await run(st, [], env); age(DAY_MS - 120_000); await run(st, [], env); assert.equal(alerts().length, 1, 'not again within the day')
  age(180_000)
  mode.stalls = { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 3 }
  r = await run(st, [], env); a = alerts(); assert.equal(a.length, 2, 'a day later, still stalled: once more'); assert.match(a[1].text, /: 3 scan\(s\) stuck running\. /)
  mode.stalls = { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 }
  r = await run(st, [], env); assert.equal(alerts().length, 2); assert.equal(JSON.parse(readFileSync(st, 'utf8'))._stalls, undefined, 'cleared: forgotten')
  mode.stalls = { needs_reconnect: 1, held_over_24h: 0, scans_stuck: 0 }
  r = await run(st, [], env); assert.equal(alerts().length, 3, 'a new stall after a clear alerts at once')
})

test('stalled workspaces: an undelivered alert is owed; an answer without readable counts changes nothing', async () => {
  const st = path.join(T, 'stalls-owed.json'), before = alerts().length
  mode.stalls = { needs_reconnect: 1, held_over_24h: 0, scans_stuck: 0 }
  let r = await run(st, [], { UPTIME_ALERT_CMD: failCmd }); assert.equal(r.code, 0); assert.equal(JSON.parse(readFileSync(st, 'utf8'))._stalls, undefined, 'not delivered: not recorded')
  r = await run(st, [], { UPTIME_ALERT_CMD: alertCmd }); assert.equal(alerts().length, before + 1, 'delivered on the next run')
  const at = JSON.parse(readFileSync(st, 'utf8'))._stalls.sched; assert.equal(typeof at, 'number')
  for (const odd of [null, { needs_reconnect: 'many', held_over_24h: 0, scans_stuck: 0 }, { needs_reconnect: -1, held_over_24h: 0, scans_stuck: 0 }, { needs_reconnect: 1 }]) {
    mode.stalls = odd
    r = await run(st, [], { UPTIME_ALERT_CMD: alertCmd }); assert.equal(r.code, 0, r.out)
    assert.equal(alerts().length, before + 1); assert.equal(JSON.parse(readFileSync(st, 'utf8'))._stalls.sched, at, 'the last delivery time is kept')
  }
  mode.stalls = { needs_reconnect: 0, held_over_24h: 0, scans_stuck: 0 }
})

test('install.sh puts the probe, the units and an empty root-only env file in place and enables the timer; a second run keeps the env', () => {
  const root = path.join(T, 'root'), bin = path.join(T, 'bin'), log = path.join(T, 'systemctl.log'); mkdirSync(root); mkdirSync(bin)
  writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> ${log}\n`); chmodSync(path.join(bin, 'systemctl'), 0o755)
  const sh = (args: string[] = []) => spawnSync('bash', [install, ...args], { encoding: 'utf8', env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, UPTIME_ROOT: root, UPTIME_SYSTEMCTL: path.join(bin, 'systemctl') } as unknown as NodeJS.ProcessEnv })
  let r = sh(); assert.equal(r.status, 0, r.stdout + r.stderr)
  const same = (installed: string, source: string) => assert.equal(readFileSync(path.join(root, installed), 'utf8'), readFileSync(path.join(UPTIME, source), 'utf8'), installed)
  same('usr/local/lib/dazl-uptime/probe.mjs', 'probe.mjs'); same('usr/local/lib/dazl-uptime/send-test-alert.sh', 'send-test-alert.sh')
  same('etc/systemd/system/dazl-uptime.service', 'dazl-uptime-system.service'); same('etc/systemd/system/dazl-uptime.timer', 'dazl-uptime.timer')
  const env = path.join(root, 'etc/dazl-uptime/env')
  assert.equal(readFileSync(env, 'utf8'), '', 'the installer never writes the alert URL'); assert.equal(statSync(env).mode & 0o777, 0o600)
  assert.equal(statSync(path.join(root, 'usr/local/lib/dazl-uptime/send-test-alert.sh')).mode & 0o111, 0o111)
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['daemon-reload', 'enable --now dazl-uptime.timer'])
  writeFileSync(env, 'OPS_ALERT_WEBHOOK_URL=https://hooks.example/x\n')
  r = sh(); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /env kept as it is/)
  assert.equal(readFileSync(env, 'utf8'), 'OPS_ALERT_WEBHOOK_URL=https://hooks.example/x\n')
  assert.equal(sh(['extra']).status, 2)
})

test('the system unit runs the installed probe as a throwaway unprivileged user, from the every-minute timer', () => {
  const unit = readFileSync(path.join(UPTIME, 'dazl-uptime-system.service'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
  assert.ok(unit.includes('DynamicUser=yes')); assert.ok(!unit.some(l => /^User=/.test(l)), 'no fixed user, so never root')
  assert.ok(unit.includes('Type=oneshot')); assert.ok(unit.includes('EnvironmentFile=/etc/dazl-uptime/env')); assert.ok(unit.includes('StateDirectory=dazl-uptime'))
  assert.ok(unit.includes('ExecStart=/usr/bin/env node /usr/local/lib/dazl-uptime/probe.mjs --state %S/dazl-uptime/state.json'))
  assert.ok(unit.includes('SuccessExitStatus=1'), 'a failing check is the probe working, not a failed unit')
  const timer = readFileSync(path.join(UPTIME, 'dazl-uptime.timer'), 'utf8')
  assert.match(timer, /^OnCalendar=\*:0\/1$/m); assert.match(timer, /^WantedBy=timers\.target$/m)
  // the two-failures rule and the daily stall reminder are the probe's defaults: the unit passes no flag that changes them
  const src = readFileSync(probe, 'utf8')
  assert.match(src, /int\('--fail-after', 2, 1\)/); assert.match(src, /int\('--stall-remind-s', 86_400, 60\)/)
  assert.match(src, /prod=https:\/\/dazl\.ai\/api\/health=http/)
})
