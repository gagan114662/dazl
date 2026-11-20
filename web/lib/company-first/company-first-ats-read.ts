// Unmounted public ATS reader. All ports are trusted server implementations;
// do not accept receipts, policies, origins, or transports from request bodies.
import { atsPostingRef, atsRecord, atsRecordUrl, type AtsPostingRef } from '../sources/ats-posting.ts'

type Scope = Readonly<{ tenant: string; job: string; attempt: string }>
type Criteria = Readonly<{ roleKey: string; placeKey: string; event: 'hiring_posting'; from: string; through: string }>
type Target = Readonly<{ scope: Scope; companyKey: string; websiteOrigin: string }>
type Review = Readonly<{
  scope: Scope; version: string; expiresAtMs: number; companyKey: string; companyName: string; websiteOrigin: string;
  // Must be observed literally on the independently verified company's page.
  kind: 'observed_owned_link'; linkSource: string; literalPostingHref: string;
}>
type HttpResult = Readonly<{ status: number; finalUrl: string; body: string; truncated?: boolean }>
type DateProof = Readonly<{ kind: 'ats_first_published'; sourceUrl: string; day: string }>
type Rejection = 'disabled' | 'invalid_scope' | 'owned_link_unknown' | 'reservation_unavailable' |
  'unavailable' | 'record_unknown' | 'employer_unknown' | 'role_unknown' | 'place_unknown' |
  'date_unknown' | 'quote_unknown' | 'superseded_or_expired'
export type PublicAtsResult = Readonly<{ state: 'held'; reason: Rejection }> |
  Readonly<{ state: 'candidate'; companyKey: string; place: string; event: 'hiring_posting'; date: string; sourceUrl: string;
    quote: string; literalSourceText: string; dateProof: DateProof }>
export interface PublicAtsPorts {
  readCurrentOwnedLink: (target: Target, signal: AbortSignal) => Promise<Review | null>
  // Atomically validate exact attempt and receipt version, and admit this one
  // public read to the existing operation budget. No money or fallback is involved.
  authorizeAndReserve: (request: Readonly<{ target: Target; reviewVersion: string; signal: AbortSignal }>) => Promise<boolean>
  // The guarded HTTPS transport must enforce destination/IP policy, maxBytes,
  // deadline and redirect:error during the request. No credentials or cookies.
  readPublicJson: (request: Readonly<{ url: string; maxBytes: number; redirect: 'error'; signal: AbortSignal }>) => Promise<HttpResult | null>
  // Deterministic, already-reviewed canonical matchers (no transport). Unknown
  // modes, multiple places, inferred location and wrong entity must not match.
  matchesRole: (roleKey: string, exactTitle: string) => boolean
  matchesPlace: (placeKey: string, location: Readonly<{ literal: string; workplace: 'onsite' | 'unknown' }>) => boolean
}
const MAX_BYTES = 256_000
const MAX_ASHBY_ROWS = 128
const TIMEOUT_MS = 8_000
const text = (x: unknown, max: number): x is string =>
  typeof x === 'string' && !!x.trim() && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x)
const day = (x: unknown): x is string =>
  typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x
const row = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null
const fold = (x: string) => x.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')
function https(raw: unknown): URL | null {
  if (!text(raw, 500) || !raw.startsWith('https://') || /\\|\s/.test(raw)) return null
  try {
    const u = new URL(raw)
    return u.hostname.includes('.') && /[a-z]{2,}$/.test(u.hostname) && !u.username && !u.password && !u.port ? u : null
  } catch { return null }
}
function sameRef(url: unknown, ref: AtsPostingRef) {
  const u = https(url)
  const r = u && atsPostingRef(u.href)
  return !!r && r.kind === ref.kind && r.org === ref.org && r.id === ref.id
}
const sameScope = (a: Scope | undefined, b: Scope) => !!a && a.tenant === b.tenant && a.job === b.job && a.attempt === b.attempt
function within<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const abort = () => settle(undefined)
    const settle = (value: T | undefined) => { signal.removeEventListener('abort', abort); resolve(value) }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : work()).then(settle, () => settle(undefined))
  })
}
// Select a visible field without stripping or joining HTML fragments. A short
// title plus HTML-only description cannot support a quote and deliberately holds.
function visibleQuote(title: unknown, description: unknown): string | null {
  for (const field of [title, description]) {
    if (typeof field !== 'string' || field.length > 32_000 || /[<>]|&(?:#\w+|[a-z]+);/i.test(field)) continue
    const start = field.search(/\S/u)
    if (start < 0) continue
    const line = field.slice(start).split(/[\r\n]/, 1)[0].trimEnd()
    const sample = line.length <= 300 ? line : line.slice(0, line.slice(0, 301).lastIndexOf(' '))
    if (text(sample, 300) && sample.length >= 20) return sample
  }
  return null
}

export async function readPublicAtsSignal(
  policy: Readonly<{ enabled?: boolean; signal?: AbortSignal }>,
  supplied: Target, requested: Criteria, ports: PublicAtsPorts,
): Promise<PublicAtsResult> {
  const held = (reason: Rejection): PublicAtsResult => ({ state: 'held', reason })
  if (policy.enabled !== true) return held('disabled')
  const target = Object.freeze({ scope: Object.freeze({ tenant: supplied.scope.tenant, job: supplied.scope.job, attempt: supplied.scope.attempt }), companyKey: supplied.companyKey, websiteOrigin: supplied.websiteOrigin })
  const c = Object.freeze({ roleKey: requested.roleKey, placeKey: requested.placeKey, event: requested.event, from: requested.from, through: requested.through })
  if (![...Object.values(target.scope), target.companyKey, c.roleKey, c.placeKey].every(x => text(x, 200)) || c.event !== 'hiring_posting' ||
      https(target.websiteOrigin)?.origin !== target.websiteOrigin || !day(c.from) || !day(c.through) || c.from > c.through) return held('invalid_scope')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = policy.signal ? AbortSignal.any([policy.signal, timeout]) : timeout
  function compile(review: Review | null | undefined) {
    if (!review || review.kind !== 'observed_owned_link' || !sameScope(review.scope, target.scope) ||
        review.companyKey !== target.companyKey || review.websiteOrigin !== target.websiteOrigin ||
        !text(review.version, 200) || !Number.isSafeInteger(review.expiresAtMs) || review.expiresAtMs <= Date.now() || !text(review.companyName, 200)) return null
    const source = https(review.linkSource)
    const link = https(review.literalPostingHref)
    const ref = link && atsPostingRef(link.href)
    if (source?.origin !== target.websiteOrigin || !link || !ref) return null
    // No signed/attribution data is sent to the public ATS or returned as evidence.
    link.search = ''; link.hash = ''
    return { ref, link: link.href, name: review.companyName, version: review.version, expiresAtMs: review.expiresAtMs, witness: JSON.stringify([source.href, link.href, review.companyName, review.version, review.expiresAtMs]) }
  }
  const permit = compile(await within(signal, () => ports.readCurrentOwnedLink(target, signal)))
  if (signal.aborted) return held('superseded_or_expired')
  if (!permit) return held('owned_link_unknown')
  const admitted = await within(signal, () => ports.authorizeAndReserve(Object.freeze({ target, reviewVersion: permit.version, signal })))
  if (signal.aborted) return held('superseded_or_expired')
  if (admitted !== true) return held('reservation_unavailable')
  if (permit.expiresAtMs <= Date.now()) return held('superseded_or_expired')

  const api = atsRecordUrl(permit.ref)
  const response = await within(signal, () => ports.readPublicJson(Object.freeze({ url: api, maxBytes: MAX_BYTES, redirect: 'error', signal })))
  if (signal.aborted) return held('superseded_or_expired')
  if (!response || response.status !== 200 || response.finalUrl !== api || response.truncated ||
      typeof response.body !== 'string' || response.body.length > MAX_BYTES || new TextEncoder().encode(response.body).length > MAX_BYTES) return held('unavailable')
  let body: unknown
  try { body = JSON.parse(response.body) } catch { return held('record_unknown') }

  const kind = permit.ref.kind
  let job = row(body)
  if (kind === 'ashby') {
    const jobs = job?.jobs
    if (!Array.isArray(jobs) || jobs.length > MAX_ASHBY_ROWS) return held('record_unknown')
    const matches = jobs.map(row).filter(j =>
      !!j && ((typeof j.id === 'string' && j.id.toLowerCase() === permit.ref.id) || sameRef(j.jobUrl, permit.ref)))
    if (matches.length !== 1) return held('record_unknown')
    job = matches[0]
    if (!job || job.isListed !== true || !sameRef(job.jobUrl, permit.ref) ||
        (job.id !== undefined && (typeof job.id !== 'string' || job.id.toLowerCase() !== permit.ref.id))) return held('record_unknown')
    body = { jobs: [job] } // exact candidate only; never use suffix-only helper fallback across board rows
  }
  if (!job || job.closed === true || job.archived === true ||
      (job.status !== undefined && (typeof job.status !== 'string' || !/^(open|published|listed|active)$/i.test(job.status)))) return held('record_unknown')
  for (const claim of [job.company_name, job.companyName, job.employerName]) {
    if (claim !== undefined && claim !== null && (!text(claim, 200) || fold(claim) !== fold(permit.name))) return held('employer_unknown')
  }
  const record = atsRecord(body, permit.ref)
  if (!record || record === 'missing') return held('record_unknown')
  const title = kind === 'lever' ? job.text : job.title
  if (!text(title, 200)) return held('record_unknown')
  const locations = kind === 'lever' ? row(job.categories)?.allLocations : kind === 'ashby' ? job.secondaryLocations : undefined
  if (locations !== undefined && (!Array.isArray(locations) || locations.length > (kind === 'lever' ? 1 : 0) ||
      (locations.length === 1 && (typeof locations[0] !== 'string' || fold(locations[0]) !== fold(record.location))))) return held('place_unknown')
  const workplace = typeof job.workplaceType === 'string' ? job.workplaceType.toLowerCase() : ''
  if ((job.workplaceType !== undefined && !/^(onsite|on-site)$/.test(workplace)) || job.isRemote === true ||
      !text(record.location, 120) || /\b(remote|hybrid|multiple locations)\b/i.test(record.location) || /\b(remote|hybrid)\b/i.test(title)) return held('place_unknown')
  try {
    if (ports.matchesRole(c.roleKey, title) !== true) return held('role_unknown')
    if (ports.matchesPlace(c.placeKey, Object.freeze({ literal: record.location, workplace: workplace ? 'onsite' : 'unknown' })) !== true) return held('place_unknown')
  } catch { return held('record_unknown') }

  const quote = visibleQuote(title, kind === 'greenhouse' ? undefined : job.descriptionPlain)
  if (!quote) return held('quote_unknown')
  if (!day(record.posted) || record.posted < c.from || record.posted > c.through) return held('date_unknown')
  const checked = compile(await within(signal, () => ports.readCurrentOwnedLink(target, signal)))
  if (signal.aborted || !checked || checked.witness !== permit.witness) return held('superseded_or_expired')
  return { state: 'candidate', companyKey: target.companyKey, place: c.placeKey, event: c.event,
    date: record.posted, sourceUrl: permit.link, quote, literalSourceText: quote,
    dateProof: { kind: 'ats_first_published', sourceUrl: permit.link, day: record.posted } }
}
