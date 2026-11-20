// Unmounted pre-lead issuer. Provider/search hints propose a candidate; they
// never supply the independent record or establish an owner. No I/O defaults.
import { verifyCompanyWebsite, type WebsitePorts, type WebsiteProof } from './company-first-website-proof.ts'
import type { Candidate, Scope } from './company-first-evidence.ts'

export type CanonicalOffice = Readonly<{
  placeKey: string; countryKey: string; street: string; locality: string; region: string; postal: string; country: string
}>
type Binding = Readonly<{ issuerKey: string; jurisdictionKey: string; legalId: string }>
export type IndependentEntity = Readonly<{
  scope: Scope; reviewVersion: string; expiresAtMs: number; companyKey: string; legalName: string;
  legalIdentity: Binding; recordAuthorityOrigin: string; exactSourceRecordUrl: string;
  // The exact official website field in the independently attributable record.
  websiteField: string; exactOwnedIdentityUrl: string; exactLinkedHintUrl?: string;
  canonicalOffice?: CanonicalOffice;
}>
type ReviewQuery = Parameters<WebsitePorts['readIndependentOrigin']>[0]
type RecordLookup = ReviewQuery & Readonly<{ requiredPlaceKey?: string }>
export type OwnedIdentityBlock = Readonly<{
  // Offsets in the exact raw fetched document, anchored to this visible entity.
  start: number; end: number; legalName: string;
  legalIdentity?: Binding;
  office?: CanonicalOffice;
}>
export interface OriginIssuerPorts extends Omit<WebsitePorts, 'readIndependentOrigin'> {
  // Server-controlled allowlisted source/verification implementation, not a
  // lookup of provider guesses. Return no more than two independently resolved
  // records (two means ambiguous); legal ID, source provenance and website
  // field must already be independently checked. Return null if unsupported.
  readIndependentRecords: (query: RecordLookup, signal: AbortSignal) => Promise<readonly IndependentEntity[] | null>
  // Deterministic vetted parser/location resolver over this particular guarded
  // response only. Return visible, owner-labelled blocks; no script, HTML
  // joins, raw provider copy or client/branch/partner addresses. No network.
  readOwnedIdentityBlocks: (body: string, exactUrl: string) => readonly OwnedIdentityBlock[]
}
const short = (x: unknown, max = 200): x is string => typeof x === 'string' && !!x.trim() && x.length <= max && !/[\p{C}]/u.test(x)
const fold = (x: string) => x.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
const OMIT = { state: 'held', reason: 'identity_unknown' } as const
function publicUrl(value: unknown): URL | null {
  if (!short(value, 500) || !value.startsWith('https://') || /\s|\\/.test(value)) return null
  try {
    const url = new URL(value)
    return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) &&
      !url.username && !url.password && !url.port && url.href === value ? url : null
  } catch { return null }
}
const sameScope = (a: Scope | undefined, b: Scope) =>
  a?.tenant === b.tenant && a?.job === b.job && a?.attempt === b.attempt
function legalId(value: Binding | undefined): Binding | null {
  if (!value || ![value.issuerKey, value.jurisdictionKey].every(x => short(x, 100)) ||
      !short(value.legalId, 100) || value.legalId.trim().length < 3) return null
  return Object.freeze({ issuerKey: value.issuerKey, jurisdictionKey: value.jurisdictionKey, legalId: value.legalId })
}
const sameId = (a: Binding, b: Binding) => a.issuerKey === b.issuerKey && a.jurisdictionKey === b.jurisdictionKey && a.legalId === b.legalId
function canonicalOffice(value: CanonicalOffice | undefined): CanonicalOffice | null {
  if (!value || ![value.placeKey, value.countryKey, value.street, value.locality, value.region, value.postal, value.country].every(x => short(x))) return null
  return Object.freeze({ placeKey: value.placeKey, countryKey: value.countryKey, street: value.street, locality: value.locality, region: value.region, postal: value.postal, country: value.country })
}
function sameOffice(a: CanonicalOffice, b: CanonicalOffice): boolean {
  return a.placeKey === b.placeKey && a.countryKey === b.countryKey &&
    (['street', 'locality', 'region', 'postal', 'country'] as const).every(k => fold(a[k]) === fold(b[k]))
}
function literalIn(block: string, value: string): boolean {
  const text = fold(block)
  const needle = fold(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${needle}(?![\\p{L}\\p{M}\\p{N}])`, 'u').test(text)
}
function compile(records: readonly IndependentEntity[] | null, q: RecordLookup) {
  if (!Array.isArray(records) || records.length !== 1) return null
  const r: IndependentEntity | undefined = records[0]
  if (!r || !sameScope(r.scope, q.scope) || !short(r.companyKey) || !short(r.reviewVersion) ||
      !short(r.legalName) || fold(r.legalName) !== fold(q.candidateName) ||
      !Number.isSafeInteger(r.expiresAtMs) || r.expiresAtMs <= Date.now()) return null
  const id = legalId(r.legalIdentity)
  const office = canonicalOffice(r.canonicalOffice)
  if (!id || (r.canonicalOffice !== undefined && !office) || (q.requiredPlaceKey && office?.placeKey !== q.requiredPlaceKey)) return null
  const website = publicUrl(r.websiteField), identity = publicUrl(r.exactOwnedIdentityUrl), record = publicUrl(r.exactSourceRecordUrl)
  if (!website || website.search || website.hash || !identity || identity.origin !== website.origin || identity.search || identity.hash ||
      !record || record.origin !== r.recordAuthorityOrigin || record.origin === website.origin || record.pathname === '/' ||
      (website.origin !== q.hintedOrigin && r.exactLinkedHintUrl !== q.exactHintUrl) ||
      (r.exactLinkedHintUrl !== undefined && r.exactLinkedHintUrl !== q.exactHintUrl)) return null
  const candidateName = q.candidateName
  const snapshot = Object.freeze({ recordUrl: record.href, websiteField: website.href, companyKey: r.companyKey, legalName: r.legalName,
    id, office, reviewVersion: r.reviewVersion, expiresAtMs: r.expiresAtMs, identityUrl: identity.href,
    hint: r.exactLinkedHintUrl, origin: website.origin, candidateName })
  return Object.freeze({ ...snapshot, witness: JSON.stringify(snapshot) })
}

export async function issueCompanyFirstWebsite(
  policy: Readonly<{ enabled?: boolean; signal?: AbortSignal }>,
  scope: Scope, candidate: Candidate, requiredPlaceKey: string | undefined, ports: OriginIssuerPorts,
): Promise<WebsiteProof> {
  if (policy.enabled !== true) return { state: 'held', reason: 'disabled' }
  if (requiredPlaceKey !== undefined && !short(requiredPlaceKey)) return OMIT
  let initial: NonNullable<ReturnType<typeof compile>> | undefined
  let corroborated = false
  function confirms(body: string, exactUrl: string): boolean {
    if (!initial || typeof body !== 'string' || body.length > 128_000 || new TextEncoder().encode(body).byteLength > 128_000) return false
    // Multiple owner blocks are ambiguous in this small slice, even if one agrees.
    const blocks = ports.readOwnedIdentityBlocks(body, exactUrl)
    if (!Array.isArray(blocks) || blocks.length !== 1) return false
    const b: OwnedIdentityBlock | undefined = blocks[0]
    if (!b || !Number.isSafeInteger(b.start) || !Number.isSafeInteger(b.end) || b.start < 0 ||
        b.end <= b.start || b.end > body.length || b.end - b.start > 4096 || !short(b.legalName)) return false
    const literal = body.slice(b.start, b.end)
    if (fold(b.legalName) !== fold(initial.legalName) || !literalIn(literal, b.legalName)) return false
    const id = legalId(b.legalIdentity)
    const office = canonicalOffice(b.office)
    // Contradictory supplied identity/place is not rescued by another match.
    if (b.legalIdentity !== undefined && (!id || !sameId(id, initial.id) || !literalIn(literal, id.legalId))) return false
    const officeMatches = !!office && !!initial.office && sameOffice(office, initial.office) &&
      [office.street, office.locality, office.region, office.postal, office.country].every(x => literalIn(literal, x))
    if ((b.office !== undefined && initial.office && !officeMatches) || (requiredPlaceKey && !officeMatches)) return false
    return !!id || officeMatches
  }
  const verified = await verifyCompanyWebsite(policy, scope, candidate, {
    parsePage: ports.parsePage,
    parseRobots: ports.parseRobots,
    authorizeAndReserve: ports.authorizeAndReserve,
    async readIndependentOrigin(q, signal) {
      const query = Object.freeze({ ...q, ...(requiredPlaceKey ? { requiredPlaceKey } : {}) })
      const current = compile(await ports.readIndependentRecords(query, signal), query)
      if (!current || (initial && (!corroborated || current.witness !== initial.witness))) return null
      initial ??= current
      return Object.freeze({ scope: q.scope, version: initial.reviewVersion, expiresAtMs: initial.expiresAtMs,
        candidateName: q.candidateName, companyKey: initial.companyKey, basis: 'independent_official_origin',
        origin: initial.origin, identityUrl: initial.identityUrl,
        ...(initial.hint ? { hintBinding: Object.freeze({ kind: 'independently_reviewed_exact_hint' as const, exactHintUrl: initial.hint, companyKey: initial.companyKey }) } : {}),
      })
    },
    async read(url, options) {
      const response = await ports.read(url, options)
      if (url === initial?.identityUrl && response?.status === 200 && !response.truncated && !response.location && !options?.signal?.aborted) {
        try { corroborated = confirms(response.body, url) } catch { corroborated = false }
        if (!corroborated) return null
      }
      return response
    },
  })
  return verified.state === 'verified' && !corroborated ? OMIT : verified
}
