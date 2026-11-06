// The lookalike block a scan profile carries (#386; built by lib/scan/lookalike-discovery.ts). Kept free of imports so
// lib/scan/icp.ts - which client bundles reach through run-budget - can validate it without pulling in server modules.

// Supplied accounts all travel with the scan profile (as short hashed keys) so the run can exclude them; the profile has
// a hard size budget (icp.ts ICP_JSON_BUDGET), so the import is capped and an oversized one is refused whole.
export const MAX_EXAMPLES = 100
export const MIN_POSITIVES = 5, MIN_NEGATIVES = 5, MIN_SUPPORT = 2, MIN_LIFT = 2, MAX_FEATURES = 12
export const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

// Compact persisted shape inside scan_jobs.icp (no schema change; same pattern as the #379 research block):
//   f: discriminators {d: i|s|l|k, t: value, n: support, x: lift}, p/q: positives/negatives, h: held-out numbers,
//   k: supplied-account keys by kind (c customer/won, x competitor, n negative), each a run of 5-char hashes.
export interface LookalikeBlock { v: 1; f: { d: 'i' | 's' | 'l' | 'k'; t: string; n: number; x: number }[]; p: number; q: number; h: { p: number; b: number; n: number }; k: { c: string; x: string; n: string } }
const KEYRUN = /^(?:[0-9a-z]{5})*$/
// Validates anything that claims to be a persisted lookalike block. Returns undefined for an absent block and null for
// a present but malformed one: the caller refuses the whole profile then (a scan must never run without the exclusions
// its profile claims). A block whose held-out check does not beat chance is malformed by definition.
export function normalizeLookalike(raw: unknown): LookalikeBlock | null | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
  const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  if (r.v !== 1 || !int(r.p, MIN_POSITIVES, MAX_EXAMPLES) || !int(r.q, MIN_NEGATIVES, MAX_EXAMPLES)) return null
  if (!Array.isArray(r.f) || r.f.length === 0 || r.f.length > MAX_FEATURES) return null
  const f: LookalikeBlock['f'] = []
  for (const x of r.f as Record<string, unknown>[]) {
    const t = typeof x?.t === 'string' ? x.t : ''
    if (!x || !['i', 's', 'l', 'k'].includes(String(x.d)) || !t || t.length > 60 || slug(t) !== t || !int(x.n, MIN_SUPPORT, MAX_EXAMPLES) || !num(x.x, MIN_LIFT, 1e6)) return null
    f.push({ d: x.d as LookalikeBlock['f'][number]['d'], t, n: x.n as number, x: x.x as number })
  }
  const h = r.h as Record<string, unknown> | null
  if (!h || !num(h.p, 0, 1) || !num(h.b, 0, 1) || !int(h.n, 4, MAX_EXAMPLES) || !((h.p as number) > (h.b as number))) return null
  const k = r.k as Record<string, unknown> | null
  const run = (v: unknown) => typeof v === 'string' && KEYRUN.test(v) && v.length <= MAX_EXAMPLES * 2 * 5
  if (!k || !run(k.c) || !run(k.x) || !run(k.n) || (k.c as string).length === 0) return null
  return { v: 1, f, p: r.p as number, q: r.q as number, h: { p: h.p as number, b: h.b as number, n: h.n as number }, k: { c: k.c as string, x: k.x as string, n: k.n as string } }
}

// The block a scan job's stored profile carries: null when it has none (or the profile is not JSON - the runner re-infers
// such a profile, which then carries no block), 'unreadable' when one is present but malformed.
export function lookalikeOf(job: { icp?: string | null }): LookalikeBlock | 'unreadable' | null {
  let raw: unknown
  try { raw = job.icp ? JSON.parse(job.icp) : null } catch { return null }
  const la = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).lookalike : undefined
  if (la === undefined || la === null) return null
  return normalizeLookalike(la) ?? 'unreadable'
}
