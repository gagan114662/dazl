// Lookalike DISCOVERY from explicitly supplied customer outcomes (#386). Unlike lookalike.ts (read-only annotation of leads the tenant already has, cohort = model fit
// grades), this takes a supplied cohort of customers / won opportunities AND negative examples, derives explainable discriminating features, evaluates them on a
// held-out split, and uses them to rank and to query for NET-NEW accounts. Honesty rules: the supplied customers and competitors are never returned; every match
// carries feature-level reasons; "lookalike fit" is a different label from verified current intent - a lookalike without a verified event is never ready-to-buy; with
// no negatives, too few examples, or a held-out check that does not beat chance, nothing is claimed. Pure: no model call, no search, no network.

export interface Example { name: string; domain?: string | null; industry?: string | null; size?: string | null; location?: string | null; description?: string | null; kind: 'customer' | 'won' | 'negative' | 'competitor' }
export interface Candidate { name: string; domain?: string | null; industry?: string | null; size?: string | null; location?: string | null; description?: string | null; verifiedEvent?: { date: string; source_url: string } | null }

const STOP = new Set('this that with from have been were they their will would could should about into over after before more most other these those when where which while company inc llc ltd group services service solutions'.split(' '))
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(?:inc|llc|ltd|corp|co|the|gmbh)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()
const host = (d?: string | null) => (d ?? '').toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0]
export const entityKey = (e: { name: string; domain?: string | null }) => (host(e.domain).includes('.') ? `d:${host(e.domain)}` : `n:${slug(e.name)}`)

export interface Feature { dimension: 'industry' | 'size' | 'location' | 'keyword'; value: string }
const fkey = (f: Feature) => `${f.dimension}:${f.value}`
export function featuresOf(e: Pick<Example, 'industry' | 'size' | 'location' | 'description'>): Feature[] {
  const out = new Map<string, Feature>(), add = (f: Feature) => { if (f.value) out.set(fkey(f), f) }
  if (e.industry) add({ dimension: 'industry', value: slug(e.industry) })
  if (e.size) add({ dimension: 'size', value: slug(e.size) })
  if (e.location) add({ dimension: 'location', value: slug(e.location) })
  for (const w of slug(e.description ?? '').split(' ')) if (w.length >= 4 && !STOP.has(w)) add({ dimension: 'keyword', value: w })
  return [...out.values()]
}

export interface Discriminator { feature: Feature; posRate: number; negRate: number; lift: number; support: number }
export interface Model { discriminators: Discriminator[]; positives: number; negatives: number }
export const MIN_POSITIVES = 5, MIN_NEGATIVES = 5, MIN_SUPPORT = 2, MIN_LIFT = 2
// Smoothed (add-one) rate ratio of a feature among positives vs negatives; kept only with enough support and a real lift, so a feature common to everyone is not "discriminating".
export function deriveModel(pos: Example[], neg: Example[]): Model {
  const count = (xs: Example[]) => { const m = new Map<string, { f: Feature; n: number }>(); for (const x of xs) for (const f of featuresOf(x)) { const c = m.get(fkey(f)) ?? { f, n: 0 }; c.n++; m.set(fkey(f), c) } return m }
  const P = count(pos), N = count(neg), out: Discriminator[] = []
  for (const [k, { f, n }] of P) {
    if (n < MIN_SUPPORT) continue
    const posRate = n / pos.length, negRate = ((N.get(k)?.n ?? 0) + 1) / (neg.length + 2)
    const lift = posRate / negRate
    if (lift >= MIN_LIFT) out.push({ feature: f, posRate, negRate, lift, support: n })
  }
  return { discriminators: out.sort((a, b) => b.lift * b.support - a.lift * a.support).slice(0, 12), positives: pos.length, negatives: neg.length }
}

export interface Match { fit: number; reasons: string[] }
// Fit in [0,1]: the share of the model's discriminating weight the candidate has; reasons are the exact features it matched, with their lift.
export function scoreCandidate(m: Model, c: Candidate): Match {
  const have = new Set(featuresOf(c).map(fkey)); let got = 0, all = 0; const reasons: string[] = []
  for (const d of m.discriminators) { const w = Math.log2(d.lift) * d.support; all += w; if (have.has(fkey(d.feature))) { got += w; reasons.push(`${d.feature.dimension}: ${d.feature.value} (${d.support} of ${m.positives} customers, ${d.lift.toFixed(1)}x vs non-customers)`) } }
  return { fit: all ? got / all : 0, reasons }
}

// Deterministic split so the evaluation is reproducible and the held-out part is never used to derive the features.
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
export function split(xs: Example[], holdout = 0.3): { train: Example[]; test: Example[] } {
  const train: Example[] = [], test: Example[] = []
  for (const x of xs) (h32(entityKey(x)) % 100 < holdout * 100 ? test : train).push(x)
  return { train, test }
}

export type Readiness = 'lookalike_only' | 'lookalike_with_event'
export interface Discovery { state: 'ready' | 'needs_positives' | 'needs_negatives' | 'unvalidated'; why: string; model: Model | null; heldOut: { precisionAt: number; baseRate: number; lift: number; n: number } | null }
// Precision of the model's top picks on the held-out customers+negatives vs the base rate (what picking at random would give).
export function validate(all: Example[], minFit = 0.35): Discovery {
  const pos = all.filter(e => e.kind === 'customer' || e.kind === 'won'), neg = all.filter(e => e.kind === 'negative' || e.kind === 'competitor')
  if (pos.length < MIN_POSITIVES) return { state: 'needs_positives', why: `need at least ${MIN_POSITIVES} customers / won opportunities (have ${pos.length})`, model: null, heldOut: null }
  if (neg.length < MIN_NEGATIVES) return { state: 'needs_negatives', why: `need at least ${MIN_NEGATIVES} negative examples (have ${neg.length}); positives alone cannot say what discriminates`, model: null, heldOut: null }
  const p = split(pos), n = split(neg)
  const model = deriveModel(p.train, n.train)
  const test = [...p.test.map(e => ({ e, y: 1 })), ...n.test.map(e => ({ e, y: 0 }))]
  if (!model.discriminators.length || test.length < 4 || !p.test.length || !n.test.length) return { state: 'unvalidated', why: 'no discriminating features, or too few held-out examples to check them', model, heldOut: null }
  const picked = test.filter(t => scoreCandidate(model, t.e).fit >= minFit), hit = picked.filter(t => t.y === 1).length
  const precisionAt = picked.length ? hit / picked.length : 0, baseRate = p.test.length / test.length
  const heldOut = { precisionAt, baseRate, lift: baseRate ? precisionAt / baseRate : 0, n: test.length }
  if (!picked.length || heldOut.lift <= 1) return { state: 'unvalidated', why: `held-out precision ${precisionAt.toFixed(2)} does not beat chance ${baseRate.toFixed(2)}`, model, heldOut }
  return { state: 'ready', why: `held-out precision ${precisionAt.toFixed(2)} vs chance ${baseRate.toFixed(2)}`, model, heldOut }
}

export interface Ranked { candidate: Candidate; fit: number; reasons: string[]; readiness: Readiness; label: string }
// Rank NEW accounts. The supplied customers and competitors never come back. Lookalike fit is its own label; ready-to-buy needs a verified event, which a lookalike does not carry.
export function discover(all: Example[], candidates: Candidate[], minFit = 0.35): { discovery: Discovery; ranked: Ranked[]; excluded: { candidate: Candidate; why: string }[] } {
  const discovery = validate(all, minFit), excluded: { candidate: Candidate; why: string }[] = []
  if (discovery.state !== 'ready' || !discovery.model) return { discovery, ranked: [], excluded }
  const known = new Map(all.map(e => [entityKey(e), e.kind] as const)), ranked: Ranked[] = []
  for (const c of candidates) {
    const k = known.get(entityKey(c))
    if (k) { excluded.push({ candidate: c, why: k === 'customer' || k === 'won' ? 'already a customer' : k === 'competitor' ? 'competitor' : 'rejected negative example' }); continue }
    const m = scoreCandidate(discovery.model, c); if (m.fit < minFit) continue
    const ev = !!c.verifiedEvent?.date && !!c.verifiedEvent.source_url
    ranked.push({ candidate: c, fit: m.fit, reasons: m.reasons, readiness: ev ? 'lookalike_with_event' : 'lookalike_only', label: ev ? 'Lookalike fit + verified recent event' : 'Lookalike fit only - no verified current intent' })
  }
  return { discovery, ranked: ranked.sort((a, b) => b.fit - a.fit), excluded }
}

// Search queries for net-new accounts from the top discriminating features (industry / location / keywords) - to feed the normal verifier, not to skip it.
export function lookalikeQueries(m: Model, max = 4): string[] {
  const by = (d: Feature['dimension']) => m.discriminators.filter(x => x.feature.dimension === d).map(x => x.feature.value)
  const ind = by('industry')[0], loc = by('location')[0], kw = by('keyword').slice(0, 3)
  return [...new Set([[ind, loc].filter(Boolean).join(' '), [ind, ...kw.slice(0, 2)].filter(Boolean).join(' '), [...kw, loc].filter(Boolean).join(' ')].map(s => s.trim()).filter(s => s.split(' ').length >= 2))].slice(0, max)
}

// Measured against ordinary ICP retrieval on the same labelled candidates (the #372 style comparison): precision@k of each ranking and the lift between them.
export function compareToBaseline(labelled: { id: string; good: boolean }[], lookalikeOrder: string[], icpOrder: string[], k = 5): { lookalike: number; icp: number; lift: number | null; k: number } {
  const good = new Set(labelled.filter(l => l.good).map(l => l.id)), p = (o: string[]) => { const t = o.slice(0, k); return t.length ? t.filter(i => good.has(i)).length / t.length : 0 }
  const a = p(lookalikeOrder), b = p(icpOrder)
  return { lookalike: a, icp: b, lift: b > 0 ? a / b : null, k }
}
