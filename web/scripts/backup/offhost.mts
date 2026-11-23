// The off-host destination as the recovery tools use it (issue #360): the same OFFHOST_DEST spec offhost-copy.sh writes
// to and backup-check.mts reads: a directory (a mounted remote, a second disk), rclone:REMOTE:PATH, or s3:BUCKET/PREFIX
// (s3.mts: a write-only key, so list and put work and read, fetch and remove are refused by design). Used by
// prune-backups.mts (list, delete) and replacement-drill.mts (list, read, fetch). Every rclone call is bounded by
// RCLONE_TIMEOUT_S (a positive integer, default 120; anything else is 120) and any rclone failure throws, naming the
// subcommand and exit code only (never a path or a remote's credentials).
import { spawnSync } from 'node:child_process'
import { chmodSync, chownSync, copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseS3, s3Label, type S3Object } from './s3.mts'

export const sha256File = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

export interface OffhostDest {
  label: string
  list(): string[]
  read(name: string): string
  fetch(name: string, to: string): void
  // upload a local file under name: a directory gets .partial then a rename (mode 600); rclone gets copyto
  put(from: string, name: string): void
  remove(name: string): void
  // true for s3:BUCKET/PREFIX: the key can add and list copies, never read or delete one. Retention there is the
  // bucket's lifecycle rule, not prune-backups.mts.
  writeOnly?: boolean
}

// only plain file names are ever read, fetched or removed: no path separators, no leading dot, no traversal
export const plainName = (n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 200 && /^[A-Za-z0-9._-]+$/.test(n) && !n.startsWith('.')

export function rcloneTimeoutS(raw = process.env.RCLONE_TIMEOUT_S): number {
  const v = raw === undefined || raw.trim() === '' ? 120 : /^\d+$/.test(raw.trim()) ? Number(raw) : 0
  return v > 0 ? v : 120
}

export function openDest(spec: string): OffhostDest {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('no off-host destination (OFFHOST_DEST)')
  const guard = (n: string) => { if (!plainName(n)) throw new Error(`refused file name ${JSON.stringify(String(n).slice(0, 40))}`) }
  if (spec.startsWith('rclone:')) {
    const remote = spec.slice('rclone:'.length).replace(/\/+$/, '')
    if (!remote.includes(':')) throw new Error('rclone destination must be rclone:REMOTE:PATH')
    const bin = process.env.RCLONE_BIN || 'rclone', limit = rcloneTimeoutS()
    const run = (args: string[]) => {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: limit * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`rclone ${args[0]} timed out (${limit}s)`)
      if (r.error) throw new Error(`rclone not runnable (${(r.error as NodeJS.ErrnoException).code ?? r.error.name})`)
      if (r.status !== 0) throw new Error(`rclone ${args[0]} failed (exit ${r.status})`)
      return r.stdout
    }
    return {
      label: remote.split(':')[0] + ':',
      list: () => run(['lsf', '--files-only', remote]).split('\n').map(l => l.trim()).filter(Boolean),
      read: n => { guard(n); return run(['cat', `${remote}/${n}`]) },
      fetch: (n, to) => { guard(n); run(['copyto', `${remote}/${n}`, to]) },
      put: (from, n) => { guard(n); run(['copyto', from, `${remote}/${n}`]) },
      remove: n => { guard(n); run(['deletefile', `${remote}/${n}`]) },
    }
  }
  if (spec.startsWith('s3:')) {
    parseS3(spec) // a malformed destination is refused here, not at the first upload
    // the same CLI offhost-copy.sh uploads with, as a child process: this interface is synchronous, s3.mts is fetch
    const cli = fileURLToPath(new URL('./s3.mts', import.meta.url)), limit = rcloneTimeoutS(process.env.S3_TIMEOUT_S)
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { encoding: 'utf8', timeout: (limit + 30) * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 })
      if (r.error) throw new Error(`s3 ${args[0]} not runnable (${(r.error as NodeJS.ErrnoException).code ?? r.error.name})`)
      if (r.status !== 0) throw new Error((r.stderr.trim().split('\n').pop() ?? '').replace(/^s3: /, '') || `s3 ${args[0]} failed (exit ${r.status})`)
      return r.stdout
    }
    const no = (what: string) => (): never => { throw new Error(`${what} is not possible at an s3: destination: the box's key is write-only by design (restore with ops/backup/restore-s3.sh on a machine with the owner's AWS login)`) }
    return {
      label: s3Label(spec), writeOnly: true,
      list: () => (JSON.parse(run(['list', spec])) as S3Object[]).map(o => o.name),
      read: no('reading a copy'), fetch: no('fetching a copy'), remove: no('deleting a copy'),
      put: (from, n) => { guard(n); run(['put', from, spec, n]) },
    }
  }
  const d = path.resolve(spec)
  return {
    label: path.basename(d),
    list: () => { if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error('directory not found'); return readdirSync(d) },
    read: n => { guard(n); return readFileSync(path.join(d, n), 'utf8') },
    fetch: (n, to) => { guard(n); copyFileSync(path.join(d, n), to) },
    // run as root (config-backup.mts), the file is handed to the directory's owner: the app user's backup-check and
    // prune must be able to read and remove what root wrote there
    put: (from, n) => {
      guard(n); const p = path.join(d, n); copyFileSync(from, p + '.partial'); chmodSync(p + '.partial', 0o600)
      if (process.getuid?.() === 0) { const o = statSync(d); chownSync(p + '.partial', o.uid, o.gid) }
      renameSync(p + '.partial', p)
    },
    remove: n => { guard(n); unlinkSync(path.join(d, n)) },
  }
}

// dazl-backup-<YYYYMMDDTHHMMSSZ>... -> epoch ms, else null (the timestamp create-backup.ts embeds in every name)
export function nameTime(name: string, prefix = 'dazl-backup-'): number | null {
  if (!name.startsWith(prefix)) return null
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name.slice(prefix.length))
  if (!m) return null
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  const back = new Date(t)
  // 20261399T... must not roll over into another month: the parts must round-trip
  if (back.getUTCFullYear() !== +m[1] || back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3] || back.getUTCHours() !== +m[4] || back.getUTCMinutes() !== +m[5] || back.getUTCSeconds() !== +m[6]) return null
  return t
}

// The off-host retention policy (prune-backups.mts on the box, pull-offhost.mts on the operator machine): of copies named
// with their timestamp, the newest `hourly`, plus the newest of each of the last `daily` UTC days and of each of the last
// `weekly` ISO weeks. `copies` is [name, epoch ms], newest first.
export function retainedCopies(copies: [string, number][], retain: { hourly: number; daily: number; weekly: number }): Set<string> {
  const keep = new Set(copies.slice(0, retain.hourly).map(([b]) => b))
  const day = (t: number) => new Date(t).toISOString().slice(0, 10)
  const week = (t: number) => { const d = new Date(t); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10) } // Monday of the ISO week
  for (const [bucket, n] of [[day, retain.daily], [week, retain.weekly]] as const) {
    const seen = new Set<string>()
    for (const [b, t] of copies) { const k = bucket(t); if (seen.has(k)) continue; seen.add(k); if (seen.size > n) break; keep.add(b) }
  }
  return keep
}
