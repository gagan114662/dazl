// Lookalike DISCOVERY from customer outcomes the tenant supplies (#386). lookalike.ts annotates leads the tenant already
// has against its own past fit grades (model guesses); this module starts from what actually happened: customers and won
// opportunities, plus REQUIRED negative examples (lost / bad-fit accounts, competitors). It derives explainable
// discriminating features, checks them on a held-out split, turns them into a reviewable search profile for the normal
// scan pipeline (net-new accounts go through the same verifier and gates as any scan), and travels with that scan's
// profile so the run never brings back a supplied account and every lead shows which customer features it matches.
//
// Honesty rules:
// - Too few customers, no negatives, or a held-out check that does not beat chance: no model, no profile, nothing claimed.
// - Every supplied account (customer, won, negative, competitor) is excluded from the discovered results.
// - "Lookalike fit" is its own label. It never raises a grade, an intent or a gate; a lookalike without a proof-backed
//   current event is labelled "no verified current intent", never ready-to-buy.
// - Pure: no model call, no search, no network, no database.
import { getDomain } from 'tldts'
import { companyKey, companyOwnsDomain, hasPhrase } from './evidence.ts'
import { lookalikeOf, normalizeLookalike, slug, MAX_EXAMPLES, MAX_FEATURES, MIN_LIFT, MIN_NEGATIVES, MIN_POSITIVES, MIN_SUPPORT, type LookalikeBlock } from './lookalike-block.ts'
export { lookalikeOf, normalizeLookalike, slug, MAX_EXAMPLES, MAX_FEATURES, MIN_LIFT, MIN_NEGATIVES, MIN_POSITIVES, MIN_SUPPORT, type LookalikeBlock }

export type ExampleKind = 'customer' | 'won' | 'negative' | 'competitor'
export interface Example { name: string; domain?: string | null; industry?: string | null; size?: string | null; location?: string | null; description?: string | null; kind: ExampleKind }
const KINDS = new Set<ExampleKind>(['customer', 'won', 'negative', 'competitor'])
const isPositive = (e: Example) => e.kind === 'customer' || e.kind === 'won'

export const MIN_FIT = 0.35
const CAP = { name: 150, domain: 253, field: 100, description: 400 }

const STOP = new Set('this that with from have been were they their will would could should about into over after before more most other these those when where which while company companies inc llc ltd group services service solutions business businesses based provider providers offering offers customers clients'.split(' '))
// A bare host from a domain or URL: the WHATWG URL parser lowercases, maps full-width and other compatibility forms, punycodes IDN
// (bücher.de and xn--bcher-kva.de are one host), and drops scheme, userinfo, port, path, query and fragment; then trailing dots and www.
// Anything that is not a string, or does not parse, is no host.
export const host = (d?: unknown) => {
  let s = typeof d === 'string' ? d.trim().slice(0, 2048) : ''
  if (!s) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`
  let h: string
  try { h = new URL(s).hostname } catch { return '' }
  return h.replace(/\.+$/, '').replace(/^www\./, '')
}
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
// The registrable domain of a host (public-suffix aware, private suffixes included, so two stores on one hosting platform stay two
// accounts); the host itself when it has none (a bare public suffix, an unknown shape).
export const registrable = (h: string) => { const r = HOST_RE.test(h) ? getDomain(h, { allowPrivateDomains: true }) : null; return r && HOST_RE.test(r) ? r : h }
const text = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''

// ---- import ------------------------------------------------------------------------------------------------------
export type CohortParse = { ok: true; examples: Example[] } | { ok: false; error: 'invalid_cohort' | 'too_many_examples'; detail: string }
// Validates a supplied cohort. Any malformed row refuses the whole import with the row named: a half-read customer list
// would silently weaken both the model and the exclusions.
export function parseCohort(raw: unknown): CohortParse {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'invalid_cohort', detail: 'examples must be a non-empty list' }
  if (raw.length > MAX_EXAMPLES) return { ok: false, error: 'too_many_examples', detail: `at most ${MAX_EXAMPLES} accounts per import (got ${raw.length}); nothing was truncated` }
  const out: Example[] = []
  for (const [i, r] of raw.entries()) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const kind = o.kind as ExampleKind
    if (!KINDS.has(kind)) return { ok: false, error: 'invalid_cohort', detail: `examples[${i}].kind must be customer, won, negative or competitor` }
    const name = text(o.name, CAP.name)
    if (companyKey(name).length < 2) return { ok: false, error: 'invalid_cohort', detail: `examples[${i}].name is required` }
    let domain: string | null = null
    if (o.domain !== undefined && o.domain !== null && o.domain !== '') {
      domain = host(text(o.domain, CAP.domain))
      if (!HOST_RE.test(domain)) return { ok: false, error: 'invalid_cohort', detail: `examples[${i}].domain is not a hostname` }
    }
    out.push({ kind, name, domain, industry: text(o.industry, CAP.field) || null, size: text(o.size, CAP.field) || null, location: text(o.location, CAP.field) || null, description: text(o.description, CAP.description) || null })
  }
  return { ok: true, examples: out }
}

// ---- features and model ------------------------------------------------------------------------------------------
export type Dimension = 'industry' | 'size' | 'location' | 'keyword'
export interface Feature { dimension: Dimension; value: string }
const fkey = (f: Feature) => `${f.dimension}:${f.value}`
export function featuresOf(e: Pick<Example, 'industry' | 'size' | 'location' | 'description'>): Feature[] {
  const out = new Map<string, Feature>(), add = (f: Feature) => { if (f.value) out.set(fkey(f), f) }
  if (e.industry) add({ dimension: 'industry', value: slug(e.industry) })
  if (e.size) add({ dimension: 'size', value: slug(e.size) })
  if (e.location) add({ dimension: 'location', value: slug(e.location) })
  for (const w of slug(e.description ?? '').split(' ')) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) add({ dimension: 'keyword', value: w })
  return [...out.values()]
}

export interface Discriminator { feature: Feature; support: number; posRate: number; negRate: number; lift: number }
export interface Model { discriminators: Discriminator[]; positives: number; negatives: number }
// A feature discriminates when enough customers have it AND it is clearly rarer among the negatives (add-one smoothed
// rate ratio). A feature every account shares, or one only the negatives have, is never a discriminator.
export function deriveModel(pos: Example[], neg: Example[]): Model {
  const count = (xs: Example[]) => { const m = new Map<string, { f: Feature; n: number }>(); for (const x of xs) for (const f of featuresOf(x)) { const c = m.get(fkey(f)) ?? { f, n: 0 }; c.n++; m.set(fkey(f), c) } return m }
  const P = count(pos), N = count(neg), out: Discriminator[] = []
  for (const [k, { f, n }] of P) {
    if (n < MIN_SUPPORT) continue
    const posRate = n / pos.length, negRate = ((N.get(k)?.n ?? 0) + 1) / (neg.length + 2), lift = posRate / negRate
    if (lift >= MIN_LIFT) out.push({ feature: f, support: n, posRate, negRate, lift })
  }
  out.sort((a, b) => b.lift * b.support - a.lift * a.support || fkey(a.feature).localeCompare(fkey(b.feature)))
  return { discriminators: out.slice(0, MAX_FEATURES), positives: pos.length, negatives: neg.length }
}

export interface Match { fit: number; matched: Discriminator[] }
const weight = (d: Pick<Discriminator, 'lift' | 'support'>) => Math.log2(d.lift) * d.support
// Fit in [0,1]: the share of the model's discriminating weight the account has.
export function scoreFeatures(m: Pick<Model, 'discriminators'>, has: (f: Feature) => boolean): Match {
  let got = 0, all = 0; const matched: Discriminator[] = []
  for (const d of m.discriminators) { const w = weight(d); all += w; if (has(d.feature)) { got += w; matched.push(d) } }
  return { fit: all ? got / all : 0, matched }
}
export const scoreExample = (m: Model, e: Pick<Example, 'industry' | 'size' | 'location' | 'description'>) => { const have = new Set(featuresOf(e).map(fkey)); return scoreFeatures(m, f => have.has(fkey(f))) }
export const reason = (d: Pick<Discriminator, 'feature' | 'support' | 'lift'>, positives: number) => `${d.feature.dimension} "${d.feature.value}": ${d.support} of ${positives} customers, ${d.lift.toFixed(1)}x vs non-customers`

// ---- held-out validation -----------------------------------------------------------------------------------------
const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return h >>> 0 }
export const entityKey = (e: { name: string; domain?: string | null }) => (HOST_RE.test(host(e.domain)) ? `d:${host(e.domain)}` : `n:${companyKey(e.name)}`)
// Deterministic split (by account, so a run is reproducible); the held-out part never contributes to the features it checks.
export function split(xs: Example[], holdout = 0.3): { train: Example[]; test: Example[] } {
  const train: Example[] = [], test: Example[] = []
  for (const x of xs) (h32(entityKey(x)) % 100 < holdout * 100 ? test : train).push(x)
  return { train, test }
}

export interface HeldOut { precision: number; baseRate: number; lift: number; picked: number; n: number }
export interface Discovery { state: 'ready' | 'needs_positives' | 'needs_negatives' | 'unvalidated'; why: string; model: Model | null; heldOut: HeldOut | null }
// The features are derived on the training part and judged on the held-out part: precision of the accounts they pick
// versus the base rate (what picking at random would give). Only a model that beats chance is used, and then it is
// refit on every supplied example (the held-out numbers describe the training-only model, and say so).
export function validate(all: Example[], minFit = MIN_FIT): Discovery {
  const pos = all.filter(isPositive), neg = all.filter(e => !isPositive(e))
  if (pos.length < MIN_POSITIVES) return { state: 'needs_positives', why: `need at least ${MIN_POSITIVES} customers or won opportunities (have ${pos.length})`, model: null, heldOut: null }
  if (neg.length < MIN_NEGATIVES) return { state: 'needs_negatives', why: `need at least ${MIN_NEGATIVES} negative examples - lost or bad-fit accounts, or competitors (have ${neg.length}); customers alone cannot show what sets them apart`, model: null, heldOut: null }
  const p = split(pos), n = split(neg)
  const trained = deriveModel(p.train, n.train)
  const test = [...p.test.map(e => ({ e, y: 1 })), ...n.test.map(e => ({ e, y: 0 }))]
  if (!trained.discriminators.length) return { state: 'unvalidated', why: 'no feature separates the customers from the negative examples', model: null, heldOut: null }
  if (p.test.length < 2 || n.test.length < 2) return { state: 'unvalidated', why: `too few held-out accounts to check the features (${p.test.length} customers, ${n.test.length} negatives held out; add more examples)`, model: null, heldOut: null }
  const picked = test.filter(t => scoreExample(trained, t.e).fit >= minFit), hit = picked.filter(t => t.y === 1).length
  const precision = picked.length ? hit / picked.length : 0, baseRate = p.test.length / test.length
  const heldOut: HeldOut = { precision, baseRate, lift: precision / baseRate, picked: picked.length, n: test.length }
  if (!picked.length || heldOut.lift <= 1) return { state: 'unvalidated', why: `held-out precision ${precision.toFixed(2)} does not beat chance ${baseRate.toFixed(2)}`, model: null, heldOut }
  return { state: 'ready', why: `held-out precision ${precision.toFixed(2)} vs chance ${baseRate.toFixed(2)} on ${test.length} held-out accounts`, model: deriveModel(pos, neg), heldOut }
}

// ---- the profile block that travels with the scan ----------------------------------------------------------------
const DIM: Record<Dimension, LookalikeBlock['f'][number]['d']> = { industry: 'i', size: 's', location: 'l', keyword: 'k' }
const MID: Record<string, Dimension> = { i: 'industry', s: 'size', l: 'location', k: 'keyword' }
// 25-bit FNV-1a in base36, 5 chars. A collision can only exclude a candidate (fail closed), never admit a supplied account.
export const keyHash = (k: string) => (h32(k) >>> 7).toString(36).padStart(5, '0')
// A supplied account's keys: its name, and its domain as the REGISTRABLE domain, so jobs.acme.com, eu.acme.com and acme.com are one
// account whichever of them was supplied or comes back (#606 review: exact-host keys let a supplied account return via a subdomain).
export function accountKeys(e: { name: string; domain?: string | null }): string[] {
  const out: string[] = []; const n = companyKey(typeof e.name === 'string' ? e.name : ''), d = host(e.domain)
  if (n.length >= 2) out.push(`n:${n}`)
  if (HOST_RE.test(d)) out.push(`d:${registrable(d)}`)
  return out
}
// A candidate host's domain keys: the registrable domain (matches every block built by accountKeys) and the exact host (matches blocks
// stored before registrable keys, which hashed the supplied host as given).
const hostKeys = (h: string) => HOST_RE.test(h) ? [...new Set([`d:${registrable(h)}`, `d:${h}`])] : []
// Whether the company is plausibly the owner of a page host: its own domain (companyOwnsDomain), or the registrable domain's label is the
// leading part of its name ("Acme Labs" on careers.acme.com). Only used to match a SUPPLIED account's domain, so a news, platform or
// partner host never makes another company "known" (Maple Row Dental on a customer's blog stays net-new).
const nameOwnsHost = (company: string, h: string) => {
  if (companyOwnsDomain(company, h)) return true
  const label = registrable(h).split('.')[0].replace(/-/g, '')
  if (label.length < 3) return false
  let acc = ''
  for (const t of companyKey(company).split(' ')) { acc += t.replace(/[^a-z0-9]/g, ''); if (acc === label) return true; if (acc.length >= label.length) return false }
  return false
}
const round = (x: number, p = 2) => Math.round(x * 10 ** p) / 10 ** p

export function toBlock(d: Discovery, all: Example[]): LookalikeBlock | null {
  if (d.state !== 'ready' || !d.model || !d.heldOut) return null
  const keys = (pick: (e: Example) => boolean) => [...new Set(all.filter(pick).flatMap(accountKeys).map(keyHash))].sort().join('')
  return {
    v: 1,
    f: d.model.discriminators.map(x => ({ d: DIM[x.feature.dimension], t: x.feature.value.slice(0, 60), n: x.support, x: round(x.lift, 1) })),
    p: d.model.positives, q: d.model.negatives,
    h: { p: round(d.heldOut.precision), b: round(d.heldOut.baseRate), n: d.heldOut.n },
    k: { c: keys(isPositive), x: keys(e => e.kind === 'competitor'), n: keys(e => e.kind === 'negative') },
  }
}

const blockModel = (b: LookalikeBlock) => ({ discriminators: b.f.map(x => ({ feature: { dimension: MID[x.d], value: x.t }, support: x.n, lift: x.x, posRate: 0, negRate: 0 })) })

// ---- net-new: never a supplied account ---------------------------------------------------------------------------
export type KnownKind = 'customer' | 'competitor' | 'negative'
// Which supplied account a candidate is, if any. The name key always counts; the source page's host counts only when that
// host is the company's own domain (a news site hosting the article is not the company), plus an explicit company domain.
export function knownAccount(b: LookalikeBlock, c: { company: string; name?: string; source_url?: string | null; company_domain?: string | null }): KnownKind | null {
  const company = typeof c.company === 'string' ? c.company : '', name = typeof c.name === 'string' ? c.name : ''
  const n = companyKey(company || name)
  const keys = [...(n.length >= 2 ? [`n:${n}`] : []), ...hostKeys(host(c.company_domain))]
  const src = host(c.source_url)
  if (src && company && nameOwnsHost(company, src)) keys.push(...hostKeys(src))
  const has = (run: string, h: string) => { for (let i = 0; i < run.length; i += 5) if (run.slice(i, i + 5) === h) return true; return false }
  for (const h of keys.map(keyHash)) {
    if (has(b.k.c, h)) return 'customer'
    if (has(b.k.x, h)) return 'competitor'
    if (has(b.k.n, h)) return 'negative'
  }
  return null
}
// Splits candidates into the net-new ones and the supplied accounts the run must not bring back (with the reason).
export function dropKnown<T extends { company: string; name?: string; source_url?: string | null; company_domain?: string | null }>(b: LookalikeBlock | null | undefined, list: T[]): { kept: T[]; dropped: { row: T; reason: string }[] } {
  if (!b) return { kept: list, dropped: [] }
  const kept: T[] = [], dropped: { row: T; reason: string }[] = []
  for (const row of list) { const k = knownAccount(b, row); if (k) dropped.push({ row, reason: `lookalike_supplied_${k}` }); else kept.push(row) }
  return { kept, dropped }
}

// ---- the lead label ----------------------------------------------------------------------------------------------
export type Readiness = 'lookalike_only' | 'lookalike_with_event'
export interface LookalikeFit { fit: number; reasons: string[]; readiness: Readiness; label: string; basis: string }
// Lookalike fit of a stored lead, from the lead's OWN evidence text (company, signal, verbatim excerpt) only - never from
// the job's search inputs or the grader's rationale, which would just echo the profile back. `proofBackedEvent` is the
// existing timing proof (scoreboard surfaceStoredIntent); lookalike fit never substitutes for it.
export function leadLookalikeFit(b: LookalikeBlock, lead: { company: string; signal: string; evidence_excerpt?: string | null }, proofBackedEvent: boolean): LookalikeFit {
  const hay = slug([lead.company, lead.signal, lead.evidence_excerpt ?? ''].join(' '))
  const m = scoreFeatures(blockModel(b), f => hasPhrase(hay, f.value))
  const withEvent = proofBackedEvent
  return {
    fit: round(m.fit),
    reasons: m.matched.map(d => `${reason(d, b.p)} - found in this lead's own evidence`),
    readiness: withEvent ? 'lookalike_with_event' : 'lookalike_only',
    label: withEvent ? 'Lookalike fit + proof-backed current event' : 'Lookalike fit only - no verified current intent',
    basis: `features from ${b.p} supplied customers vs ${b.q} negative examples; held-out precision ${b.h.p.toFixed(2)} vs chance ${b.h.b.toFixed(2)} (${b.h.n} accounts)`,
  }
}

// ---- the reviewable search profile -------------------------------------------------------------------------------
export interface Proposal { query: string; icp: { summary: string; who: string[]; industries: string[]; sizes: string[]; where: string[]; signals: string[]; exclude: string[]; lookalike: LookalikeBlock } }
// What the scan will search for: the discriminating industries, sizes and places as the profile's own fields, the
// discriminating keywords in the request text. The normal scan does the retrieval and verification; nothing here is a lead.
export function proposeProfile(d: Discovery, all: Example[]): Proposal | null {
  const block = toBlock(d, all)
  if (!block || !d.model) return null
  const by = (dim: Dimension) => d.model!.discriminators.filter(x => x.feature.dimension === dim).map(x => x.feature.value)
  const industries = by('industry').slice(0, 3), sizes = by('size').slice(0, 2), where = by('location').slice(0, 3), kws = by('keyword').slice(0, 4)
  const what = industries.length ? industries.join(' or ') : 'companies'
  const query = `${what}${where.length ? ` in ${where.join(' or ')}` : ''}${kws.length ? ` - ${kws.join(', ')}` : ''}, like our customers`.slice(0, 600)
  const traits = [...industries, ...sizes.map(s => `${s} employees`), ...where, ...kws].join(', ')
  const summary = `Companies resembling our supplied customers (${traits})`.slice(0, 300)
  return { query, icp: { summary, who: [], industries, sizes, where, signals: [], exclude: [], lookalike: block } }
}

// One call for the route: validated cohort -> discovery state, features with reasons, held-out numbers, profile.
export function discover(all: Example[]) {
  const d = validate(all)
  return {
    state: d.state, why: d.why,
    features: d.model ? d.model.discriminators.map(x => ({ dimension: x.feature.dimension, value: x.feature.value, support: x.support, lift: round(x.lift, 1), reason: reason(x, d.model!.positives) })) : [],
    held_out: d.heldOut ? { precision: round(d.heldOut.precision), chance: round(d.heldOut.baseRate), lift: round(d.heldOut.lift), picked: d.heldOut.picked, accounts: d.heldOut.n } : null,
    counts: { customers: all.filter(isPositive).length, negatives: all.filter(e => e.kind === 'negative').length, competitors: all.filter(e => e.kind === 'competitor').length },
    proposal: proposeProfile(d, all),
  }
}

// ---- measured against ordinary ICP retrieval ---------------------------------------------------------------------
// Precision@k of two orderings of the SAME labelled candidates (the #372 benchmark shape): the lookalike ordering and the
// ordinary-ICP ordering. lift = lookalike / icp; null when the ICP ordering found nothing.
export function compareToBaseline(labelled: { id: string; good: boolean }[], lookalikeOrder: string[], icpOrder: string[], k = 5): { lookalike: number; icp: number; lift: number | null; k: number } {
  const good = new Set(labelled.filter(l => l.good).map(l => l.id)), p = (o: string[]) => { const t = o.slice(0, k); return t.length ? t.filter(i => good.has(i)).length / t.length : 0 }
  const a = p(lookalikeOrder), b = p(icpOrder)
  return { lookalike: a, icp: b, lift: b > 0 ? a / b : null, k }
}
// The two orderings over candidate evidence text. ICP baseline: how many of the profile's own industry/size/place terms
// the text names (ordinary profile retrieval). Lookalike: the discriminating-feature fit. Ties keep input order.
export function orderByIcp(icp: { industries: string[]; sizes: string[]; where: string[] }, cands: { id: string; text: string }[]): string[] {
  const terms = [...icp.industries, ...icp.sizes, ...icp.where].map(slug).filter(Boolean)
  return cands.map((c, i) => ({ id: c.id, i, s: terms.filter(t => hasPhrase(slug(c.text), t)).length })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.id)
}
export function orderByLookalike(b: LookalikeBlock, cands: { id: string; text: string }[]): string[] {
  return cands.map((c, i) => ({ id: c.id, i, s: scoreFeatures(blockModel(b), f => hasPhrase(slug(c.text), f.value)).fit })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.id)
}
