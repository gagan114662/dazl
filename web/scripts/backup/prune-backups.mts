// Backup retention (issue #360; docs/RECOVERY.md "Retention"). Deletes local backups and off-host copies beyond the
// owner-approved policy, and only when the newest backup is known good. Run by ops/backup/run-backup.sh after a
// backup, its restore check and its off-host copy all passed, and only when BACKUP_RETENTION=1 (the owner approves the
// numbers, Instinct sets the flag; until then backups accumulate and nothing is ever deleted).
//   local (--dir):        the newest RETAIN_LOCAL (default 48: two days of hourly backups) by sidecar createdAt
//   off-host (--offhost): the newest RETAIN_OFFHOST_HOURLY copies (default 48), plus the newest copy of each of the
//                         last RETAIN_OFFHOST_DAILY UTC days (14) and each of the last RETAIN_OFFHOST_WEEKLY ISO weeks (8)
// Fail-closed rules (each refuses the WHOLE run, exit 1, nothing deleted):
//   - a retention number that is not a decimal integer >= 1 (exit 2);
//   - no usable local backup, the newest no longer matches its sidecar sha256, or the drill report is missing, not ok,
//     or about another backup than the newest (restore-drill.ts --report names it in `backup`):
//     while the newest is in doubt, the older ones may be the only good ones;
//   - the off-host destination cannot be listed (when one is configured).
// Never deleted: anything not named dazl-backup-<YYYYMMDDTHHMMSSZ>-..., a timestamp more than 300 s in the future
// (counted as an anomaly), a local backup with an unreadable sidecar, and - when an off-host destination is configured -
// a local backup that has no complete off-host copy yet (its .age AND its .age.json). dazl-config-* bundles are tiny and change rarely: never pruned.
// Each deletion is attempted independently; a failure is reported and makes the exit 1, the rest still run.
//   node --experimental-strip-types scripts/backup/prune-backups.mts --dir BACKUP_DIR [--offhost DEST] [--drill-report F] [--dry-run]
// Prints one JSON line: kept / deleted / failed counts and names (file names only). Exit 0 ok; 1 refused or a failed
// deletion; 2 usage.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { nameTime, openDest, type OffhostDest } from './offhost.mts'

const arg = (f: string) => {
  const i = process.argv.indexOf(f); if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) { console.error(`prune-backups: ${f} needs a value`); process.exit(2) }
  return v
}
const keepN = (name: string, d: number) => {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return d
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < 1) { console.error(`prune-backups: ${name} must be a whole number >= 1, got ${JSON.stringify(raw)}: nothing pruned`); process.exit(2) }
  return Number(raw)
}
const dir = arg('--dir')
if (!dir) { console.error('usage: prune-backups.mts --dir BACKUP_DIR [--offhost DEST] [--drill-report FILE] [--dry-run]'); process.exit(2) }
const retain = { local: keepN('RETAIN_LOCAL', 48), hourly: keepN('RETAIN_OFFHOST_HOURLY', 48), daily: keepN('RETAIN_OFFHOST_DAILY', 14), weekly: keepN('RETAIN_OFFHOST_WEEKLY', 8) }
const dry = process.argv.includes('--dry-run')
const offFlag = arg('--offhost')
const offSpec = offFlag ?? (process.env.OFFHOST_DEST?.trim() || undefined)
const drillFlag = arg('--drill-report')
const drillPath = (drillFlag?.trim() || undefined) ?? (process.env.DRILL_REPORT?.trim() || undefined) ?? path.join(dir, 'drill-report.json')
const now = Date.now(), SKEW_MS = 300_000
const out: Record<string, unknown> = { type: 'backup_prune', dry_run: dry, retain }
const finish = (code: number, refused?: string): never => {
  if (refused) out.refused = refused
  out.ok = code === 0
  console.log(JSON.stringify(out))
  process.exit(code)
}
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
const LOCAL = /^dazl-backup-\d{8}T\d{6}Z-[0-9a-f]{8}\.db$/

// ---- local: what exists, and is the newest good?
type Local = { f: string; t: number }
const locals: Local[] = []
const anomalies: string[] = []
try {
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!LOCAL.test(f)) continue
    const side = readJson(path.join(dir, f + '.json'))
    const t = typeof side?.createdAt === 'string' ? Date.parse(side.createdAt) : NaN
    if (!Number.isFinite(t)) { anomalies.push(`${f}: unreadable sidecar (kept)`); continue }
    if (t - now > SKEW_MS) { anomalies.push(`${f}: future timestamp (kept)`); continue }
    locals.push({ f, t })
  }
} catch (e) { finish(1, `backup directory unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`) }
locals.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f))
if (!locals.length) finish(1, 'no usable local backup: nothing is pruned while there is no known-good newest backup')
{
  const newest = locals[0], side = readJson(path.join(dir, newest.f + '.json'))
  let same = false
  try { same = sha256(path.join(dir, newest.f)) === side?.sha256 } catch { same = false }
  if (!same) finish(1, `newest backup ${newest.f} does not match its sidecar sha256`)
  const drill = readJson(drillPath)
  if (drill?.ok !== true) finish(1, 'the drill report is missing or not ok')
  // an ok report about an OLDER backup says nothing about the newest one
  if (drill.backup !== newest.f) finish(1, `the drill report is not about the newest backup ${newest.f}`)
  out.newest = newest.f
}
if (anomalies.length) out.anomalies = anomalies

// ---- off-host: list once (needed both to prune it and to keep local backups that are not copied yet)
let dest: OffhostDest | null = null
let remote: string[] = []
if (offSpec) {
  try { dest = openDest(offSpec); remote = dest.list() } catch (e) { finish(1, `off-host destination unreadable: ${e instanceof Error ? e.message : 'error'}`) }
}
const remoteSet = new Set(remote)

const deleted: string[] = [], failed: string[] = []
const del = (label: string, f: () => void) => {
  if (dry) { deleted.push(label); return }
  try { f(); deleted.push(label) } catch (e) { failed.push(`${label} (${(e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : 'error')})`) }
}

// ---- local retention
const localKeep = new Set(locals.slice(0, retain.local).map(l => l.f))
for (const l of locals) {
  if (localKeep.has(l.f)) continue
  // both halves of the copy must be there: a manifest alone (an interrupted copy or prune) is not an off-host copy
  if (dest && !(remoteSet.has(`${l.f}.age`) && remoteSet.has(`${l.f}.age.json`))) { anomalies.push(`${l.f}: no off-host copy yet (kept)`); continue }
  del(l.f, () => { unlinkSync(path.join(dir, l.f)); unlinkSync(path.join(dir, l.f + '.json')) })
}
out.local = { total: locals.length, kept: locals.length - deleted.length - failed.length }

// ---- off-host retention: copies are <backup>.age + <backup>.age.json; the timestamp is the one in the name
if (dest) {
  const before = deleted.length + failed.length
  const copies = new Map<string, number>()
  for (const f of remote) {
    const base = f.endsWith('.age.json') ? f.slice(0, -'.age.json'.length) : f.endsWith('.age') ? f.slice(0, -'.age'.length) : null
    if (!base || !LOCAL.test(base)) continue
    const t = nameTime(base)
    if (t === null) continue
    if (t - now > SKEW_MS) { if (!copies.has(base)) anomalies.push(`${base}: future off-host timestamp (kept)`); copies.set(base, -1); continue }
    copies.set(base, t)
  }
  const sorted = [...copies].filter(([, t]) => t >= 0).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
  const keep = new Set(sorted.slice(0, retain.hourly).map(([b]) => b))
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  const week = (t: number) => { const d = new Date(t); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10) } // Monday of the ISO week
  for (const [bucket, n] of [[day, retain.daily], [week, retain.weekly]] as const) {
    const seen = new Set<string>()
    for (const [b, t] of sorted) { const k = bucket(t); if (seen.has(k)) continue; seen.add(k); if (seen.size > n) break; keep.add(b) }
  }
  for (const [b] of sorted) {
    if (keep.has(b)) continue
    // ciphertext first: an interrupted run leaves at worst a manifest without its copy, which the next run removes
    del(`offhost:${b}`, () => { if (remoteSet.has(`${b}.age`)) dest!.remove(`${b}.age`); if (remoteSet.has(`${b}.age.json`)) dest!.remove(`${b}.age.json`) })
  }
  out.offhost = { label: dest.label, total: sorted.length, kept: sorted.length - (deleted.length + failed.length - before) }
}
out.deleted = deleted; if (failed.length) out.failed = failed
if (anomalies.length) out.anomalies = anomalies
finish(failed.length ? 1 : 0)
