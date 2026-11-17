// The research engine's one contract (MISSION v2, LEAD_ENGINE=research; port of ~/work/proto/ai-research). Every part imports these
// types and nothing else defines them:
//   A  triggers.ts + hunt.ts     ResearchCase -> ResearchPlan -> Candidate[]
//   C  filter.ts + gate.ts       Candidate[] -> Candidate[] (filter scores kept), ResearchEvent[] -> ResearchEvent[] (gate verdict kept)
//   D  read-page.ts + verify.ts  Candidate -> ResearchEvent[]; (ResearchEvent, CompanyResearch) -> Verification -> VerifiedLead
//   G  company.ts                ResearchEvent -> CompanyResearch (site, sources, Person, emails)
//   E  sources/*.ts              more Candidate[] for hunt.ts (registries, permits, ATS boards: dated by construction)
//   F  person-first engagers     more Candidate[] for hunt.ts
// Rules every stage keeps (the prototype's, which invented nothing in 67 hand-checked leads):
//   - every fact carries a VERBATIM quote and the URL it was copied from; a quote is only ever checked against the opened page's text;
//   - a date is the page's own (date_quote on the page) unless its tier says otherwise; nothing is guessed;
//   - every stage records what it dropped and why (Funnel), so a scan shows "340 results -> 50 pages -> 27 companies -> 15 ready".

// ---------- input ----------
// One scan's question, from the tenant's GTM profile / ICP (or one matrix case). `where` and `category` are the plain names; the keyword
// lists are the matrix's place/category check words when known.
export interface ResearchCase {
  tenant: string
  jobId: string
  query: string                       // the seller's own words for who they want
  offer: string                       // what the seller sells
  seller?: string | null              // the seller's name or site line
  where: string                       // "Austin, Texas"
  category: string                    // "roofing contractors"
  whereKeywords?: string[]
  categoryKeywords?: string[]
  windowDays: number                  // the recency window; the prototype's 90
  today: string                       // YYYY-MM-DD, injected so tests are deterministic
}

// ---------- 1. understand (A: triggers.ts) ----------
export interface Trigger {
  id: string                          // 't1'...; 'ask' for the people-asking queries; a source adapter's own id (E/F) for theirs
  name: string
  why: string                         // why this event makes them need the seller NOW
  footprint: string                   // how it shows publicly
  queries: string[]                   // plain web-search queries, 4-9 words, with the place
  weight?: number                     // starts equal; learn.ts adjusts it from outcomes
  enabled?: boolean                   // the tenant can switch a trigger off
}
export interface ResearchPlan {
  persona: string
  decisionMakerTitles: string[]
  triggers: Trigger[]
  askingQueries: string[]
  source: 'model' | 'stored' | 'fallback'
}

// ---------- 2. hunt (A: hunt.ts; E/F add sources) ----------
// One search result or registry record that may be about a target business. `date` is the index's / registry's date, NOT a page-proven one.
export interface Candidate {
  url: string
  title: string
  snippet: string
  date: string | null                 // YYYY-MM-DD from the search index or the registry record
  triggerId: string
  query: string                       // the query (or source adapter) that found it
  via: 'tinyfish' | 'registry' | 'engager' | string
  dated?: 'registry'                  // E: the record itself is dated by construction (a permit's issue day, a Form D filing day)
  // C: filter.ts
  filter?: { trigger: number; place: number; category: number; kind: 'company' | 'news' | 'list' | 'other' | null; model: string } | null
  score?: number
  keep?: boolean
  dropped?: string | null             // why it was not read ('unopenable host', 'filter', 'host cap', 'syndicated copy', 'page budget')
}

// ---------- 3. read (D: read-page.ts) ----------
export interface PersonMention { name: string; title: string | null; quote: string }
// One trigger event a page states about one named business.
export interface ResearchEvent {
  company: string
  website: string | null              // as shown on the page
  pageIsCompanySite: boolean
  triggerId: string
  whatHappened: string                // the bare fact, <= 15 words
  whyNow: string                      // one sentence for the seller
  quote: string                       // VERBATIM, proves the event
  eventDate: string | null            // YYYY-MM-DD as the page states it
  dateQuote: string | null            // VERBATIM text on the page stating that date
  locationQuote: string | null
  people: PersonMention[]
  sourceUrl: string
  indexDate: string | null            // the Candidate's date (fallback tier only)
  foundBy: string                     // the Candidate's query
  // C: gate.ts (place and category, before paying for research)
  gate?: 'yes' | 'no' | 'unknown'
}

// ---------- 4. research the company (G: company.ts) ----------
export interface Source { id: string; url: string; text: string; kind: 'page' | 'snippet' }
export interface Person {
  name: string
  title: string | null
  sourceId: string                    // a Source.id
  quote: string                       // VERBATIM, names the person AND their role
  profileUrl: string | null
  from: 'research' | 'trigger article' | 'second look'
}
export interface CompanyResearch {
  site: string | null
  sources: Source[]
  person: Person | null
  location: { sourceId: string; quote: string } | null
  whatTheyDo: string | null
  emails: { email: string; url: string }[]   // published on the company's own pages only
}

// ---------- 5. verify (D: verify.ts) ----------
export type DateTier = 'page' | 'registry' | 'index'
export interface Verification {
  triggerLiteral: boolean             // the quote is literally on the opened source page
  triggerP: number | null             // second model: the excerpt supports the fact
  triggerOk: boolean
  date: string | null
  dateTier: DateTier | null           // page: date_quote found on the page and agrees; registry: a dated record; index: the search index only
  dateInWindow: boolean
  personOk: boolean
  personP: number | null
  personTier: 'page' | 'snippet' | null
  personUrl: string | null
  placeP: number | null
  categoryP: number | null
  placeCategoryOk: boolean
  ready: boolean                      // triggerOk && personOk && dateInWindow && dateTier in (page, registry) && placeCategoryOk
  why: string[]                       // every check that failed, in words
}

// The lead the store writes (scan/runner.ts INSERT via the research entry point): READY only when verification.ready.
export interface VerifiedLead {
  event: ResearchEvent
  company: CompanyResearch
  verification: Verification
}

// ---------- the funnel (every stage) ----------
export interface FunnelStage { stage: 'understand' | 'hunt' | 'filter' | 'read' | 'gate' | 'research' | 'verify'; in: number; out: number; dropped: Record<string, number>; seconds?: number; usd?: number }
export interface Funnel { stages: FunnelStage[] }
