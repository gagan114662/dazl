// Reviewed exclusions that outlive an offer change (#1441, PM call on Qodo). When a returning user runs a play with a
// DIFFERENT offer, the earlier play's buyer profile is dropped (#1436) and a fresh one is inferred; its exclusions are
// not about the buyer but about who must never be contacted, so they ride along: the profile's exclude list and its
// reviewed disqualifiers. They are stored on the job as a stub that normalizeIcp refuses (no summary), so the runner
// still infers a fresh profile, then merges these in.
import type { Icp } from './icp.ts'

const MAX_ITEMS = 40, MAX_LEN = 200
const clean = (xs: unknown[]): string[] => {
  const out: string[] = [], seen = new Set<string>()
  for (const x of xs) {
    if (typeof x !== 'string') continue
    const t = x.replace(/\s+/g, ' ').trim().slice(0, MAX_LEN)
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

export function carriedExclusions(icp: Icp | null | undefined): string[] {
  if (!icp) return []
  const dq = (icp.research?.hyps ?? []).filter(h => h.k === 'disqualifier' && h.s === 'reviewed').map(h => h.t)
  return clean([...(icp.exclude ?? []), ...dq])
}

// Room the carried list may take in the stored profile (ICP_JSON_BUDGET is 3900): a list that cannot fit is refused at
// admission with a clear message, never silently trimmed.
export const CARRY_JSON_BUDGET = 800
export function carryStub(exclude: unknown): string | null {
  const xs = Array.isArray(exclude) ? clean(exclude) : []
  return xs.length ? JSON.stringify({ carry_exclude: xs }) : null
}
export function carryAdmission(exclude: unknown): { ok: true; stub: string | null } | { ok: false; error: string } {
  const stub = carryStub(exclude)
  if (stub && stub.length > CARRY_JSON_BUDGET) return { ok: false, error: 'Too many reviewed exclusions to carry into a play with a new offer. Shorten or remove some exclusions in the profile, then run again.' }
  return { ok: true, stub }
}

// The carried list lives on the profile as its own field (carry_exclude, kept whole by normalizeIcp), so every
// attempt of the job reads it back unchanged; it is not merged into the 6-item exclude list.
export const listOf = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  try { const v = JSON.parse(raw) as { carry_exclude?: unknown }; return Array.isArray(v?.carry_exclude) ? clean(v.carry_exclude) : [] } catch { return [] }
}
export function applyCarriedExclusions(icp: Icp, raw: string | null | undefined): Icp {
  const xs = listOf(raw)
  if (!xs.length) return icp
  return { ...icp, carry_exclude: clean([...(icp.carry_exclude ?? []), ...xs]) }
}


// A stored carry stub is not a profile: readers that show the job's profile treat it as none yet.
export const isCarryStub = (raw: string | null | undefined): boolean => !!raw && raw.startsWith('{"carry_exclude"')
export const shownIcp = (raw: string | null | undefined): unknown => raw && !isCarryStub(raw) ? JSON.parse(raw) : null
