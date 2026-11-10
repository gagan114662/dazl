// Source-capability matrix (#388): what each signal source supports, honestly. An advertised signal / market must be backed by a source that is BUILT and has
// source-to-qualified-lead evidence and negative fixtures; a worker-backed source whose worker is disconnected is UNAVAILABLE (never "0 opportunities"); a planned
// source is NOT BUILT. Defaults are enabled only on measured incremental usable yield. Access policy is explicit: authorized APIs / public pages / consented workers -
// nothing here scrapes around an access control. Consumers: GET /api/sources/capabilities (lib/sources/capability-report.ts, per-tenant availability) and the
// run report's source lines; adding an adapter without an entry fails the test. Worker platforms are one entry each and take their built / not-built status from
// PLATFORM_SUPPORT (lib/advanced/config.ts), so a platform nobody wrote an adapter for (Facebook, Xiaohongshu) is NOT BUILT, which is a different state from a built
// platform whose worker is disconnected (UNAVAILABLE).
import { ADV_PLATFORMS, PLATFORM_SUPPORT, type AdvPlatform } from '../advanced/config.ts'

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
  worker?: AdvPlatform                    // needs this connected worker platform
  credentialEnv?: string                  // needs this per-deployment credential (env var name); absent = unavailable, never a zero
  license: string                         // terms it is used under
  failureReporting: string                // how a failure shows in the run report
  evidence: { liveSourceToLead: boolean; negativeFixtures: boolean; incrementalYield: number | null }   // measured; null = not measured
  blocker?: string                        // planned only: what was evaluated and why it is not built
}

const reported = 'AdapterRun status ok|empty|error|timeout|partial in the run report'
// Evaluated for #388 (Nov 2026). Free / public sources only, robots and access controls respected: a source whose cited page cannot be re-read by the verifier
// would only produce held leads, and reading around a block is not allowed.
const BLOCKERS: Record<string, string> = {
  'registry-funding-regional': 'Norway is built (brreg). France annuaire-entreprises pages sit behind a bot wall (Incapsula); Finland YTJ pages render only with JavaScript; UK Companies House is built as companies-house (new_company only: it is the UK opening signal, needs a per-deployment API key). No paid provider.',
  'local-openings-permits': 'GB is covered by companies-house (new incorporation as the opening signal, owner decision on #764) and NO by brreg new_location. For US / CA / AU, city licence / permit open data (e.g. Chicago business licences on Socrata) has no public per-record page to cite and re-read.',
  'procurement-rfp': 'UK Find a Tender and Contracts Finder OCDS APIs are open, but their notice pages answer 403 to automated readers; CanadaBuys robots.txt disallows its notice pages; TED search is POST-only and its notice pages need JavaScript.',
  'leadership-changes': 'Register officer data gives current roles, not dated changes; a dated change needs history diffing that is not built.',
  'first-party-careers': 'lib/signals/careers-page.ts reads the careers page of a lead already found (hiring half only, undated); there is no discovery source.',
  'authorized-engagement': 'Needs a consented worker per platform; only the existing social workers exist.',
}

// One entry per worker platform. Built-ness comes from PLATFORM_SUPPORT, never from a label: unsupported = planned (not built) with the reason as its blocker.
const PLATFORM_LABEL: Record<AdvPlatform, string> = { x: 'X (Twitter)', reddit: 'Reddit', instagram: 'Instagram', facebook: 'Facebook', xiaohongshu: 'Xiaohongshu', bilibili: 'Bilibili', linkedin: 'LinkedIn' }
// Bilibili's worker keeps only Latin-script excerpts (session-worker latinUsable; the verifier strips CJK), so a Chinese-only result never enters
// evidence: it covers Latin-script text on a CN platform, not Chinese. Xiaohongshu is not built.
const PLATFORM_LANGS: Partial<Record<AdvPlatform, string[]>> = { xiaohongshu: ['zh'], bilibili: ['en'] }
// What the evidence a worker row produces actually carries. collectAdvanced keeps url/title/quote/date and drops the worker's author object, so no
// worker row proves identity by author handle. Instagram (profile results) and LinkedIn (feed posts) always return date null; X, Reddit and Bilibili
// return the post's own date (the X operator-index path keeps the search hit's date).
const PLATFORM_DATED: Partial<Record<AdvPlatform, boolean>> = { x: true, reddit: true, bilibili: true }
const PLATFORM_MARKETS: Partial<Record<AdvPlatform, string[]>> = { xiaohongshu: ['CN'], bilibili: ['CN'] }
export function workerEntries(support: Record<AdvPlatform, { supported: boolean; reason: string | null }> = PLATFORM_SUPPORT): Capability[] {
  return ADV_PLATFORMS.map((p): Capability => {
    const built = support[p]?.supported === true
    return {
      id: `adv:${p}`, label: `${PLATFORM_LABEL[p]} (authorized worker session)`, status: built ? 'shipped' : 'planned', signals: ['engagement', 'discussion'],
      markets: PLATFORM_MARKETS[p] ?? ['*'], languages: PLATFORM_LANGS[p] ?? ['*'], refresh: built ? 'per scan' : 'not built', identityProof: 'none', dateProof: built && PLATFORM_DATED[p] ? 'published_date' : 'none',
      access: 'authorized_worker', worker: p, license: built ? 'user consent + worker terms' : 'to be decided with the source owner',
      // Honest about where a failure shows today: connector_audit, not the scan run report (the runner lists only adv: sources that returned evidence).
      failureReporting: built ? 'worker disconnected = unavailable here, never a zero; per-scan outcome (ok|empty|disabled|no_consent|rate_limited|worker_error|unsupported) is recorded in connector_audit only - the scan run report does not list it yet' : 'not built',
      evidence: { liveSourceToLead: false, negativeFixtures: false, incrementalYield: null },
      ...(built ? {} : { blocker: support[p]?.reason?.trim() || 'adapter not built' }),
    }
  })
}
export const MATRIX: Capability[] = [
  { id: 'rss', label: 'RSS / Atom feeds', status: 'shipped', signals: ['news', 'funding', 'launch'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'page_host', dateProof: 'published_date', access: 'open_api', license: 'feeds the user supplies', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'github', label: 'GitHub', status: 'shipped', signals: ['product_launch', 'hiring_signal'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'GitHub REST API terms', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'web', label: 'Web pages (reader)', status: 'shipped', signals: ['any'], markets: ['*'], languages: ['*'], refresh: 'per scan', identityProof: 'page_host', dateProof: 'published_date', access: 'public_pages', license: 'public pages, robots respected', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'v2ex', label: 'V2EX', status: 'shipped', signals: ['hiring_signal', 'discussion'], markets: ['CN'], languages: ['zh'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'V2EX public API', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'youtube', label: 'YouTube', status: 'shipped', signals: ['content', 'engagement'], markets: ['*'], languages: ['*'], refresh: 'per scan', identityProof: 'author_handle', dateProof: 'published_date', access: 'open_api', license: 'YouTube Data API terms', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'jobboards', label: 'Greenhouse / Lever / Ashby boards', status: 'shipped', signals: ['hiring_signal'], markets: ['*'], languages: ['en'], refresh: 'per scan', identityProof: 'domain_or_registry_id', dateProof: 'structured_posting_date', access: 'open_api', license: 'public ATS board APIs', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'sec-form-d', label: 'SEC Form D (US funding)', status: 'shipped', signals: ['funding'], markets: ['US'], languages: ['en'], refresh: 'daily filings', identityProof: 'domain_or_registry_id', dateProof: 'registry_filing_date', access: 'official_registry', license: 'SEC EDGAR fair-access policy', failureReporting: reported, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'brreg', label: 'Norway business register (Enhetsregisteret): new businesses and new locations', status: 'shipped', signals: ['new_company', 'new_location'], markets: ['NO'], languages: ['nb', 'nn'], refresh: 'register updated daily; read per scan, last 60 days', identityProof: 'domain_or_registry_id', dateProof: 'registry_filing_date', access: 'official_registry', license: 'NLOD 2.0 open data (data.brreg.no, no key); entity pages on virksomhet.brreg.no (robots: Allow /)', failureReporting: `${reported}; a request outside its markets or industries is skipped_out_of_coverage, never empty`, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  { id: 'companies-house', label: 'UK Companies House: newly incorporated companies (local opening signal)', status: 'shipped', signals: ['new_company'], markets: ['GB'], languages: ['en'], refresh: 'register updated daily; read per scan, last 30 days (newest first, one page of up to 100 matches)', identityProof: 'domain_or_registry_id', dateProof: 'registry_filing_date', access: 'official_registry', credentialEnv: 'COMPANIES_HOUSE_API_KEY', license: 'Companies House API terms with the deployment\'s own free API key; Open Government Licence data; company pages on find-and-update.company-information.service.gov.uk (no robots.txt)', failureReporting: `${reported}; no key = credential_missing (unavailable, never empty); a request outside its markets or industries is skipped_out_of_coverage, never empty; a page that does not show the company, Active status and the same incorporation date is page_mismatch`, evidence: { liveSourceToLead: false, negativeFixtures: true, incrementalYield: null } },
  ...workerEntries(),
  // Not built. Listed so the gap is visible, and so nothing can advertise them: each needs an authorized source, identity/date proof and a measured yield first.
  ...[
    ['registry-funding-regional', 'Regional company / funding registries', ['funding', 'new_company'], ['GB', 'DE', 'FR', 'SG', 'IN', 'BR'], 'official_registry', 'registry_filing_date'],
    ['local-openings-permits', 'Local openings and permits', ['expansion', 'new_location'], ['US', 'CA', 'AU'], 'official_registry', 'registry_filing_date'],
    ['procurement-rfp', 'Procurement / RFP portals', ['rfp', 'procurement'], ['US', 'GB', 'EU'], 'official_registry', 'published_date'],
    ['leadership-changes', 'Leadership changes', ['leadership_change'], ['*'], 'public_pages', 'published_date'],
    ['first-party-careers', 'First-party careers pages', ['hiring_signal'], ['*'], 'public_pages', 'structured_posting_date'],
    ['authorized-engagement', 'Authorized topic / competitor engagement', ['engagement'], ['*'], 'authorized_worker', 'published_date'],
  ].map(([id, label, signals, markets, access, dateProof]): Capability => ({ id: id as string, label: label as string, status: 'planned', signals: signals as string[], markets: markets as string[], languages: ['*'], refresh: 'not built', identityProof: 'none', dateProof: dateProof as Capability['dateProof'], access: access as Access, license: 'to be decided with the source owner', failureReporting: 'not built', evidence: { liveSourceToLead: false, negativeFixtures: false, incrementalYield: null }, blocker: BLOCKERS[id as string] })),
]
export const byId = (id: string) => MATRIX.find(c => c.id === id)

export type Availability = 'available' | 'unavailable' | 'not_built'
// unavailable = built but its worker/credential is not connected: reported as unavailable, never as "no opportunities".
export function availability(c: Capability, connected: { workers: ReadonlySet<string>; credentials?: ReadonlySet<string> }): Availability {
  if (c.status === 'planned') return 'not_built'
  if (c.credentialEnv && !connected.credentials?.has(c.credentialEnv)) return 'unavailable'
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
  if (a === 'unavailable') return `${c.label}: unavailable (worker or credential not connected) - this is not "no opportunities"`
  if (!run) return `${c.label}: not selected for this scan`
  return run.status === 'ok' || run.status === 'empty' ? `${c.label}: ${run.status}, ${run.evidence ?? 0} items` : `${c.label}: ${run.status} - treat as a failure to read, not as an empty market`
}
