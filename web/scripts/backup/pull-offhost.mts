// The off-host copy with no bucket (issue #1080): run on an operator machine that can already ssh to the box, it PULLS
// the box's encrypted copies (offhost-copy.sh writes them to a directory destination there, OFFHOST_DEST) into a
// directory on this machine. Free: rsync and ssh only, storage the operator already has, no cloud account, no IAM, and
// no credential on the box for this machine.
//   node --experimental-strip-types scripts/backup/pull-offhost.mts --from HOST: --to DIR [--ack ACKHOST] [--max-age-s 7200]
// HOST's key is restricted on the box to `rrsync -ro <outbox>`, so the path after "HOST:" is relative to the outbox
// (empty = the outbox itself). Each run:
//   1. rsync over ssh (BatchMode: never prompts) copies the dazl-backup-*.db.age / dazl-ledger-*.jsonl.age files and
//      their .json manifests that are not here yet, minus the names this machine already retired (.retired/names), so
//      a retired copy is never pulled again. Nothing here is overwritten or removed by the box's side; half-written
//      files (.partial on the box, rsync's own temp files) never land under a copy's name.
//   2. every copy here with a manifest is checked: the ciphertext must have the manifest's bytes and sha256. A copy that
//      fails, or whose times lie in the future, is moved to .bad/ (never restored from) and is a problem.
//   3. problems (each alerts, and none of them lets retention run): the pull failed; a copy failed its check; a copy
//      new this run is named OLDER than the newest copy already held (a box never backdates a copy: this is how a box
//      that writes fake old copies to push real ones out of retention is caught); a ciphertext still has no manifest
//      after two hours; there is no checked backup copy, or the newest is older than --max-age-s (7200); there is no
//      deletion-ledger copy.
//   4. retention, only when there is no problem: the box's policy (retainedCopies in offhost.mts, RETAIN_OFFHOST_HOURLY
//      48 / _DAILY 14 / _WEEKLY 8), per kind. Nothing is deleted outright: a copy past the policy is MOVED to .retired/,
//      at most RETIRE_MAX_PER_RUN (3) per kind per run (more due is an alert, so a flood of fake new copies cannot push
//      the real ones out quietly), and a retired copy is deleted only RETIRED_KEEP_DAYS (7) after it was retired.
//   5. after a run with no problem, `ssh ACKHOST` (a second key whose only command, on the box, touches the pull marker
//      that backup-check.mts reads as OFFHOST_PULL_MARKER): so the box alerts when this machine stops pulling.
// Alerts go to OPS_ALERT_WEBHOOK_URL (https; lib/ops/alert-destination.ts) or, for tests, BACKUP_ALERT_CMD (run with the
// JSON as its one argument); the timer runs hourly. Prints one JSON line (names, counts, ages: no data, no key).
// Exit 0 ok; 1 a problem; 2 usage. Restore from here: ops/backup/restore-offhost.sh --offhost DIR (offline identity).
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alertDestinationProblem, alertRequest } from '../../lib/ops/alert-destination.ts'
import { nameTime, retainedCopies, sha256File } from './offhost.mts'

const usage = (why: string): never => { console.error(`pull-offhost: ${why}\nusage: pull-offhost.mts --from HOST: --to DIR [--ack ACKHOST] [--max-age-s N]`); process.exit(2) }
const arg = (f: string) => {
  const i = process.argv.indexOf(f); if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) usage(`${f} needs a value`)
  return v
}
const whole = (name: string, raw: string | undefined, d: number, min: number) => {
  if (raw === undefined || raw.trim() === '') return d
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min) usage(`${name} must be a whole number >= ${min}`)
  return Number(raw)
}
const from = arg('--from'), to = arg('--to'), ack = arg('--ack')
if (!from || !to) usage('--from and --to are required')
if (/\s/.test(from!) || (ack !== undefined && /\s/.test(ack))) usage('--from and --ack must have no spaces')
if (!existsSync(to!) || !statSync(to!).isDirectory()) usage(`--to ${to} is not a directory (create it: install -d -m 700 ${to})`)
const maxAgeS = whole('--max-age-s', arg('--max-age-s'), 7200, 1)
const retain = { hourly: whole('RETAIN_OFFHOST_HOURLY', process.env.RETAIN_OFFHOST_HOURLY, 48, 1), daily: whole('RETAIN_OFFHOST_DAILY', process.env.RETAIN_OFFHOST_DAILY, 14, 1), weekly: whole('RETAIN_OFFHOST_WEEKLY', process.env.RETAIN_OFFHOST_WEEKLY, 8, 1) }
const retireMax = whole('RETIRE_MAX_PER_RUN', process.env.RETIRE_MAX_PER_RUN, 3, 1)
const keepRetiredMs = whole('RETIRED_KEEP_DAYS', process.env.RETIRED_KEEP_DAYS, 7, 1) * 86_400_000
const dir = to!
const now = Date.now(), SKEW_MS = 300_000, NO_MANIFEST_MS = 2 * 3_600_000
const problems: string[] = []
const out: Record<string, unknown> = { type: 'offhost_pull', from: from!.replace(/^.*@/, '') }
const COPY = /^(dazl-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.db|dazl-ledger-\d{8}T\d{6}Z\.jsonl)\.age(\.json)?$/
const kindOf = (base: string) => (base.startsWith('dazl-backup-') ? 'backup' : 'ledger') as 'backup' | 'ledger'
const timeOf = (base: string) => nameTime(base, kindOf(base) === 'backup' ? 'dazl-backup-' : 'dazl-ledger-')
const retiredDir = path.join(dir, '.retired'), retiredNames = path.join(retiredDir, 'names')
mkdirSync(retiredDir, { recursive: true, mode: 0o700 })
if (!existsSync(retiredNames)) writeFileSync(retiredNames, '', { mode: 0o600 })

// the newest copy held BEFORE this run, per kind (a new copy named older than it is a backdated copy)
const heldBefore = new Set(readdirSync(dir))
const newestHeld = { backup: -Infinity, ledger: -Infinity }
for (const f of heldBefore) { const m = COPY.exec(f); if (m && !m[2] && existsSync(path.join(dir, `${f}.json`))) { const t = timeOf(m[1]); if (t !== null) newestHeld[kindOf(m[1])] = Math.max(newestHeld[kindOf(m[1])], t) } }

// ---- 1. pull: copy names only, never a name already retired here
const exclude = path.join(retiredDir, 'rsync-exclude')
writeFileSync(exclude, readFileSync(retiredNames, 'utf8').split('\n').filter(n => COPY.test(n)).map(n => `/${n}\n`).join(''), { mode: 0o600 })
const rsync = spawnSync('rsync', [
  '-rt', '--ignore-existing', '--chmod=F600', '--partial-dir=.rsync-partial', `--exclude-from=${exclude}`,
  '--include=dazl-backup-*.db.age', '--include=dazl-backup-*.db.age.json',
  '--include=dazl-ledger-*.jsonl.age', '--include=dazl-ledger-*.jsonl.age.json', '--exclude=*',
  '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=20',
  from!.endsWith(':') || from!.endsWith('/') ? from! : `${from}/`, `${dir.replace(/\/+$/, '')}/`,
], { encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL' })
if (rsync.error || rsync.status !== 0) problems.push(`pull failed (${rsync.error ? (rsync.error as NodeJS.ErrnoException).code ?? 'error' : `rsync exit ${rsync.status}`})`)
const pulled = readdirSync(dir).filter(f => COPY.test(f) && !heldBefore.has(f))
out.pulled = pulled.length

// ---- 2. check every copy that has its manifest
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> } catch { return null } }
type Copy = { base: string; t: number; copiedAt: number }
const good: { backup: Copy[]; ledger: Copy[] } = { backup: [], ledger: [] }
const bad: string[] = [], backdated: string[] = [], orphans: string[] = []
const setAside = (f: string) => {
  mkdirSync(path.join(dir, '.bad'), { recursive: true, mode: 0o700 })
  for (const x of [f, `${f}.json`]) { try { renameSync(path.join(dir, x), path.join(dir, '.bad', x)) } catch { /* already gone */ } }
}
for (const f of readdirSync(dir)) {
  const m = COPY.exec(f)
  if (!m || m[2]) continue // manifests are read with their ciphertext
  const base = m[1], kind = kindOf(base), t = timeOf(base)
  if (!existsSync(path.join(dir, `${f}.json`))) {
    // the manifest is copied after the ciphertext: the next run checks it; one still missing after two hours is a problem
    if (t === null || now - t > NO_MANIFEST_MS) orphans.push(f)
    continue
  }
  const j = readJson(path.join(dir, `${f}.json`))
  let ok = false
  try { ok = !!j && j.ciphertext === f && typeof j.ciphertext_sha256 === 'string' && statSync(path.join(dir, f)).size === j.bytes && sha256File(path.join(dir, f)) === j.ciphertext_sha256 } catch { ok = false }
  const copiedAt = typeof j?.copied_at === 'string' ? Date.parse(j.copied_at) : NaN
  if (!ok || t === null || !Number.isFinite(copiedAt)) { bad.push(f); setAside(f); continue }
  if (t - now > SKEW_MS || copiedAt - now > SKEW_MS) { bad.push(`${f} (future time)`); setAside(f); continue }
  // new this run (its ciphertext or its manifest arrived now) and named older than the newest copy already held
  if ((pulled.includes(f) || pulled.includes(`${f}.json`)) && t < newestHeld[kind]) backdated.push(f)
  good[kind].push({ base, t, copiedAt })
}
if (bad.length) problems.push(`${bad.length} copy(ies) failed the manifest check (moved to .bad): ${bad.slice(0, 5).join(', ')}`)
if (backdated.length) problems.push(`${backdated.length} new copy(ies) named older than the newest copy already here (the box does not backdate copies): ${backdated.slice(0, 5).join(', ')}; retention is held`)
if (orphans.length) problems.push(`${orphans.length} copy(ies) without a manifest for over 2 h: ${orphans.slice(0, 5).join(', ')}`)
for (const k of ['backup', 'ledger'] as const) good[k].sort((a, b) => b.t - a.t || b.base.localeCompare(a.base))
const newest = good.backup[0]
out.backups = good.backup.length; out.ledgers = good.ledger.length
if (!newest) problems.push('no checked backup copy here')
else {
  const age = Math.max(0, Math.round((now - newest.copiedAt) / 1000))
  out.newest = `${newest.base}.age`; out.newest_age_s = age
  if (age > maxAgeS) problems.push(`newest off-host copy is ${age}s old (limit ${maxAgeS}s)`)
}
if (!good.ledger.length) problems.push('no deletion-ledger copy here')

// ---- 4. retention: never while anything is in doubt; moves (never deletes) at most retireMax per kind
const retired: string[] = [], failed: string[] = [], warnings: string[] = []
if (!problems.length) {
  for (const k of ['backup', 'ledger'] as const) {
    const keep = retainedCopies(good[k].map(c => [c.base, c.t]), retain)
    const due = good[k].filter(c => !keep.has(c.base)).reverse() // oldest first
    if (due.length > retireMax) warnings.push(`${due.length} ${k} copies are past retention; ${retireMax} retired this run (a catch-up after downtime, or a flood of new copies from the box)`)
    for (const c of due.slice(0, retireMax)) {
      try {
        for (const x of [`${c.base}.age`, `${c.base}.age.json`]) { renameSync(path.join(dir, x), path.join(retiredDir, x)); utimesSync(path.join(retiredDir, x), new Date(now), new Date(now)) }
        appendFileSync(retiredNames, `${c.base}.age\n${c.base}.age.json\n`)
        retired.push(c.base)
      } catch (e) { failed.push(`${c.base} (${(e as NodeJS.ErrnoException).code ?? 'error'})`) }
    }
  }
  if (failed.length) problems.push(`retention could not retire ${failed.length} copy(ies)`)
}
// a retired copy is deleted RETIRED_KEEP_DAYS after it was retired (its name stays in .retired/names, so it is never pulled again)
let purged = 0
for (const f of readdirSync(retiredDir)) {
  if (!COPY.test(f)) continue
  try { if (now - statSync(path.join(retiredDir, f)).mtimeMs > keepRetiredMs) { unlinkSync(path.join(retiredDir, f)); purged++ } } catch { /* next run */ }
}

// ---- 5. tell the box this machine pulled (its check alerts when the pulls stop)
if (!problems.length && ack) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ack], { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
  if (r.error || r.status !== 0) warnings.push(`could not record the pull on the box (ssh ${ack} exit ${r.status ?? 'error'}): the box will alert that pulls stopped`)
  else out.acked = true
}
out.retired = retired.length; out.purged = purged
problems.push(...warnings)
out.problems = problems
out.ok = problems.length === 0
console.log(JSON.stringify(out))
if (!problems.length) process.exit(0)

// ---- alert
const body = { type: 'offhost_pull_problem', host: os.hostname(), problems }
const cmd = process.env.BACKUP_ALERT_CMD, hook = process.env.OPS_ALERT_WEBHOOK_URL
if (cmd) {
  const r = spawnSync(cmd, [JSON.stringify(body)], { stdio: 'inherit', timeout: 10_000, killSignal: 'SIGKILL' })
  if (r.error || r.status !== 0) console.error('pull-offhost: alert command failed')
} else {
  const req = alertRequest(hook, body, ['dazl off-host backup pull problem:', ...problems.map(p => `- ${p}`)].join('\n'))
  if (!req) console.error(`pull-offhost: no alert destination (${alertDestinationProblem(hook)}); the problems are in the journal only`)
  else {
    try {
      const r = await fetch(req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
      if (!r.ok) console.error(`pull-offhost: alert webhook HTTP ${r.status}`)
    } catch (e) { console.error(`pull-offhost: alert webhook failed (${e instanceof Error ? e.name : 'error'})`) }
  }
}
process.exit(1)
