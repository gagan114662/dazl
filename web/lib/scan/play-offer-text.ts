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
// The first offer a text states: the offer, the rest of that sentence after it (buyers, "but not ..." clauses), and
// which sentence it was in.
type Found = { offer: string; tail: string; sentence: number; sentences: string[] }
function findOffer(text: string | null | undefined): Found | null {
  const q = (text ?? '').replace(/[ \t]+/g, ' ').trim()
  if (!q) return null
  const sentences = q.split(SENTENCE_STOP).map(x => x.trim()).filter(Boolean)
  for (const [i, sentence] of sentences.entries()) {
    for (const p of [TO_FOR, SELLING_TO_FOR, LABEL, BARE]) {
      const m = p.exec(sentence)
      if (!m) continue
      const o = cleanOffer(m[1].replace(/^(?:our|my|a|an)\s+/i, ''))
      if (o.length >= 3 && !NOT_AN_OFFER.test(o)) return { offer: o, tail: sentence.slice(m.index + m[0].indexOf(m[1]) + m[1].length).trim(), sentence: i, sentences }
    }
  }
  return null
}
export function statedOffer(query: string | null | undefined): string | null {
  return findOffer(query)?.offer ?? null
}

// The offer part of a recorded seller line "<sells> - <website>" (the website, a URL or a bare domain, dropped).
export function offerOfSeller(seller: string | null | undefined): string | null {
  const s = (seller ?? '').trim()
  if (!s) return null
  const m = /^(.*)\s-\s(\S+)$/.exec(s)
  const offer = m && /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(m[2]) ? m[1] : s
  return cleanOffer(offer) || null
}

// Whether two texts state the same offer (#349). Each is read as an offer statement with three parts:
//   offer     what is sold ("CRM setup"); text that states no offer ("appointment booking and reminder software", "We do
//             not sell hardware.", "We sell to dental practices.") is taken whole, as written
//   audience  who it is sold to: "to/for ..." after the offer, up to the first ",", "but", "except", "excluding" or
//             "without"
//   terms     everything else the text says: the rest of that sentence (", but not outbound consulting") and every other
//             sentence except a targeting instruction of a request ("Find London SaaS startups hiring.", "Exclude
//             agencies.", "Do not target ..."). Any further service assertion, in any wording ("We also offer payroll.",
//             "Selling payroll software to founders.", "Outbound consulting is unavailable.", "No outbound consulting."),
//             is a term, so text the parser does not understand is a difference, never silently dropped. A sentence
//             of its own counts as the audience only when it is exactly the other side's audience.
// Two statements are the same offer when the offers match, the terms match, and the audiences match or one side names
// none: "appointment booking and reminder software" and the saved "We sell appointment booking and reminder software to
// independent dental practices in New York City." are one offer (#349 live case). Only a missing audience is allowed:
// a different audience ("to veterinary practices"), or any withdrawn service or exclusion on one side only, is a
// difference. Exact text throughout, ignoring only case and spacing: no substring or word-set matching, no reordering.
const exact = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
// A targeting instruction of a request: an imperative naming the buyers to find or skip ("Find dental practices in
// NYC.", "Email founders who are hiring.", "Search for agencies that are growing.", "Do not target agencies.", "Skip
// chains."). Only a sentence that is DEMONSTRABLY one is ignored; everything else, including any statement about a
// service whose name starts with the same word ("Email marketing supports agencies.", "Contact enrichment costs
// credits."), is material, so an unknown wording is a conflict (fail closed) and never a silent match.
// Demonstrably: a targeting verb, then (after "for"/"to"/"out"/"only"/...) a buyer group (buyerGroup), and nothing after
// it except what tailOk can consume whole: the whole sentence is checked, never cut at a preposition. Each modifier
// must be provably descriptive (safeModifier), so a declarative sentence ("Email marketing won customers.") can never
// pass as an object. The lists only decide what may be ignored: a buyer, modifier or trailing phrase they do not know
// makes the sentence a term, never the other way round.
const IMPERATIVE = /^(?:(?:please|and|also|but)\s+)?(?:(?:do not|don['’]t|never)\s+)?(?:find|search|look|target|contact|reach|email|message|include|exclude|skip|avoid|ignore)\s+(.+)$/i
const LEADING = /^(?:(?:for|to|out|at|up|only|all|any|the|more|new|every|other)\s+)+/i
const BUYERS = new Set(('founders owners ceos ctos cfos cmos coos executives leaders managers directors heads teams companies businesses startups ' +
  'firms agencies consultancies consultants clinics practices dentists doctors physicians practitioners hospitals schools universities ' +
  'retailers stores shops restaurants brands organizations organisations nonprofits charities people prospects buyers customers vendors ' +
  'resellers chains contractors plumbers electricians landlords investors recruiters developers engineers marketers freelancers ' +
  'coaches therapists lawyers accountants manufacturers distributors wholesalers merchants sellers operators providers labs').split(' '))
// A modifier before the buyer noun is safe only when it is provably descriptive: a known describing word, the singular
// of a buyer noun ("restaurant owners", "clinic managers"), or a hyphenated -backed/-funded/-stage/-owned/-based/-sized/
// -led form ("VC-backed startups"). Any other word (a verb in any tense, a service name, an unknown word) means the
// sentence is not provably targeting, so it is material.
const SAFE_MODIFIERS = new Set(('independent dental medical veterinary local small large midsize mid-size early growing regional national ' +
  'family private b2b b2c saas smb enterprise seed series fast-growing high-growth').split(' '))
const singular = (w: string) => w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches') ? w.slice(0, -2) : w.replace(/s$/, '')
const BUYER_SINGULAR = new Set([...BUYERS].map(singular))
const safeModifier = (w: string) => {
  const x = w.toLowerCase()
  return SAFE_MODIFIERS.has(x) || BUYER_SINGULAR.has(x) || /^[a-z0-9]+-(?:backed|funded|stage|owned|based|sized|led)$/.test(x)
}
// One buyer group: at most three safe modifiers, a buyer noun, at most one -ing word ("dental practices", "SaaS startups
// hiring"). Returns how many words it used, or 0.
function buyerGroup(words: string[]): number {
  for (let n = Math.min(words.length, 5); n >= 1; n--) {
    const w = words.slice(0, n)
    const ing = n >= 2 && /ing$/i.test(w[n - 1]) && BUYERS.has(w[n - 2].toLowerCase())
    const head = ing ? w[n - 2] : w[n - 1]
    const mods = w.slice(0, ing ? n - 2 : n - 1)
    if (BUYERS.has(head.toLowerCase()) && mods.length <= 3 && mods.every(safeModifier)) return n
  }
  return 0
}
// What may follow the buyer group in a targeting instruction, each consumed whole; anything left over that is none of
// these (a predicate such as "cost extra" after "in Canada") makes the sentence material:
//   a place: in/at/from/near/across/within/around/outside/inside or "based in", then a verified place (PLACES:
//            "in New York City", "based in Leeds"), optionally after "the"
//   another buyer group after of/for/at/with ("owners of clinics") or after a list separator (", resellers and consultancies")
//   a short who/that clause: "who are hiring", "that are growing" (who/that, is/are, one -ing word)
const PLACE_PREP = /^(?:in|at|from|near|across|within|around|outside|inside|based in)$/i
// A place is verified, never inferred from capitalisation: a country or region name (from Intl.DisplayNames over the
// two-letter region codes), a US state, or a listed city or abbreviation, matched whole and ignoring case. An unknown
// place phrase is not provably targeting, so the sentence stays material.
const PLACES: Set<string> = (() => {
  const out = new Set<string>()
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    for (const x of A) for (const y of A) {
      try { const n = names.of(x + y); if (n && n !== x + y && !/unknown/i.test(n)) out.add(n.toLowerCase()) } catch { /* not a region code */ }
    }
  } catch { /* no Intl.DisplayNames: only the lists below */ }
  for (const p of ('alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|' +
    'kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|' +
    'new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|' +
    'tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|' +
    'new york city|nyc|los angeles|san francisco|bay area|silicon valley|chicago|boston|seattle|austin|denver|miami|atlanta|dallas|houston|' +
    'philadelphia|phoenix|san diego|portland|toronto|vancouver|montreal|london|manchester|leeds|birmingham|bristol|edinburgh|glasgow|' +
    'liverpool|dublin|paris|berlin|munich|amsterdam|madrid|barcelona|lisbon|stockholm|copenhagen|zurich|sydney|melbourne|auckland|' +
    'singapore|dubai|bangalore|mumbai|delhi|tel aviv|' +
    'us|usa|uk|eu|uae|emea|apac|latam|north america|europe|asia|africa|south america|oceania|the midwest|the bay area').split('|')) out.add(p)
  return out
})()
// how many words from the start of `words` name a known place (longest first), 0 if none
function placeLength(words: string[]): number {
  for (let n = Math.min(words.length, 5); n >= 1; n--) if (PLACES.has(words.slice(0, n).join(' ').toLowerCase())) return n
  return 0
}
function tailOk(words: string[]): boolean {
  if (!words.length) return true
  const [w0, w1] = [words[0].toLowerCase(), (words[1] ?? '').toLowerCase()]
  // a place
  const prepLen = w0 === 'based' && w1 === 'in' ? 2 : PLACE_PREP.test(w0) ? 1 : 0
  if (prepLen) {
    let k = prepLen
    if ((words[k] ?? '').toLowerCase() === 'the' && !placeLength(words.slice(k))) k++
    let n = placeLength(words.slice(k))
    // more verified places in a list: "in London, Leeds and Manchester"
    while (n) {
      k += n
      if (tailOk(words.slice(k))) return true
      const sep = words[k] === ',' ? (['and', 'or'].includes((words[k + 1] ?? '').toLowerCase()) ? 2 : 1) : ['and', 'or'].includes((words[k] ?? '').toLowerCase()) ? 1 : 0
      n = sep ? placeLength(words.slice(k + sep)) : 0
      if (n) k += sep
    }
  }
  // another buyer group
  const sepLen = w0 === ',' ? (['and', 'or'].includes(w1) ? 2 : 1) : ['and', 'or', 'of', 'for', 'at', 'with'].includes(w0) ? 1 : 0
  if (sepLen) {
    const n = buyerGroup(words.slice(sepLen))
    if (n && tailOk(words.slice(sepLen + n))) return true
  }
  // who/that are -ing
  if ((w0 === 'who' || w0 === 'that') && /^(?:is|are)$/.test(w1) && words.length === 3 && /ing$/i.test(words[2])) return true
  return false
}
function isTargeting(x: string): boolean {
  const m = IMPERATIVE.exec(x)
  if (!m) return false
  const words = m[1].replace(LEADING, '').replace(/,/g, ' , ').trim().split(/\s+/).filter(Boolean)
  const n = buyerGroup(words)
  return n > 0 && tailOk(words.slice(n))
}
const AUDIENCE = /^(?:to|for)\s+(.*?)(?=\s*(?:,|\bbut\b|\bexcept\b|\bexcluding\b|\bwithout\b)|$)/i
type Statement = { offer: string; audience: string; rest: string; others: string[] }
function statement(text: string): Statement {
  const f = findOffer(text)
  if (!f) return { offer: exact(text), audience: '', rest: '', others: [] }
  const tail = f.tail.trim()
  const a = AUDIENCE.exec(tail)
  const audience = a ? exact(a[1]) : ''
  const rest = exact((a ? tail.slice(a[0].length) : tail).replace(/^[\s,;:]+/, ''))
  // every other sentence is part of the offer statement unless it is a targeting instruction: a service assertion in
  // any wording ("Selling payroll software to founders.", "Outbound consulting is unavailable.") is never dropped
  const others = f.sentences.filter((x, i) => i !== f.sentence && !isTargeting(x.trim())).map(exact)
  return { offer: exact(f.offer), audience, rest, others }
}
// A side whose offer sentence names no audience may name it in a sentence of its own ("Independent dental practices
// in New York City. We sell ..."): that sentence is its audience only when it is exactly the other side's audience.
function withAudienceOf(x: Statement, y: Statement): Statement {
  if (x.audience || !y.audience || !x.others.includes(y.audience)) return x
  return { ...x, audience: y.audience, others: x.others.filter(o => o !== y.audience) }
}
const terms = (x: Statement) => [x.rest, ...x.others].filter(Boolean).join(' | ')
export function sameOffer(a: string, b: string): boolean {
  const x0 = statement(a), y0 = statement(b)
  const x = withAudienceOf(x0, y0), y = withAudienceOf(y0, x0)
  if (!x.offer || x.offer !== y.offer || terms(x) !== terms(y)) return false
  return !x.audience || !y.audience || x.audience === y.audience
}

export function effectiveOffer(play: { offer?: string | null; seller?: string | null; query?: string | null }, profileSells: string | null | undefined): PlayOffer {
  const reviewed = cleanOffer(play.offer)
  if (reviewed) return { offer: reviewed, source: 'play', conflict: null }
  const recorded = offerOfSeller(play.seller)
  const base = recorded ?? (cleanOffer(profileSells) || null)
  const stated = statedOffer(play.query)
  // the request's whole offer statement is compared (its buyers and seller negations too), not only the offer words
  if (stated && base && !sameOffer(play.query ?? '', base)) return { offer: null, source: 'conflict', conflict: { stated, recorded: base } }
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
