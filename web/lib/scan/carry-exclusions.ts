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

export function carryStub(exclude: unknown): string | null {
  const xs = Array.isArray(exclude) ? clean(exclude) : []
  return xs.length ? JSON.stringify({ carry_exclude: xs }) : null
}

export function applyCarriedExclusions(icp: Icp, raw: string | null | undefined): Icp {
  if (!raw) return icp
  let v: unknown
  try { v = JSON.parse(raw) } catch { return icp }
  const xs = v && typeof v === 'object' && Array.isArray((v as { carry_exclude?: unknown }).carry_exclude) ? clean((v as { carry_exclude: unknown[] }).carry_exclude) : []
  if (!xs.length) return icp
  return { ...icp, exclude: clean([...(icp.exclude ?? []), ...xs]) }
}

// A stored carry stub is not a profile: readers that show the job's profile treat it as none yet.
export const isCarryStub = (raw: string | null | undefined): boolean => !!raw && raw.startsWith('{"carry_exclude"')
export const shownIcp = (raw: string | null | undefined): unknown => raw && !isCarryStub(raw) ? JSON.parse(raw) : null
