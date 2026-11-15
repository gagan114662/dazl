// MISSION v2, part E: the signal-index sources the research engine's hunt (web/lib/research/hunt.ts, part A) reads besides web search.
// Each source returns records that are DATED BY CONSTRUCTION: the event date is a structured field the source itself publishes (a permit's
// issue date, a filing date, a posting's publish date), never a date read out of page text. That is why these records can be "ready"
// where search results could not (~/work/proto/SIGNAL_INDEX.md: Austin roofing 0 -> 43 ready, Chicago law 0 -> 23, at $0).
//
// A source never sees a tenant, a key or the database: it gets the market and a guarded HTTP getter, and returns public records.
// Mapping to the shared engine types (web/lib/research/types.ts, part A) is one function in hunt.ts; nothing here depends on them.
import type { SafeGet } from '../../sources/types.ts'

export interface Market {
  city: string          // "Austin"
  region: string        // "TX"
  country: string       // ISO code, "US"
  category: string      // the market's category key, "roofing"
}

export interface SourceSignal {
  source: string            // adapter id, e.g. 'socrata-permits:austin'
  company: string           // as the source names it, trimmed
  eventKind: string         // what the record proves, e.g. 'roofing_permits' (never relabelled as another signal)
  eventSummary: string      // one sentence a person can check against the source
  eventDate: string         // YYYY-MM-DD, the source's own structured date for the latest event
  eventCount: number        // how many such events the source holds for this company inside the window
  sourceUrl: string         // the public record of the latest event
  personName: string | null // a person the SOURCE names for this company (e.g. the contractor of record), never guessed
  personTitle: string | null  // what the source says that person is, stated as such ("contractor of record on the city permit")
  personSourceUrl: string | null
  phone: string | null
  city: string; region: string; country: string
  category: string
}

export interface SignalSource {
  id: string
  label: string
  // the markets this source can answer; a market it does not cover is not asked
  covers(market: Market): boolean
  // records dated inside [since, today], for one market
  collect(market: Market, since: string, http: SafeGet): Promise<{ signals: SourceSignal[]; notes: string[] }>
}
