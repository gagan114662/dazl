// A signed, expiring preview claim (#416): a prospect receives a link to the proof its own run produced (#403),
// authenticates, and claims that exact stored preview. The token carries only an id and its HMAC: the row is the
// truth. The served snapshot is the stripped public artifact built at issue time (no contacts, no spend, no seller
// tenant data), and it never changes afterwards: the binding of run, seller, recipient and expiry is immutable.
// Claiming requires the account's own verified email to match the recipient exactly (lib/email-ownership.ts);
// a forward to a colleague or a domain match grants nothing. Claimed and expired claims are terminal: their public
// content is revoked and there is no fallback to a generic wizard.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Db } from '../db/client.ts'
import { buildProofPreview, loadProofInput, type ProofCompany, type ProofPreview } from './proof-preview.ts'
import { validateEmail } from '../validate.ts'

// SQLite: migratePreviewClaim (called from getScanDb); PG: 0029_preview_claims.sql. Same shape on both engines.
export const PREVIEW_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS preview_claims (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seller_tenant_id TEXT NOT NULL,
    recipient_email TEXT NOT NULL CHECK (length(recipient_email) <= 254),
    business TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_by_tenant TEXT,
    claimed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS preview_claims_recipient ON preview_claims (recipient_email);
`
export function migratePreviewClaim(db: Database.Database): void { db.exec(PREVIEW_CLAIMS_DDL) }

// The stripped artifact a claim serves: the ready proof preview minus its spend (spend is the seller's, #403).
export interface ClaimSnapshot {
  runId: string; builtAt: number; expiresAt: number
  offer: { inferred: true; text: string; sourceUrl: string }
  companies: ProofCompany[]; disclaimer: string
}

const claimKey = (master: Buffer) => createHmac('sha256', master).update('dazl-preview-claim-v1').digest()
const sign = (master: Buffer, id: string) => createHmac('sha256', claimKey(master)).update(id).digest('hex').slice(0, 32)
export const isClaimToken = (t: unknown): t is string => typeof t === 'string' && /^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(t)

// The id a token names, or null when it is malformed or not one of ours. Constant-time on the signature.
export function verifyClaimToken(master: Buffer, token: string): string | null {
  if (!isClaimToken(token)) return null
  const [id, sig] = token.split('.')
  const want = sign(master, id)
  return timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null
}

export type IssueResult =
  | { status: 'issued'; id: string; token: string; expiresAt: number }
  | { status: 'hold'; reason: string }

// Issue a claim for one finished run's proof. Only a ready preview becomes a claim: a hold issues nothing, so no
// invented success ever gets a link. The snapshot stored is exactly what will be served, spend stripped.
export async function issuePreviewClaim(
  db: Db, master: Buffer,
  input: { runId: string; sellerTenantId: string; recipientEmail: string; business: string; spendUsd?: number | null },
  now = Date.now(),
): Promise<IssueResult | null> {
  const recipient = validateEmail(input.recipientEmail)
  if (!recipient) return null
  // The offer comes from the run's own record, never from the issuer's keyboard: the reviewed offer when the play
  // set one, else the run's seller line; the source is the public page URL that line carries. No URL, no offer:
  // the builder holds instead of showing an invented one.
  const run = await db.get<{ seller: string | null; offer: string | null }>('SELECT seller, offer FROM scan_jobs WHERE id = ? AND user_id = ?', [input.runId, input.sellerTenantId])
  if (!run) return null
  const sourceUrl = (run.seller ?? '').match(/https?:\/\/\S+/)?.[0] ?? null
  const text = (run.offer ?? (run.seller ?? '').replace(/https?:\/\/\S+/, '').replace(/\s+-\s*$/, '').trim()) || null
  const inferredOffer = text && sourceUrl ? { text, sourceUrl } : null
  const proofInput = await loadProofInput(db, input.sellerTenantId, input.runId, { inferredOffer, spendUsd: input.spendUsd ?? null })
  if (!proofInput) return null
  const proof: ProofPreview = buildProofPreview(proofInput, now)
  if (proof.status !== 'ready') return { status: 'hold', reason: proof.reason }
  const snapshot: ClaimSnapshot = { runId: proof.runId, builtAt: proof.builtAt, expiresAt: proof.expiresAt, offer: proof.offer, companies: proof.companies, disclaimer: proof.disclaimer }
  const id = randomBytes(16).toString('hex')
  await db.run(
    'INSERT INTO preview_claims (id, run_id, seller_tenant_id, recipient_email, business, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, proof.runId, input.sellerTenantId, recipient, input.business.slice(0, 150), JSON.stringify(snapshot), now, proof.expiresAt])
  return { status: 'issued', id, token: `${id}.${sign(master, id)}`, expiresAt: proof.expiresAt }
}

export type PublicClaim =
  | { status: 'ok'; id: string; business: string; snapshot: ClaimSnapshot }
  | { status: 'unknown' | 'expired' | 'claimed' }

// What the public /preview page may show. Terminal states carry no content: a claimed preview is only visible at
// its private claimed route, and an expired one is gone. An unknown token is indistinguishable from a bad guess.
export async function readPublicClaim(db: Db, master: Buffer, token: string, now = Date.now()): Promise<PublicClaim> {
  const id = verifyClaimToken(master, token)
  if (!id) return { status: 'unknown' }
  const row = await db.get<{ id: string; business: string; snapshot: string; expires_at: number; claimed_at: number | null }>(
    'SELECT id, business, snapshot, expires_at, claimed_at FROM preview_claims WHERE id = ?', [id])
  if (!row) return { status: 'unknown' }
  if (row.claimed_at !== null) return { status: 'claimed' }
  if (Number(row.expires_at) <= now) return { status: 'expired' }
  return { status: 'ok', id: row.id, business: row.business, snapshot: JSON.parse(row.snapshot) as ClaimSnapshot }
}

export type ClaimResult =
  | { status: 'claimed' | 'already'; id: string }
  | { status: 'unknown' | 'expired' | 'unverified' | 'foreign' }

// Bind a claim to the signed-in account, once. The account's own verified email must equal the recipient; the
// binding write is a single conditional UPDATE so two concurrent claims cannot both succeed. Claiming attaches
// the stored preview to the claiming workspace only: it writes no profile, offer or wizard state anywhere.
export async function claimPreview(
  db: Db, master: Buffer, token: string, actor: { actorId: string; tenantId: string }, now = Date.now(),
): Promise<ClaimResult> {
  const id = verifyClaimToken(master, token)
  if (!id) return { status: 'unknown' }
  return await db.tx(function* (t) {
    const row = yield* t.get<{ recipient_email: string; expires_at: number; claimed_by_tenant: string | null }>(
      'SELECT recipient_email, expires_at, claimed_by_tenant FROM preview_claims WHERE id = ?', [id])
    if (!row) return { status: 'unknown' } as ClaimResult
    if (Number(row.expires_at) <= now) return { status: 'expired' } as ClaimResult
    const u = yield* t.get<{ email: string; v: number | null }>('SELECT email, email_verified_at AS v FROM users WHERE id = ?', [actor.actorId])
    if (!u || u.email.toLowerCase() !== row.recipient_email) return { status: 'foreign' } as ClaimResult
    if (u.v === null) return { status: 'unverified' } as ClaimResult
    if (row.claimed_by_tenant !== null) return (row.claimed_by_tenant === actor.tenantId ? { status: 'already', id } : { status: 'foreign' }) as ClaimResult
    const upd = yield* t.run('UPDATE preview_claims SET claimed_by_tenant = ?, claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND expires_at > ?',
      [actor.tenantId, now, id, now])
    if (upd.changes !== 1) return { status: 'foreign' } as ClaimResult // lost a race: the winner's row reads as claimed
    return { status: 'claimed', id } as ClaimResult
  }, 'serializable')
}

// The claiming workspace's own copy, for the stable private route. Another workspace's claim id reads as not found.
export async function readClaimedPreview(db: Db, tenantId: string, id: string): Promise<{ business: string; snapshot: ClaimSnapshot } | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null
  const row = await db.get<{ business: string; snapshot: string }>(
    'SELECT business, snapshot FROM preview_claims WHERE id = ? AND claimed_by_tenant = ?', [id, tenantId])
  return row ? { business: row.business, snapshot: JSON.parse(row.snapshot) as ClaimSnapshot } : null
}
