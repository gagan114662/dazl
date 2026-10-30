import { createHmac, timingSafeEqual } from 'node:crypto'
import { safeReturnTo } from './return-to.ts'

// #416: a signed, expiring link that brings one invited person, after signing in or up, to the exact play or preview
// it was made for. The link names the recipient's email and the app path to open, and is signed with a key derived
// from the deployment's master key, so it cannot be edited or made up. It grants nothing by itself: it only chooses
// where a signed-in user lands, and only when that user is the recipient. It carries no seller data or third-party
// personal details beyond the recipient's own address, and the destination page applies its own access checks.
// Minted by the preview flow (#403); verified by /app/claim.

export interface ClaimPayload { to: string; path: string; exp: number }
export type ClaimResult = { ok: true; path: string } | { ok: false; reason: 'malformed' | 'tampered' | 'expired' | 'other_account' | 'bad_path' }

const key = (master: Buffer) => createHmac('sha256', master).update('dazl preview-claim v1').digest()
const sig = (master: Buffer, body: string) => createHmac('sha256', key(master)).update(body).digest('base64url')

export function mintClaim(master: Buffer, p: ClaimPayload): string {
  const path = safeReturnTo(p.path)
  if (!path) throw new Error('claim path must be inside the app')
  const body = Buffer.from(JSON.stringify({ to: p.to.trim().toLowerCase(), path, exp: Math.floor(p.exp) })).toString('base64url')
  return `${body}.${sig(master, body)}`
}

export function verifyClaim(master: Buffer, token: unknown, user: { email: string }, nowS = Math.floor(Date.now() / 1000)): ClaimResult {
  if (typeof token !== 'string' || token.length > 2048) return { ok: false, reason: 'malformed' }
  const [body, s, extra] = token.split('.')
  if (!body || !s || extra !== undefined) return { ok: false, reason: 'malformed' }
  const want = Buffer.from(sig(master, body)), got = Buffer.from(s)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'tampered' }
  let p: Partial<ClaimPayload>
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return { ok: false, reason: 'malformed' } }
  if (typeof p.to !== 'string' || typeof p.exp !== 'number' || typeof p.path !== 'string') return { ok: false, reason: 'malformed' }
  if (p.exp <= nowS) return { ok: false, reason: 'expired' }
  if (p.to !== user.email.trim().toLowerCase()) return { ok: false, reason: 'other_account' }
  const path = safeReturnTo(p.path)
  return path ? { ok: true, path } : { ok: false, reason: 'bad_path' }
}
