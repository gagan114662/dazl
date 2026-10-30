// Source-capability matrix (#388): what each signal source supports, honestly. An advertised signal / market must be backed by a source that is BUILT and has
// source-to-qualified-lead evidence and negative fixtures; a worker-backed source whose worker is disconnected is UNAVAILABLE (never "0 opportunities"); a planned
// source is NOT BUILT. Defaults are enabled only on measured incremental usable yield. Access policy is explicit: authorized APIs / public pages / consented workers -
// nothing here scrapes around an access control. This file is the registry the UI and run report read; adding an adapter without an entry fails the test.
import type { AdvPlatform } from '../advanced/config.ts'

export type Access = 'open_api' | 'public_pages' | 'official_registry' | 'authorized_worker'
export type Status = 'shipped' | 'planned'
export type Proof = 'domain_or_registry_id' | 'name_and_place' | 'page_host' | 'author_handle' | 'none'
export interface Capability {
  id: string
  label: string
  status: Status
  signals: string[]                       // signal kinds it can surface
  markets: string[]                       // ISO country codes it genuinely covers; ['*'] = not market-specific
  languages: string[]
  refresh: string                         // how stale its data can be
  identityProof: Proof
  dateProof: 'published_date' | 'structured_posting_date' | 'registry_filing_date' | 'none'
  access: Access
  worker?: AdvPlatform | 'advanced'       // needs a connected worker
  license: string                         // terms it is used under
  failureReporting: string                // how a failure shows in the run report
  evidence: { liveSourceToLead: boolean; negativeFixtures: boolean; incrementalYield: number | null }   // measured; null = not measured
}

const reported = 'AdapterRun status ok|empty|error|timeout|partial in the run report'
export const MATRIX: Capability[] = [
  { id: 'rss', label: 'RSS / Atom feeds', status: 'shipped', signals: ['news', 'funding', 'launch'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'page_host', dateProof: 'published_date', access: 'open_api', license: 'feeds the user supplies', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'github', label: 'GitHub', status: 'shipped', signals: ['product_launch', 'hiring_signal'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'GitHub REST API terms', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'web', label: 'Web pages (reader)', status: 'shipped', signals: ['any'], markets: ['*'], languages: ['*'], refresh: 'per scan', identityProof: 'page_host', dateProof: 'published_date', access: 'public_pages', license: 'public pages, robots respected', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'v2ex', label: 'V2EX', status: 'shipped', signals: ['hiring_signal', 'discussion'], markets: ['CN'], languages: ['zh'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'V2EX public API', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'youtube', label: 'YouTube', status: 'shipped', signals: ['content', 'engagement'], markets: ['*'], languages: ['*'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'YouTube Data API terms', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'jobboards', label: 'Greenhouse / Lever / Ashby boards', status: 'shipped', signals: ['hiring_signal'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'domain_or_registry_id', dateProof: 'structured_posting_date', access: 'open_api', license: 'public ATS board APIs', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'sec-form-d', label: 'SEC Form D (US funding)', status: 'shipped', signals: ['funding'], markets: ['US'], languages: ['en'], refresh: 'daily filings', identityProof: 'domain_or_registry_id', dateProof: 'registry_filing_date', access: 'official_registry', license: 'SEC EDGAR fair-access policy', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'adv:social', label: 'Social workers (X, Reddit, Instagram, Facebook, Xiaohongshu, Bilibili)', status: 'shipped', signals: ['engagement', 'discussion'], markets: ['*'], languages: ['*'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'authorized_worker', worker: 'advanced', license: 'user consent + worker terms', failureReporting: 'worker disconnected = unavailable, never a zero', evidence: { liveSourceToLead: false, negativeFixtures: false, incrementalYield: null } },
  // Not built. Listed so the gap is visible, and so nothing can advertise them: each needs an authorized source, identity/date proof and a measured yield first.
  ...[
    ['registry-funding-regional', 'Regional company / funding registries', ['funding', 'new_company'], ['GB', 'DE', 'FR', 'SG', 'IN', 'BR'], 'official_registry', 'registry_filing_date'],
    ['local-openings-permits', 'Local openings and permits', ['expansion', 'new_location'], ['US', 'GB', 'CA', 'AU'], 'official_registry', 'registry_filing_date'],
    ['procurement-rfp', 'Procurement / RFP portals', ['rfp', 'procurement'], ['US', 'GB', 'EU'], 'official_registry', 'published_date'],
    ['leadership-changes', 'Leadership changes', ['leadership_change'], ['*'], 'public_pages', 'published_date'],
    ['first-party-careers', 'First-party careers pages', ['hiring_signal'], ['*'], 'public_pages', 'structured_posting_date'],
    ['authorized-engagement', 'Authorized topic / competitor engagement', ['engagement'], ['*'], 'authorized_worker', 'published_date'],
  ].map(([id, label, signals, markets, access, dateProof]): Capability => ({ id: id as string, label: label as string, status: 'planned', signals: signals as string[], markets: markets as string[], languages: ['*'], refresh: 'not built', identityProof: 'none', dateProof: dateProof as Capability['dateProof'], access: access as Access, license: 'to be decided with the source owner', failureReporting: 'not built', evidence: { liveSourceToLead: false, negativeFixtures: false, incrementalYield: null } })),
]
export const byId = (id: string) => MATRIX.find(c => c.id === id)

export type Availability = 'available' | 'unavailable' | 'not_built'
// unavailable = built but its worker/credential is not connected: reported as unavailable, never as "no opportunities".
export function availability(c: Capability, connected: { workers: ReadonlySet<string> }): Availability {
  if (c.status === 'planned') return 'not_built'
  return c.worker && !connected.workers.has(c.worker) ? 'unavailable' : 'available'
}
// Verified = the advertisement is backed: built, live source-to-lead evidence AND negative fixtures. Anything less must not be advertised as a working signal/market.
export const advertisable = (c: Capability) => c.status === 'shipped' && c.evidence.liveSourceToLead && c.evidence.negativeFixtures
// A default needs a measured positive incremental usable yield over the existing defaults; null (unmeasured) is never enough.
export const defaultEligible = (c: Capability) => advertisable(c) && c.evidence.incrementalYield !== null && c.evidence.incrementalYield > 0
export function coverage(): { signals: Map<string, string[]>; markets: Map<string, string[]> } {
  const signals = new Map<string, string[]>(), markets = new Map<string, string[]>()
  for (const c of MATRIX) if (advertisable(c)) { for (const s of c.signals) signals.set(s, [...(signals.get(s) ?? []), c.id]); for (const m of c.markets) markets.set(m, [...(markets.get(m) ?? []), c.id]) }
  return { signals, markets }
}
// What the run report says about one source for a scan: never "0" for something that did not run.
export function sourceStatusLine(c: Capability, a: Availability, run?: { status: string; evidence: number | null }): string {
  if (a === 'not_built') return `${c.label}: not built yet - no coverage claimed`
  if (a === 'unavailable') return `${c.label}: unavailable (worker not connected) - this is not "no opportunities"`
  if (!run) return `${c.label}: not selected for this scan`
  return run.status === 'ok' || run.status === 'empty' ? `${c.label}: ${run.status}, ${run.evidence ?? 0} items` : `${c.label}: ${run.status} - treat as a failure to read, not as an empty market`
}
