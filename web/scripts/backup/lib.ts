// Backup + restore-drill core for the web app's SQLite DB (see web/docs/backup-runbook.md).
// Safety rules baked in here, not in the callers:
//  - A backup source is opened READ-ONLY (fileMustExist). Nothing here writes to a source.
//  - URLs are refused: these scripts take a local backup FILE, they never fetch anything.
//  - createBackup never overwrites: it writes <name>.partial and renames, and the final
//    name carries a timestamp + random suffix.
//  - restoreDrill restores into a work directory it can prove it owns (marker file), and
//    only ever deletes paths inside a marker-blessed directory. There is no env override
//    for these guards; changing them means editing this file, visibly.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const MARKER_FILE = '.dazl-restore-drill-owned.json'

export class GuardError extends Error {}

function resolveLocalFile(p: string, what: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw new GuardError(`${what} must be a local file, not a URL: ${p}`)
  const abs = path.resolve(p)
  if (/-(wal|shm)$/.test(abs)) throw new GuardError(`${what} must be the main .db file, not a -wal/-shm sidecar: ${abs}`)
  return abs
}

function mustBeExistingFile(abs: string, what: string): fs.Stats {
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    throw new GuardError(`${what} does not exist: ${abs}`)
  }
  if (!st.isFile()) throw new GuardError(`${what} is not a regular file: ${abs}`)
  return st
}

function sha256File(abs: string): string {
  // Chunked: a multi-GB backup must not be read into memory whole.
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(8 * 1024 * 1024)
    let n: number
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

// ---------- metrics ----------

export interface TableMetric {
  name: string
  rows: number | null
  contentSha256: string | null
  note?: string
}

export interface DbMetrics {
  integrityOk: boolean
  integrityDetail: string[]
  foreignKeyViolations: number
  foreignKeyDetail: { table: string; rowid: number | null; parent: string; fkid: number }[]
  schemaSha256: string
  tables: TableMetric[]
  pageCount: number
  userVersion: number
}

function canonValue(v: unknown): string {
  if (v === null || v === undefined) return 'n'
  if (typeof v === 'number') return 'f' + (Object.is(v, -0) ? '-0' : String(v))
  if (typeof v === 'bigint') return 'i' + v.toString()
  if (typeof v === 'string') return 's' + JSON.stringify(v)
  if (Buffer.isBuffer(v)) return 'b' + v.toString('hex')
  return 'j' + JSON.stringify(v)
}

function canonRow(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonValue(row[k])).join(',') + '}'
}

// Deterministic content hash of one table: every row is canonicalized, the row strings
// are sorted (so no ORDER BY / primary-key assumptions are needed), then hashed.
// Order-independent, O(1)-memory content hash: sum of per-row sha256 digests mod
// 2^256. Order-independence needs no sort (so no materializing the table), and the
// sum is duplicate-safe (n identical rows contribute n*h, unlike xor). Rows are
// streamed with .iterate(), so a large table does not load into memory.
const MOD = BigInt(1) << BigInt(256)
function tableContentHash(db: Database.Database, table: string): { rows: number; sha256: string } {
  let acc = BigInt(0)
  let rows = 0
  for (const row of db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}"`).iterate() as Iterable<Record<string, unknown>>) {
    acc = (acc + BigInt('0x' + crypto.createHash('sha256').update(canonRow(row) + '\n').digest('hex'))) % MOD
    rows++
  }
  return { rows, sha256: acc.toString(16).padStart(64, '0') }
}

export function collectDbMetrics(db: Database.Database): DbMetrics {
  const schemaRows = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[]
  const schemaSha256 = crypto
    .createHash('sha256')
    .update(schemaRows.map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql ?? ''}`).join('\n'))
    .digest('hex')

  const integrityRows = db.pragma('integrity_check') as { integrity_check: string }[]
  const integrityDetail = integrityRows.map((r) => r.integrity_check)
  const integrityOk = integrityDetail.length === 1 && integrityDetail[0] === 'ok'

  const fkRows = db.pragma('foreign_key_check') as { table: string; rowid: number | null; parent: string; fkid: number }[]

  const tables: TableMetric[] = []
  for (const r of schemaRows.filter((s) => s.type === 'table')) {
    try {
      const { rows, sha256 } = tableContentHash(db, r.name)
      tables.push({ name: r.name, rows, contentSha256: sha256 })
    } catch (e) {
      // Virtual tables and similar can refuse a plain SELECT *; the schema hash still covers them.
      tables.push({ name: r.name, rows: null, contentSha256: null, note: `skipped: ${(e as Error).message}` })
    }
  }

  return {
    integrityOk,
    integrityDetail: integrityOk ? [] : integrityDetail.slice(0, 20),
    foreignKeyViolations: fkRows.length,
    foreignKeyDetail: fkRows.slice(0, 20),
    schemaSha256,
    tables,
    pageCount: db.pragma('page_count', { simple: true }) as number,
    userVersion: db.pragma('user_version', { simple: true }) as number,
  }
}

// ---------- create ----------

export interface BackupResult {
  sourcePath: string
  backupPath: string
  sidecarPath: string
  bytes: number
  sha256: string
  durationMs: number
  createdAt: string
}

export async function createBackup(opts: { source: string; destDir: string }): Promise<BackupResult> {
  const started = Date.now()
  const source = resolveLocalFile(opts.source, 'backup source')
  mustBeExistingFile(source, 'backup source')

  const destDir = path.resolve(opts.destDir)
  fs.mkdirSync(destDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const name = `dazl-backup-${stamp}-${crypto.randomBytes(4).toString('hex')}.db`
  const finalPath = path.join(destDir, name)
  const partialPath = finalPath + '.partial'
  if (fs.existsSync(finalPath)) throw new GuardError(`refusing to overwrite existing backup: ${finalPath}`)

  const srcDb = new Database(source, { readonly: true, fileMustExist: true })
  try {
    // SQLite online backup API: transactionally consistent even while the app keeps
    // writing (WAL readers never block the writer). Never copy a live DB file by hand.
    await srcDb.backup(partialPath)
  } finally {
    srcDb.close()
  }

  try {
    // Prove the bytes we just wrote, then normalize to journal_mode=DELETE so the backup
    // is ONE self-contained file (no -wal sidecar) that is safe to copy, rsync or archive.
    const check = new Database(partialPath)
    const integrity = check.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') throw new Error(`fresh backup failed integrity_check: ${integrity}`)
    check.pragma('journal_mode = DELETE')
    check.close()
    fs.renameSync(partialPath, finalPath)
  } catch (e) {
    fs.rmSync(partialPath, { force: true })
    throw e
  }

  const sha256 = sha256File(finalPath)
  const bytes = fs.statSync(finalPath).size
  const sidecarPath = finalPath + '.json'
  const result: BackupResult = {
    sourcePath: source,
    backupPath: finalPath,
    sidecarPath,
    bytes,
    sha256,
    durationMs: Date.now() - started,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(sidecarPath, JSON.stringify({ ...result, tool: 'dazl-create-backup' }, null, 2) + '\n', { flag: 'wx' })
  return result
}

// ---------- restore drill ----------

export interface DrillReport {
  verdict: 'pass' | 'fail'
  steps: { step: string; ok: boolean }[]
  reasons: string[]
  warnings: string[]
  backupPath: string
  backupSha256Before: string
  sidecarPath: string | null
  sidecarVerified: boolean | null
  backupUnchangedAfterDrill: boolean
  tablesChecked: number
  mismatches: string[]
  sourceMetrics: DbMetrics | null
  restoredMetrics: DbMetrics | null
  workDirKept: string | null
  durationMs: number
}

function writeMarker(dir: string): void {
  fs.writeFileSync(
    path.join(dir, MARKER_FILE),
    JSON.stringify({ tool: 'dazl-restore-drill', createdAt: new Date().toISOString(), pid: process.pid }, null, 2) + '\n',
    { flag: 'wx' },
  )
}

function ownsWorkDir(dir: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER_FILE), 'utf8'))
    return m && m.tool === 'dazl-restore-drill'
  } catch {
    return false
  }
}

// The only deletion path in this module: target must live INSIDE a marker-blessed dir.
function rmInsideOwnedDir(ownedDir: string, target: string): void {
  const base = path.resolve(ownedDir)
  const t = path.resolve(target)
  if (t !== base && !t.startsWith(base + path.sep)) throw new GuardError(`refusing to delete outside owned work dir: ${t}`)
  if (!ownsWorkDir(base)) throw new GuardError(`refusing to delete: ${base} lost its ${MARKER_FILE} marker`)
  fs.rmSync(t, { recursive: true, force: true })
}

export async function restoreDrill(opts: {
  backupPath: string
  workDir?: string
  keepWorkDir?: boolean
}): Promise<DrillReport> {
  const started = Date.now()
  const backup = resolveLocalFile(opts.backupPath, 'backup file')
  const st = mustBeExistingFile(backup, 'backup file')
  const backupSha256Before = sha256File(backup)
  const backupMtimeBefore = st.mtimeMs

  const reasons: string[] = []
  const warnings: string[] = []

  // If the backup was made by create-backup, its .json sidecar pins the expected sha256.
  // SQLite has no content checksums, so this manifest is the only way to detect silent
  // byte-level tampering in a backup that still opens and restores cleanly.
  let sidecarPath: string | null = null
  let sidecarVerified: boolean | null = null
  const candidateSidecar = backup + '.json'
  if (fs.existsSync(candidateSidecar)) {
    sidecarPath = candidateSidecar
    try {
      const manifest = JSON.parse(fs.readFileSync(candidateSidecar, 'utf8'))
      if (manifest.tool === 'dazl-create-backup' && typeof manifest.sha256 === 'string') {
        sidecarVerified = manifest.sha256 === backupSha256Before && manifest.bytes === st.size
        if (!sidecarVerified) {
          reasons.push(`backup file does not match its sidecar manifest ${candidateSidecar} (expected sha256 ${manifest.sha256}, got ${backupSha256Before}) - file was modified after creation`)
        }
      } else {
        warnings.push(`sidecar ${candidateSidecar} is not a dazl-create-backup manifest; ignoring it`)
      }
    } catch {
      warnings.push(`sidecar ${candidateSidecar} is unreadable; ignoring it`)
    }
  } else {
    warnings.push('no .json sidecar manifest next to the backup; content-level tampering that keeps the file valid cannot be detected without it')
  }

  // Work dir: either a fresh mkdtemp (we own it by construction) or a caller-supplied dir
  // that is either absent (we create + mark it) or already marker-blessed by a past drill.
  let ownedDir: string
  let ownedDirIsTemp = false
  if (opts.workDir) {
    ownedDir = path.resolve(opts.workDir)
    if (fs.existsSync(ownedDir)) {
      if (!fs.statSync(ownedDir).isDirectory()) throw new GuardError(`work dir exists and is not a directory: ${ownedDir}`)
      if (!ownsWorkDir(ownedDir)) {
        throw new GuardError(
          `refusing to use ${ownedDir}: it exists and was not created by a restore drill (no ${MARKER_FILE}). ` +
            `Pick an empty/new path or remove it yourself.`,
        )
      }
    } else {
      fs.mkdirSync(ownedDir, { recursive: false })
      writeMarker(ownedDir)
    }
  } else {
    ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dazl-restore-drill-'))
    writeMarker(ownedDir)
    ownedDirIsTemp = true
  }
  const runDir = path.join(ownedDir, `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(runDir)

  const mismatches: string[] = []
  let sourceMetrics: DbMetrics | null = null
  let restoredMetrics: DbMetrics | null = null
  let tablesChecked = 0
  let backupUnchangedAfterDrill = false

  try {
    let srcDb: Database.Database | null = null
    try {
      srcDb = new Database(backup, { readonly: true, fileMustExist: true })
    } catch (e) {
      reasons.push(`backup file cannot be opened by SQLite: ${(e as Error).message}`)
    }

    let restoredDb: Database.Database | null = null
    try {
      if (!srcDb) throw new Error('skip: backup did not open')
      try {
        sourceMetrics = collectDbMetrics(srcDb)
      } catch (e) {
        reasons.push(`backup is malformed: ${(e as Error).message}`)
        throw new Error('skip: backup metrics failed')
      }
      if (!sourceMetrics.integrityOk) {
        reasons.push(`backup itself fails integrity_check: ${sourceMetrics.integrityDetail.join('; ')}`)
      }

      // The restore step: materialize the backup into the sandbox via the backup API.
      // If the backup is unreadable as a database, this throws and the drill fails.
      const restoredPath = path.join(runDir, 'restored.db')
      await srcDb.backup(restoredPath)
      restoredDb = new Database(restoredPath)
      restoredMetrics = collectDbMetrics(restoredDb)

      if (!restoredMetrics.integrityOk) {
        reasons.push(`restored copy fails integrity_check: ${restoredMetrics.integrityDetail.join('; ')}`)
      }
      if (restoredMetrics.schemaSha256 !== sourceMetrics.schemaSha256) {
        mismatches.push('schema hash differs between backup and restored copy')
      }
      const byNameSource = new Map(sourceMetrics.tables.map((t) => [t.name, t]))
      for (const rt of restoredMetrics.tables) {
        const st2 = byNameSource.get(rt.name)
        if (!st2) {
          mismatches.push(`table ${rt.name} present in restored copy but not in backup`)
          continue
        }
        if (rt.rows !== null || st2.rows !== null) {
          tablesChecked++
          if (rt.rows !== st2.rows) mismatches.push(`table ${rt.name}: row count ${st2.rows} in backup vs ${rt.rows} restored`)
          if (rt.contentSha256 !== st2.contentSha256) mismatches.push(`table ${rt.name}: content hash differs`)
        }
      }
      for (const s of sourceMetrics.tables) {
        if (!restoredMetrics.tables.some((t) => t.name === s.name)) mismatches.push(`table ${s.name} missing from restored copy`)
      }
      if (sourceMetrics.foreignKeyViolations > 0) {
        // Advisory, not failure: the app historically runs without PRAGMA foreign_keys,
        // so a faithful backup can legitimately contain violations. See the runbook.
        warnings.push(
          `${sourceMetrics.foreignKeyViolations} foreign-key violation(s) present in the backup data itself ` +
            `(restored identically; app does not enforce FKs): ${JSON.stringify(sourceMetrics.foreignKeyDetail.slice(0, 3))}`,
        )
      }
    } catch (e) {
      if (!(e as Error).message.startsWith('skip:')) reasons.push(`restore failed: ${(e as Error).message}`)
    } finally {
      if (srcDb) srcDb.close()
      if (restoredDb) restoredDb.close()
    }
  } finally {
    // Prove the drill never touched the backup file before we report or clean up.
    const after = fs.statSync(backup)
    backupUnchangedAfterDrill =
      after.size === st.size && after.mtimeMs === backupMtimeBefore && sha256File(backup) === backupSha256Before
    if (!backupUnchangedAfterDrill) reasons.push('the drill modified the backup file - this must never happen')

    if (opts.keepWorkDir) {
      // leave runDir in place for inspection
    } else {
      rmInsideOwnedDir(ownedDir, runDir)
      if (ownedDirIsTemp) rmInsideOwnedDir(ownedDir, ownedDir)
    }
  }

  if (mismatches.length) reasons.push(...mismatches)
  // One entry per thing the drill checks, so a monitor (backup-check.mts) can name what failed, not only that it did.
  const steps: { step: string; ok: boolean }[] = [
    { step: 'sidecar sha256', ok: sidecarVerified !== false },
    { step: 'backup integrity', ok: sourceMetrics?.integrityOk === true },
    { step: 'restore and compare', ok: restoredMetrics !== null && restoredMetrics.integrityOk && mismatches.length === 0 },
    { step: 'backup unchanged by drill', ok: backupUnchangedAfterDrill },
  ]
  return {
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    steps,
    reasons,
    warnings,
    backupPath: backup,
    backupSha256Before,
    sidecarPath,
    sidecarVerified,
    backupUnchangedAfterDrill,
    tablesChecked,
    mismatches,
    sourceMetrics,
    restoredMetrics,
    workDirKept: opts.keepWorkDir ? runDir : null,
    durationMs: Date.now() - started,
  }
}
