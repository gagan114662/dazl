// One-click Connect LinkedIn (#1037, F-go step 2): the dazl Connect browser extension reads the user's OWN LinkedIn session cookies
// (li_at, JSESSIONID) from their signed-in browser and hands them to the tenant that paired it. No cookie is ever pasted.
//
//   1. Settings asks for a PAIRING CODE (action 'pair'): one per tenant at a time, single use, PAIR_TTL_S (10 min). Only a signed-in
//      member who may configure the workspace, same-origin, after the LinkedIn risk notice was accepted.
//   2. The extension trades the code for a DEVICE TOKEN (redeemPairing). The code is consumed by a conditional delete, so two
//      redeems of one code cannot both succeed. The token is bound to the tenant; one device per tenant (a new pairing replaces it).
//   3. With the device token the extension saves the session (saveSessionFromDevice), now and whenever LinkedIn rotates the cookie.
//      The session is stored exactly as a pasted one (the encrypted `adv:linkedin` connector credential), so every gate, cap and
//      kill switch on its use applies unchanged.
//   4. Disconnect (Settings) revokes the device and removes the stored session.
//
// Codes and tokens are `<tenantId>.<32 random bytes, base64url>`: the prefix finds the tenant's row; the secret part is compared in
// constant time. Both live as encrypted rows in tenant_connectors (erased with the tenant like every credential) and are never listed
// as connectors (connectorStatus). Db layer: SQLite and Postgres.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { encryptSecret, decryptSecret } from '../secrets.ts'
import type { Tx, TxBody } from '../db/client.ts'
import { connectorId, maxCallsPerHour } from './config.ts'
import { coolingDown, reserveRequest } from './request-budget.ts'
import { readConsent } from './index.ts'
import { setEnabled, writeAudit } from '../connectors/store.ts'
import { DAY_CONNECTOR, sessionLimits } from '../signals/linkedin-people.ts'
import { can } from '../workspaces.ts'

export const PAIR_CONNECTOR = 'adv:linkedin:pair'
export const DEVICE_CONNECTOR = 'adv:linkedin:device'
export const PAIR_TTL_S = 10 * 60
const ctx = (tenantId: string, connector: string) => `connector:${tenantId}:${connector}`
const b64u = (b: Buffer) => b.toString('base64url')
const sha = (s: string) => createHash('sha256').update(s).digest()
const same = (a: string, b: string) => timingSafeEqual(sha(a), sha(b))
const TOKEN = /^([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{43})$/

interface PairRow { s: string; u: string; exp: number }
export interface DeviceRow { s: string; u: string; at: number; name: string | null; public_id: string | null; synced_at: number | null }

async function read<T>(db: Db, tenantId: string, connector: string, master?: Buffer): Promise<{ row: T; ciphertext: string } | null> {
  const r = await db.get<{ ciphertext: string }>('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, connector])
  if (!r?.ciphertext) return null
  try { return { row: JSON.parse(decryptSecret(r.ciphertext, ctx(tenantId, connector), master)) as T, ciphertext: r.ciphertext } } catch { return null }
}
async function write(db: Db, tenantId: string, connector: string, value: unknown, master?: Buffer): Promise<void> {
  await db.run(`INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, ?, '', 1)
     ON CONFLICT(tenant_id, connector) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = '', enabled = 1`, [tenantId, connector, encryptSecret(JSON.stringify(value), ctx(tenantId, connector), master)])
}

// A new code replaces any earlier one for the tenant. Returns the code once; only its encrypted form is stored.
export async function createPairing(db: Db, tenantId: string, userId: string, now = Math.floor(Date.now() / 1000), master?: Buffer): Promise<{ code: string; expires_at: number }> {
  const s = b64u(randomBytes(32))
  await write(db, tenantId, PAIR_CONNECTOR, { s, u: userId, exp: now + PAIR_TTL_S } satisfies PairRow, master)
  return { code: `${tenantId}.${s}`, expires_at: now + PAIR_TTL_S }
}

// The code -> a device token for the code's tenant, or null (malformed, unknown, expired, already used). Single use: the pairing row
// is deleted only when it is still the row that was read, so a second redeem of the same code (or a race) gets null.
export async function redeemPairing(db: Db, code: unknown, now = Math.floor(Date.now() / 1000), master?: Buffer): Promise<{ tenantId: string; userId: string; token: string } | null> {
  const m = typeof code === 'string' ? TOKEN.exec(code.trim()) : null
  if (!m) return null
  const [, tenantId, secret] = m
  const got = await read<PairRow>(db, tenantId, PAIR_CONNECTOR, master)
  if (!got || typeof got.row.s !== 'string' || !same(got.row.s, secret)) return null
  const gone = await db.run('DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector = ? AND ciphertext = ?', [tenantId, PAIR_CONNECTOR, got.ciphertext])
  if (gone.changes !== 1) return null
  if (!(got.row.exp > now)) return null
  const s = b64u(randomBytes(32))
  await write(db, tenantId, DEVICE_CONNECTOR, { s, u: got.row.u, at: now, name: null, public_id: null, synced_at: null } satisfies DeviceRow, master)
  return { tenantId, userId: got.row.u, token: `${tenantId}.${s}` }
}

// A device token -> its tenant and device record, or null.
// `ciphertext` is the device row as it was read: every later write for this device is conditional on it (see saveSessionFromDevice).
export async function authDevice(db: Db, token: unknown, master?: Buffer): Promise<{ tenantId: string; device: DeviceRow; ciphertext: string } | null> {
  const m = typeof token === 'string' ? TOKEN.exec(token.trim()) : null
  if (!m) return null
  const got = await read<DeviceRow>(db, m[1], DEVICE_CONNECTOR, master)
  if (!got || typeof got.row.s !== 'string' || !same(got.row.s, m[2])) return null
  // The member who paired the device must still belong to the workspace and still be allowed to configure it: a removed member's
  // browser, or one whose role was lowered, stops syncing at once.
  const r = await db.get<{ role: string }>('SELECT role FROM memberships WHERE tenant_id = ? AND member_id = ?', [m[1], got.row.u])
  return r && can(r.role as Parameters<typeof can>[0], 'configure') ? { tenantId: m[1], device: got.row, ciphertext: got.ciphertext } : null
}

// The two cookies, as the browser holds them. li_at is a long opaque token; JSESSIONID is "ajax:<digits>" (sent quoted by LinkedIn).
const LI_AT = /^[A-Za-z0-9_\-.~%+/=]{20,2000}$/
const JSESSION = /^"?(ajax:\d{6,30})"?$/
export function sessionFromCookies(liAt: unknown, jsessionid: unknown): string | null {
  const a = typeof liAt === 'string' ? liAt.trim() : ''
  const j = typeof jsessionid === 'string' ? JSESSION.exec(jsessionid.trim())?.[1] : undefined
  return LI_AT.test(a) && j ? `li_at=${a}; JSESSIONID="${j}"` : null
}

// Writes for a device are keyed on the device's SECRET and done in one transaction: the row is read, the secret compared, and the update is
// conditional on that row's ciphertext. A Disconnect or a newer pairing (the row gone, or another secret) means nothing is written and the
// caller answers 401. A harmless concurrent write by the SAME device (a rotation sync, a Settings "Test connection" naming the account)
// re-encrypts the row with a fresh IV: that is not a revocation, so the write is retried against the new row (a few times, then refused).
// Never an upsert: an in-flight request must not bring a revoked device, or the session it carried, back.
function* readDevice(t: Tx, tenantId: string, master?: Buffer): TxBody<{ row: DeviceRow; ciphertext: string } | null> {
  const r = yield* t.get<{ ciphertext: string }>('SELECT ciphertext FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, DEVICE_CONNECTOR])
  if (!r?.ciphertext) return null
  try { return { row: JSON.parse(decryptSecret(r.ciphertext, ctx(tenantId, DEVICE_CONNECTOR), master)) as DeviceRow, ciphertext: r.ciphertext } } catch { return null }
}
function* updateDevice(t: Tx, tenantId: string, secret: string, patch: (d: DeviceRow) => DeviceRow, master?: Buffer): TxBody<boolean> {
  for (let i = 0; i < 3; i++) {
    const cur = yield* readDevice(t, tenantId, master)
    if (!cur || typeof cur.row.s !== 'string' || !same(cur.row.s, secret)) return false
    const ct = encryptSecret(JSON.stringify(patch(cur.row)), ctx(tenantId, DEVICE_CONNECTOR), master)
    if ((yield* t.run('UPDATE tenant_connectors SET ciphertext = ? WHERE tenant_id = ? AND connector = ? AND ciphertext = ?', [ct, tenantId, DEVICE_CONNECTOR, cur.ciphertext])).changes === 1) return true
  }
  return false
}

// Saves the session for the device's tenant, in ONE transaction with the device check: the same encrypted `adv:linkedin` credential a pasted
// session is, EXCEPT that its on/off switch is kept as it is. A connector that was switched off (by the user, or by the reader after a
// challenge or a sign-out: lib/signals/linkedin-people.ts) stays off; a cookie rotation never switches it back on. A first save creates it on.
// false when the device is gone or replaced (the caller answers 401).
export async function saveSessionFromDevice(db: Db, tenantId: string, secret: string, session: string, now = Math.floor(Date.now() / 1000), master?: Buffer): Promise<boolean> {
  const id = connectorId('linkedin')
  const cred = encryptSecret(session, ctx(tenantId, id), master)
  return db.tx(function* (t: Tx): TxBody<boolean> {
    if (!(yield* updateDevice(t, tenantId, secret, d => ({ ...d, synced_at: now }), master))) return false
    yield* t.run(`INSERT INTO tenant_connectors (tenant_id, connector, ciphertext, last4, enabled) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(tenant_id, connector) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4`, [tenantId, id, cred, session.slice(-4)])
    return true
  })
}

// The account name the session belongs to (from the worker's /linkedin/me), kept for "Connected as <name>"; keyed on the device secret.
export async function recordAccount(db: Db, tenantId: string, secret: string, account: { name: string; public_id: string | null }, master?: Buffer): Promise<boolean> {
  return db.tx(t => updateDevice(t, tenantId, secret, d => ({ ...d, name: account.name.slice(0, 120), public_id: account.public_id?.slice(0, 100) ?? null }), master))
}

// "Test connection" from Settings: the account name goes on the tenant's device record, when there is one.
export async function recordAccountForTenant(db: Db, tenantId: string, account: { name: string; public_id: string | null }, master?: Buffer): Promise<boolean> {
  const d = await read<DeviceRow>(db, tenantId, DEVICE_CONNECTOR, master)
  return !!d && typeof d.row.s === 'string' && await recordAccount(db, tenantId, d.row.s, account, master)
}

// The account check, behind every guard any LinkedIn consumer passes before a request (lib/advanced/request-budget.ts): the connector must be
// on, the workspace must not be in a cooldown after a throttle / challenge / sign-out, and the request takes one slot of the SHARED hourly
// budget (reserved before the call, never refunded). Then ONE read of the session's own profile.
export async function guardedAccountCheck(db: Db, tenantId: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch, master?: Buffer): Promise<{ ok: true; name: string; public_id: string | null } | { ok: false; outcome: string }> {
  const id = connectorId('linkedin')
  if (!(await readConsent(db, tenantId, 'linkedin'))) return { ok: false, outcome: 'no_consent' }
  const row = await db.get<{ ciphertext: string; enabled: number }>('SELECT ciphertext, enabled FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, id])
  if (!row?.ciphertext) return { ok: false, outcome: 'not_connected' }
  if (Number(row.enabled) !== 1) return { ok: false, outcome: 'connector_off' }
  if (await coolingDown(db, tenantId, id)) return { ok: false, outcome: 'cooldown' }
  if (!(await reserveRequest(db, tenantId, id, maxCallsPerHour('linkedin', env), 'account_check'))) return { ok: false, outcome: 'budget' }
  // the session's daily cap too (the hour slot is already spent when the day is refused: never undercounts, as in the reader)
  if (!(await reserveRequest(db, tenantId, DAY_CONNECTOR, sessionLimits(env).daily, 'account_check', Math.floor(Date.now() / 1000), 86_400))) return { ok: false, outcome: 'daily_cap' }
  let session: string
  try { session = decryptSecret(row.ciphertext, ctx(tenantId, id), master) } catch { return { ok: false, outcome: 'unreadable' } }
  const res = await checkAccount(session, env, fetchImpl)
  // A throttle, challenge or sign-out stops every LinkedIn consumer of the workspace exactly as the reader's own stop does: a visible stop
  // that starts the cooldown, and on a challenge or a sign-out the session goes OFF until a person turns it back on.
  if (!res.ok && (res.outcome === 'throttled' || res.outcome === 'challenge' || res.outcome === 'auth_failed')) {
    const status = res.outcome === 'auth_failed' ? 'unauthorized' : res.outcome
    await writeAudit(db, { tenantId, connector: id, jobId: null, lookup: 'account check', status: `stopped_${status}`, results: 0 })
    if (status !== 'throttled') { await setEnabled(db, tenantId, id, false); await writeAudit(db, { tenantId, connector: id, jobId: null, lookup: 'account check', status: 'session_disabled', results: 0 }) }
  }
  return res
}

// For Settings: never a secret.
export async function connectionStatus(db: Db, tenantId: string, master?: Buffer): Promise<{ connected: boolean; name: string | null; synced_at: number | null; pairing_pending: boolean }> {
  const d = await read<DeviceRow>(db, tenantId, DEVICE_CONNECTOR, master)
  const p = await db.get('SELECT 1 FROM tenant_connectors WHERE tenant_id = ? AND connector = ?', [tenantId, PAIR_CONNECTOR])
  return { connected: !!d, name: d?.row.name ?? null, synced_at: d?.row.synced_at ?? null, pairing_pending: !!p }
}

// Disconnect: the device, any pending code and the stored session go. true when anything was removed.
export async function disconnect(db: Db, tenantId: string): Promise<boolean> {
  return db.tx(function* (t: Tx): TxBody<boolean> {
    const r = yield* t.run('DELETE FROM tenant_connectors WHERE tenant_id = ? AND connector IN (?, ?, ?)', [tenantId, DEVICE_CONNECTOR, PAIR_CONNECTOR, connectorId('linkedin')])
    return r.changes > 0
  })
}

// The worker's account check itself: ONE GET of the session's own profile. { name } or the typed outcome. Callers go through guardedAccountCheck.
export async function checkAccount(session: string, env: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; name: string; public_id: string | null } | { ok: false; outcome: string }> {
  if (!env.ADVANCED_WORKER_URL || !env.ADVANCED_WORKER_TOKEN) return { ok: false, outcome: 'no_worker' }
  try {
    const res = await fetchImpl(`${env.ADVANCED_WORKER_URL.replace(/\/$/, '')}/linkedin/me`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADVANCED_WORKER_TOKEN}` }, body: JSON.stringify({ session }), signal: AbortSignal.timeout(25_000) })
    const j = await res.json().catch(() => null) as { name?: unknown; public_id?: unknown; outcome?: unknown } | null
    if (res.ok && typeof j?.name === 'string' && j.name.trim()) return { ok: true, name: j.name.trim().slice(0, 120), public_id: typeof j.public_id === 'string' ? j.public_id.slice(0, 100) : null }
    return { ok: false, outcome: typeof j?.outcome === 'string' ? j.outcome : res.ok ? 'schema_error' : 'worker_error' }
  } catch { return { ok: false, outcome: 'worker_unreachable' } }
}
