// Additive, unmounted proof adapter. A discovery name/URL is never authority.
import type { Candidate, CompanyFirstPorts, Scope } from './company-first-evidence.ts'
import type { HttpResult, SafeGet } from '../sources/types.ts'

type Query = Readonly<{ scope: Scope; candidateName: string; hintedOrigin: string; exactHintUrl: string }>
type Review = Readonly<{
  scope: Scope; version: string; expiresAtMs: number; candidateName: string; companyKey: string;
  basis: 'reviewed_company_origin' | 'independent_official_origin';
  // Both come from independent reviewed evidence, never from the discovery URL.
  origin: string; identityUrl: string;
  // Mandatory for a third-party discovery hint. Only an independent issuer can
  // assert that exact observed public source belongs to this reviewed company.
  hintBinding?: Readonly<{ kind: 'independently_reviewed_exact_hint'; exactHintUrl: string; companyKey: string }>;

}>
type Website = NonNullable<Awaited<ReturnType<CompanyFirstPorts['verifyWebsite']>>>
export type WebsiteProof = Readonly<{ state: 'verified'; site: Website }> |
  Readonly<{ state: 'held'; reason: 'disabled' | 'identity_unknown' | 'reservation_unavailable' | 'superseded_or_expired' }>
export interface WebsitePorts {
  // Read an unambiguous current company/origin assertion for this exact
  // attempt. A search result, self-asserted schema, or name match is not one.
  readIndependentOrigin: (query: Query, signal: AbortSignal) => Promise<Review | null>
  // Recheck the current review version and admit each individual GET.
  // At composition the core must not also reserve these physical GETs.
  authorizeAndReserve: (request: Readonly<{ scope: Scope; reviewVersion: string; exactUrl: string; kind: 'robots' | 'identity'; signal: AbortSignal }>) => Promise<boolean>
  // Bind existing sources/http safeGet (connect-time public IP guard, no
  // redirect, byte/time caps) in production. Never pass request credentials.
  read: SafeGet
  // Bind existing sitecrawl.parseRobots and fetch-page.htmlToText.
  parseRobots: (body: string, host: string) => { allows: (path: string) => boolean; delayMs: number }
  parsePage: (body: string) => { title: string }
}
const BODY_BYTES = 128_000
const TIMEOUT_MS = 8_000
// The same token used by the existing robots parser.
const UA = 'dazl-contact-check/1.0 (+https://dazl.ai)'
const small = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !!v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
const fold = (v: string) => v.normalize('NFC').toLowerCase().trim().replace(/\s+/g, ' ')
function publicHttps(v: unknown): URL | null {
  if (!small(v, 500) || !v.startsWith('https://') || /\\|\s/.test(v)) return null
  try {
    const parsed = new URL(v)
    return parsed.hostname.includes('.') && /[a-z]{2,}$/.test(parsed.hostname) && !parsed.port && !parsed.username && !parsed.password
      ? parsed : null
  } catch { return null }
}
const same = (a: Scope | undefined, b: Scope) => !!a && a.tenant === b.tenant && a.job === b.job && a.attempt === b.attempt
const validBody = (r: HttpResult | null | undefined): r is HttpResult =>
  !!r && !r.truncated && !r.location && typeof r.body === 'string' && r.body.length <= BODY_BYTES &&
  new TextEncoder().encode(r.body).length <= BODY_BYTES
function wait<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const abort = () => finish(undefined)
    const finish = (v: T | undefined) => { signal.removeEventListener('abort', abort); resolve(v) }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : work()).then(finish, () => finish(undefined))
  })
}
export async function verifyCompanyWebsite(
  policy: Readonly<{ enabled?: boolean; signal?: AbortSignal }>,
  suppliedScope: Scope, candidate: Candidate, ports: WebsitePorts,
): Promise<WebsiteProof> {
  const hold = (reason: Extract<WebsiteProof, { state: 'held' }>['reason']): WebsiteProof => ({ state: 'held', reason })
  if (policy.enabled !== true) return hold('disabled')
  const scope = Object.freeze({ tenant: suppliedScope.tenant, job: suppliedScope.job, attempt: suppliedScope.attempt })
  const name = candidate.name, exactHintUrl = candidate.hintUrl
  const hint = publicHttps(exactHintUrl)
  if (![scope.tenant, scope.job, scope.attempt, name].every(x => small(x, 200)) || typeof exactHintUrl !== 'string' || !hint) return hold('identity_unknown')
  const query = Object.freeze({ scope, candidateName: name, hintedOrigin: hint.origin, exactHintUrl })
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = policy.signal ? AbortSignal.any([policy.signal, timeout]) : timeout
  function compile(value: Review | null | undefined) {
    if (!value || !same(value.scope, scope) || value.candidateName !== name ||
        !['reviewed_company_origin', 'independent_official_origin'].includes(value.basis) ||
        !small(value.companyKey, 200) || !small(value.version, 200) || !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= Date.now()) return null
    const binding = value.hintBinding
    if ((value.origin !== hint?.origin || binding !== undefined) &&
        (!binding || binding.kind !== 'independently_reviewed_exact_hint' || binding.companyKey !== value.companyKey ||
          binding.exactHintUrl !== exactHintUrl)) return null
    const source = publicHttps(value.identityUrl)
    if (!source || source.origin !== value.origin || source.search || source.hash || source.pathname === '/robots.txt') return null
    return Object.freeze({ source, companyKey: value.companyKey, version: value.version, expiresAtMs: value.expiresAtMs,
      witness: JSON.stringify([value.origin, source.href, value.companyKey, value.version, value.basis, value.expiresAtMs, binding?.kind ?? null, binding?.exactHintUrl ?? null, binding?.companyKey ?? null]) })
  }
  const approved = compile(await wait(signal, () => ports.readIndependentOrigin(query, signal)))
  if (signal.aborted) return hold('superseded_or_expired')
  if (!approved) return hold('identity_unknown')
  async function get(kind: 'robots' | 'identity', url: URL) {
    if (!approved || signal.aborted || approved.expiresAtMs <= Date.now()) return { reserved: false }
    const admitted = await wait(signal, () => ports.authorizeAndReserve(Object.freeze({ scope, reviewVersion: approved.version, exactUrl: url.href, kind, signal })))
    if (admitted !== true || signal.aborted || approved.expiresAtMs <= Date.now()) return { reserved: false }
    const response = await wait(signal, () => ports.read(url.href, {
      signal, headers: { 'user-agent': UA }, accept: kind === 'robots' ? 'text/plain' : 'text/html,application/xhtml+xml',
    }))
    return { reserved: true, response }
  }
  const robots = await get('robots', new URL('/robots.txt', approved.source.origin))
  if (signal.aborted) return hold('superseded_or_expired')
  if (!robots.reserved) return hold('reservation_unavailable')
  const r = robots.response
  if (!validBody(r) || ![200, 404, 410].includes(r.status)) return hold('identity_unknown')
  if (r.status === 200) {
    try {
      const bot = ports.parseRobots(r.body, approved.source.hostname)
      // This tiny lane does not schedule delayed jobs; never violate a delay.
      if (bot.delayMs !== 0 || !bot.allows(approved.source.pathname)) return hold('identity_unknown')
    } catch { return hold('identity_unknown') }
  }
  const page = await get('identity', approved.source)
  if (signal.aborted) return hold('superseded_or_expired')
  if (!page.reserved) return hold('reservation_unavailable')
  const p = page.response
  if (!validBody(p) || p.status !== 200 || !/<(?:!doctype html|html\b|head\b|title\b)/i.test(p.body) ||
      /\b(?:captcha|verify you are (?:a )?human|access denied)\b/i.test(p.body.slice(0, 1_500))) return hold('identity_unknown')
  // Exact first-party title corroborates the independent assertion. Slugs,
  // substrings, mentions elsewhere, and self-asserted structured data alone
  // don't qualify. This intentionally holds ambiguous or branded-only titles.
  try {
    const cleanHead = p.body.slice(0, 24_000).replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template|iframe|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    const heads = [...cleanHead.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)]
    if (heads.length !== 1 || /<!--|<(script|style|noscript|template|iframe|textarea)\b/i.test(heads[0][1])) return hold('identity_unknown')
    const head = heads[0][1]
    const token = /\s+|<(?:meta|link|base)\b(?:[^<>"']|"[^<>"]*"|'[^<>']*')*>|<title\s*>[^<>]{1,600}<\/title\s*>/giy
    let titleTag: string | undefined
    while (token.lastIndex < head.length) {
      const part = token.exec(head)
      if (!part) return hold('identity_unknown')
      if (/^<title/i.test(part[0])) {
        if (titleTag) return hold('identity_unknown')
        titleTag = part[0]
      }
    }
    if (!titleTag) return hold('identity_unknown')
    const { title } = ports.parsePage(titleTag)
    if (!small(title, 300) || fold(title) !== fold(name)) return hold('identity_unknown')
  } catch { return hold('identity_unknown') }
  const checked = compile(await wait(signal, () => ports.readIndependentOrigin(query, signal)))
  if (signal.aborted || checked?.witness !== approved.witness) return hold('superseded_or_expired')
  return { state: 'verified', site: { status: 'verified', candidateName: name, companyKey: approved.companyKey,
    website: approved.source.origin, identitySource: approved.source.href } }
}
