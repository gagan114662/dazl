// The off-host copy with no bucket (issue #1080): run on an operator machine that can already ssh to the box, it PULLS
// the box's encrypted copies (offhost-copy.sh writes them to a directory destination there, OFFHOST_DEST) into a
// directory on this machine. Free: rsync and ssh only, storage the operator already has, no cloud account, no IAM, and
// no credential on the box (the box cannot reach or delete what is kept here).
//   node --experimental-strip-types scripts/backup/pull-offhost.mts --from HOST:/var/backups/dazl-offhost --to DIR \
//        [--max-age-s 7200]
// Each run:
//   1. rsync over ssh (BatchMode: never prompts) copies the dazl-backup-*.db.age / dazl-ledger-*.jsonl.age files and
//      their .json manifests that are not here yet. Nothing here is ever overwritten or deleted by the box's side: a
//      copy the box pruned or lost stays here. Half-written files (.partial on the box, rsync's own temp files) never
//      land under a copy's name.
//   2. every copy here with a manifest is checked: the ciphertext must have the manifest's bytes and sha256
//      (ciphertext_sha256). A copy that fails is moved to DIR/.bad/ (kept for inspection, never restored from) and is a
//      problem. A ciphertext whose manifest has not arrived yet is left for the next run.
//   3. problems: the pull failed (ssh / rsync), a copy failed its check, there is no checked backup copy, the newest
//      checked backup copy (its manifest's copied_at) is older than --max-age-s (default 7200), or there is no
//      deletion-ledger copy. Each problem goes to OPS_ALERT_WEBHOOK_URL (https; lib/ops/alert-destination.ts) or, for
//      tests, BACKUP_ALERT_CMD (run with the JSON as its one argument). The timer runs hourly, so at most one alert an hour.
//   4. retention, only when there is no problem (the same policy as the box: retainedCopies in offhost.mts,
//      RETAIN_OFFHOST_HOURLY 48 / _DAILY 14 / _WEEKLY 8), separately for backup and ledger copies.
// Prints one JSON line (file names, counts and ages only: no data, no key). Exit 0 ok; 1 a problem; 2 usage.
// Restore from here with ops/backup/restore-offhost.sh --offhost DIR (the age private identity, kept offline).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alertDestinationProblem, alertRequest } from '../../lib/ops/alert-destination.ts'
import { nameTime, retainedCopies, sha256File } from './offhost.mts'

const usage = (why: string): never => { console.error(`pull-offhost: ${why}\nusage: pull-offhost.mts --from HOST:DIR --to DIR [--max-age-s N]`); process.exit(2) }
const arg = (f: string) => {
  const i = process.argv.indexOf(f); if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) usage(`${f} needs a value`)
  return v
}
const keepN = (name: string, d: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return d
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) usage(`${name} must be a whole number >= 1`)
  return Number(raw)
}
const from = arg('--from'), to = arg('--to')
if (!from || !to) usage('--from and --to are required')
if (/\s/.test(from!)) usage('--from must have no spaces')
if (!existsSync(to!) || !statSync(to!).isDirectory()) usage(`--to ${to} is not a directory (create it: install -d -m 700 ${to})`)
const maxAgeRaw = arg('--max-age-s') ?? '7200'
if (!/^\d+$/.test(maxAgeRaw)) usage('--max-age-s must be a whole number of seconds')
const maxAgeS = Number(maxAgeRaw)
const retain = { hourly: keepN('RETAIN_OFFHOST_HOURLY', 48), daily: keepN('RETAIN_OFFHOST_DAILY', 14), weekly: keepN('RETAIN_OFFHOST_WEEKLY', 8) }
const dir = to!
const now = Date.now(), SKEW_MS = 300_000
const problems: string[] = []
const out: Record<string, unknown> = { type: 'offhost_pull', from: from!.replace(/^.*@/, '') }

// ---- 1. pull: only copy names, never anything else from the box's directory
const COPY = /^(dazl-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.db|dazl-ledger-\d{8}T\d{6}Z\.jsonl)\.age(\.json)?$/
const before = new Set(readdirSync(dir))
const rsync = spawnSync('rsync', [
  '-rt', '--ignore-existing', '--chmod=F600', '--partial-dir=.rsync-partial',
  '--include=dazl-backup-*.db.age', '--include=dazl-backup-*.db.age.json',
  '--include=dazl-ledger-*.jsonl.age', '--include=dazl-ledger-*.jsonl.age.json', '--exclude=*',
  '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=20',
  `${from!.replace(/\/+$/, '')}/`, `${dir.replace(/\/+$/, '')}/`,
], { encoding: 'utf8', timeout: 600_000, killSignal: 'SIGKILL' })
if (rsync.error || rsync.status !== 0) problems.push(`pull failed (${rsync.error ? (rsync.error as NodeJS.ErrnoException).code ?? 'error' : `rsync exit ${rsync.status}`})`)
const pulled = readdirSync(dir).filter(f => COPY.test(f) && !before.has(f))
out.pulled = pulled.length

// ---- 2. check every copy that has its manifest
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown> } catch { return null } }
type Copy = { base: string; t: number; copiedAt: number }
const good: { backup: Copy[]; ledger: Copy[] } = { backup: [], ledger: [] }
const bad: string[] = []
for (const f of readdirSync(dir)) {
  const m = COPY.exec(f)
  if (!m || m[2]) continue // manifests are read with their ciphertext
  const base = m[1], kind = base.startsWith('dazl-backup-') ? 'backup' : 'ledger'
  const man = path.join(dir, `${f}.json`)
  if (!existsSync(man)) continue // the manifest is copied after the ciphertext: the next run checks it
  const j = readJson(man)
  let ok = false
  try { ok = !!j && j.ciphertext === f && typeof j.ciphertext_sha256 === 'string' && statSync(path.join(dir, f)).size === j.bytes && sha256File(path.join(dir, f)) === j.ciphertext_sha256 } catch { ok = false }
  const t = nameTime(base, kind === 'backup' ? 'dazl-backup-' : 'dazl-ledger-')
  const copiedAt = typeof j?.copied_at === 'string' ? Date.parse(j.copied_at) : NaN
  if (!ok || t === null || !Number.isFinite(copiedAt)) {
    bad.push(f)
    mkdirSync(path.join(dir, '.bad'), { recursive: true, mode: 0o700 })
    for (const x of [f, `${f}.json`]) { try { renameSync(path.join(dir, x), path.join(dir, '.bad', x)) } catch { /* already gone */ } }
    continue
  }
  if (t - now > SKEW_MS || copiedAt - now > SKEW_MS) { bad.push(`${f} (future timestamp)`); continue }
  good[kind].push({ base, t, copiedAt })
}
if (bad.length) problems.push(`${bad.length} copy(ies) failed the manifest check: ${bad.slice(0, 5).join(', ')}`)
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

// ---- 4. retention (3. is below): never while anything is in doubt
const deleted: string[] = [], failed: string[] = []
if (!problems.length) {
  for (const k of ['backup', 'ledger'] as const) {
    const keep = retainedCopies(good[k].map(c => [c.base, c.t]), retain)
    for (const c of good[k]) {
      if (keep.has(c.base)) continue
      // ciphertext first: an interrupted run leaves at worst a manifest alone, which is never restored from
      try { unlinkSync(path.join(dir, `${c.base}.age`)); unlinkSync(path.join(dir, `${c.base}.age.json`)); deleted.push(c.base) } catch (e) { failed.push(`${c.base} (${(e as NodeJS.ErrnoException).code ?? 'error'})`) }
    }
  }
  if (failed.length) problems.push(`retention could not delete ${failed.length} copy(ies)`)
}
out.deleted = deleted.length
out.problems = problems
out.ok = problems.length === 0
console.log(JSON.stringify(out))
if (!problems.length) process.exit(0)

// ---- 3. alert
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
