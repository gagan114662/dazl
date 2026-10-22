// Rehearsal target-identity guards. Every destructive pg-migrate script (slice
// rehearsal, full rehearsal, live contract test) MUST go through here.
//
// Layers (each necessary, none sufficient alone):
//  1. Loopback transport only. No remote override exists in code.
//  2. Dedicated database: current_database() must match /^dazl_rehearse_/.
//  3. Ownership marker: table dazl_rehearse_meta with a random token written by
//     provisionRehearsalDb at creation time; the caller must present the same
//     token. A pre-existing dazl_rehearse_* DB WITHOUT the matching token is
//     refused - setup never marks an unknown existing database.
//  4. Dedicated non-superuser role dazl_rehearse with rights only on the fresh
//     DB. Verified: NOT superuser, no createdb/createrole. NOTE (no overclaim):
//     other databases' PUBLIC-schema defaults are outside our control; we do
//     not claim the role physically cannot touch other targets, only that we
//     grant it nothing beyond the fresh DB and verify its role flags.
import pg from 'pg'

export const ROLE = 'dazl_rehearse'
export const DB_PREFIX = 'dazl_rehearse_'
export const MARKER = 'dazl_rehearse_meta'

export function assertLoopback(url: string): void {
  const u = new URL(url)
  const h = u.hostname
  if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1' && h !== '[::1]') {
    throw new Error(`rehearsal target must be loopback, got host: ${h}`)
  }
}

export interface Provisioned { url: string; dbName: string; token: string }

// Creates a FRESH database (fails if the name somehow exists - never reuses or
// marks an existing one), plants the ownership marker with a random token, and
// ensures the dedicated non-superuser role has rights on only this DB.
export async function provisionRehearsalDb(adminUrl: string, rolePassword: string): Promise<Provisioned> {
  assertLoopback(adminUrl)
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    const dbName = DB_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    // UTF8 + template0 is REQUIRED: sqlite length() counts characters; under a
    // SQL_ASCII cluster default PG char_length counts BYTES and CHECKs diverge
    // (the dense unicode pass caught this). Production target encoding/collation
    // remains an explicit pre-migration decision.
    await admin.query(`CREATE DATABASE "${dbName}" WITH TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`) // fails if it exists - safe by construction
    const roleCheck = await admin.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [ROLE])
    if (roleCheck.rows.length === 0) {
      // utility statement: no bind params allowed; password is generated base36, quote defensively anyway
      await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${rolePassword.replace(/'/g, "''")}'`)
    } else {
      const r = roleCheck.rows[0] as { rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }
      if (r.rolsuper || r.rolcreatedb || r.rolcreaterole) {
        throw new Error(`role ${ROLE} exists with elevated privileges (super=${r.rolsuper} createdb=${r.rolcreatedb} createrole=${r.rolcreaterole}) - refusing`)
      }
      // existing role from an earlier run: rotate to this run's password
      await admin.query(`ALTER ROLE ${ROLE} PASSWORD '${rolePassword.replace(/'/g, "''")}'`)
    }
    await admin.query(`GRANT ALL ON DATABASE "${dbName}" TO ${ROLE}`)
    const u = new URL(adminUrl)
    const dbUrl = `postgres://${u.username}:${u.password}@${u.host}/${dbName}`
    const onNew = new pg.Client({ connectionString: dbUrl })
    await onNew.connect()
    await onNew.query(`CREATE TABLE ${MARKER} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`)
    await onNew.query(`INSERT INTO ${MARKER} (k, v) VALUES ('owned_by', 'dazl-pg-migrate'), ('token', $1), ('created_at', $2)`, [token, String(Math.floor(Date.now() / 1000))])
    await onNew.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${ROLE}`)
    await onNew.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
    await onNew.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${ROLE}`)
    await onNew.end()
    return { url: `postgres://${ROLE}:${encodeURIComponent(rolePassword)}@${u.host}/${dbName}`, dbName, token }
  } finally {
    await admin.end()
  }
}

// Checked by the runner BEFORE any destructive DDL/DML. Marker absence or token
// mismatch is a hard refusal.
export async function assertRehearsalTarget(client: pg.Client, token: string): Promise<void> {
  const db = (await client.query('SELECT current_database() AS d')).rows[0] as { d: string }
  if (!db.d.startsWith(DB_PREFIX)) throw new Error(`refusing: database ${db.d} does not match ${DB_PREFIX}*`)
  const marker = await client.query(`SELECT k, v FROM ${MARKER} WHERE k IN ('owned_by', 'token')`).catch(() => { throw new Error('refusing: no rehearsal ownership marker table') })
  const m = Object.fromEntries((marker.rows as { k: string; v: string }[]).map(r => [r.k, r.v]))
  if (m.owned_by !== 'dazl-pg-migrate') throw new Error('refusing: marker owned_by mismatch')
  if (m.token !== token) throw new Error('refusing: marker token mismatch - this DB was not provisioned by this run')
}

export async function dropRehearsalDb(adminUrl: string, dbName: string): Promise<void> {
  if (!dbName.startsWith(DB_PREFIX)) throw new Error(`refusing to drop ${dbName}`)
  assertLoopback(adminUrl)
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  } finally {
    await admin.end()
  }
}
