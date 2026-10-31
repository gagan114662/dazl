// Backup freshness and failure alert (issue #360; docs/RECOVERY.md "Monitoring"). Run every 15 minutes by
// ops/backup/dazl-backup-check.timer. Problems it reports (exit 1, and an alert):
//   - no local backup with a create-backup sidecar in --dir, the newest is older than --max-age-s, or the newest no
//     longer matches its sidecar sha256 (modified or truncated after it was taken);
//   - the off-host destination (--offhost DEST, else OFFHOST_DEST from the environment, the same setting run-backup.sh
//     copies to): a directory (mounted remote, second disk) or rclone:REMOTE:PATH. It is unreadable (rclone missing, a
//     listing or read fails), holds no copy manifest, the newest copy is older than --offhost-max-age-s, or the newest
//     manifest's ciphertext is absent, has other bytes than declared, or does not hash to its declared sha256: a
//     manifest alone is not a recoverable backup. With OFFHOST_REQUIRED=1, no destination configured is a problem;
//   - --drill-report (the newest recovery-drill.mts --report): missing, not ok, or older than --drill-max-age-s.
// Alerts go to OPS_ALERT_WEBHOOK_URL (https only; e.g. a Slack incoming webhook) or, for tests, BACKUP_ALERT_CMD (run
// with the JSON as its one argument). The same set of problems (sorted, so discovery order does not matter) alerts at
// most once per BACKUP_ALERT_EVERY_S (a decimal integer, default 3600; 0 = no throttle; anything else falls back to
// 3600 with a log line), counted from a delivered alert (command exit 0, webhook 2xx): a failed delivery or no
// destination leaves no stamp, so the next run retries. Stamps (backup-alert-*) live in --state-dir (default
// BACKUP_DIR/.backup-check; when it is unusable the alert still goes out, unthrottled; the directory may be shared with
// scheduler-check, only this script's stamps are ever removed). Runs are not locked against each other: two concurrent
// runs can both deliver (the systemd timer never overlaps its own job; a manual start during one can). When everything
// is ok the stamps are removed and nothing is sent: there is deliberately no recovery announcement (scheduler-check.mts
// has one). The alert names problems, ages and file names only: no data, no directory paths (I/O errors are forwarded
// by code and syscall). The webhook is https only and redirects are not followed. Age limits are decimal integers of
// seconds (else exit 2; a flag without a value is exit 2 too). A sidecar or manifest timestamp more than 300 s in the
// future is a problem and never the newest; ages never go below 0. Every manifest that shares the newest copied_at is
// judged. Only the newest 5 valid manifests (at most 10 files) are read, so a run stays O(1) as copies accrue: by the
// timestamp in dazl-backup-* names first, then other names; copied_at decides within that window.
// RCLONE_TIMEOUT_S (positive integer, default 120; else 120 with a log line) bounds each rclone call; a few slow calls
// can still add up past the unit's TimeoutStartSec. An empty --offhost is a usage error; an unset OFFHOST_DEST is
// "not configured" and said in the journal. Exit 0 = ok; 1 = problem (alerted, throttled or
// undeliverable); 2 = usage.
// Known one-off: create-backup writes its sidecar in place (lib.ts), so a check that reads it at that instant can see a
// partial file and alert "unreadable sidecar" once; the next run clears it. offhost-copy.sh writes its manifest via a
// .partial rename, so the off-host side has no such window.
//   node --experimental-strip-types scripts/backup/backup-check.mts --dir /var/backups/dazl --max-age-s 7200 \
//     [--offhost DIR|rclone:REMOTE:PATH --offhost-max-age-s 7200] [--drill-report FILE --drill-max-age-s 691200] [--state-dir DIR]
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (f: string) => {
  const i = process.argv.indexOf(f); if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (v === undefined || v.startsWith('--')) { console.error(`backup-check: ${f} needs a value`); process.exit(2) }
  return v
}
const seconds = (what: string, v: string | undefined, d: number) => {
  if (v === undefined || v.trim() === '') return d
  if (!/^-?\d+$/.test(v.trim())) { console.error(`backup-check: ${what} must be a number of seconds, got ${JSON.stringify(v)}`); process.exit(2) }
  return Number(v)
}
const num = (f: string, d: number) => seconds(f, arg(f), d)
const dir = arg('--dir')
if (!dir) { console.error('usage: backup-check.mts --dir DIR [--max-age-s N] [--offhost DIR|rclone:REMOTE:PATH --offhost-max-age-s N] [--drill-report FILE --drill-max-age-s N] [--state-dir DIR]'); process.exit(2) }
const now = Date.now()
const everyRaw = process.env.BACKUP_ALERT_EVERY_S
let every = everyRaw === undefined || everyRaw.trim() === '' ? 3600 : /^\d+$/.test(everyRaw.trim()) ? Number(everyRaw) : NaN
if (!Number.isFinite(every)) { console.error(`backup-check: BACKUP_ALERT_EVERY_S is not a number of seconds (${JSON.stringify(everyRaw)}); using 3600`); every = 3600 }
const problems: string[] = []
const facts: Record<string, unknown> = {}
const sha256 = (f: string) => new Promise<string>((res, rej) => { const h = createHash('sha256'); createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej) })
const ageS = (iso: string | undefined | null) => iso && !Number.isNaN(Date.parse(iso)) ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null
const SKEW_S = 300 // a clock this far ahead is tolerated; beyond it a timestamp is from the future and never the newest
const future = (iso: string) => Date.parse(iso) - now > SKEW_S * 1000
// an error as the alert may name it: our own messages verbatim, a filesystem error by code and syscall (never its
// message, which carries a full path)
const reason = (e: unknown) => { const x = e as NodeJS.ErrnoException; return x?.code ? `${x.code}${x.syscall ? ' on ' + x.syscall : ''}` : e instanceof Error ? e.message : 'error' }
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

// local backups: newest by sidecar createdAt. A sidecar that exists but does not parse is a problem (a newer backup
// must not be silently replaced by an older one); an I/O error here is a problem too, never an exit before the alert.
const maxAge = num('--max-age-s', 7200)
try {
  const local: { f: string; side: { createdAt: string; sha256?: string } }[] = []; let sawSidecar = false
  for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.db') && existsSync(path.join(dir, f + '.json'))) : []) {
    const side = readJson(path.join(dir, f + '.json')); sawSidecar = true
    if (!side?.createdAt || Number.isNaN(Date.parse(side.createdAt))) problems.push(`unreadable sidecar for ${f}`)
    else if (future(side.createdAt)) problems.push(`backup ${f} has a future timestamp`)
    else local.push({ f, side })
  }
  local.sort((a, b) => Date.parse(b.side.createdAt) - Date.parse(a.side.createdAt))
  if (!local.length) problems.push(sawSidecar ? `no usable backup in ${path.basename(dir)}` : `no backup with a sidecar in ${path.basename(dir)}`)
  else {
    const n = local[0], age = ageS(n.side.createdAt)
    facts.newest_backup = n.f; facts.newest_backup_age_s = age; facts.backups = local.length
    if (age === null || age > maxAge) problems.push(`newest backup is ${age}s old (limit ${maxAge}s)`)
    try { if (await sha256(path.join(dir, n.f)) !== n.side.sha256) problems.push(`newest backup ${n.f} no longer matches its sidecar sha256`) }
    catch (e) { problems.push(`newest backup ${n.f} unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`) }
  }
} catch (e) { problems.push(`backup directory ${path.basename(dir)} unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})`) }

// An off-host destination as the check reads it: list the files, read a small one, hash a large one (streamed).
interface Dest { label: string; list(): Promise<string[]>; read(name: string): Promise<string>; digest(name: string): Promise<{ bytes: number; sha256: string } | null> }
const plainName = (n: string) => /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.')
function localDest(d: string): Dest {
  return {
    label: path.basename(d),
    list: async () => { if (!existsSync(d)) throw new Error('directory not found'); return readdirSync(d) },
    read: async n => readFileSync(path.join(d, n), 'utf8'),
    digest: async n => { const f = path.join(d, n); if (!existsSync(f)) return null; return { bytes: statSync(f).size, sha256: await sha256(f) } },
  }
}
// rclone:REMOTE:PATH through the rclone CLI (the same one offhost-copy.sh uploads with). Any rclone failure throws.
function rcloneDest(spec: string): Dest {
  const remote = spec.slice('rclone:'.length).replace(/\/+$/, '')
  const bin = process.env.RCLONE_BIN || 'rclone'
  // every rclone call is bounded by RCLONE_TIMEOUT_S (120): a hung remote is a problem, never a hung check. Only a
  // positive integer is a bound (spawnSync takes 0 as "no timeout"); anything else falls back to 120 with a log line.
  // Several slow reads each just under the bound can still exceed the unit's 5-minute TimeoutStartSec backstop.
  const rawLimit = process.env.RCLONE_TIMEOUT_S
  let limitS = rawLimit === undefined || rawLimit.trim() === '' ? 120 : /^\d+$/.test(rawLimit.trim()) ? Number(rawLimit) : 0
  if (!(limitS > 0)) { console.error(`backup-check: RCLONE_TIMEOUT_S must be a positive number of seconds (${JSON.stringify(rawLimit)}); using 120`); limitS = 120 }
  const run = (args: string[]) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: limitS * 1000, killSignal: 'SIGKILL' })
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`rclone ${args[0]} timed out (${limitS}s)`)
    if (r.error) throw new Error(`rclone not runnable (${(r.error as NodeJS.ErrnoException).code ?? r.error.name})`)
    if (r.status !== 0) throw new Error(`rclone ${args[0]} failed (exit ${r.status})`)
    return r.stdout
  }
  return {
    label: remote.split(':')[0] + ':',
    list: async () => run(['lsf', '--files-only', remote]).split('\n').map(l => l.trim()).filter(Boolean),
    read: async n => run(['cat', `${remote}/${n}`]),
    digest: n => new Promise((res, rej) => {
      if (!run(['lsf', '--files-only', remote]).split('\n').map(l => l.trim()).includes(n)) return res(null)
      // Its own process group, killed whole on exit and on timeout: a wrapper that forks without exec must not leave a
      // grandchild holding the stdout pipe past the bound. Bytes are hashed until the stream ends, so nothing is lost.
      const p = spawn(bin, ['cat', `${remote}/${n}`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); const h = createHash('sha256'); let bytes = 0
      let timedOut = false, exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
      const killGroup = () => { try { if (p.pid) process.kill(-p.pid, 'SIGKILL') } catch { /* already gone */ } }
      const timer = setTimeout(() => { timedOut = true; killGroup() }, limitS * 1000)
      p.stdout.on('data', (b: Buffer) => { bytes += b.length; h.update(b) })
      p.on('error', e => { clearTimeout(timer); rej(new Error(`rclone not runnable (${(e as NodeJS.ErrnoException).code ?? e.name})`)) })
      p.on('exit', (code, signal) => { exit = { code, signal }; killGroup() })
      p.on('close', (code, signal) => {
        clearTimeout(timer); const c = exit?.code ?? code, s = exit?.signal ?? signal
        if (timedOut) return rej(new Error(`rclone cat timed out (${limitS}s)`))
        if (c === 0) res({ bytes, sha256: h.digest('hex') }); else rej(new Error(s ? `rclone cat killed (${s})` : `rclone cat failed (exit ${c})`))
      })
    }),
  }
}
const offFlag = arg('--offhost') ?? arg('--offhost-dir')
if (offFlag !== undefined && offFlag.trim() === '') { console.error('backup-check: --offhost needs a value (unset OFFHOST_DEST means not configured; an empty flag is a mistake)'); process.exit(2) }
const offSpec = offFlag ?? (process.env.OFFHOST_DEST?.trim() || undefined)
if (!offSpec) {
  if (process.env.OFFHOST_REQUIRED === '1') problems.push('an off-host copy is required (OFFHOST_REQUIRED=1) but no destination is configured (OFFHOST_DEST)')
  else console.error('backup-check: off-host copy not configured (OFFHOST_DEST empty, OFFHOST_REQUIRED=0): only local backups and the drill are checked')
  facts.offhost = 'not configured'
} else {
  const max = num('--offhost-max-age-s', 7200)
  const dest = offSpec.startsWith('rclone:') ? rcloneDest(offSpec) : localDest(offSpec)
  facts.offhost = dest.label
  try {
    // Copies accrue hourly and retention is not implemented, so the check reads only the newest manifests by name
    // (copy names embed the backup timestamp): at most READ_MAX files, stopping once NEWEST_K valid ones are in hand;
    // copied_at is the authority within that window. The run stays O(1) however many copies exist; older manifests
    // are listed and counted, not read or judged.
    const NEWEST_K = 5, READ_MAX = 10
    // dazl-backup-<timestamp> names come first, newest timestamp first, so a few copies under other names (a manual
    // pre-migration copy, say) can never push the real newest out of the window; other names follow, newest-named first
    const rank = (f: string) => { const m = /^dazl-backup-(\d{8}T\d{6}Z)/.exec(f); return m ? `1-${m[1]}` : `0-${f}` }
    const names = (await dest.list()).filter(f => f.endsWith('.age.json') && plainName(f)).sort((a, b) => rank(b).localeCompare(rank(a)))
    facts.offhost_manifests_listed = names.length
    const manifests: Record<string, unknown>[] = []; let read = 0
    for (const f of names) {
      if (manifests.length >= NEWEST_K || read >= READ_MAX) break
      read++
      // unreadable or truncated: a problem, never a silent skip that lets an older copy stand in for the newer one.
      // A filesystem error names this manifest; a transport error (rclone failed, timed out) is the destination's.
      let text: string
      try { text = await dest.read(f) } catch (e) { if (!(e as NodeJS.ErrnoException)?.code) throw e; problems.push(`off-host manifest ${f} unreadable (${reason(e)})`); continue }
      let m: Record<string, unknown> | null = null
      try { m = JSON.parse(text) } catch { problems.push(`off-host manifest ${f} unreadable (not JSON)`); continue }
      if (m?.tool !== 'dazl-offhost-copy') continue // another tool's file
      if (!m.copied_at || Number.isNaN(Date.parse(String(m.copied_at)))) { problems.push(`off-host manifest ${f} has no copied_at`); continue }
      if (future(String(m.copied_at))) { problems.push(`off-host manifest ${f} has a future timestamp`); continue }
      manifests.push(m)
    }
    manifests.sort((a, b) => Date.parse(String(b.copied_at)) - Date.parse(String(a.copied_at)) || String(b.ciphertext ?? '').localeCompare(String(a.ciphertext ?? '')))
    facts.offhost_copies = manifests.length; facts.offhost_manifests_read = read
    if (!manifests.length) problems.push(`no off-host copy manifest at ${dest.label}`)
    else {
      const age = ageS(String(manifests[0].copied_at)); facts.newest_offhost_age_s = age
      if (age === null || age > max) problems.push(`newest off-host copy is ${age}s old (limit ${max}s)`)
      // the copy itself, not its manifest: present, the declared size, the declared hash. Every manifest that shares
      // the newest copied_at is judged, so the listing order never decides which one is.
      const newest = manifests.filter(x => Date.parse(String(x.copied_at)) === Date.parse(String(manifests[0].copied_at))) as { ciphertext?: string; bytes?: number; ciphertext_sha256?: string }[]
      let verified = 0
      for (const m of newest) {
        if (!m.ciphertext || !plainName(m.ciphertext) || !/^[0-9a-f]{64}$/.test(m.ciphertext_sha256 ?? '') || typeof m.bytes !== 'number') { problems.push('newest off-host manifest does not name a ciphertext, its size and its sha256'); continue }
        const d = await dest.digest(m.ciphertext)
        if (!d) problems.push(`newest off-host copy ${m.ciphertext} is missing (only its manifest exists)`)
        else if (d.bytes !== m.bytes) problems.push(`newest off-host copy ${m.ciphertext} has ${d.bytes} bytes, its manifest says ${m.bytes} (truncated or replaced)`)
        else if (d.sha256 !== m.ciphertext_sha256) problems.push(`newest off-host copy ${m.ciphertext} does not match its manifest sha256 (replaced or corrupted)`)
        else verified++
      }
      if (verified === newest.length) facts.newest_offhost_verified = true
    }
  } catch (e) { problems.push(`off-host destination ${dest.label} unreadable: ${reason(e)}`) }
}

const drill = arg('--drill-report')
if (drill) {
  const max = num('--drill-max-age-s', 8 * 86_400)
  const r = readJson(drill)
  if (!r) problems.push('no readable recovery drill report')
  else {
    const age = ageS(r.started_at); facts.drill_age_s = age; facts.drill_ok = r.ok
    if (typeof r.started_at === 'string' && age !== null && future(r.started_at)) problems.push('last recovery drill report has a future timestamp')
    if (r.ok !== true) problems.push(`last recovery drill FAILED (${(r.steps ?? []).filter((s: { ok: boolean }) => !s.ok).map((s: { step: string }) => s.step).join(', ') || 'unknown step'})`)
    if (age === null || age > max) problems.push(`last recovery drill is ${age}s old (limit ${max}s)`)
  }
}

const state = arg('--state-dir') ?? path.join(dir, '.backup-check')
const kind = (p: string) => p.replace(/\d+s old/, 'Ns old') // numbers change every run; the kind of problem is what is throttled
problems.sort((a, b) => kind(a).localeCompare(kind(b)) || a.localeCompare(b)) // one set, one stamp, whatever the discovery order or the ages
const body = { level: problems.length ? 'error' : 'info', type: 'backup_check', ok: problems.length === 0, host: os.hostname(), at: new Date(now).toISOString(), problems, ...facts }
console.log(JSON.stringify(body))
// Stamps are backup-alert-<hash of the problem kinds>. A healthy run removes only them: the state dir may be shared
// with scheduler-check (alert-*) or hold other tools' files, and an operator-supplied directory is never deleted.
const STAMP = 'backup-alert-'
if (!problems.length) {
  try { if (existsSync(state)) for (const f of readdirSync(state)) if (f.startsWith(STAMP)) rmSync(path.join(state, f), { force: true }) }
  catch { /* a stale stamp only delays the next alert of the same kind */ }
  process.exit(0)
}

// A throttle stamp is a delivery receipt, never an attempted-send receipt (the same contract as
// scripts/ops/scheduler-check.mts).
const send = async (b: object): Promise<boolean> => {
  const cmd = process.env.BACKUP_ALERT_CMD, hook = process.env.OPS_ALERT_WEBHOOK_URL
  if (cmd) {
    const result = spawnSync(cmd, [JSON.stringify(b)], { stdio: 'inherit', timeout: 10_000, killSignal: 'SIGKILL' })
    if (result.error || result.status !== 0) { console.error('backup-check: alert command failed'); return false }
    return true
  }
  if (!hook?.startsWith('https://')) { console.error('backup-check: no alert destination: set OPS_ALERT_WEBHOOK_URL (https); problems are in the journal only'); return false }
  try {
    const r = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b), redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!r.ok) { console.error(`backup-check: alert webhook HTTP ${r.status}`); return false }
    return true
  } catch (e) { console.error(`backup-check: alert webhook failed (${e instanceof Error ? e.name : 'error'})`); return false }
}
// The state dir is best-effort. The shipped service has none, so it defaults to inside BACKUP_DIR: when that is gone
// under a parent this user cannot write, the alert still goes out, unthrottled, and the reason is logged. The monitor
// must never die before alerting in the case it exists for.
let stamp: string | null = null
try {
  mkdirSync(state, { recursive: true, mode: 0o700 })
  stamp = path.join(state, STAMP + createHash('sha256').update(problems.map(kind).join('\n')).digest('hex').slice(0, 16))
  if (existsSync(stamp) && now - statSync(stamp).mtimeMs < every * 1000) { console.error('backup-check: alert already sent for these problems within the interval'); process.exit(1) }
} catch (e) { console.error(`backup-check: state dir ${state} unusable (${(e as NodeJS.ErrnoException).code ?? 'error'}); alerting without throttle`); stamp = null }
if (await send(body) && stamp) { try { writeFileSync(stamp, '') } catch (e) { console.error(`backup-check: alert delivered, throttle stamp not written (${(e as NodeJS.ErrnoException).code ?? 'error'}); the next run alerts again`) } }
process.exit(1)
