// Unmounted company-first evidence core. Ports are trusted server-side adapters,
// not request callbacks. A qualified signal is not a Ready or contact decision.
import { getDomain } from 'tldts'
import { isReviewedCompanySizePair } from './company-first-size-reader.ts'
import { isRecentCompanyFirstSignal } from './company-first-signal-freshness.ts'
import { atsPostingRef } from '../sources/ats-posting.ts'

export type Scope = Readonly<{ tenant: string; job: string; attempt: string }>
export type Stage = 'discover' | 'website' | 'signal'
export type CompanySizeBand = Readonly<{ min: number; max: number }>
// Produced by trusted exact-source adapters, never discovery text/model estimates.
// datasetKey identifies the original producer (syndication/mirrors share one key).
// observedDay is the date the source states for the count, not its fetch date.
export type CompanySizeFact = Readonly<{
  scope: Scope; companyKey: string; sourceUrl: string; datasetKey: string; observedDay: string;
  basis:'first_party_disclosure'|'independent_primary_record'; employees:CompanySizeBand
}>
export type Criteria = Readonly<{ category: string; place: string; event: string; from: string; through: string; companySize?:CompanySizeBand }>
export type Candidate = Readonly<{ name: string; hintUrl?: string }>
type Site = Readonly<{
  status: 'verified'; companyKey: string; candidateName: string; website: string; identitySource: string;
  // An exact posting href seen by the adapter on the verified first-party origin.
  posting?: Readonly<{ linkSource: string; postingUrl: string }>;
}>
type VerifiedSite = Readonly<{ companyKey: string; website: string; identitySource: string }>
type DateProof = Readonly<
  { kind: 'first_party_event_date'; sourceUrl: string; day: string; literalDate: string } |
  { kind: 'ats_first_published'; sourceUrl: string; day: string }
>
type Signal = Readonly<{
  companyKey: string; place: string; event: string; date: string;
  sourceUrl: string; quote: string; literalSourceText: string;
  // The trusted reader must tie the date to this exact event/record. A page's
  // crawl/update day or a date found elsewhere is never a valid date proof.
  dateProof: DateProof
}>
type Call<T> = Readonly<{ input: Readonly<T>; signal: AbortSignal }>
export type Reservation = Readonly<{ scope: Scope; stage: Stage; ordinal: number; signal: AbortSignal }>
export type SizeReadInput=Readonly<{scope:Scope;companyKey:string;websiteOrigin:string;target:CompanySizeBand}>
export interface CompanyFirstPorts {
  // Separate provider-free exact-source reader. Must own per-source
  // reservations and current, independent source identity verification.
  readCompanySize?: (call: Call<SizeReadInput>)=>Promise<readonly CompanySizeFact[]|null>
  // Must affirm the exact current authorized attempt and reserve its operation
  // before each transport. No provider payloads or credentials cross this port.
  reserveBeforeDispatch: (request: Reservation) => Promise<boolean>
  // Post-read current-attempt gate; unknown/unavailable is not affirmative.
  isCurrent: (scope: Scope) => Promise<boolean>
  // All metered ports must settle known actual before returning; on uncertain
  // usage reject (never return null/empty). Later stages then cannot dispatch.
  discover: (call: Call<Pick<Criteria, 'category' | 'place'>>) => Promise<readonly Candidate[]>
  verifyWebsite: (call: Call<Candidate>) => Promise<Site | null>
  verifyDatedSignal: (call: Call<{ companyKey: string; websiteOrigin: string; event: string; place: string; from: string; through: string; postingUrl?: string; companySize?:CompanySizeBand }>) => Promise<Signal | null>
}
export type Hold = 'identity_unknown' | 'duplicate_company' | 'signal_unknown' | 'size_unconfirmed' | 'reservation_unavailable'
export type Finding = Readonly<{ state: 'held'; reason: Hold; count: number }> |
  Readonly<{ name: string; state: 'signal_verified'; site: VerifiedSite; signal: Readonly<Omit<Signal, 'literalSourceText' | 'dateProof'>> }>
type SignalFinding = Extract<Finding, { state: 'signal_verified' }>
type AtsWitness = Readonly<{ scope: Scope; postingUrl: string; ownedLinkSource: string; firstPublishedDay: string; originalSignal:Signal }>
const issuedOwnSignals = new WeakMap<SignalFinding,Scope>()
// A first-party record branded only after the discovery attempt is rechecked.
export function isCoreVerifiedOwnFinding(finding:SignalFinding,scope:Scope):boolean{
  const bound=issuedOwnSignals.get(finding)
  return !!bound&&bound.tenant===scope.tenant&&bound.job===scope.job&&bound.attempt===scope.attempt
}
const issuedAts = new WeakMap<SignalFinding, AtsWitness>()

// Read-only provenance check. Only an original frozen finding published by a
// current core run can carry the external ATS exception; serialized copies,
// caller objects and different tenant/job/attempt scopes cannot inherit it.
export function isCoreVerifiedAtsFinding(finding: SignalFinding, scope: Scope): boolean {
  const witness = issuedAts.get(finding)
  return !!witness && witness.scope.tenant === scope?.tenant && witness.scope.job === scope?.job &&
    witness.scope.attempt === scope?.attempt && witness.postingUrl === finding.signal.sourceUrl &&
    witness.firstPublishedDay === finding.signal.date && url(witness.ownedLinkSource)?.origin === finding.site.website
}

// Internal protected bridge only: recover the exact stage object, not public
// report text or a reconstructed copy.
export function originalCoreAtsSignal(finding:SignalFinding,scope:Scope):Signal|undefined {
  return isCoreVerifiedAtsFinding(finding,scope)?issuedAts.get(finding)?.originalSignal:undefined
}

export type Report = Readonly<{
  state: 'disabled' | 'invalid' | 'discovery_unavailable' | 'superseded_or_expired' | 'checked';
  findings: readonly Finding[];
  observed?: Readonly<{
    discovered: number; website_verified: number; distinct_sites: number; signals_verified: number;
    dispatches: Readonly<Record<Stage, number>>; holds: Readonly<Partial<Record<Hold, number>>>;
  }>
}>
// Hard maxima for the entire attempt: one discovery, twenty website operations,
// twenty signal operations. Each still needs the common reservation and deadline. Each port must apply bounded, guarded HTTP inside its operation;
// this core does not grant per-host access or start delegated fallback work.
const MAX_CANDIDATES = 20
// An outer Finder deadline also applies; discovery/evidence may not monopolize the whole run.
const DEADLINE_MS = 4 * 60_000
const validText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !!v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
const day = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
function url(v: unknown): URL | null {
  if (!validText(v, 500) || !/^https:\/\//.test(v) || /\\|\s/.test(v)) return null
  try {
    const u = new URL(v)
    return u.hostname.includes('.') && /[a-z]{2,}$/.test(u.hostname) && !u.port && !u.username && !u.password
      ? u : null
  } catch { return null }
}
function within<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const stop = () => finish(undefined)
    const finish = (value: T | undefined) => { signal.removeEventListener('abort', stop); resolve(value) }
    signal.addEventListener('abort', stop, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : fn()).then(finish, () => finish(undefined))
  })
}

const MAX_SIZE_AGE_MS = 90 * 86_400_000
function validSizeBand(b: CompanySizeBand | null | undefined): b is CompanySizeBand {
  return !!b && Number.isSafeInteger(b.min) && Number.isSafeInteger(b.max) && b.min >= 0 && b.max >= b.min
}
function confirmsSize(facts: readonly CompanySizeFact[] | undefined, target:CompanySizeBand, scope:Scope, site:VerifiedSite, now:number):boolean {
  if (!Array.isArray(facts) || facts.length !== 2 || !isReviewedCompanySizePair(facts,now)) return false
  const owner = url(site.website)
  const domains = new Set<string>(), datasets = new Set<string>()
  let lower = target.min, upper = target.max, independent = false
  for (const f of facts) {
    const source = url(f?.sourceUrl), domain = source && getDomain(source.hostname,{allowPrivateDomains:true})
    if (!f || !source || source.search || source.hash || source.pathname==='/' || !domain || domains.has(domain) ||
        !validText(f.datasetKey,200) || datasets.has(f.datasetKey) || f.companyKey!==site.companyKey ||
        f.scope?.tenant!==scope.tenant || f.scope?.job!==scope.job || f.scope?.attempt!==scope.attempt ||
        !day(f.observedDay) || Date.parse(f.observedDay)>now || now-Date.parse(f.observedDay)>MAX_SIZE_AGE_MS ||
        !validSizeBand(f.employees) || f.employees.min<target.min || f.employees.max>target.max) return false
    const ownDomain = owner && getDomain(owner.hostname,{allowPrivateDomains:true})
    if (!ownDomain || (f.basis==='first_party_disclosure' ? source.origin!==site.website :
      f.basis!=='independent_primary_record' || domain===ownDomain)) return false
    independent ||= f.basis==='independent_primary_record'
    lower=Math.max(lower,f.employees.min); upper=Math.min(upper,f.employees.max)
    domains.add(domain); datasets.add(f.datasetKey)
  }
  return independent && lower<=upper
}

export async function runCompanyFirst(
  policy: Readonly<{ enabled?: boolean; signal?: AbortSignal }>,
  scope: Scope, criteria: Criteria, ports: CompanyFirstPorts,
): Promise<Report> {
  const empty = (state: Report['state']): Report => ({ state, findings: [] })
  if (policy.enabled !== true) return empty('disabled')
  const scopeSnapshot = Object.freeze({ tenant: scope.tenant, job: scope.job, attempt: scope.attempt })
  if (criteria.companySize!==undefined && !validSizeBand(criteria.companySize)) return empty('invalid')
  const companySize=criteria.companySize && Object.freeze({min:criteria.companySize.min,max:criteria.companySize.max})
  const c = Object.freeze({ category: criteria.category, place: criteria.place, event: criteria.event, from: criteria.from, through: criteria.through })
  if (!Object.values(scopeSnapshot).every(v => validText(v, 200)) ||
      ![c.category, c.place, c.event].every(v => validText(v, 200)) ||
      !day(c.from) || !day(c.through) || c.from > c.through) return empty('invalid')
  const timeout = AbortSignal.timeout(DEADLINE_MS)
  const signal = policy.signal ? AbortSignal.any([policy.signal, timeout]) : timeout
  let ordinal = 0
  let blocked = false
  const dispatches = { discover: 0, website: 0, signal: 0 }
  const run = async <T, R>(stage: Stage, input: Readonly<T>, port: (call: Call<T>) => Promise<R>) => {
    if (blocked) return { reserved: false, value: undefined }
    const allow = await within(signal, () => ports.reserveBeforeDispatch(Object.freeze({ scope: scopeSnapshot, stage, ordinal: ordinal++, signal })))
    if (allow !== true || signal.aborted) { blocked = true; return { reserved: false, value: undefined } }
    const value = await within(signal, () => {
      dispatches[stage]++
      return port(Object.freeze({ input: Object.freeze(input), signal }))
    })
    if (value === undefined) blocked = true
    return { reserved: true, value }
  }
  const first = await run('discover', { category: c.category, place: c.place }, ports.discover)
  if (signal.aborted) return empty('superseded_or_expired')
  if (!Array.isArray(first.value) || first.value.length > MAX_CANDIDATES) return empty('discovery_unavailable')
  // Snapshot and validate all discovery results before passing any downstream.
  // Duplicate names are conservatively held even when hints disagree.
  const candidates: Candidate[] = []
  for (const item of first.value as readonly Candidate[]) {
    if (!item || !validText(item.name, 200) || (item.hintUrl !== undefined && !url(item.hintUrl))) return empty('discovery_unavailable')
    const hint = url(item.hintUrl)
    // Do not pass discovery URL query strings/fragments into another provider stage.
    if (hint) { hint.search = ''; hint.hash = '' }
    candidates.push(Object.freeze({ name: item.name, ...(hint ? { hintUrl: hint.href } : {}) }))
  }
  const nameKey = (name: string) => name.trim().normalize('NFC').toLowerCase()
  const visited: { candidate: Candidate; site?: VerifiedSite; postingUrl?: string; postingLinkSource?: string; hold?: Hold }[] = []
  for (const candidate of candidates) {
    if (signal.aborted) return empty('superseded_or_expired')
    if (candidates.filter(x => nameKey(x.name) === nameKey(candidate.name)).length > 1) {
      visited.push({ candidate, hold: 'duplicate_company' }); continue
    }
    const { reserved, value } = await run('website', candidate, ports.verifyWebsite)
    const website = url(value?.website), authority = url(value?.identitySource)
    if (!value || value.status !== 'verified' || value.candidateName !== candidate.name || !validText(value.companyKey, 200) || !website || !authority || website.origin !== authority.origin) {
      visited.push({ candidate, hold: reserved ? 'identity_unknown' : 'reservation_unavailable' }); continue
    }
    const site = Object.freeze({ companyKey: value.companyKey, website: website.origin, identitySource: authority.href })
    const linkSource = url(value.posting?.linkSource), posting = url(value.posting?.postingUrl)
    const postingUrl = linkSource?.origin === site.website && posting && atsPostingRef(posting.href) ? posting.href : undefined
    visited.push({ candidate, site, postingUrl, postingLinkSource: postingUrl ? linkSource?.href : undefined })
  }
  const findings: Finding[] = []
  const pendingAts: [SignalFinding, AtsWitness][] = []
  const counts = new Map<Hold, number>()
  let distinctSites = 0
  const holdOne = (reason: Hold) => counts.set(reason, (counts.get(reason) ?? 0) + 1)
  for (const { candidate, site, postingUrl, postingLinkSource, hold } of visited) {
    if (signal.aborted) return empty('superseded_or_expired')
    if (!site) { holdOne(hold ?? 'identity_unknown'); continue }
    if (visited.filter(v => v.site && (nameKey(v.site.companyKey) === nameKey(site.companyKey) || v.site.website === site.website)).length > 1) {
      holdOne('duplicate_company'); continue
    }
    distinctSites++
    const { reserved, value } = await run('signal', {
      companyKey: site.companyKey, websiteOrigin: site.website, event: c.event, place: c.place,
      from: c.from, through: c.through, ...(postingUrl ? { postingUrl } : {}), ...(companySize ? { companySize } : {}),
    }, ports.verifyDatedSignal)
    const source = url(value?.sourceUrl)
    if (!reserved || !value || !source || (source.origin !== site.website && source.href !== postingUrl) ||
        value.companyKey !== site.companyKey || value.place !== c.place || value.event !== c.event ||
        !validText(value.quote, 300) || value.quote.length < 20 || typeof value.literalSourceText !== 'string' ||
        value.literalSourceText.length > 64_000 || !value.literalSourceText.includes(value.quote)) {
      holdOne(reserved ? 'signal_unknown' : 'reservation_unavailable'); continue
    }
    const proof = value.dateProof
    if (!isRecentCompanyFirstSignal(value.date) || value.date < c.from || value.date > c.through || !proof ||
        proof.day !== value.date || url(proof.sourceUrl)?.href !== source.href ||
        (source.origin === site.website ?
          proof.kind !== 'first_party_event_date' || !validText(proof.literalDate, 100) || !value.literalSourceText.includes(proof.literalDate) :
          proof.kind !== 'ats_first_published')) {
      holdOne('signal_unknown'); continue
    }
    const evidenceDay=value.date,evidenceQuote=value.quote,proofKind=proof.kind
    if(companySize){
      const read=ports.readCompanySize
      const facts=read&&await within(signal,()=>ports.isCurrent(scopeSnapshot))===true
        ? await within(signal,()=>read(Object.freeze({input:Object.freeze({scope:scopeSnapshot,companyKey:site.companyKey,
          websiteOrigin:site.website,target:companySize}),signal}))) : null
      if(!facts||!confirmsSize(facts,companySize,scopeSnapshot,site,Date.now())||
          await within(signal,()=>ports.isCurrent(scopeSnapshot))!==true){
        holdOne('size_unconfirmed');continue
      }
    }
    if(!isRecentCompanyFirstSignal(evidenceDay)){holdOne('signal_unknown');continue}
    const finding: SignalFinding = { name: candidate.name, state: 'signal_verified', site,
      signal: { companyKey: site.companyKey, place: c.place, event: c.event, date: evidenceDay, sourceUrl: source.href, quote: evidenceQuote } }
    Object.freeze(finding.signal)
    Object.freeze(finding)
    if (source.origin !== site.website && source.href === postingUrl && postingLinkSource && proofKind === 'ats_first_published') {
      pendingAts.push([finding, Object.freeze({ scope: scopeSnapshot, postingUrl, ownedLinkSource: postingLinkSource, firstPublishedDay: evidenceDay, originalSignal:value })])
    }
    findings.push(finding)
  }
  if (await within(signal, () => ports.isCurrent(scopeSnapshot)) !== true || signal.aborted) return empty('superseded_or_expired')
  for (const [finding, witness] of pendingAts) issuedAts.set(finding, witness)
  for(const finding of findings) if(finding.state==='signal_verified'&&
    url(finding.signal.sourceUrl)?.origin===finding.site.website)issuedOwnSignals.set(finding, scopeSnapshot)
  const signalsVerified = findings.length
  for (const [reason, count] of counts) findings.push({ state: 'held', reason, count })
  return { state: 'checked', findings, observed: { discovered: candidates.length, website_verified: visited.filter(v => !!v.site).length,
    distinct_sites: distinctSites, signals_verified: signalsVerified, dispatches, holds: Object.fromEntries(counts) } }
}
