// Multi-page seller research: a bounded read of the seller's OWN site (product, pricing, customers / case studies, industries) that produces offers and buyer
// hypotheses, each with the page URL, a verbatim quote and a fetch time. The homepage alone often omits the buyer segment (#379).
// Rules: a statement is `sourced` only when its quote appears verbatim on the cited fetched page; a persona the pages do not support is kept as a `hypothesis`
// (never presented as fact); a size or place with no supporting quote is `unknown`. Reviewed corrections are keyed by offer, so one offer's answers never
// leak into another's targeting. Pure core: the fetcher and the model call are injected (tests stub both); no database, no network of its own.
import { extractSiteText } from './icp-from-site.ts'
import { norm } from './evidence.ts'
import { quoteSupports, quoteBacksOffer, quoteBacksDisqualifier } from './claim-quote.ts'

export type HypKind = 'offer' | 'persona' | 'industry' | 'size' | 'location' | 'disqualifier' | 'pain'
export type HypStatus = 'sourced' | 'hypothesis' | 'unknown' | 'reviewed' | 'rejected'
export interface Hypothesis { id: string; offer: string; kind: HypKind; text: string; status: HypStatus; url: string | null; quote: string | null; fetched_at: number | null }
export interface ResearchedPage { url: string; title: string; fetched_at: number; kind: PageKind }
export interface AnsweredQuestion { question: string; offer: string; text?: string }
// A saved decision (a reviewed or rejected statement, or a typed answer) whose OFFER can no longer be told: it is kept here by the name(s) it might belong to, never moved onto a guess.
// Every current offer whose stored name is in `names` is HELD: only statements the person explicitly reviewed target for it (see targetingFor) until none of its statements is left unreviewed.
export interface Unresolved { names: string[]; kind: HypKind; text: string; status: 'reviewed' | 'rejected'; whole?: boolean; rej?: string[]; rev?: string[]; open?: boolean }   // whole: capacity overflow folded to a group-level hold; rej/rev: identities (digests) of the rejected / reviewed statements folded into it; open: the set is unknown, never released
export interface SellerResearch { site: string; pages: ResearchedPage[]; offers: { id: string; name: string }[]; hypotheses: Hypothesis[]; question: string | null; answered: AnsweredQuestion | null; unresolved?: Unresolved[] }
export type PageKind = 'home' | 'product' | 'pricing' | 'customers' | 'industries'

export const MAX_PAGES = 5            // besides the homepage
const PAGE_TEXT = 3500                // characters of visible text per page given to the model
const KINDS: [PageKind, RegExp][] = [
  ['pricing', /\b(?:pricing|plans|price)\b/i], ['customers', /\b(?:customers?|case[-\s]?stud(?:y|ies)|success[-\s]?stor(?:y|ies)|testimonials?|clients?)\b/i],
  ['industries', /\b(?:industries|industry|use[-\s]?cases?|who we serve|solutions?\s+for)\b/i], ['product', /\b(?:products?|platform|features?|solutions?|services?|how it works)\b/i],
]
const registrable = (h: string) => h.toLowerCase().replace(/^www\./, '')

// Offer identity lives in ./offer-identity.ts (one contract for construction, storage, the reviewed draft, retrieval titles and decision reuse).
import { capHolds, holdName, holdNameOf, holdTag, offerId, offerIds, offerKey, rejDigest, selectOffer, storedKey } from './offer-identity.ts'
export { offerId, offerIds, offerKey }

// Hypothesis ids are content-keyed (offer + kind + the model's original text), so a recrawl that finds the same
// statement reproduces the same id and a reviewed correction re-applies to it. An edited text is a new statement.
function hypId(offer: string, kind: HypKind, text: string): string {
  let h = 5381
  const s = `${offer}|${kind}|${norm(text)}`
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return `${offer}:${kind}:${h.toString(36)}`
}

// Same-site links worth reading, best kinds first (pricing, customers, industries, product), at most MAX_PAGES, one per URL. Offsite links, mailto, files and fragments are ignored.
export function researchLinks(homeHtml: string, finalUrl: string): { url: string; kind: PageKind }[] {
  let base: URL; try { base = new URL(finalUrl) } catch { return [] }
  const out = new Map<string, { url: string; kind: PageKind; rank: number }>()
  for (const m of homeHtml.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    let u: URL; try { u = new URL(m[1], base) } catch { continue }
    if (!/^https?:$/.test(u.protocol) || registrable(u.hostname) !== registrable(base.hostname) || /\.(?:pdf|png|jpe?g|gif|svg|zip|mp4)$/i.test(u.pathname) || u.pathname === '/' || u.pathname === base.pathname) continue
    const label = `${u.pathname} ${m[2].replace(/<[^>]+>/g, ' ')}`
    const idx = KINDS.findIndex(([, re]) => re.test(label)); if (idx < 0) continue
    u.search = ''; u.hash = ''
    const url = u.toString(); if (!out.has(url)) out.set(url, { url, kind: KINDS[idx][0], rank: idx })
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank).slice(0, MAX_PAGES).map(({ url, kind }) => ({ url, kind }))
}

export const jsonOnly = (s: string): unknown => { try { return JSON.parse(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s)?.[1] ?? s) } catch { return null } }

export interface FetchedPage { url: string; kind: PageKind; title: string; text: string; fetched_at: number }

// Validates raw model output into a SellerResearch. Offers get stable name-derived ids; items referencing an unknown
// offer ref are dropped; a statement is sourced only when its quote is verbatim on the cited page. When `prior` is
// given, its answered-question binding is carried while the answering offer still exists, and the same question is
// never re-asked; prior reviewed/rejected corrections re-apply to the same content-keyed hypotheses.
export const OFFER_QUESTION = 'Which of your offers is this play for?'
export const WHO_QUESTION = 'Who buys this?'

// The offer-citation validator (#872): optional model-supplied {url, quote, inferred} on an offer, verified against the
// pages actually fetched - never trusted on the model's say-so.
function offerCitation(x: { name: string; url?: unknown; quote?: unknown; inferred?: unknown }, byUrl: Map<string, FetchedPage>, names: string[]): { url: string; quote: string; fetched_at: number } | null {
  if (x.inferred === true) return null
  const pg = typeof x.url === 'string' ? byUrl.get(x.url) : undefined
  const quote = typeof x.quote === 'string' ? x.quote.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
  if (!pg || quote.length < 12 || !norm(pg.text).includes(norm(quote))) return null
  if (!quoteBacksOffer(x.name, quote, names)) return null
  return { url: pg.url, quote, fetched_at: pg.fetched_at }
}

export function buildResearch(out: unknown, pages: FetchedPage[], site: string, prior?: SellerResearch | null): SellerResearch | { error: 'model_failed' } {
  if (!out || typeof out !== 'object') return { error: 'model_failed' }
  // Site identity: another site's corrections and answers never carry into this read, even when offer slugs collide.
  if (prior && prior.site !== site) prior = null
  const o = out as { offers?: unknown; items?: unknown }
  const raw = (Array.isArray(o.offers) ? o.offers : []).filter((x): x is { id?: unknown; name: string; url?: unknown; quote?: unknown; inferred?: unknown } => typeof (x as { name?: unknown })?.name === 'string').slice(0, 6)
  const names = raw.map(x => x.name.slice(0, 120)), { ids, ambiguous } = offerIds(names)
  const offers = raw.map((x, i) => ({ ref: typeof (x as { id?: unknown }).id === 'string' ? String((x as { id?: unknown }).id) : null, id: ids[i], name: names[i], ambiguous: ambiguous[i], url: x.url, quote: x.quote, inferred: x.inferred }))
  if (offers.length === 0) return { error: 'model_failed' }
  const byRef = new Map(offers.map(x => [x.ref, x.id]))
  const byUrl = new Map(pages.map(p => [p.url, p]))
  // #872: an offer is source-backed only by a verbatim, claim-carrying first-party sentence on an ALREADY FETCHED page,
  // cited by its exact URL with that page's own fetch time. No quote, an unfetched URL, a model-marked inference, or a
  // citation failing the ownership/polarity/attribution guards (claim-quote.ts quoteBacksOffer) stays a hypothesis.
  const hyps: Hypothesis[] = offers.map(x => {
    const cite = offerCitation(x, byUrl, names)
    return { id: `${x.id}:offer`, offer: x.id, kind: 'offer' as const, text: x.name, status: cite ? 'sourced' as const : 'hypothesis' as const, url: cite?.url ?? null, quote: cite?.quote ?? null, fetched_at: cite?.fetched_at ?? null }
  })
  const origin = new Map<Hypothesis, string>()   // the model's own wording, which the content-keyed id was made from (an edited text is a different string)
  for (const it of (Array.isArray(o.items) ? o.items : []).slice(0, 40) as Record<string, unknown>[]) {
    const offer = typeof it.offer === 'string' && byRef.has(it.offer) ? byRef.get(it.offer)! : offers.some(x => x.id === it.offer) ? String(it.offer) : null
    const kind = typeof it.kind === 'string' && ['persona', 'industry', 'size', 'location', 'disqualifier', 'pain'].includes(it.kind) ? it.kind as HypKind : null
    const text = typeof it.text === 'string' ? it.text.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
    if (!offer || !kind || !text) continue
    const pg = typeof it.url === 'string' ? byUrl.get(it.url) : undefined
    const quote = typeof it.quote === 'string' ? it.quote.replace(/\s+/g, ' ').trim().slice(0, 300) : ''
    // Sourced = the quote is verbatim on the cited page AND carries the claim itself (claim-quote.ts: a real quote next
    // to an invented headcount proves nothing), and the model did not itself mark the item as inferred.
    // #872: a disqualifier needs an EXPLICIT exclusion claim bound to its own offer (claim-quote.ts); every other kind
    // keeps the existing claim-carrying quote check.
    const offerName = offers.find(x => x.id === offer)?.name ?? ''
    const backed = kind === 'disqualifier' ? quoteBacksDisqualifier(offerName, text, quote, names) : quoteSupports(kind, text, quote)
    const quoted = !!pg && it.inferred !== true && quote.length >= 12 && norm(pg.text).includes(norm(quote)) && backed
    // A size or place without that is unknown, never carried as fact; a persona without it is a hypothesis.
    const status: HypStatus = quoted ? 'sourced' : kind === 'size' || kind === 'location' ? 'unknown' : 'hypothesis'
    const h: Hypothesis = { id: hypId(offer, kind, text), offer, kind, text: status === 'unknown' ? 'unknown' : text, status, url: quoted ? pg!.url : null, quote: quoted ? quote : null, fetched_at: quoted ? pg!.fetched_at : null }
    hyps.push(h); origin.set(h, text)
  }
  // Saved reviewed/rejected corrections and the answered question belong to an OFFER, so they follow the offer by NAME (see priorBindings), never by an id that
  // two offers can share or that a reordered listing can move. An offer with no unambiguous prior counterpart starts clean: the correction holds, it does not move.
  const bind = priorBindings(prior, offers)
  const carried = carryUnresolved(prior, offers, bind)
  let corrected = hyps
  if (prior?.hypotheses?.length && bind.size) {
    const prev = new Map(prior.hypotheses.filter(h => h.status === 'reviewed' || h.status === 'rejected').map(h => [h.id, h]))
    corrected = hyps.map(h => {
      const pid = bind.get(h.offer), raw = origin.get(h)
      if (!pid || raw === undefined || h.status === 'unknown') return h
      const p = prev.get(hypId(pid, h.kind, raw))   // the prior id was made with the prior offer id: recompute it the same way
      return p && p.offer === pid ? { ...h, text: p.status === 'reviewed' ? p.text : h.text, status: p.status } : h
    })
  }
  const offersKept = offers.map(({ id, name }) => ({ id, name }))
  // The answered binding survives a recrawl while the answering offer still exists; the same question is not re-asked.
  const answeredAs = prior?.answered ? [...bind].find(([, pid]) => pid === prior.answered!.offer)?.[0] : undefined
  const answered = prior?.answered && answeredAs ? { ...prior.answered, offer: answeredAs } : null
  // A typed 'Who buys this?' answer is the person's own targeting: it survives a recrawl as a REVIEWED persona on the
  // answering offer, so a fresh model draft can never lose it behind the answered-question suppression. Deleting it
  // from the draft on the next play records an explicit rejection, like any reviewed statement.
  if (answered?.text && !corrected.some(h => h.offer === answered.offer && h.kind === 'persona' && exact(h.text, answered.text!)))
    corrected = [...corrected, { id: hypId(answered.offer, 'persona', answered.text), offer: answered.offer, kind: 'persona', text: answered.text, status: 'reviewed', url: null, quote: null, fetched_at: null }]
  // Entries are kept only for candidates that a current offer still carries (a removed offer's decisions are not carried). A typed answer for an offer releases THAT candidate's share of a matching
  // answer entry; the other candidates stay held until their own explicit decision.
  const answeredName = answered ? holdNameOf(offersKept.find(x => x.id === answered.offer)?.name ?? '') : ''
  const groupSize = new Map<string, number>(); for (const x of offersKept) groupSize.set(holdNameOf(x.name), (groupSize.get(holdNameOf(x.name)) ?? 0) + 1)
  const current = new Set(groupSize.keys())
  const heldEntries = carried.map(u => {
    // A name shared by more than one current offer (equal through the stored width, or the same name listed twice) cannot be told apart from persisted names alone: it is never released by an answer for one id.
    const names = u.names.map(holdName).filter(n => current.has(n) && !(answered?.text && u.kind === 'persona' && u.status === 'reviewed' && n === answeredName && groupSize.get(n) === 1 && exact(u.text, answered.text)))
    const tags = new Set(names.map(holdTag))
    // a typed answer for an unambiguous offer re-decides that persona: it resolves the folded reviewed digest of the same text
    const typed = answered?.text && groupSize.get(answeredName) === 1 ? rejDigest(answeredName, 'persona', answered.text) : null
    const f = (l?: string[], drop?: string | null) => l?.filter(d => tags.has(d.split('.')[0]) && d !== drop)
    return { ...u, names, ...(u.rej ? { rej: f(u.rej) } : {}), ...(u.rev ? { rev: f(u.rev, typed) } : {}) }
  }).filter(u => u.names.length)
  // An unattributable REJECTION is honoured on every candidate (fail closed): the same statement on an offer it might have belonged to stays rejected. An unattributable confirmation or
  // edit is applied to none; it stays recorded in `unresolved` until the person reviews the offer.
  const rejects = heldEntries.filter(u => u.status === 'rejected')
  if (rejects.length) corrected = corrected.map(h => h.kind !== 'offer' && h.status !== 'unknown' && rejects.some(u => u.kind === h.kind && norm(u.text) === norm(h.text) && offersKept.some(x => x.id === h.offer && u.names.includes(holdNameOf(x.name)))) ? { ...h, status: 'rejected' as const } : h)
  // Rejections folded into a whole-group entry keep their identity as digests: the same statement, however it returns (a later quote, a different crawl), stays rejected on the offers that name carries.
  const digests = new Set(heldEntries.flatMap(u => u.rej ?? []))
  if (digests.size) corrected = corrected.map(h => h.kind !== 'offer' && h.status !== 'unknown' && h.status !== 'rejected' && offersKept.some(x => x.id === h.offer && digests.has(rejDigest(holdNameOf(x.name), h.kind, h.text))) ? { ...h, status: 'rejected' as const } : h)
  // Offers an old decision could not be attributed to are HELD: a page-supported (sourced) statement alone does not count as a buyer for them, and they are asked about again.
  const heldNow = new Set(heldIds({ offers: offersKept, unresolved: heldEntries }))
  const sourcedBuyer = (id: string) => corrected.some(h => h.offer === id && h.kind === 'persona' && (h.status === 'reviewed' || (h.status === 'sourced' && !heldNow.has(id))))
  // At most ONE question, and only when the answer changes targeting: several offers with no sourced buyer for them, or no sourced buyer at all.
  let question = offersKept.length > 1 && offersKept.some(x => !sourcedBuyer(x.id)) ? OFFER_QUESTION : !offersKept.some(x => sourcedBuyer(x.id)) ? WHO_QUESTION : null
  if (question && answered && answered.question === question) question = null
  const stillHeld = heldEntries
  return { site, pages: pages.map(p => ({ url: p.url, title: p.title, fetched_at: p.fetched_at, kind: p.kind })), offers: offersKept, hypotheses: corrected, question, answered, ...(stillHeld.length ? { unresolved: stillHeld } : {}) }
}

// ---- held (unresolved) identity ----
const wholeEntry = (names: string[], rej: string[], rev: string[], open: boolean): Unresolved => ({ names, kind: 'persona', text: '', status: 'reviewed', whole: true, ...(rej.length ? { rej } : {}), ...(rev.length ? { rev } : {}), ...(open ? { open: true } : {}) })
const decisionsOf = (prior: SellerResearch, id: string): Unresolved[] => [
  ...prior.hypotheses.filter(h => h.offer === id && h.kind !== 'offer' && (h.status === 'reviewed' || h.status === 'rejected')).map(h => ({ names: [], kind: h.kind, text: h.text, status: h.status as 'reviewed' | 'rejected' })),
  ...(prior.answered?.offer === id && prior.answered.text ? [{ names: [], kind: 'persona' as const, text: prior.answered.text, status: 'reviewed' as const }] : []),
]
// Saved decisions that could not be attributed to exactly one current offer, kept (not dropped, not moved) for as long as the offers they might belong to are not re-reviewed.
function carryUnresolved(prior: SellerResearch | null | undefined, offers: { id: string; name: string; ambiguous: boolean }[], bind: Map<string, string>): Unresolved[] {
  const out: Unresolved[] = [...(prior?.unresolved ?? [])]
  if (prior?.offers?.length) {
    const bound = new Set(bind.values()), ids = [...new Set(prior.offers.map(p => p.id))]
    for (const id of ids) {
      const group = prior.offers.filter(p => p.id === id)
      // bound only when this id is one unique saved offer that some current offer was matched to
      if (group.length === 1 && bound.has(id)) continue
      const names = [...new Set(group.map(p => holdNameOf(p.name)))]
      if (!offers.some(o => names.includes(holdNameOf(o.name)))) continue   // no current offer carries any of these names: the offer was removed, its decisions are not carried
      for (const d of decisionsOf(prior, id)) out.push({ ...d, names })
    }
  }
  return capHolds(out, wholeEntry)
}
// Current offers that are held: their stored name is in an unresolved decision. The hold ends only by an explicit new decision on the same statement (applyCorrections) or, for a typed answer,
// by the person answering again; a rerun, an unanswered question and a rejection the hold itself applied never end it.
export function heldIds(r: Pick<SellerResearch, 'offers' | 'unresolved'>): string[] {
  const names = new Set((r.unresolved ?? []).flatMap(u => u.names.map(holdName)))
  return r.offers.filter(o => names.has(holdNameOf(o.name))).map(o => o.id)
}

// Which saved offer is THIS offer? Only a saved offer whose stored name equals this one's (the stored form, see offer-identity.ts) and that nothing else in either list
// resembles. Same name twice (either side), two names that agree through the stored width, or no counterpart: no binding, so nothing saved is applied.
function priorBindings(prior: SellerResearch | null | undefined, offers: { id: string; name: string; ambiguous: boolean }[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!prior?.offers?.length) return out
  for (const c of offers) {
    if (c.ambiguous) continue
    const k = storedKey(c.name)
    const ps = prior.offers.filter(p => storedKey(p.name) === k)
    // A saved id that more than one saved offer carries (the old 40-character id budget cut '...-2' back to the shared prefix, so such state cannot say whose
    // statements are whose) is no identity at all: hold.
    if (ps.length === 1 && prior.offers.filter(p => p.id === ps[0].id).length === 1 && offers.filter(x => storedKey(x.name) === k).length === 1) out.set(c.id, ps[0].id)
  }
  return out
}

// ---- reviewed corrections: keyed by offer, applied before anything is used for retrieval or ranking ----
export interface Correction { offer: string; hypothesis: string; action: 'confirm' | 'reject' | 'edit'; value?: string }
export function applyCorrections(r: SellerResearch, corrections: Correction[]): SellerResearch {
  const hyps = r.hypotheses.map(h => {
    const c = [...corrections].reverse().find(x => x.offer === h.offer && x.hypothesis === h.id)   // the latest answer wins; another offer's answer never matches
    if (!c) return h
    return c.action === 'reject' ? { ...h, status: 'rejected' as const } : c.action === 'edit' && c.value?.trim() ? { ...h, text: c.value.trim().slice(0, 160), status: 'reviewed' as const } : { ...h, status: 'reviewed' as const }
  })
  // A new explicit decision on the same statement ends the hold for THAT candidate only. A hold is persisted as a NAME, so offers sharing a name key (equal through the stored width, or the same
  // name listed twice) are one group that persisted state cannot tell apart: the group is released only when EVERY offer in it has its own explicit decision on that statement in this call.
  const decided = corrections.map(c => { const h = r.hypotheses.find(x => x.id === c.hypothesis && x.offer === c.offer); const o = r.offers.find(x => x.id === c.offer); return h && o ? { kind: h.kind, text: norm(h.text), raw: h.text, name: holdNameOf(o.name), offer: o.id } : null }).filter((x): x is { kind: HypKind; text: string; raw: string; name: string; offer: string } => !!x)
  const groupOf = (n: string) => r.offers.filter(o => holdNameOf(o.name) === n).map(o => o.id)
  const releasable = (u: Unresolved, n: string) => { const who = new Set(decided.filter(d => d.kind === u.kind && d.text === norm(u.text) && d.name === n).map(d => d.offer)); return groupOf(n).length > 0 && groupOf(n).every(id => who.has(id)) }
  // A whole-group entry (capacity overflow) stands for decisions that could not be kept one by one. Its rejected statements keep their identity (rej digests): a digest is resolved only by an
  // explicit decision on that same statement from EVERY offer carrying the name (never by absence, an empty call or a decision elsewhere). An `open` entry has no identifiable set: never released.
  // Once no digest is left, the name is released when no statement is left unreviewed.
  const unreviewed = (n: string) => groupOf(n).some(id => hyps.some(h => h.offer === id && h.kind !== 'offer' && (h.status === 'sourced' || h.status === 'hypothesis')))
  const decidedDigests = decided.map(d => ({ name: d.name, offer: d.offer, dg: rejDigest(d.name, d.kind, d.raw) }))
  const resolved = new Set(decidedDigests.filter(x => groupOf(x.name).every(id => decidedDigests.some(y => y.name === x.name && y.offer === id && y.dg === x.dg))).map(x => x.dg))
  const left: Unresolved[] = []
  for (const u of r.unresolved ?? []) {
    if (!u.whole) { const names = u.names.map(holdName).filter(n => !releasable(u, n)); if (names.length) left.push({ ...u, names }); continue }
    const rej = (u.rej ?? []).filter(d => !resolved.has(d)), rev = (u.rev ?? []).filter(d => !resolved.has(d))
    const names = u.names.map(holdName).filter(n => u.open || [...rej, ...rev].some(d => d.startsWith(`${holdTag(n)}.`)) || unreviewed(n))
    if (!names.length) continue
    const tags = new Set(names.map(holdTag)), keepR = rej.filter(d => tags.has(d.split('.')[0])), keepV = rev.filter(d => tags.has(d.split('.')[0]))
    const { rej: _a, rev: _b, ...base } = u; void _a; void _b
    left.push({ ...base, names, ...(keepR.length ? { rej: keepR } : {}), ...(keepV.length ? { rev: keepV } : {}) })
  }
  const { unresolved: _drop, ...rest } = r; void _drop
  return { ...rest, hypotheses: hyps, question: null, ...(left.length ? { unresolved: left } : {}) }
}
// What retrieval and ranking may use for ONE offer: sourced and reviewed statements only. Unsupported hypotheses, unknowns and rejected items are never targeting.
export function targetingFor(r: SellerResearch, offer: string): { who: string[]; industries: string[]; exclude: string[]; sizes: string[]; where: string[] } {
  // A held offer (an old decision of its name could not be attributed) fails closed: nothing the page or the model merely supports targets until the person reviews it; only what they reviewed does.
  const held = heldIds(r).includes(offer)
  const use = r.hypotheses.filter(h => h.offer === offer && (h.status === 'reviewed' || (!held && h.status === 'sourced')))
  const t = (k: HypKind) => [...new Set(use.filter(h => h.kind === k).map(h => h.text))]
  return { who: t('persona'), industries: t('industry'), exclude: t('disqualifier'), sizes: t('size'), where: t('location') }
}

// ---- bridge to the persisted icp shape (lib/scan/icp.ts) and the reviewed-draft merge (#379 acceptance) ----
import type { Icp, IcpResearch, ResearchedHyp } from './icp.ts'

export function toStored(r: SellerResearch): IcpResearch {
  return {
    v: 1, site: r.site, q: r.question, ans: r.answered ? { q: r.answered.question, o: r.answered.offer, ...(r.answered.text ? { t: r.answered.text } : {}) } : null,
    offers: r.offers.map(o => ({ i: o.id, n: o.name })),
    ...(r.unresolved?.length ? { u: r.unresolved.map(x => ({ n: x.names, k: x.kind, t: x.text, s: x.status, ...(x.whole ? { w: true as const } : {}), ...(x.rej?.length ? { r: x.rej } : {}), ...(x.rev?.length ? { v: x.rev } : {}), ...(x.open ? { o: true as const } : {}) })) } : {}),
    hyps: r.hypotheses.filter(h => h.status !== 'unknown').map(h => ({ i: h.id, o: h.offer, k: h.kind, t: h.text, s: h.status as ResearchedHyp['s'], u: h.url, q: h.quote, at: h.fetched_at })),
  }
}
export function fromStored(s: IcpResearch): SellerResearch {
  return {
    ...(s.u?.length ? { unresolved: s.u.map(x => ({ names: x.n.map(holdName), kind: x.k, text: x.t, status: x.s, ...(x.w ? { whole: true as const } : {}), ...(x.r?.length ? { rej: x.r } : {}), ...(x.v?.length ? { rev: x.v } : {}), ...(x.o ? { open: true as const } : {}) })) } : {}),
    site: s.site, question: s.q, answered: s.ans ? { question: s.ans.q, offer: s.ans.o, ...(s.ans.t ? { text: s.ans.t } : {}) } : null,
    pages: [], offers: s.offers.map(o => ({ id: o.i, name: o.n })),
    hypotheses: s.hyps.map(h => ({ id: h.i, offer: h.o, kind: h.k, text: h.t, status: h.s, url: h.u, quote: h.q, fetched_at: h.at })),
  }
}

const kindField = { persona: 'who', industry: 'industries', size: 'sizes', location: 'where', disqualifier: 'exclude' } as const
type DraftField = 'who' | 'industries' | 'sizes' | 'where' | 'exclude'
const exact = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && x === y }
const bindOffer = (offers: { id: string; name: string }[], offer: string): string | null => selectOffer(offers, offer, exact)

// The reviewed draft is the person's authority over the hypotheses (#379):
// - a hypothesis whose text appears EXACTLY (normalized) in the matching draft field is confirmed ('reviewed');
// - one the person previously confirmed and has now REMOVED from the draft is 'rejected': deleting it is an explicit
//   correction, and it stays rejected across recrawls;
// - one they never confirmed keeps its status: absence from the draft is NOT a rejection, because the person may
//   never have been shown it. A page-verified statement is never auto-rejected and never silently re-asked away.
// The effective profile is the draft VERBATIM - hypothesis text is never merged INTO the targeting fields; the one
// exception is rejection precedence below: an explicitly rejected statement's own exact text leaves the effective fields. Research
// feeds retrieval and ranking only through these truthful statuses and the person's own edits to the visible fields.
// Questions: choosing the play's offer answers ONLY the offer-selection question, and only when the offer binding is
// unambiguous. 'Who buys this?' is answered by the person's typed words (carried in the stored research), never inferred.
export function applyReviewedDraft(icp: Icp, offer: string, opts?: { reviewed?: boolean }): Icp {
  const stored = icp.research
  if (!stored) return icp
  const r = fromStored(stored)
  // reviewed: false = the profile is carried as stored (a saved business profile on a FIRST scan), NOT re-reviewed
  // for this play: presence in the visible fields is not a confirmation, removal is not a rejection, and the offer
  // question is not answered by the binding. Explicit rejections still strip their own text from the effective fields
  // below (that guarantee is about the person's past acts, not this request).
  const promote = opts?.reviewed !== false
  // Stable, unambiguous offer identity: the offer's stored NAME (an id alone never binds: two names can share a legacy id). Zero matches (the play's offer was not
  // found on the site read) or several ('SEO audit' vs 'SEO audit Pro', two offers with the same name) mean nothing
  // can be bound: no corrections, no answer, the draft passes through untouched.
  const oid = bindOffer(r.offers, offer)
  if (!oid) return icp
  const hyps = r.hypotheses.map(h => {
    if (h.offer !== oid) return h
    const field = kindField[h.kind as keyof typeof kindField] as DraftField | undefined
    if (!field) return h   // offer/pain statements carry evidence, not a draft field
    if (h.status === 'rejected') return h   // an explicit rejection is NEVER resurrected by matching field text
    if (!promote) return h
    const inDraft = icp[field].some(v => exact(v, h.text))
    if (inDraft) return h.status === 'reviewed' ? h : { ...h, status: 'reviewed' as const }
    if (h.status === 'reviewed') return { ...h, status: 'rejected' as const }
    return h
  })
  // Rejection precedence: a dismissed statement's exact text leaves the EFFECTIVE targeting for this play, so stale
  // field text cannot keep targeting a statement the person rejected. (The dismissed UI also removes the field text in
  // the same action; this is the server-side guarantee for any client.) The stored draft itself is the person's input
  // and is not rewritten here.
  const rejectedText = new Map<DraftField, Set<string>>()
  for (const h of hyps) {
    if (h.offer !== oid || h.status !== 'rejected') continue
    const field = kindField[h.kind as keyof typeof kindField] as DraftField | undefined
    if (!field) continue
    const l = rejectedText.get(field) ?? new Set<string>(); l.add(norm(h.text)); rejectedText.set(field, l)
  }
  const effective: Partial<Pick<Icp, DraftField>> = {}
  for (const [field, texts] of rejectedText) effective[field] = icp[field].filter(v => !texts.has(norm(v)))
  const answered = r.answered ?? (promote && r.question === OFFER_QUESTION ? { question: r.question, offer: oid } : null)
  return { ...icp, ...effective, research: toStored({ ...r, hypotheses: hyps, answered }) }
}
