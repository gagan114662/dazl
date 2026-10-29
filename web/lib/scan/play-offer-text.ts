// What the tenant sells, FOR ONE PLAY (#349): the pure rules, shared by the server (lib/scan/play-offer.ts) and the
// pages that show and choose a play's offer.
// The business profile (users.sells) is where a new play starts; each play
// keeps the offer its research and drafting are for. Home, campaign detail, the outreach drafts of a play and the
// drafting itself all read the effective offer from here, so they cannot disagree.
//
// The effective offer of a play, in order:
//   1. the offer reviewed for this play (scan_jobs.offer): set on the review step before the scan ran, or chosen
//      later to resolve a conflict;
//   2. otherwise the offer recorded when the play was created (scan_jobs.seller, a snapshot of the profile then:
//      "<sells> - <website>"), or, for a play created before snapshots, the tenant's current selling context: the
//      Memory positioning, else the business profile's offer (what drafting used before plays had their own).
// A conflict: the play's own request states an offer ("selling CRM setup to ...") that differs from (2). Then the play
// has no effective offer until the tenant chooses one, and drafting for it is refused. A play's recorded context is
// never rewritten except by that explicit choice for that play: an old play keeps the offer it was created with.
export const MAX_OFFER = 150

// The ONLY read failure that may be treated as "this play has no offer of its own": a database from before per-play
// offers (or before Memory), where the table or column does not exist yet. Any other failure (busy, locked, I/O, a lost
// connection) is not "no play": callers refuse or defer instead of falling back to the tenant-wide offer.
export function isMissingSchema(e: unknown): boolean {
  return /no such (table|column)|(relation|column) "?[\w.]+"? (of relation "?[\w.]+"? )?does not exist/i.test(e instanceof Error ? e.message : String(e))
}
export type OfferSource = 'play' | 'recorded' | 'profile' | 'request'
export type PlayOffer =
  | { offer: string; source: OfferSource; conflict: null }
  | { offer: null; source: 'conflict'; conflict: { stated: string; recorded: string } }
  | { offer: null; source: 'none'; conflict: null }

export const cleanOffer = (s: unknown): string => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_OFFER) : ''

// The offer a request states, if it states one. Only a positive seller assertion counts, and only at the start of a
// sentence or clause (after ",", ";", ":" or a dash), never words embedded in targeting or an exclusion:
//   "We sell / we're selling / I am offering / we provide <offer> to|for ..."   "Selling <offer> to ..."
//   "We sell <offer>." (the whole sentence)                                     "Offer: <offer>" / "Our product: <offer>"
// Plain targeting ("dental practices in NYC hiring a receptionist"), exclusions ("Exclude agencies selling CRM to
// founders.", "Do not target people selling services to dental practices.") and negations ("We don't sell to agencies.",
// "We are not selling hardware.") state none, and neither does "We sell to <buyers>" (a target, not an offer).
const SENTENCE_STOP = /[.!?;\n]/
const LEAD = String.raw`(?:^|[,;:\u2013\u2014]\s*|\s-\s*)(?:(?:hi|hello|note|fyi|also|and|but|so|ps)[,:]?\s+)?`
const SPEAKER = String.raw`(?:i|we|i'm|we're|i am|we are)\s+(?:sell|selling|offer|offering|provide|providing)`
const TO_FOR = new RegExp(`${LEAD}${SPEAKER}\\s+(.{3,150}?)\\s+(?:to|for)\\s+\\S`, 'i')
const SELLING_TO_FOR = new RegExp(`${LEAD}selling\\s+(.{3,150}?)\\s+(?:to|for)\\s+\\S`, 'i')
const BARE = new RegExp(`${LEAD}${SPEAKER}\\s+(.{3,150})$`, 'i')
const LABEL = new RegExp(`${LEAD}(?:(?:our|my)\\s+)?(?:offer|offering|product|service)s?\\s*:\\s*(.{3,150})$`, 'i')
// a capture that is a target ("to dental practices") or itself an exclusion is not an offer. Whole words only (an offer
// like "insurance", "inbound marketing", "attribution software" or "no-code tools" starts with the same letters); the
// one stem kept is exclud(e|es|ed|ing), since every form of it is an exclusion.
const NOT_AN_OFFER = /^(?:(?:to|for|into|in|at|within|only|except|no|not)(?![\p{L}\p{N}'’-])|exclud)/iu
export function statedOffer(query: string | null | undefined): string | null {
  const q = (query ?? '').replace(/[ \t]+/g, ' ').trim()
  if (!q) return null
  for (const sentence of q.split(SENTENCE_STOP).map(x => x.trim()).filter(Boolean)) {
    for (const p of [TO_FOR, SELLING_TO_FOR, LABEL, BARE]) {
      const m = p.exec(sentence)
      if (!m) continue
      const o = cleanOffer(m[1].replace(/^(?:our|my|a|an)\s+/i, ''))
      if (o.length >= 3 && !NOT_AN_OFFER.test(o)) return o
    }
  }
  return null
}

// The offer part of a recorded seller line "<sells> - <website>" (the website, a URL or a bare domain, dropped).
export function offerOfSeller(seller: string | null | undefined): string | null {
  const s = (seller ?? '').trim()
  if (!s) return null
  const m = /^(.*)\s-\s(\S+)$/.exec(s)
  const offer = m && /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(m[2]) ? m[1] : s
  return cleanOffer(offer) || null
}

// Two offers are the same only when they are the same text, ignoring case and spacing. Nothing else is normalized:
// word order, negation ("SEO but not PPC" / "PPC but not SEO"), exclusions and buyer qualifiers all carry meaning, so
// any other difference is a choice for the tenant, never inferred.
const exact = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
export function sameOffer(a: string, b: string): boolean {
  const x = exact(a), y = exact(b)
  return !!x && x === y
}

export function effectiveOffer(play: { offer?: string | null; seller?: string | null; query?: string | null }, profileSells: string | null | undefined): PlayOffer {
  const reviewed = cleanOffer(play.offer)
  if (reviewed) return { offer: reviewed, source: 'play', conflict: null }
  const recorded = offerOfSeller(play.seller)
  const base = recorded ?? (cleanOffer(profileSells) || null)
  const stated = statedOffer(play.query)
  if (stated && base && !sameOffer(stated, base)) return { offer: null, source: 'conflict', conflict: { stated, recorded: base } }
  if (base) return { offer: base, source: recorded ? 'recorded' : 'profile', conflict: null }
  if (stated) return { offer: stated, source: 'request', conflict: null }
  return { offer: null, source: 'none', conflict: null }
}

// The tenant's own selling context, for a play without an offer of its own (#349): the Memory positioning set in
// Settings, else what onboarding saved (users.sells), so nobody needs a second hidden form. Every drafting path (template,
// rewrite, follow-ups), scoring and the offer card read it through these two functions, so they cannot disagree.
export function tenantOffer(memoryPositioning: string | null | undefined, profileSells: string | null | undefined): string | null {
  return cleanOffer(memoryPositioning) || cleanOffer(profileSells) || null
}
// The offer a draft for a lead of this play states: the play's effective offer, with the tenant context as its base. A
// contested play refuses (offer_conflict). offer null and no refusal: there is nothing to state.
export type DraftOffer = { offer: string | null; refuse: 'offer_conflict' | null }
export function draftOffer(play: { offer?: string | null; seller?: string | null; query?: string | null } | null | undefined, tenant: string | null): DraftOffer {
  const e = effectiveOffer(play ?? {}, tenant ?? '')
  if (e.conflict) return { offer: null, refuse: 'offer_conflict' }
  return { offer: e.offer, refuse: null }
}
