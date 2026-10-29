// Backup freshness and failure alert (issue #360; docs/RECOVERY.md "Monitoring"). Run every 15 minutes by
// ops/backup/dazl-backup-check.timer. Problems it reports (exit 1, and an alert):
//   - no local backup with a create-backup sidecar in --dir, the newest is older than --max-age-s, or the newest no
//     longer matches its sidecar sha256 (modified or truncated after it was taken);
//   - --offhost-dir (a mounted copy of the off-host destination, or the local staging of it): no .age manifest, or the
//     newest copy is older than --offhost-max-age-s;
//   - --drill-report (the newest recovery-drill.mts --report): missing, not ok, or older than --drill-max-age-s.
// Alerts go to OPS_ALERT_WEBHOOK_URL (https only; e.g. a Slack incoming webhook) or, for tests, BACKUP_ALERT_CMD (run
// with the JSON as its one argument). The same set of problems alerts at most once per BACKUP_ALERT_EVERY_S (3600);
// stamps live in --state-dir. The alert names problems and ages only: no data, paths of backups only by file name.
//   node --experimental-strip-types scripts/backup/backup-check.mts --dir /var/backups/dazl --max-age-s 7200 \
//     [--offhost-dir DIR --offhost-max-age-s 7200] [--drill-report FILE --drill-max-age-s 691200] [--state-dir DIR]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (f: string) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : undefined }
const num = (f: string, d: number) => { const v = arg(f); return v === undefined ? d : Number(v) }
const dir = arg('--dir')
if (!dir) { console.error('usage: backup-check.mts --dir DIR [--max-age-s N] [--offhost-dir DIR --offhost-max-age-s N] [--drill-report FILE --drill-max-age-s N] [--state-dir DIR]'); process.exit(2) }
const now = Date.now()
const problems: string[] = []
const facts: Record<string, unknown> = {}
const sha256 = (f: string) => new Promise<string>((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej) })
const ageS = (iso: string | undefined | null) => iso && !Number.isNaN(Date.parse(iso)) ? Math.round((now - Date.parse(iso)) / 1000) : null
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

// local backups: newest by sidecar createdAt
const maxAge = num('--max-age-s', 7200)
const local = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.db') && existsSync(path.join(dir, f + '.json')))
  .map(f => ({ f, side: readJson(path.join(dir, f + '.json')) })).filter(x => x.side?.createdAt).sort((a, b) => Date.parse(b.side.createdAt) - Date.parse(a.side.createdAt)) : []
if (!local.length) problems.push(`no backup with a sidecar in ${dir}`)
else {
  const n = local[0], age = ageS(n.side.createdAt)
  facts.newest_backup = n.f; facts.newest_backup_age_s = age; facts.backups = local.length
  if (age === null || age > maxAge) problems.push(`newest backup is ${age}s old (limit ${maxAge}s)`)
  if (await sha256(path.join(dir, n.f)) !== n.side.sha256) problems.push(`newest backup ${n.f} no longer matches its sidecar sha256`)
}

const off = arg('--offhost-dir')
if (off) {
  const max = num('--offhost-max-age-s', 7200)
  const copies = existsSync(off) ? readdirSync(off).filter(f => f.endsWith('.age.json')).map(f => readJson(path.join(off, f))).filter(m => m?.copied_at && m?.tool === 'dazl-offhost-copy')
    .sort((a, b) => Date.parse(b.copied_at) - Date.parse(a.copied_at)) : []
  if (!copies.length) problems.push(`no off-host copy manifest in ${off}`)
  else {
    const age = ageS(copies[0].copied_at); facts.newest_offhost_age_s = age; facts.offhost_copies = copies.length
    if (age === null || age > max) problems.push(`newest off-host copy is ${age}s old (limit ${max}s)`)
  }
}

const drill = arg('--drill-report')
if (drill) {
  const max = num('--drill-max-age-s', 8 * 86_400)
  const r = readJson(drill)
  if (!r) problems.push('no readable recovery drill report')
  else {
    const age = ageS(r.started_at); facts.drill_age_s = age; facts.drill_ok = r.ok
    if (r.ok !== true) problems.push(`last recovery drill FAILED (${(r.steps ?? []).filter((s: { ok: boolean }) => !s.ok).map((s: { step: string }) => s.step).join(', ') || 'unknown step'})`)
    if (age === null || age > max) problems.push(`last recovery drill is ${age}s old (limit ${max}s)`)
  }
}

const state = arg('--state-dir') ?? path.join(dir, '.backup-check')
const every = Number(process.env.BACKUP_ALERT_EVERY_S ?? 3600)
const body = { level: problems.length ? 'error' : 'info', type: 'backup_check', ok: problems.length === 0, host: os.hostname(), at: new Date(now).toISOString(), problems, ...facts }
console.log(JSON.stringify(body))
if (!problems.length) { rmSync(state, { recursive: true, force: true }); process.exit(0) }

mkdirSync(state, { recursive: true, mode: 0o700 })
const stamp = path.join(state, 'alert-' + createHash('sha256').update(problems.map(p => p.replace(/\d+s old/, 'Ns old')).join('\n')).digest('hex').slice(0, 16))
if (existsSync(stamp) && now - statSync(stamp).mtimeMs < every * 1000) { console.error('backup-check: alert already sent for these problems within the interval'); process.exit(1) }
writeFileSync(stamp, '')
const cmd = process.env.BACKUP_ALERT_CMD
const url = process.env.OPS_ALERT_WEBHOOK_URL
if (cmd) { const r = spawnSync(cmd, [JSON.stringify(body)], { stdio: 'inherit' }); if (r.status !== 0) console.error('backup-check: alert command failed') }
else if (url?.startsWith('https://')) {
  try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); if (!r.ok) console.error(`backup-check: alert webhook HTTP ${r.status}`) }
  catch (e) { console.error(`backup-check: alert webhook failed (${e instanceof Error ? e.name : 'error'})`) }
} else console.error('backup-check: no alert destination: set OPS_ALERT_WEBHOOK_URL (https); problems are in the journal only')
process.exit(1)
