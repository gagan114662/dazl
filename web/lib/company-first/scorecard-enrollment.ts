import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db, TxBody } from '../db/client.ts'

const hex64 = /^[0-9a-f]{64}$/
const hex40 = /^[0-9a-f]{40}$/
const identity = /^[A-Za-z0-9_-]{1,100}$/

/** Server operations only; do not mount an ordinary settings or job route.
 * The protected signer issues one short-lived, exact-workspace revision
 * transition after review. No signer, default key, request cookie, arbitrary
 * environment flag, or public API is defined here. A successful CAS only
 * opens the workspace gate; each run still requires its own signed ticket. */
export async function applyReviewedScorecardEnrollment(db: Db, release: string, token: string,
  trustedKey: Uint8Array, clock = Date.now): Promise<boolean> {
  const now = clock()
  if (!hex40.test(release) || !Number.isSafeInteger(now) || now < 1 || trustedKey.byteLength < 32 ||
      typeof token !== 'string' || token.length > 1200) return false
  const [encoded, mac, extra] = token.split('.')
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded ?? '') || !hex64.test(mac ?? '')) return false
  try {
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded ||
        !timingSafeEqual(createHmac('sha256', trustedKey).update('dazl-scorecard-enrollment:v1\n').update(encoded).digest(),
          Buffer.from(mac,'hex'))) return false
    const data: unknown = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(data) || data.length !== 8) return false
    const [tenant, actor, exactRelease, previous, next, enabledBefore, enabledAfter, expiry] = data
    if (typeof tenant !== 'string' || !identity.test(tenant) || typeof actor !== 'string' || !identity.test(actor) ||
        exactRelease !== release || (previous !== null && (typeof previous !== 'string' || !hex64.test(previous))) ||
        typeof next !== 'string' || !hex64.test(next) || previous === next ||
        typeof enabledBefore !== 'boolean' || typeof enabledAfter !== 'boolean' || enabledBefore === enabledAfter ||
        !Number.isSafeInteger(expiry) || expiry <= now || expiry - now > 900_000) return false
    return await db.tx(function* (t): TxBody<boolean> {
      // Serialize against account/workspace erasure using the canonical locks.
      if (t.kind === 'pg') for (const id of [...new Set([tenant,actor])].sort()) {
        yield* t.get('SELECT pg_advisory_xact_lock_shared(hashtext(?))',[id])
      }
      const clockAfterLock = clock()
      if (!Number.isSafeInteger(clockAfterLock) || clockAfterLock < now || clockAfterLock >= expiry) return false
      const owner = yield* t.get('SELECT 1 FROM memberships m JOIN users u ON u.id=m.member_id WHERE m.tenant_id=? AND m.member_id=? AND m.role=\'owner\'' +
        (t.kind === 'pg' ? ' FOR SHARE OF m' : ''),[tenant,actor])
      if (!owner || clock() >= expiry) return false
      return (yield* t.run(`UPDATE organizations SET company_first_scorecard_enabled=?, company_first_scorecard_revision=?
        WHERE id=? AND company_first_scorecard_enabled=?
          AND COALESCE(company_first_scorecard_revision, '')=?
          AND NOT EXISTS (SELECT 1 FROM tenant_tombstones WHERE deleted_tenant IN (?,?))`,
      [enabledAfter ? 1 : 0,next,tenant,enabledBefore ? 1 : 0,previous ?? '',tenant,actor])).changes === 1
    })
  } catch { return false }
}
