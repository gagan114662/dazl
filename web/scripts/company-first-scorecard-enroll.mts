// Run only from the stamped web directory of the already-approved, live
// release. Consume one operator-issued signed grant on stdin. This is not a
// settings action, migration, scan, privileged public route or ticket signer.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { pgDb, sqliteDb } from '../lib/db/client.ts'
import { applyReviewedScorecardEnrollment } from '../lib/company-first/scorecard-enrollment.ts'

const sha = /^[a-f0-9]{40}$/
const secretHex = /^[a-f0-9]{64}$/
const tokenLine = /^[a-zA-Z0-9_-]+\.[a-f0-9]{64}\r?\n?$/
const MAX_GRANT_BYTES = 1202

async function signedInput(): Promise<string | null> {
  // Refuse interactive stdin. A grant must not be typed into command history.
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const data of process.stdin) {
    const part = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if ((bytes += part.byteLength) > MAX_GRANT_BYTES) return null
    chunks.push(part)
  }
  const input = Buffer.concat(chunks).toString('utf8')
  return tokenLine.test(input) ? input.replace(/\r?\n$/, '') : null
}

async function run(): Promise<boolean> {
  if (process.argv.length !== 3 || !sha.test(process.argv[2])) return false
  // No commit env, Git fallback or parent-directory stamp accepted.
  const expected = process.argv[2]
  const marker = await readFile(path.resolve('.build-commit'), 'utf8')
  if (marker.trim() !== expected) return false
  const configured = process.env.DAZL_SCORECARD_SIGNING_KEY
  if (!configured || !secretHex.test(configured)) return false
  const token = await signedInput()
  if (!token) return false
  const key = Buffer.from(configured, 'hex')
  try {
    const url = process.env.DATABASE_URL
    if (url) {
      const db = pgDb({ connectionString: url, max: 1 })
      try { return await applyReviewedScorecardEnrollment(db, expected, token, key) }
      finally { await db.close?.() }
    }
    const file = process.env.DB_PATH
    // No default database path, creation, auto-migration, or schema fallback.
    if (!file || !path.isAbsolute(file)) return false
    const raw = new Database(file, { fileMustExist: true, timeout: 3_000 })
    try { return await applyReviewedScorecardEnrollment(sqliteDb(raw), expected, token, key) }
    finally { raw.close() }
  } finally { key.fill(0) }
}

try {
  if (await run()) console.log('Company-first scorecard enrollment applied.')
  else { console.error('Company-first scorecard enrollment refused.'); process.exitCode = 1 }
} catch {
  // SQL errors, launch environment, identities and signed grants stay private.
  console.error('Company-first scorecard enrollment refused.')
  process.exitCode = 1
}
