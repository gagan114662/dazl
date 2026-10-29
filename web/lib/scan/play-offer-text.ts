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
export type OfferSource = 'play' | 'recorded' | 'profile' | 'request'
export type PlayOffer =
  | { offer: string; source: OfferSource; conflict: null }
  | { offer: null; source: 'conflict'; conflict: { stated: string; recorded: string } }
  | { offer: null; source: 'none'; conflict: null }

export const cleanOffer = (s: unknown): string => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, MAX_OFFER) : ''

// The offer a request states, if it states one: "selling X to ...", "we sell X to ...", "I offer X for ...",
// "offer: X". Plain targeting ("dental practices in NYC hiring a receptionist") states none.
export function statedOffer(query: string | null | undefined): string | null {
  const q = (query ?? '').replace(/\s+/g, ' ').trim()
  if (!q) return null
  const pats = [
    /\b(?:i|we|i'm|we're|i am|we are)\s+(?:sell|selling|offer|offering|provide|providing)\s+(.{3,150}?)\s+(?:to|for)\s+\S/i,
    /\bselling\s+(.{3,150}?)\s+(?:to|for)\s+\S/i,
    /\b(?:offer|offering|product|service)\s*:\s*([^.;\n]{3,150})/i,
  ]
  for (const p of pats) {
    const m = p.exec(q)
    if (m) { const o = cleanOffer(m[1].replace(/^(?:our|my|a|an)\s+/i, '')); if (o.length >= 3) return o }
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

// Words that never change what an offer is. Everything else counts, including negations ("no", "without", "except")
// and buyer qualifiers ("for veterinary practices"): those are exactly the differences a tenant must decide.
const FILLER = new Set(['a', 'an', 'the', 'and', 'our', 'my', 'your'])
const offerWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !FILLER.has(w)).map(w => w.length > 3 ? w.replace(/s$/, '') : w)
// Two offers name the same thing only when they say the same words (order, case, punctuation, articles and plural
// endings aside). Any added, removed or replaced word is a difference to choose between, never a guess: a near match
// ("appointment software for dental practices" / "... for veterinary practices", "CRM setup and outbound consulting" /
// "CRM setup but no outbound consulting") is a different offer.
export function sameOffer(a: string, b: string): boolean {
  const wa = offerWords(a), wb = offerWords(b)
  if (!wa.length || !wb.length) return false
  const sa = [...new Set(wa)].sort().join(' '), sb = [...new Set(wb)].sort().join(' ')
  return sa === sb
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
