#!/usr/bin/env node
// External uptime probe for dazl (issue #1088). Runs every minute on a machine that is NOT the production box (its
// whole point is to notice when the box, its network or Caddy is gone), from ops/uptime/dazl-uptime.timer or cron.
// Free: Node 20+ and this one file, no account, no dependency. It reads public health endpoints only.
//
//   node ops/uptime/probe.mjs --state ~/.local/state/dazl-uptime.json [--check name=url[=rule]]...
//
// Checks (default when no --check is given):
//   prod            https://dazl.ai/api/health                    rule http: answers 200 with {"ok":true}
//   prod-scheduler  https://dazl.ai/api/health/scheduler          rule scheduler: operational.state is fresh or running
//   staging         https://staging.dazl.ai/api/health            rule http
// The scheduler rule looks at the scheduler's own state only; tenant-level problems (the endpoint's 503) are the
// on-box scheduler check's alert, not an outage.
// A check is DOWN after --fail-after (2) consecutive failures, i.e. about 2 minutes at one run a minute: one alert when
// it goes down, a reminder every --remind-s (3600) while it stays down, one "recovered" notice when it is back.
// Alerts go to OPS_ALERT_WEBHOOK_URL (the environment only, never a flag: a bot token on the command line would show in `ps`): the same destinations as the app's own alerts
// (web/lib/ops/alert-destination.ts): a Telegram bot URL https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
// gets { chat_id, text }; any other https URL gets JSON with a Slack-compatible `text`. UPTIME_ALERT_CMD (tests) runs a
// command with the JSON as its argument instead. The alert carries check names, URLs, HTTP status or error class and
// times: no response body. A state change is recorded only after its alert was DELIVERED, so a failed send is retried
// on the next run. The alert URL is never printed.
// A redirect is not followed: a health URL that answers 301 is reported as "HTTP 301" (give the final URL).
// Stalled workspaces (#1090): a scheduler-rule answer also carries `stalls` (web/lib/ops/stalls.ts: mailboxes that need
// reconnect, workspaces with autopilot on and everything held for over 24 h, scans stuck running), counts only. While
// any count is above zero one alert goes out, then one every --stall-remind-s (86400: once a day) until all are zero
// again. It is not an outage: it does not change the exit code.
//   node ops/uptime/probe.mjs --test-alert     sends one test message to the alert destination and exits (0 = delivered,
//                                              1 = not): the operator's "do alerts arrive?" check. Probes nothing.
// Exit 0 = every check up; 1 = at least one failing or down; 2 = usage; 3 = the state file cannot be written.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const all = f => argv.flatMap((a, i) => a === f && argv[i + 1] !== undefined ? [argv[i + 1]] : [])
const one = f => all(f).pop()
const usage = why => { console.error(`uptime-probe: ${why}\nusage: probe.mjs --state FILE [--check name=url[=http|scheduler]]... [--fail-after N] [--remind-s S] [--stall-remind-s S] [--timeout-ms MS]\n       probe.mjs --test-alert`); process.exit(2) }
const int = (f, d, min) => { const v = one(f); if (v === undefined) return d; const n = Number(v); if (!Number.isSafeInteger(n) || n < min) usage(`${f} must be an integer >= ${min}`); return n }
const testAlert = argv.includes('--test-alert')
const stateFile = one('--state'); if (!stateFile && !testAlert) usage('--state FILE is required')
const failAfter = int('--fail-after', 2, 1), remindS = int('--remind-s', 3600, 60), stallRemindS = int('--stall-remind-s', 86_400, 60), timeoutMs = int('--timeout-ms', 10_000, 100)
const DEFAULTS = ['prod=https://dazl.ai/api/health=http', 'prod-scheduler=https://dazl.ai/api/health/scheduler=scheduler', 'staging=https://staging.dazl.ai/api/health=http']
const checks = (all('--check').length ? all('--check') : DEFAULTS).map(spec => {
  const m = /^([a-z0-9][a-z0-9-]{0,31})=(.+?)(?:=(http|scheduler))?$/.exec(spec); if (!m) usage(`bad --check ${JSON.stringify(spec)} (name=url[=http|scheduler])`)
  let u; try { u = new URL(m[2]) } catch { usage(`bad URL in --check ${m[1]}`) }
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) usage(`--check ${m[1]}: the URL must be https (or loopback)`)
  return { name: m[1], url: u.href, rule: m[3] ?? 'http' }
})
if (new Set(checks.map(c => c.name)).size !== checks.length) usage('two --check entries share a name')

// #1090: the stall counts a scheduler answer carried, per check name: known keys, whole numbers only (nothing else is read)
const STALLS = [['needs_reconnect', 'mailbox(es) need reconnect'], ['held_over_24h', 'workspace(s) with autopilot on and everything held for over 24 h'], ['scans_stuck', 'scan(s) stuck running']]
const stallsSeen = new Map()
function readStalls(c, body) {
  const st = body && typeof body === 'object' && body.stalls && typeof body.stalls === 'object' ? body.stalls : null
  if (st && STALLS.every(([k]) => Number.isSafeInteger(st[k]) && st[k] >= 0)) stallsSeen.set(c.name, Object.fromEntries(STALLS.map(([k]) => [k, st[k]])))
}

// one probe: null = up, else a short reason built here (never the response body)
async function probe(c) {
  try {
    const r = await fetch(c.url, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'dazl-uptime-probe' } })
    const body = await r.json().catch(() => undefined)
    if (c.rule === 'scheduler') {
      readStalls(c, body)
      const s = body && typeof body === 'object' && body.operational && typeof body.operational === 'object' ? body.operational.state : undefined
      if (typeof s !== 'string' || !/^[a-z_]{1,20}$/.test(s)) return `HTTP ${r.status}, no scheduler state in the answer`
      return s === 'fresh' || s === 'running' ? null : `scheduler state ${s}`
    }
    if (r.status !== 200) return `HTTP ${r.status}`
    return body && typeof body === 'object' && body.ok === true ? null : 'HTTP 200 but not {"ok":true}'
  } catch (e) {
    const n = e instanceof Error ? e.name : 'Error', code = e instanceof Error && e.cause && typeof e.cause === 'object' && typeof e.cause.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(e.cause.code) ? ` ${e.cause.code}` : ''
    return n === 'TimeoutError' ? `no answer in ${timeoutMs} ms` : `${['TypeError', 'AbortError'].includes(n) ? 'connection failed' : 'error'}${code}`
  }
}

// state: per check { fails, down, since, alerted_at, reason }. An unreadable state file starts clean (and says so).
let state = {}
if (stateFile) try { const j = JSON.parse(readFileSync(stateFile, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) state = j } catch (e) { if (e?.code !== 'ENOENT') console.error('uptime-probe: state file unreadable, starting clean') }
const now = Date.now(), iso = t => new Date(t).toISOString()

// the destination's body (mirrors web/lib/ops/alert-destination.ts; this file must run on a machine with no checkout)
function alertRequest(url, payload, text) {
  if (!url || !/^https:\/\//.test(url)) return null
  let u; try { u = new URL(url) } catch { return null }
  const tg = u.hostname.replace(/\.$/, '').toLowerCase() === 'api.telegram.org'
  if (tg && !/^\/bot[^/]+\/sendMessage$/.test(u.pathname)) return null
  if (tg) {
    const chat = u.searchParams.get('chat_id')?.trim()
    if (!chat || !/^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$/.test(chat)) return null
    return { url: `${u.origin}${u.pathname}`, body: JSON.stringify({ chat_id: /^-?\d{1,15}$/.test(chat) ? Number(chat) : chat, text: text.slice(0, 4000) || 'dazl alert', disable_web_page_preview: true }) }
  }
  return { url, body: JSON.stringify({ text, ...payload }) }
}
async function send(payload, text) {
  const cmd = process.env.UPTIME_ALERT_CMD
  if (cmd) { const r = spawnSync(cmd, [JSON.stringify({ text, ...payload })], { stdio: 'inherit', timeout: 10_000, killSignal: 'SIGKILL' }); return !r.error && r.status === 0 }
  const req = alertRequest(process.env.OPS_ALERT_WEBHOOK_URL, payload, text)
  if (!req) { console.error('uptime-probe: no usable alert destination (OPS_ALERT_WEBHOOK_URL: an https webhook, or https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>)'); return false }
  try {
    const r = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!r.ok) console.error(`uptime-probe: alert destination answered HTTP ${r.status}`)
    return r.ok
  } catch (e) { console.error(`uptime-probe: alert not delivered (${e instanceof Error ? e.name : 'error'})`); return false }
}

if (testAlert) {
  const ok = await send({ type: 'uptime', level: 'info', state: 'test', host: os.hostname(), at: iso(now) }, `dazl test alert from ${os.hostname()} at ${iso(now)}: alerts reach this destination. Nothing is wrong.`)
  console.log(JSON.stringify({ level: ok ? 'info' : 'error', type: 'uptime_test_alert', delivered: ok, at: iso(now) }))
  process.exit(ok ? 0 : 1)
}

const results = await Promise.all(checks.map(async c => ({ c, reason: await probe(c) })))
const next = {}, lines = []
let bad = 0
for (const { c, reason } of results) {
  const prev = state[c.name] && typeof state[c.name] === 'object' ? state[c.name] : {}
  const s = { fails: Number.isSafeInteger(prev.fails) ? prev.fails : 0, down: prev.down === true, since: typeof prev.since === 'number' ? prev.since : null, alerted_at: typeof prev.alerted_at === 'number' ? prev.alerted_at : null, reason: typeof prev.reason === 'string' ? prev.reason : null }
  const base = { type: 'uptime', check: c.name, url: c.url, host: os.hostname(), at: iso(now) }
  if (reason === null) {
    if (s.down) {
      const mins = s.since ? Math.max(1, Math.round((now - s.since) / 60_000)) : null
      const ok = await send({ ...base, level: 'info', state: 'recovered', down_since: s.since ? iso(s.since) : null }, `dazl ${c.name} is back UP (${c.url})${mins ? ` after about ${mins} min` : ''}.`)
      // a recovery notice that could not be sent is retried next run: the check stays "down" in the state until it is delivered
      next[c.name] = ok ? { fails: 0, down: false, since: null, alerted_at: null, reason: null } : s
    } else {
      // it was failing long enough to be an outage but the DOWN alert never got through: the outage must not vanish
      if (s.fails >= failAfter) {
        const mins = s.since ? Math.max(1, Math.round((now - s.since) / 60_000)) : null
        const ok = await send({ ...base, level: 'info', state: 'recovered', down_since: s.since ? iso(s.since) : null, down_alert_delivered: false },
          `dazl ${c.name} was DOWN${mins ? ` for about ${mins} min` : ''} (${s.reason ?? 'no answer'}) and is back UP (${c.url}). The DOWN alert could not be delivered at the time.`)
        if (!ok) console.error(`uptime-probe: ${c.name} was down for ${s.fails} checks and recovered; neither alert could be delivered`)
      }
      next[c.name] = { fails: 0, down: false, since: null, alerted_at: null, reason: null }
    }
    lines.push({ check: c.name, up: true })
    continue
  }
  bad++
  s.fails += 1; s.reason = reason; if (s.since === null) s.since = now
  const due = s.fails >= failAfter && (!s.down || s.alerted_at === null || now - s.alerted_at >= remindS * 1000)
  if (due) {
    const mins = Math.max(1, Math.round((now - s.since) / 60_000))
    const ok = await send({ ...base, level: 'error', state: s.down ? 'still_down' : 'down', reason, failing_since: iso(s.since), consecutive_failures: s.fails },
      `dazl ${c.name} is ${s.down ? 'STILL DOWN' : 'DOWN'}: ${reason} (${c.url}), failing for about ${mins} min, ${s.fails} checks in a row. Seen from ${os.hostname()}.`)
    if (ok) { s.down = true; s.alerted_at = now }   // not delivered: stays un-alerted, so the next run tries again
  }
  next[c.name] = s
  lines.push({ check: c.name, up: false, reason, consecutive_failures: s.fails, alerted: s.down })
}
// #1090 stalled workspaces: one alert when a count is above zero, then one every --stall-remind-s while any still is.
// state._stalls[check] = when the last one was DELIVERED (a failed send is owed again next run). All zero: forgotten, so
// the next stall alerts at once. An answer without readable counts changes nothing.
const prevStalls = state._stalls && typeof state._stalls === 'object' ? state._stalls : {}, nextStalls = {}
for (const c of checks) {
  const last = typeof prevStalls[c.name] === 'number' ? prevStalls[c.name] : null, seen = stallsSeen.get(c.name)
  if (!seen) { if (last !== null) nextStalls[c.name] = last; continue }
  const parts = STALLS.filter(([k]) => seen[k] > 0).map(([k, words]) => `${seen[k]} ${words}`)
  if (!parts.length) continue
  if (last !== null && now - last < stallRemindS * 1000) { nextStalls[c.name] = last; continue }
  const ok = await send({ type: 'uptime', check: c.name, url: c.url, host: os.hostname(), at: iso(now), level: 'warn', state: 'stalled', stalls: seen },
    `dazl ${c.name}: work is stalled for some workspaces: ${parts.join(', ')}. Repeats every ${Math.round(stallRemindS / 3600) || 1} h until all are zero (${c.url}).`)
  if (ok) nextStalls[c.name] = now; else if (last !== null) nextStalls[c.name] = last
  lines.push({ check: c.name, stalled: seen, alerted: ok })
}
if (Object.keys(nextStalls).length) next._stalls = nextStalls
// a state that cannot be written would make every run alert again: say so and exit 3 (a real unit failure, unlike exit 1)
try {
  mkdirSync(path.dirname(path.resolve(stateFile)), { recursive: true, mode: 0o700 })
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(next), { mode: 0o600 }); renameSync(`${stateFile}.tmp`, stateFile)
} catch (e) { console.error(`uptime-probe: cannot write the state file (${e?.code ?? 'error'}): alerts will repeat until this is fixed`); process.exit(3) }
console.log(JSON.stringify({ level: bad ? 'error' : 'info', type: 'uptime_probe', ok: bad === 0, at: iso(now), checks: lines }))
process.exit(bad ? 1 : 0)
