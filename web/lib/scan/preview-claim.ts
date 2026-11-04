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
// Privacy-safe claim-attempt audit (#416): outcome codes only - never an email, IP, token or snapshot.
export const PREVIEW_CLAIM_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS preview_claim_events (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('claimed','already','claimed_other_workspace','foreign','unverified','expired','unknown')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS preview_claim_events_claim ON preview_claim_events (claim_id);
`
export function migratePreviewClaim(db: Database.Database): void { db.exec(PREVIEW_CLAIMS_DDL + PREVIEW_CLAIM_EVENTS_DDL) }

// The stripped artifact a claim serves: the ready proof preview minus its spend (spend is the seller's, #403).
// `version` names the builder contract the snapshot was made under, so a later change to the gates never makes an old
// snapshot read as if the new rules had produced it. Snapshots issued before versioning read as version 0.
export const PROOF_SNAPSHOT_VERSION = 1
export interface ClaimSnapshot {
  version?: number
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
  | { status: 'issued'; id: string; token: string; expiresAt: number; reused: boolean }
  | { status: 'hold'; reason: string }

// The offer a run's proof is for, from the run's own record (never from the issuer's keyboard): the reviewed offer when
// the play set one, else the run's seller line; the source is the public page URL that line carries. No URL, no offer.
function runOffer(run: { seller: string | null; offer: string | null }): { text: string; sourceUrl: string } | null {
  const seller = typeof run.seller === 'string' ? run.seller : ''
  const sourceUrl = seller.match(/https?:\/\/\S+/)?.[0] ?? null
  const text = ((typeof run.offer === 'string' ? run.offer : null) ?? seller.replace(/https?:\/\/\S+/, '').replace(/\s+-\s*$/, '').trim()) || null
  return text && sourceUrl ? { text, sourceUrl } : null
}
// The run's spend as its own ledger recorded it (scan_jobs.spend_reserved_usd: the paid-call total the job guard saved,
// settled to actuals). null when nothing was recorded: never a zero.
function runSpend(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}
// What makes two snapshots the same proof: everything but the moment it was built.
const sameProof = (a: ClaimSnapshot, b: ClaimSnapshot) =>
  JSON.stringify([a.version ?? 0, a.runId, a.expiresAt, a.offer, a.companies, a.disclaimer]) === JSON.stringify([b.version ?? 0, b.runId, b.expiresAt, b.offer, b.companies, b.disclaimer])
const parseSnapshot = (raw: unknown): ClaimSnapshot | null => {
  try {
    const v = JSON.parse(String(raw)) as ClaimSnapshot
    const str = (x: unknown) => typeof x === 'string'
    // every field a page renders must have its shape: anything else is unreadable and is never served
    return v && typeof v === 'object' && !Array.isArray(v) && str(v.runId) && Number.isFinite(v.expiresAt) && Array.isArray(v.companies)
      && v.offer && str(v.offer.text) && str(v.offer.sourceUrl) && str(v.disclaimer)
      && v.companies.every(c => c && str(c.company) && str(c.event) && str(c.quote) && str(c.eventDate) && str(c.sourceUrl)) ? v : null
  } catch { return null }
}

// Issue a claim for one finished run's proof. Only a ready preview becomes a claim: a hold issues nothing, so no
// invented success ever gets a link. The snapshot stored is exactly what will be served, spend stripped.
export async function issuePreviewClaim(
  db: Db, master: Buffer,
  input: { runId: string; sellerTenantId: string; recipientEmail: string; business: string },
  now = Date.now(),
): Promise<IssueResult | null> {
  const recipient = validateEmail(input.recipientEmail)
  if (!recipient) return null
  // No offer URL on the run: the builder holds instead of showing an invented offer. The spend is the run's own
  // recorded spend; it stays with the seller (proofReport) and never enters the served snapshot.
  const run = await db.get<{ seller: string | null; offer: string | null; spend_reserved_usd: unknown }>('SELECT seller, offer, spend_reserved_usd FROM scan_jobs WHERE id = ? AND user_id = ?', [input.runId, input.sellerTenantId])
  if (!run) return null
  const proofInput = await loadProofInput(db, input.sellerTenantId, input.runId, { inferredOffer: runOffer(run), spendUsd: runSpend(run.spend_reserved_usd) })
  if (!proofInput) return null
  const proof: ProofPreview = buildProofPreview(proofInput, now)
  if (proof.status !== 'ready') return { status: 'hold', reason: proof.reason }
  // Honest copy: the stored record proves an inferred offer and its source URL for one run. It does not prove the
  // pages are the recipient's, so the claim's disclaimer never asserts that (#403's "your public pages" would be an
  // unproven claim here: the issuer names the recipient).
  const snapshot: ClaimSnapshot = { version: PROOF_SNAPSHOT_VERSION, runId: proof.runId, builtAt: proof.builtAt, expiresAt: proof.expiresAt, offer: proof.offer, companies: proof.companies,
    disclaimer: 'Found by one dazl run for an inferred offer, from the sources linked with each company. These are signals, not guaranteed customers.' }
  const business = input.business.slice(0, 150)
  // Cached per (seller, run, recipient, business): issuing the same proof again returns the open claim that already
  // serves it, so a repeat click never mints a second live link. A changed proof (a lead quarantined, a newer builder
  // version) is a new version and gets its own claim. Checked and written in one transaction.
  const once = () => db.tx(function* (t) {
    const open = yield* t.all<{ id: string; snapshot: string; expires_at: number | string }>(
      `SELECT id, snapshot, expires_at FROM preview_claims WHERE seller_tenant_id = ? AND run_id = ? AND recipient_email = ? AND business = ?
         AND claimed_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id LIMIT 20`,
      [input.sellerTenantId, proof.runId, recipient, business, now])
    for (const r of open) {
      const prior = parseSnapshot(r.snapshot)
      if (prior && sameProof(prior, snapshot)) return { id: r.id, expiresAt: Number(r.expires_at), reused: true }
    }
    const id = randomBytes(16).toString('hex')
    yield* t.run(
      'INSERT INTO preview_claims (id, run_id, seller_tenant_id, recipient_email, business, snapshot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, proof.runId, input.sellerTenantId, recipient, business, JSON.stringify(snapshot), now, proof.expiresAt])
    return { id, expiresAt: proof.expiresAt, reused: false }
  }, 'serializable')
  // Two identical issues racing on Postgres: SERIALIZABLE rolls one back; it retries a bounded number of times and then
  // finds the claim the winner wrote (reused). It never inserts outside the transaction.
  let out: { id: string; expiresAt: number; reused: boolean } | undefined
  for (let attempt = 1; !out; attempt++) {
    try { out = await once() } catch (e) { if (attempt >= 4 || !isSerializationFailure(e)) throw e }
  }
  return { status: 'issued', id: out.id, token: `${out.id}.${sign(master, out.id)}`, expiresAt: out.expiresAt, reused: out.reused }
}

function isSerializationFailure(e: unknown): boolean {
  for (let x = e, depth = 0; x && typeof x === 'object' && depth < 5; depth++) {
    const v = x as { code?: unknown; cause?: unknown }
    if (v.code === '40001' || v.code === '40P01') return true
    x = v.cause
  }
  return false
}

// A served preview stays backed by its run: every company it shows must still be a lead of that run (same source URL)
// with no review reason, not quarantined and its evidence not purged. Evidence withdrawn after issue (a quarantine, a
// purge, a deleted run or tenant) withdraws the preview: its content is never served from the frozen snapshot.
const BACKING_SQL = `SELECT l.source_url, l.review_reason, l.quarantined_at, l.evidence_purged_at FROM leads l
  JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.scan_job_id = ? AND j.user_id = ?`
type BackingRow = { source_url: string; review_reason: string | null; quarantined_at: unknown; evidence_purged_at: unknown }
function backed(rows: BackingRow[], snap: ClaimSnapshot | null): boolean {
  if (!snap || snap.companies.length === 0) return false
  const live = new Set(rows.filter(r => r.review_reason === null && r.quarantined_at === null && r.evidence_purged_at === null).map(r => r.source_url))
  return snap.companies.every(c => typeof c?.sourceUrl === 'string' && live.has(c.sourceUrl))
}
async function stillBacked(db: Db, runId: string, sellerTenantId: string, snap: ClaimSnapshot | null): Promise<boolean> {
  return backed(await db.all<BackingRow>(BACKING_SQL, [runId, sellerTenantId]), snap)
}

export type PublicClaim =
  | { status: 'ok'; id: string; business: string; snapshot: ClaimSnapshot }
  | { status: 'unknown' | 'expired' | 'claimed' }

// What the public /preview page may show. Terminal states carry no content: a claimed preview is only visible at
// its private claimed route, and an expired one is gone. An unknown token is indistinguishable from a bad guess.
export async function readPublicClaim(db: Db, master: Buffer, token: string, now = Date.now()): Promise<PublicClaim> {
  const id = verifyClaimToken(master, token)
  if (!id) return { status: 'unknown' }
  const row = await db.get<{ id: string; business: string; snapshot: string; expires_at: number; claimed_at: number | null; run_id: string; seller_tenant_id: string }>(
    'SELECT id, business, snapshot, expires_at, claimed_at, run_id, seller_tenant_id FROM preview_claims WHERE id = ?', [id])
  if (!row) return { status: 'unknown' }
  if (row.claimed_at !== null) return { status: 'claimed' }
  if (Number(row.expires_at) <= now) return { status: 'expired' }
  // withdrawn evidence reads as expired: the content is gone, and the page says no more than that
  const snap = parseSnapshot(row.snapshot)
  if (!snap || !(await stillBacked(db, row.run_id, row.seller_tenant_id, snap))) return { status: 'expired' }
  return { status: 'ok', id: row.id, business: row.business, snapshot: snap }
}

export type ClaimResult =
  | { status: 'claimed' | 'already'; id: string }
  | { status: 'unknown' | 'expired' | 'unverified' | 'foreign' | 'claimed_other_workspace' }

// Bind a claim to the signed-in account, once. The account's own verified email must equal the recipient; the
// binding write is a single conditional UPDATE so two concurrent claims cannot both succeed. Claiming attaches
// the stored preview to the claiming workspace only: it writes no profile, offer or wizard state anywhere.
export async function claimPreview(
  db: Db, master: Buffer, token: string, actor: { actorId: string; tenantId: string }, now = Date.now(),
): Promise<ClaimResult> {
  const id = verifyClaimToken(master, token)
  if (!id) { await auditClaim(db, '', 'unknown', now); return { status: 'unknown' } }
  return await db.tx(function* (t) {
    const row = yield* t.get<{ recipient_email: string; expires_at: number; claimed_by_tenant: string | null; run_id: string; seller_tenant_id: string; snapshot: string }>(
      'SELECT recipient_email, expires_at, claimed_by_tenant, run_id, seller_tenant_id, snapshot FROM preview_claims WHERE id = ?', [id])
    let result: ClaimResult
    if (!row) result = { status: 'unknown' }
    else if (Number(row.expires_at) <= now) result = { status: 'expired' }
    else if (!backed(yield* t.all<BackingRow>(BACKING_SQL, [row.run_id, row.seller_tenant_id]), parseSnapshot(row.snapshot))) result = { status: 'expired' }
    else {
      const u = yield* t.get<{ email: string; v: number | null }>('SELECT email, email_verified_at AS v FROM users WHERE id = ?', [actor.actorId])
      if (!u || u.email.toLowerCase() !== row.recipient_email) result = { status: 'foreign' }
      else if (u.v === null) result = { status: 'unverified' }
      // the recipient's own email, but another workspace of theirs already holds it (or won the race just now)
      else if (row.claimed_by_tenant !== null && row.claimed_by_tenant !== actor.tenantId) result = { status: 'claimed_other_workspace' }
      else if (row.claimed_by_tenant !== null) result = { status: 'already', id }
      else {
        const upd = yield* t.run('UPDATE preview_claims SET claimed_by_tenant = ?, claimed_at = ? WHERE id = ? AND claimed_at IS NULL AND expires_at > ?',
          [actor.tenantId, now, id, now])
        result = upd.changes === 1 ? { status: 'claimed', id } : { status: 'claimed_other_workspace' }
      }
    }
    yield* t.run('INSERT INTO preview_claim_events (id, claim_id, outcome, created_at) VALUES (?, ?, ?, ?)',
      [randomBytes(12).toString('hex'), id, result.status, now])
    return result
  }, 'serializable')
}

// One audit row per claim attempt outside the binding transaction (a malformed token names no row): outcome only.
async function auditClaim(db: Db, claimId: string, outcome: string, now: number): Promise<void> {
  await db.run('INSERT INTO preview_claim_events (id, claim_id, outcome, created_at) VALUES (?, ?, ?, ?)',
    [randomBytes(12).toString('hex'), claimId, outcome, now]).catch(() => {})
}

// The claiming workspace's own copy, for the stable private route. Another workspace's claim id reads as not found.
// Expiry is consistent with the public page: past the evidence expiry the preview is gone there too.
export async function readClaimedPreview(db: Db, tenantId: string, id: string, now = Date.now()): Promise<{ business: string; snapshot: ClaimSnapshot } | { expired: true } | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null
  const row = await db.get<{ business: string; snapshot: string; expires_at: number; run_id: string; seller_tenant_id: string }>(
    'SELECT business, snapshot, expires_at, run_id, seller_tenant_id FROM preview_claims WHERE id = ? AND claimed_by_tenant = ?', [id, tenantId])
  if (!row) return null
  if (Number(row.expires_at) <= now) return { expired: true }
  const snap = parseSnapshot(row.snapshot)
  if (!snap || !(await stillBacked(db, row.run_id, row.seller_tenant_id, snap))) return { expired: true }
  return { business: row.business, snapshot: snap }
}

// ---------- evaluation (#403): sample quality, cost and conversion, for the seller only ----------
// Read-only and tenant-scoped: every row is the asking workspace's own (seller_tenant_id / scan_jobs.user_id). It shows
// no recipient email and no snapshot content. "Claimed" is the observed outcome dazl can see (the recipient signed in
// with the exact verified email and claimed the preview); it is not a purchase, a reply or a customer result.
export const PROOF_REPORT_PREVIEWS = 100
export const PROOF_REPORT_RUNS = 20
export type PreviewState = 'open' | 'claimed' | 'expired' | 'withdrawn'
export interface ProofReport {
  previews: { id: string; runId: string; business: string; createdAt: number; expiresAt: number; state: PreviewState; version: number; companies: number; runSpendUsd: number | null; claimAttempts: Record<string, number> }[]
  runs: { runId: string; finishedAt: number | null; leads: number; proof: 'ready' | 'run_not_finished' | 'no_inferred_offer' | 'no_usable_results'; companies: number; spendUsd: number | null }[]
  totals: {
    issued: number; open: number; claimed: number; expired: number; withdrawn: number
    conversion: { claimed: number; issued: number; rate: number | null }
    runs: { evaluated: number; ready: number; held: number; holdReasons: Record<string, number> }
    spend: { runsWithSpend: number; runsWithoutSpend: number; totalUsd: number | null; perShownCompanyUsd: number | null }
  }
  scope: string
}
const REPORT_SCOPE = 'Your own issued previews (latest 100) and finished runs (latest 20). Claimed = the recipient signed in with the exact verified email and claimed the preview; it is not a purchase or a customer result. Spend is each run\'s own recorded paid-call total (scan_jobs.spend_reserved_usd, rounded to micro-dollars); runs with no recorded spend are counted apart, never as zero.'

export async function proofReport(db: Db, sellerTenantId: string, now = Date.now()): Promise<ProofReport> {
  const claims = await db.all<{ id: string; run_id: string; business: string; snapshot: string; created_at: number | string; expires_at: number | string; claimed_at: number | string | null }>(
    `SELECT id, run_id, business, snapshot, created_at, expires_at, claimed_at FROM preview_claims WHERE seller_tenant_id = ?
       ORDER BY created_at DESC, id LIMIT ?`, [sellerTenantId, PROOF_REPORT_PREVIEWS])
  const jobs = await db.all<{ id: string; status: string; finished_at: number | string | null; seller: string | null; offer: string | null; spend_reserved_usd: unknown }>(
    `SELECT id, status, finished_at, seller, offer, spend_reserved_usd FROM scan_jobs WHERE user_id = ? AND status = 'done'
       ORDER BY finished_at DESC, id LIMIT ?`, [sellerTenantId, PROOF_REPORT_RUNS])
  const spendOf = new Map<string, number | null>()
  const spendFor = async (runId: string): Promise<number | null> => {
    if (!spendOf.has(runId)) {
      const r = await db.get<{ spend_reserved_usd: unknown }>('SELECT spend_reserved_usd FROM scan_jobs WHERE id = ? AND user_id = ?', [runId, sellerTenantId])
      spendOf.set(runId, r ? runSpend(r.spend_reserved_usd) : null)
    }
    return spendOf.get(runId)!
  }
  const previews: ProofReport['previews'] = []
  for (const c of claims) {
    const snap = parseSnapshot(c.snapshot)
    const events = await db.all<{ outcome: string; n: number | string }>('SELECT outcome, count(*) AS n FROM preview_claim_events WHERE claim_id = ? GROUP BY outcome', [c.id])
    const state: PreviewState = c.claimed_at !== null ? 'claimed' : Number(c.expires_at) <= now ? 'expired'
      : !(await stillBacked(db, c.run_id, sellerTenantId, snap)) ? 'withdrawn' : 'open'
    previews.push({
      id: c.id, runId: c.run_id, business: c.business, createdAt: Number(c.created_at), expiresAt: Number(c.expires_at), state,
      version: snap?.version ?? 0, companies: snap ? snap.companies.length : 0, runSpendUsd: await spendFor(c.run_id),
      claimAttempts: Object.fromEntries(events.map(e => [e.outcome, Number(e.n)])),
    })
  }
  const runs: ProofReport['runs'] = []
  for (const j of jobs) {
    const spendUsd = runSpend(j.spend_reserved_usd)
    spendOf.set(j.id, spendUsd)
    const input = await loadProofInput(db, sellerTenantId, j.id, { inferredOffer: runOffer(j), spendUsd })
    if (!input) continue
    const p = buildProofPreview(input, now)
    runs.push({ runId: j.id, finishedAt: j.finished_at === null ? null : Number(j.finished_at), leads: input.leads.length,
      proof: p.status === 'ready' ? 'ready' : p.reason, companies: p.status === 'ready' ? p.companies.length : 0, spendUsd })
  }
  const count = (s: PreviewState) => previews.filter(p => p.state === s).length
  const holdReasons: Record<string, number> = {}
  for (const r of runs) if (r.proof !== 'ready') holdReasons[r.proof] = (holdReasons[r.proof] ?? 0) + 1
  const ready = runs.filter(r => r.proof === 'ready')
  const priced = ready.filter(r => r.spendUsd !== null)
  const shown = priced.reduce((a, r) => a + r.companies, 0)
  const micro = (x: number) => Math.round(x * 1e6) / 1e6
  const total = runs.some(r => r.spendUsd !== null) ? micro(runs.reduce((a, r) => a + (r.spendUsd ?? 0), 0)) : null
  const claimed = count('claimed')
  return {
    previews, runs,
    totals: {
      issued: previews.length, open: count('open'), claimed, expired: count('expired'), withdrawn: count('withdrawn'),
      conversion: { claimed, issued: previews.length, rate: previews.length ? claimed / previews.length : null },
      runs: { evaluated: runs.length, ready: ready.length, held: runs.length - ready.length, holdReasons },
      spend: { runsWithSpend: runs.filter(r => r.spendUsd !== null).length, runsWithoutSpend: runs.filter(r => r.spendUsd === null).length, totalUsd: total,
        perShownCompanyUsd: shown > 0 ? micro(priced.reduce((a, r) => a + (r.spendUsd ?? 0), 0) / shown) : null },
    },
    scope: REPORT_SCOPE,
  }
}
