import type Database from 'better-sqlite3'

// Server-only, read-only. Whether a saved AI key has open negative evidence: a scan that stopped because the key was
// rejected (key_rejected) or could not be read (key_unreadable), with no positive acceptance of THAT key since.
//
// Identity, from the records only:
// - Trial-funded scans (funded_by 'trial') ran on the shared free-search key and are never evidence about the user's.
// - A scan uses the account's newest saved key (pickVendor: created_at desc). So the vendor a scan used is known only
//   when a key row existed before the scan was created: the newest of those. A key added later was not used by it.
//   Otherwise (no such row, e.g. a key deleted since or a legacy trial row) the vendor is unknown (null).
// - Positive, key-specific acceptance: the provider check when that vendor's key is saved (validated_at, refreshed by
//   a re-save), or a later non-trial scan that finished 'done' and provably used that same key (its vendor by the rule
//   above, and the key not re-saved since that scan started). A cancelled or otherwise failed scan proves nothing.
// A rejection is open until such acceptance after the scan finished; with an unknown vendor, until every current key
// has been saved again. Only rejections that bear on the key scans use now (the newest key) or
// whose key is unknown are reported.
export interface KeyEvidence { error: 'key_rejected' | 'key_unreadable'; vendor: string | null }

export function openKeyRejection(db: Database.Database, tenantId: string): KeyEvidence | null {
  const keys = db.prepare('SELECT vendor, created_at, validated_at FROM tenant_llm_keys WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC').all(tenantId) as { vendor: string; created_at: number; validated_at: number }[]
  if (!keys.length) return null
  const selected = keys[0].vendor
  const done = db.prepare(`SELECT created_at FROM scan_jobs WHERE user_id = ? AND status = 'done' AND funded_by != 'trial'`).all(tenantId) as { created_at: number }[]
  const usedBy = (createdAt: number) => keys.find(k => k.created_at <= createdAt)?.vendor ?? null
  const failures = db.prepare(`SELECT error, created_at, COALESCE(finished_at, created_at) AS ended FROM scan_jobs
    WHERE user_id = ? AND status = 'failed' AND error IN ('key_rejected', 'key_unreadable') AND funded_by != 'trial'
    ORDER BY created_at DESC, rowid DESC`).all(tenantId) as { error: KeyEvidence['error']; created_at: number; ended: number }[]
  for (const f of failures) {
    const used = usedBy(f.created_at)
    if (used !== null && used !== selected) continue // a key scans no longer use
    const key = used !== null ? keys.find(k => k.vendor === used)! : null
    const open = key
      ? key.validated_at <= f.ended && !done.some(d => d.created_at > f.ended && usedBy(d.created_at) === key.vendor && key.validated_at <= d.created_at)
      : keys.some(k => k.validated_at <= f.ended)
    if (open) return { error: f.error, vendor: used }
  }
  return null
}
