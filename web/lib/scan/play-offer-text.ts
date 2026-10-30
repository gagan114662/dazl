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
  // stated: the offer the request names instead (null when it only withdraws one); withdrawn: what it says is no longer sold
  | { offer: null; source: 'conflict'; conflict: { stated: string | null; recorded: string; withdrawn?: string } }
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
const IMPERATIVE = /^(?:(?:please|and|also|but|only|just)\s+)?((?:do not|don['’]t|never)\s+)?(find|search|look|target|contact|reach|email|message|include|exclude|skip|avoid|ignore)\s+(.+)$/i
const LEADING = /^(?:(?:for|to|out|at|up|only|all|any|the|more|new|every|other)\s+)+/i
const BUYERS = new Set(('founders owners ceos ctos cfos cmos coos executives leaders managers directors heads teams companies businesses startups ' +
  'firms agencies consultancies consultants clinics practices dentists doctors physicians practitioners hospitals schools universities ' +
  'retailers stores shops restaurants brands organizations organisations nonprofits charities people prospects buyers customers vendors ' +
  'resellers chains contractors plumbers electricians landlords investors recruiters developers engineers marketers freelancers ' +
  'coaches therapists lawyers accountants manufacturers distributors wholesalers merchants sellers operators providers labs').split(' '))
// What a request skips that is never a buyer (directories, job boards, franchises, competitors). Accepted only after an
// excluding verb ("Exclude ...", "Skip ...", "Do not target ..."): after "Include" or "Find", or in a plain description,
// "customer portals" or "marketplace listings" could name something sold, so the sentence stays material.
const EXCLUDABLE = new Set(('directories listings marketplaces aggregators franchises franchisees competitors suppliers networks associations ' +
  'portals boards brokers dealers intermediaries individuals students hobbyists governments municipalities').split(' '))
// Which grammars a tail may use: excl admits EXCLUDABLE nouns as buyer heads; narrow keeps the pre-#349-live tail
// (places, buyer lists, who/that -ing, hiring a role) for the withdrawal gate, which this change must not loosen.
type Mode = { excl: boolean; narrow: boolean }
const PLAIN: Mode = { excl: false, narrow: false }
const NARROW: Mode = { excl: false, narrow: true }
// A modifier before the buyer noun is safe only when it is provably descriptive: a known describing word, the singular
// of a buyer noun ("restaurant owners", "clinic managers"), or a hyphenated -backed/-funded/-stage/-owned/-based/-sized/
// -led form ("VC-backed startups"). Any other word (a verb in any tense, a service name, an unknown word) means the
// sentence is not provably targeting, so it is material.
const SAFE_MODIFIERS = new Set(('independent dental medical veterinary local small large midsize mid-size early growing regional national ' +
  'family private b2b b2c saas smb enterprise seed series fast-growing high-growth job').split(' '))
const singular = (w: string) => w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches') ? w.slice(0, -2) : w.replace(/s$/, '')
const BUYER_SINGULAR = new Set([...BUYERS].map(singular))
const safeModifier = (w: string) => {
  const x = w.toLowerCase()
  return SAFE_MODIFIERS.has(x) || BUYER_SINGULAR.has(x) || /^[a-z0-9]+-(?:backed|funded|stage|owned|based|sized|led)$/.test(x) || /^(?:multi|single)-[a-z]+$/.test(x)
}
// the modifiers may also include a verified place used as an adjective ("London SaaS startups", "New York dental
// practices"): a place phrase of any length from PLACES, never an unverified capitalised word
function modifiersOk(mods: string[]): boolean {
  let i = 0
  while (i < mods.length) {
    const p = placeLength(mods.slice(i))
    if (p) { i += p; continue }
    if (safeModifier(mods[i])) { i++; continue }
    return false
  }
  return true
}
// One buyer group: at most three safe modifiers, a buyer noun, at most one -ing word ("dental practices", "SaaS startups
// hiring"). Returns every length that parses, longest first ("startups hiring SDRs" may be "startups" + "hiring SDRs").
function buyerGroup(words: string[], excl = false): number[] {
  const out: number[] = []
  const isHead = (w: string) => BUYERS.has(w.toLowerCase()) || (excl && EXCLUDABLE.has(w.toLowerCase()))
  for (let n = Math.min(words.length, 5); n >= 1; n--) {
    const w = words.slice(0, n)
    const ing = n >= 2 && /ing$/i.test(w[n - 1]) && isHead(w[n - 2])
    const head = ing ? w[n - 2] : w[n - 1]
    const mods = w.slice(0, ing ? n - 2 : n - 1)
    if (isHead(head) && mods.length <= 4 && modifiersOk(mods)) out.push(n)
  }
  return out
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
    'brooklyn|manhattan|queens|the bronx|bronx|staten island|long island|jersey city|newark|westchester|stamford|white plains|' +
    'san jose|columbus|charlotte|indianapolis|jacksonville|fort worth|nashville|detroit|oklahoma city|las vegas|memphis|louisville|' +
    'baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|kansas city|mesa|omaha|raleigh|durham|minneapolis|st paul|tampa|orlando|' +
    'pittsburgh|cincinnati|cleveland|st louis|salt lake city|richmond|new orleans|buffalo|rochester|hartford|providence|boise|anchorage|' +
    'honolulu|scottsdale|san antonio|el paso|arlington|plano|irvine|oakland|berkeley|palo alto|mountain view|santa monica|pasadena|' +
    'sheffield|nottingham|leicester|cardiff|belfast|newcastle|brighton|oxford|cambridge|york|bath|coventry|southampton|reading|milton keynes|' +
    'ottawa|calgary|edmonton|mississauga|oakville|burlington|hamilton|waterloo|kitchener|victoria|winnipeg|quebec city|halifax|markham|brampton|' +
    'brisbane|perth|adelaide|canberra|wellington|christchurch|' +
    'singapore|dubai|bangalore|mumbai|delhi|tel aviv|' +
    'us|usa|uk|eu|uae|emea|apac|latam|north america|europe|asia|africa|south america|oceania|the midwest|the bay area').split('|')) out.add(p)
  return out
})()
// how many words from the start of `words` name a known place (longest first), 0 if none
function placeLength(words: string[]): number {
  for (let n = Math.min(words.length, 5); n >= 1; n--) if (PLACES.has(words.slice(0, n).join(' ').toLowerCase())) return n
  return 0
}
// A role being hired: an optional a/an/the, at most three role modifiers (a known one, a singular role noun as in "office
// manager", or a hyphenated form like "front-desk"), and a known role noun. Returns the words it used, or 0.
const ROLES = new Set(('coordinator receptionist manager assistant administrator admin engineer developer designer marketer recruiter ' +
  'salesperson sdr bdr ae rep representative nurse hygienist dentist technician accountant bookkeeper director head lead cfo cto ' +
  'coo cmo vp officer specialist analyst consultant agent operator associate executive').split(' '))
const ROLE_MODIFIERS = new Set('office sales marketing dental medical clinical senior junior first new full-time part-time account customer support operations finance front-desk'.split(' '))
const roleNoun = (w: string) => { const x = w.toLowerCase(); return ROLES.has(x) || (x.endsWith('s') && ROLES.has(x.slice(0, -1))) }
// wide (the targeting grammar): also "for a ... role", a count ("2 receptionists") and a possessive; the withdrawal
// gate (narrow) keeps the pre-#349-live form.
function roleLength(words: string[], wide = true): number {
  let k = 0
  if (wide && /^for$/i.test(words[0] ?? '')) k++
  if ((wide ? /^(?:a|an|the|their|its|your|our)$/i : /^(?:a|an|the)$/i).test(words[k] ?? '') || (wide && isNumber(words[k] ?? ''))) k++
  const start = k
  while (k < words.length && k - start <= 3) {
    if (roleNoun(words[k])) return wide && /^(?:role|roles|position|positions|job|jobs|opening|openings|vacancy|vacancies)$/i.test(words[k + 1] ?? '') ? k + 2 : k + 1
    const x = words[k].toLowerCase()
    if (!(ROLE_MODIFIERS.has(x) || ROLES.has(x) || /^[a-z]+-[a-z]+$/.test(x))) return 0
    k++
  }
  return 0
}
// The qualifiers a targeting instruction may carry after its buyer group (#349 live dental control: "with 1–5 locations
// that opened a new location or are hiring a receptionist in the last 90 days"). Each is a closed grammar of its own,
// consumed whole; a word none of them knows leaves the sentence material. None of them admits a sell verb, a price,
// a commercial term or a product name, so a request can never state a change of offer through one of them.
const NUMBER = /^\d{1,7}(?:[-–—]\d{1,7}|\+)?$|^\d{1,3}(?:st|nd|rd|th)$/i
const NUMBER_WORDS = new Set(('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen ' +
  'twenty thirty forty fifty sixty seventy eighty ninety hundred several multiple').split(' '))
const isNumber = (w: string) => NUMBER.test(w) || NUMBER_WORDS.has(w.toLowerCase())
// an amount in an event ("raised $2M", "raised 2 million"): a currency figure, or a number followed by a scale word
const MONEY = /^[$£€]?\d[\d,.]*[kmb]?$/i
const MONEY_WORDS = new Set('million millions billion thousand k m usd gbp eur cad aud dollars pounds euros'.split(' '))
// a size: "with 1–5 locations", "of 10-50 employees", "under 20 staff", "2+ locations", "between 5 and 50 people"
const SIZE_PREP = /^(?:with|having|of|under|over|above|below|between|from|about|around|approximately)$/i
const SIZE_NOUNS = new Set(('location locations office offices site sites branch branches store stores clinic clinics practice practices facility facilities ' +
  'employee employees staff people person persons seat seats member members fte ftes headcount chair chairs bed beds room rooms unit units ' +
  'truck trucks vehicle vehicles property properties door doors desk desks').split(' '))
function sizeLength(words: string[]): number {
  let k = 0
  if (SIZE_PREP.test(words[0] ?? '')) k++
  if (/^(?:at least|at most|up to|more than|fewer than|less than)$/i.test(`${words[k] ?? ''} ${words[k + 1] ?? ''}`)) k += 2
  if (!isNumber(words[k] ?? '')) return 0
  k++
  if (/^(?:to|and|-|–|—)$/i.test(words[k] ?? '') && isNumber(words[k + 1] ?? '')) k += 2
  const noun = (words[k] ?? '').toLowerCase()
  return SIZE_NOUNS.has(noun) || BUYERS.has(noun) || roleNoun(noun) ? k + 1 : 0
}
// a time window: "in the last 90 days", "within the past six months", "this year", "since 2025", "recently"
const PERIOD = /^(?:day|days|week|weeks|month|months|year|years|quarter|quarters)$/i
function timeLength(words: string[]): number {
  const w0 = (words[0] ?? '').toLowerCase(), w1 = (words[1] ?? '').toLowerCase()
  if (/^(?:recently|lately|currently|now|today|year-to-date|ytd)$/.test(w0)) return 1
  if (/^(?:this|last|past|next)$/.test(w0) && PERIOD.test(w1)) return 2
  if (w0 === 'since' && (/^\d{4}$/.test(w1) || /^(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/.test(w1))) return /^\d{4}$/.test((words[2] ?? '')) && !/^\d{4}$/.test(w1) ? 3 : 2
  let k = 0
  if (/^(?:in|within|over|during|from)$/.test(w0)) k++ // never "for": "for 3 months" reads as a contract length
  if ((words[k] ?? '').toLowerCase() === 'the') k++
  if (/^(?:last|past|previous|next|recent|first)$/i.test(words[k] ?? '')) k++
  else if (k === 0) return 0
  if (isNumber(words[k] ?? '')) k++
  return PERIOD.test(words[k] ?? '') ? k + 1 : 0
}
// a signal event the buyers went through: "that opened a new location", "or that raised seed funding", "launching a
// product". A relative pronoun or a list joiner, optional auxiliaries, an event verb, then only words that name what
// such an event is about (a round, a location, a product, a job, a role). Without a pronoun or joiner only an -ing verb
// right after the buyers qualifies ("startups raising seed funding"): "Customers also receive a new app." or
// "Practices launched a website." is a claim about them, so it stays material. Never won/bought/sold/paid/receive and
// never a commercial noun, so "bought payroll software from us" or "won customers" stays material.
const EVENT_VERBS = new Set(('open opened opening opens launch launched launching launches raise raised raising raises announce announced announcing announces ' +
  'post posted posting posts expand expanded expanding expands move moved moving moves relocate relocated relocating relocates acquire acquired acquiring acquires ' +
  'add added adding adds sign signed signing signs secure secured securing secures close closed closing closes ' +
  'start started starting starts grow grew growing grows double doubled doubling rebrand rebranded rebranding renovate renovated renovating remodel remodeled remodelled ' +
  'recruit recruited recruiting recruits appoint appointed appointing appoints promote promoted promoting partner partnered partnering merge merged merging ' +
  'register registered registering incorporate incorporated incorporating list listed listing').split(' '))
const EVENT_WORDS = new Set(('a an the their its another additional new second third fresh latest recent first more big major ' +
  'seed pre-seed series a b c d round rounds funding capital investment money venture vc angel grant grants ' +
  'location locations office offices clinic clinics site sites store stores branch branches practice practices facility facilities building buildings warehouse hq headquarters ' +
  'product products ' +
  'job jobs role roles position positions posting postings listing listings opening openings vacancy vacancies team teams department hire hires staff employees ' +
  'partnership partnerships award awards certification certifications license licenses licence licences permit permits expansion acquisition merger ipo exit ' +
  'publicly public').split(' '))
const AUX = /^(?:have|has|had|are|is|were|was|recently|just|newly|also|now|been|being)$/i
const EVENT_BASE = new Set('open launch raise announce post expand move relocate acquire add sign secure close start grow double rebrand renovate remodel recruit appoint promote partner merge register incorporate list'.split(' '))
function eventLengths(words: string[]): number[] {
  let k = 0, gated = false, pronoun = false, aux = false
  if (/^(?:,|and|or)$/i.test(words[k] ?? '')) { k++; gated = true }
  if (/^(?:that|who|which)$/i.test(words[k] ?? '')) { k++; gated = true; pronoun = true }
  if (gated) while (AUX.test(words[k] ?? '')) { k++; aux = true }
  const verb = (words[k] ?? '').toLowerCase()
  if (!EVENT_VERBS.has(verb)) return []
  if (!gated && !(k === 0 && /ing$/i.test(words[0]))) return []
  // "Customers, add a product." is an instruction to the seller, not an event: after a bare joiner only a past or
  // -ing form counts
  if (gated && !pronoun && !aux && EVENT_BASE.has(verb)) return []
  k++
  const out = [k]
  while (k < words.length) {
    const w = words[k].toLowerCase()
    if (EVENT_WORDS.has(w) || isNumber(w) || MONEY.test(w) || MONEY_WORDS.has(w)) { k++; out.push(k); continue }
    const role = roleLength(words.slice(k)); if (role) { k += role; out.push(k); continue }
    const buyer = buyerGroup(words.slice(k))[0]; if (buyer) { k += buyer; out.push(k); continue }
    break
  }
  return out.reverse()
}
// the lengths every qualifier grammar can consume from the start of `words` (longest first)
function qualifierLengths(words: string[], mode: Mode): number[] {
  const out = new Set<number>()
  const [w0, w1] = [(words[0] ?? '').toLowerCase(), (words[1] ?? '').toLowerCase()]
  // a place, or a list of verified places: "in London, Leeds and Manchester", "outside the UK"
  const prepLen = w0 === 'based' && w1 === 'in' ? 2 : PLACE_PREP.test(w0) ? 1 : 0
  if (prepLen) {
    let k = prepLen
    const the = (words[k] ?? '').toLowerCase() === 'the' && !placeLength(words.slice(k))
    if (the) k++
    let n = placeLength(words.slice(k))
    // a bare "us" is the country only after "the" ("in the US"); "from us" is the seller
    if (n === 1 && (words[k] ?? '').toLowerCase() === 'us' && !the) n = 0
    while (n) {
      k += n
      out.add(k)
      const sep = words[k] === ',' ? (['and', 'or'].includes((words[k + 1] ?? '').toLowerCase()) ? 2 : 1) : ['and', 'or'].includes((words[k] ?? '').toLowerCase()) ? 1 : 0
      n = sep ? placeLength(words.slice(k + sep)) : 0
      if (n) k += sep
    }
  }
  // another buyer group after a list separator or of/for/at/with
  const sepLen = w0 === ',' ? (['and', 'or'].includes(w1) ? 2 : 1) : ['and', 'or', 'of', 'for', 'at', 'with'].includes(w0) ? 1 : 0
  if (sepLen) for (const n of buyerGroup(words.slice(sepLen), mode.excl)) out.add(sepLen + n)
  // a size as a list item: "in New York City, 1-5 locations, hiring receptionists"
  if (!mode.narrow && w0 === ',') { const n = sizeLength(words.slice(1)); if (n) out.add(1 + n) }
  // who/that are -ing
  if ((w0 === 'who' || w0 === 'that') && /^(?:is|are)$/.test(w1) && /ing$/i.test(words[2] ?? '') && !EVENT_VERBS.has((words[2] ?? '').toLowerCase())) out.add(3)
  // hiring a role: "hiring a front-desk coordinator", "who are hiring SDRs", "or are hiring their first sales representative"
  let hireAt = 0
  if (w0 === 'hiring') hireAt = 1
  else if ((w0 === 'who' || w0 === 'that') && /^(?:is|are)$/.test(w1) && (words[2] ?? '').toLowerCase() === 'hiring') hireAt = 3
  else if (!mode.narrow && /^(?:,|and|or)$/.test(w0)) {
    if (w1 === 'hiring') hireAt = 2
    else if (/^(?:is|are)$/.test(w1) && (words[2] ?? '').toLowerCase() === 'hiring') hireAt = 3
    else if (/^(?:who|that)$/.test(w1) && /^(?:is|are)$/.test((words[2] ?? '').toLowerCase()) && (words[3] ?? '').toLowerCase() === 'hiring') hireAt = 4
  }
  if (hireAt) {
    const n = roleLength(words.slice(hireAt), !mode.narrow)
    if (n) {
      let k = hireAt + n
      out.add(k)
      // a list of roles: "an office manager or a receptionist"
      let sep = mode.narrow ? 0 : /^(?:,|and|or)$/.test((words[k] ?? '').toLowerCase()) ? (words[k] === ',' && /^(?:and|or)$/.test((words[k + 1] ?? '').toLowerCase()) ? 2 : 1) : 0
      while (sep) {
        const r = roleLength(words.slice(k + sep)); if (!r) break
        k += sep + r; out.add(k)
        sep = /^(?:,|and|or)$/.test((words[k] ?? '').toLowerCase()) ? (words[k] === ',' && /^(?:and|or)$/.test((words[k + 1] ?? '').toLowerCase()) ? 2 : 1) : 0
      }
    }
  }
  if (!mode.narrow) {
    const size = sizeLength(words); if (size) out.add(size)
    const time = timeLength(words); if (time) out.add(time)
    for (const n of eventLengths(words)) out.add(n)
  }
  return [...out].filter(n => n > 0).sort((a, b) => b - a)
}
// Whether `words` is wholly a sequence of qualifiers (memoised per start index: the grammars overlap, so a sentence
// is tried every way it parses, never only the greedy one).
function tailOk(words: string[], mode: Mode = PLAIN): boolean {
  const memo = new Map<number, boolean>()
  const from = (i: number): boolean => {
    if (i >= words.length) return true
    const hit = memo.get(i); if (hit !== undefined) return hit
    memo.set(i, false)
    const ok = qualifierLengths(words.slice(i), mode).some(n => from(i + n))
    memo.set(i, ok)
    return ok
  }
  return from(0)
}
// An output instruction of a request ("Show the dated evidence and an owner or practice manager contact.", "List the
// company, website and a named contact."): a reporting verb, then only words that name what to show (evidence, dates,
// sources, contacts, names, links), who (a buyer or role), or how many. A price, discount, term or product word is not
// among them, so "Show the dated evidence and our discount." stays material.
// Only reporting verbs: never give/provide/offer, which hand the buyers something and so can state an offer ("Provide
// dental practices with leads."). The object is a list of report items, each ending in a report noun; a buyer or role
// word may appear only as the modifier of a contact-type noun ("an owner or practice manager contact", "founder or
// head of sales contacts"), never as the object itself ("dental practices a new website" is not a report item).
const OUTPUT_IMPERATIVE = /^(?:(?:please|and|also|then|just)\s+)?(?:show|list|return|report|display|surface|cite|attach|output|include)(?:\s+(?:me|us))?\s+(.+)$/i
const OUTPUT_FILLER = new Set('a an the each every all any its their your our per of for with plus and or as well too also only'.split(' '))
const OUTPUT_ADJ = new Set(('dated verified direct primary named public recent relevant original exact full short brief one-line top best key main specific ' +
  'supporting matching confirmed cited linked clickable working valid current latest first second new decision-making').split(' '))
const REPORT_NOUNS = new Set(('evidence source sources contact contacts email emails phone phones number numbers date dates link links url urls name names ' +
  'title titles role roles summary summaries reason reasons excerpt excerpts snippet snippets signal signals proof address addresses domain domains linkedin ' +
  'profile profiles headcount size location locations detail details info information context note notes line lines page pages score scores fit rationale ' +
  'why result results timestamp timestamps publication article articles posting postings listing listings citation citations column columns field fields ' +
  'match matches explanation explanations description descriptions industry company website websites lead leads decision-maker decision-makers decisionmaker decisionmakers').split(' '))
// the report nouns a person or role may qualify: who the contact is, not what they get
const PERSON_NOUNS = new Set('contact contacts name names email emails phone phones number numbers title titles detail details profile profiles address addresses linkedin'.split(' '))
function isOutputInstruction(x: string): boolean {
  const m = OUTPUT_IMPERATIVE.exec(x)
  if (!m) return false
  const words = m[1].replace(/,/g, ' , ').trim().split(/\s+/).filter(Boolean).map(w => w.toLowerCase())
  if (!words.length) return false
  // every item (between commas) ends in a report noun, and a person/role word inside an item is followed, within that
  // item, by a person noun
  const items: string[][] = [[]]
  for (const w of words) { if (w === ',') items.push([]); else items[items.length - 1].push(w) }
  return items.every(item => {
    if (!item.length) return true
    if (!REPORT_NOUNS.has(item[item.length - 1])) return false
    // once a person or role word appears, the rest of the item names only that person (a role list, descriptive
    // words, and the person noun it ends in): "an owner or practice manager contact" yes, "dental practices a new
    // website and contact details" no, since a report noun in between is something handed to the buyers
    let person = false
    // a report noun is read as one first: "company" and "lead" are columns of the report, not people handed something
    const isWho = (w: string) => !REPORT_NOUNS.has(w) && (BUYERS.has(w) || BUYER_SINGULAR.has(w) || roleNoun(w) || ROLE_MODIFIERS.has(w))
    return item.every((w, i) => {
      if (isWho(w)) person = true
      if (!person) return OUTPUT_FILLER.has(w) || OUTPUT_ADJ.has(w) || REPORT_NOUNS.has(w) || NUMBER.test(w)
      // "owner or practice manager contact": a joiner inside the person joins person words; "a receptionist and a
      // contact" starts a second thing handed over, so it is not a report item
      if (w === 'and' || w === 'or') return isWho(item[i + 1] ?? '')
      return isWho(w) || OUTPUT_FILLER.has(w) || OUTPUT_ADJ.has(w) || PERSON_NOUNS.has(w)
    }) && (!person || PERSON_NOUNS.has(item[item.length - 1]))
  })
}
// A targeting instruction, a plain description of the buyers with no verb ("Independent dental practices in New
// York City hiring a front-desk coordinator."), or an output instruction: the same whole-sentence grammars either way,
// so a sentence is ignored only when every word of it is a buyer group, a verified place, a size, a time window, a
// recognised hiring or event qualifier, a list of these, or what to show.
function isTargeting(x: string): boolean {
  if (isOutputInstruction(x)) return true
  const m = IMPERATIVE.exec(x)
  const body = m ? m[3].replace(LEADING, '') : x
  // EXCLUDABLE nouns only after an excluding verb or a negated one ("Do not target directories.")
  // ... or a negated targeting verb ("Do not target directories."); never a negated include/find, which narrows the offer
  const mode: Mode = { excl: !!m && (/^(?:exclude|skip|avoid|ignore)$/i.test(m[2]) || (!!m[1] && /^(?:target|contact|reach|email|message)$/i.test(m[2]))), narrow: false }
  // parentheses only group ("practices (1-5 locations)"); their content is parsed like any other words
  const words = body.replace(/[()]/g, ' ').replace(/,/g, ' , ').trim().split(/\s+/).filter(Boolean)
  return buyerGroup(words, mode.excl).some(n => tailOk(words.slice(n), mode))
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

// What a request says the seller no longer or does not sell ("We do not sell X.", "We no longer offer X.", "We are not
// selling X."), when it names an offer (not a target such as "to agencies"). Such a request contradicts any saved offer
// it might otherwise fall back to, so the play cannot silently use one: it waits for an explicit choice.
// Anywhere in the request (after "Note:", "As of May", ...): a seller subject, then a negated sell verb or a stop verb, then
// the rest of the clause up to a sentence end.
const WITHDRAWN = new RegExp(String.raw`\b(?:i|we|our (?:company|business|team|firm|agency|studio|shop)|the company|we['’]re|we['’]ve)\s+(?:(?:do not|dont|don['’]t|does not|doesnt|doesn['’]t|no longer|are not|are no longer|aren['’]t|is not|is no longer|isn['’]t|am not|will not|won['’]t|cannot|can['’]t)\s+(?:(?:currently|now|really|actually)\s+)?(?:sell|sells|selling|offer|offers|offering|provide|provides|providing)|used to (?:sell|offer|provide)|(?:have |has )?(?:stopped|ceased|quit)\s+(?:selling|offering|providing)|(?:have |has )?discontinued)\s+([^.!?;]{2,300})`, 'i')
// A replacement named in the same clause: a joiner (comma, colon, dash, or but/and/so/instead/now/only/just), then a sell
// verb ("..., we now sell X", "... but we do sell X", "... and instead offer X") or only/just/instead ("..., only X").
const SELL_CLAUSE = String.raw`(?:(?:but|and|so|instead|now)\s+)*(?:(?:i|we)\s+)?(?:(?:now|instead|only|do|also|just)\s+)*(?:sell|sells|offer|offers|provide|provides)\s+`
const SPLIT = new RegExp(String.raw`(?:\s*[,:]\s*|\s+[-–—]\s+|\s+(?=(?:but|and|so|instead|now|only|just)\s))(?=${SELL_CLAUSE}|(?:(?:but|and)\s+)?(?:only|just|instead)\s+)`, 'i')
const REPLACEMENT_IN_CLAUSE = new RegExp(String.raw`^(?:${SELL_CLAUSE}|(?:(?:but|and)\s+)?(?:only|just|instead)\s+)(.+)$`, 'i')
// ... or the next clause or sentence, with a seller subject ("; instead we sell X", ". Now we sell X")
const REPLACEMENT_NEXT = /^[\s.;!?]+(?:(?:instead|now|but|so)\s*,?\s+)*(?:i|we)\s+(?:(?:now|instead|only|also|just|do)\s+)*(?:sell|sells|offer|offers|provide|provides)\s+([^.!?;]{2,150})/i
const offerText = (t: string) => {
  const o = cleanOffer(t.replace(/^(?:our|my|a|an|the)\s+/i, '').replace(/\s+(?:any ?more|anymore)\s*$/i, ''))
  return o.length >= 2 && !NOT_AN_OFFER.test(o) ? o : null
}
// What a request says is not (or no longer) sold, and the offer it names instead, if any.
export function readWithdrawal(query: string | null | undefined): { withdrawn: string; replacement: string | null } | null {
  const q = (query ?? '').replace(/\s+/g, ' ')
  const m = WITHDRAWN.exec(q)
  if (!m) return null
  const split = SPLIT.exec(m[1])
  const withdrawn = offerText(split ? m[1].slice(0, split.index) : m[1])
  if (!withdrawn) return null
  const inClause = split ? REPLACEMENT_IN_CLAUSE.exec(m[1].slice(split.index + split[0].length)) : null
  const next = inClause ? null : REPLACEMENT_NEXT.exec(q.slice(m.index + m[0].length))
  const r = inClause?.[1] ?? next?.[1]
  const replacement = r ? offerText(r) : null
  return { withdrawn, replacement: replacement && replacement.length >= 3 && !sameOffer(replacement, withdrawn) ? replacement : null }
}
export function withdrawnOffer(query: string | null | undefined): string | null {
  return readWithdrawal(query)?.withdrawn ?? null
}
// A withdrawal leaves the saved offer in place only when it is demonstrably a commercial-term exclusion unrelated to it:
// its object is commercial terms only (refunds, free trials, on-site training, ...), any complement is wholly a buyer or
// place audience (buyerGroup/tailOk: "to restaurants"), and no term word appears in the saved offer in any number
// ("warranties" against "warranty management software"). Any other object, complement or relation - a product named in
// other words ("scheduling tools"), a term qualified by a product ("support for payroll software"), an unparsed tail -
// keeps the play unresolved (fail closed).
const TERMS = new Set(['refund', 'discount', 'free', 'trial', 'guarantee', 'warranty', 'support', 'training', 'onboarding', 'onsite', 'contract',
  'long', 'term', 'payment', 'plan', 'credit', 'invoicing', 'return', 'exchange', 'shipping', 'delivery', 'international', 'weekend', 'phone', 'live',
  'chat', '247', 'custom', 'pricing', 'annual', 'monthly'])
// one word in any number: warranties/warranty, deliveries/delivery, classes/class, batches/batch, payments/payment
const fold = (w: string) => {
  const x = w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  if (x.length > 4 && x.endsWith('ies')) return `${x.slice(0, -3)}y`
  if (/(?:ss|sh|ch|x|z)es$/.test(x)) return x.slice(0, -2)
  if (x.length > 3 && x.endsWith('s') && !/(?:ss|us|is)$/.test(x)) return x.slice(0, -1)
  return x
}
const GENERIC = new Set(['we', 'sell', 'and', 'the', 'for', 'to', 'in', 'of', 'with', 'our', 'your', 'a', 'an', 'at', 'or', 'any', 'https', 'http', 'www'])
function unrelatedTermExclusion(withdrawn: string, saved: string): boolean {
  const words = withdrawn.replace(/,/g, ' , ').trim().split(/\s+/).filter(Boolean)
  let k = 0
  while (k < words.length && (TERMS.has(fold(words[k])) || (k > 0 && [',', 'and', 'or'].includes(words[k].toLowerCase())))) k++
  if (k === 0 || !TERMS.has(fold(words[k - 1]))) return false
  const tail = words.slice(k)
  // the pre-live-fix tail only (places, buyer lists, hiring a role): the #349 qualifier grammars must not loosen this gate
  const audience = !tail.length || (tail[0].toLowerCase() === 'to' ? buyerGroup(tail.slice(1)).some(n => tailOk(tail.slice(1 + n), NARROW)) : tailOk(tail, NARROW))
  if (!audience) return false
  const savedWords = new Set(saved.split(/[^\p{L}\p{N}]+/u).filter(w => w && !GENERIC.has(w.toLowerCase())).map(fold))
  return !words.slice(0, k).some(w => savedWords.has(fold(w)))
}
function withdrawsSaved(withdrawn: string, saved: string): boolean {
  return !unrelatedTermExclusion(withdrawn, saved)
}

export function effectiveOffer(play: { offer?: string | null; seller?: string | null; query?: string | null }, profileSells: string | null | undefined): PlayOffer {
  const reviewed = cleanOffer(play.offer)
  if (reviewed) return { offer: reviewed, source: 'play', conflict: null }
  const recorded = offerOfSeller(play.seller)
  const base = recorded ?? (cleanOffer(profileSells) || null)
  const stated = statedOffer(play.query)
  // a request that withdraws an offer never resolves to a saved one by default: explicit choice only
  const w = readWithdrawal(play.query)
  if (w && base && withdrawsSaved(w.withdrawn, base)) {
    const named = w.replacement ?? (stated && !sameOffer(stated, w.withdrawn) ? stated : null)
    return { offer: null, source: 'conflict', conflict: { stated: named, recorded: base, withdrawn: w.withdrawn } }
  }
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
