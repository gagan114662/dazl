// Offline company-first contact proof. This module owns no transport, storage,
// lookup activation, display, outreach, or Ready decision. All supplied readers
// are proof adapters, not search engines: they must return observed public data.
import type { Finding, Scope } from './company-first-evidence.ts'

export interface OfficialDirectory {
  url: string
  // The vetted reader observed this exact link on a verified-origin page,
  // identifying the visible company team/directory structure on arrival.
  navigation: { sourceUrl: string; linkedUrl: string }
  // Visible, exact person/title pairs, each with its own published biography.
  people: readonly { name: string; title: string; bioUrl: string }[]
}
export interface OfficialBio {
  url: string
  name: string
  title: string
  company: string
  // Must be the bio's visible owned person block, not page-wide or hidden text.
  text: string
  // Explicitly person-labelled links within that exact bio block.
  profiles: readonly { url: string; named: string }[]
  // Independently classified direct personal publication within this same
  // owned visible block, not a shared, departmental, or page-wide address.
  publications: readonly { named: string; address: string; literalLine: string }[]
}
export interface PublicProfileCorroboration {
  url: string
  name: string
  title: string
  company: string
  current: boolean
}
export type ContactStage = 'directory' | 'bio' | 'profile'
type SignalFinding = Extract<Finding, { state: 'signal_verified' }>
export interface CompanyFirstContactReaders {
  // The trusted orchestrator must bind the completed core finding to this
  // exact scope; receiving a copied finding is not authority to look up people.
  isCurrent(scope: Scope, finding: SignalFinding): Promise<boolean>
  reserveBeforeDispatch(request: { scope: Scope; stage: ContactStage; signal: AbortSignal }): Promise<boolean>
  readDirectory(verifiedOrigin: string, signal: AbortSignal): Promise<OfficialDirectory | null>
  readBio(exactBioUrl: string, signal: AbortSignal): Promise<OfficialBio | null>
  corroborateProfile(exactAlreadyPublishedUrl: string, signal: AbortSignal): Promise<PublicProfileCorroboration | null>
}
type Hold = 'missing_signal_proof' | 'missing_requested_role' | 'directory_unavailable' | 'buyer_unconfirmed' |
  'bio_unconfirmed' | 'profile_unconfirmed' | 'email_unconfirmed' | 'contact_scope_unavailable'
export type CompanyFirstContactResult =
  | { status: 'held'; reason: Hold }
  | { status: 'contact_proof'; buyer: { name: string; title: string; bioUrl: string; linkedin: string }; published: { address: string; sourceUrl: string } }
const held = (reason: Hold): CompanyFirstContactResult => ({ status: 'held', reason })
const fold = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
const sane = (x: unknown, max = 120): x is string => typeof x === 'string' && x.length <= max && !!x.trim() && !/[\p{C}]/u.test(x)
const ordinaryTitle = (title: string) => !/\b(?:former|previously|retired|emeritus|past|resigned|ex[- ]|until)\b/i.test(title)
// Same unspaced full-name scripts admitted by the lead-person display rule.
const UNSPACED = /^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\u30FB]{2,20}$/u
const exactName = (name: unknown): name is string => sane(name) &&
  (UNSPACED.test(name.normalize('NFKC')) ||
    /^\p{L}[\p{L}\p{M}'’.\-]*(?: +\p{L}[\p{L}\p{M}'’.\-]*)+$/u.test(name.normalize('NFKC')))
function pageUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 500 || /[\s\\]/u.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) &&
      url.href === value ? url : null
  } catch { return null }
}
const LINKEDIN = /^https:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]{3,100}\/?$/
// Existing audited display mailbox veto, not an address generation rule.
const ROLE = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|inquiry|sales|business|office|admin|general|mail|team|support|help|press|media|partnerships|partners|bookings|booking|reservations|hola|contacto|kontakt|bonjour|ciao|ola|connect)$/i
const MAIL = /^[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}$/i
const LETTER_ADDRESS = /(?<![\p{L}\p{N}._%+@-])[a-z0-9]+(?:[._-][a-z0-9]+)*@[a-z0-9.-]+\.[a-z]{2,}(?![\p{L}\p{N}._%+@-])/giu
function parts(name: string): [string, string] | null {
  const words = name.trim().split(/\s+/).map(s => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, ''))
  const first = words[0], last = words.at(-1)
  return words.length >= 2 && !!first && first.length >= 2 && !!last && last.length >= 2 && first !== last ? [first, last] : null
}
function nameLocal(local: string, name: string): boolean {
  const pair = parts(name)
  if (!pair) return false
  const [first, last] = pair
  return [first + last, last + first, first[0] + last, first + last[0], last + first[0]].includes(local)
}
function literalNamedAddress(bio: OfficialBio, names: readonly string[], host: string, directory: OfficialDirectory): string | null {
  if (!Array.isArray(bio.publications) || bio.publications.length !== 1) return null
  const p = bio.publications[0]
  if (!p || !exactName(p.named) || fold(p.named) !== fold(bio.name) || !sane(p.address, 254) || !MAIL.test(p.address) ||
      !sane(p.literalLine, 400) || !bio.text.split(/\r?\n/).includes(p.literalLine)) return null
  const exactAddresses = p.literalLine.match(LETTER_ADDRESS)
  if (exactAddresses?.length !== 1 || exactAddresses[0] !== p.address) return null
  const [local, domain] = p.address.toLowerCase().split('@')
  const key = local.replace(/[._-]/g, '')
  if (domain !== host || ROLE.test(key) || !names.some(name => nameLocal(key, name))) return null
  if (directory.people.some(person => person && exactName(person.name) && fold(person.name) !== fold(bio.name) && nameLocal(key, person.name))) return null
  // An observed publication, not mailbox exclusivity/deliverability.
  return p.address
}
const dateOnly = (x: unknown) => typeof x === 'string' && /^\d{4}-\d\d-\d\d$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x

function bounded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise(resolve => {
    const abort = () => finish(undefined)
    const finish = (value: T | undefined) => { signal.removeEventListener('abort', abort); resolve(value) }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => signal.aborted ? undefined : operation()).then(finish, () => finish(undefined))
  })
}

export async function proveCompanyFirstContact(
  finding: Finding | null,
  requestedTitles: readonly string[],
  scope: Scope,
  readers: CompanyFirstContactReaders,
  signalFromCaller?: AbortSignal,
): Promise<CompanyFirstContactResult> {
  if (!finding || finding.state !== 'signal_verified') return held('missing_signal_proof')
  const { name: company, site, signal } = finding
  if (!sane(company) || !sane(site.companyKey) || site.companyKey !== signal.companyKey ||
      !dateOnly(signal.date) || !sane(signal.quote, 400) || !sane(signal.place) || !sane(signal.event)) return held('missing_signal_proof')
  const origin = site.website
  const identity = pageUrl(site.identitySource)
  const page = pageUrl(signal.sourceUrl)
  // This initial slice requires the issuer's own dated event. An externally
  // hosted ATS signal awaits a separate proof contract, not a guessed domain.
  if (!identity || identity.origin !== origin || !page || page.origin !== origin || page.pathname === '/') return held('missing_signal_proof')
  if (!sane(scope?.tenant) || !sane(scope?.job) || !sane(scope?.attempt)) return held('contact_scope_unavailable')
  if (!Array.isArray(requestedTitles) || requestedTitles.length > 12) return held('missing_requested_role')
  const roles = new Set(requestedTitles.filter((x): x is string => sane(x) && ordinaryTitle(x)).map(fold))
  if (!roles.size) return held('missing_requested_role')
  const scopeSnapshot = Object.freeze({ tenant: scope.tenant, job: scope.job, attempt: scope.attempt })
  const deadline = AbortSignal.timeout(8_000)
  const abort = signalFromCaller ? AbortSignal.any([signalFromCaller, deadline]) : deadline
  const current = () => bounded(abort, () => readers.isCurrent(scopeSnapshot, finding))
  const permit = async (stage: ContactStage) => await current() === true &&
    await bounded(abort, () => readers.reserveBeforeDispatch({ scope: scopeSnapshot, stage, signal: abort })) === true
  if (!await permit('directory')) return held('contact_scope_unavailable')
  const dir = await bounded(abort, () => readers.readDirectory(origin, abort))
  if (await current() !== true) return held('contact_scope_unavailable')
  const directory = pageUrl(dir?.url)
  const navigationSource = pageUrl(dir?.navigation?.sourceUrl)
  if (!dir || !directory || directory.origin !== origin || directory.pathname === '/' ||
      !navigationSource || navigationSource.origin !== origin || (navigationSource.href !== identity.href && navigationSource.pathname !== '/') ||
      navigationSource.href === directory.href || dir.navigation.linkedUrl !== directory.href ||
      !Array.isArray(dir.people) || dir.people.length > 80) return held('directory_unavailable')
  const selected = dir.people.filter(p => p && exactName(p.name) && sane(p.title) && ordinaryTitle(p.title) && roles.has(fold(p.title)))
  if (selected.length !== 1) return held('buyer_unconfirmed')
  const person = selected[0]
  if (dir.people.filter(p => p && exactName(p.name) && fold(p.name) === fold(person.name)).length !== 1) return held('buyer_unconfirmed')
  const bioUrl = pageUrl(person.bioUrl)
  if (!bioUrl || bioUrl.origin !== origin || bioUrl.href === directory.href || bioUrl.pathname === '/') return held('bio_unconfirmed')
  if (!await permit('bio')) return held('contact_scope_unavailable')
  const bio = await bounded(abort, () => readers.readBio(bioUrl.href, abort))
  if (await current() !== true) return held('contact_scope_unavailable')
  if (!bio || bio.url !== bioUrl.href || !exactName(bio.name) || fold(bio.name) !== fold(person.name) || !sane(bio.title) ||
      fold(bio.title) !== fold(person.title) || !sane(bio.company) || fold(bio.company) !== fold(company) ||
      typeof bio.text !== 'string' || bio.text.length > 16_384) return held('bio_unconfirmed')
  const lines = bio.text.split(/\r?\n/).map(line => line.normalize('NFKC').trim()).filter(Boolean)
  const nameLines = lines.flatMap<{ index: number; alternate: string | null }>((line, index) => {
    if (fold(line) === fold(person.name)) return [{ index, alternate: null }]
    // A Latin spelling co-published on the own heading is proof; never
    // transliterate or guess a local part from a search result.
    const paired = /^(.*?)\s*\(([^()]*)\)$/.exec(line)
    return paired && fold(paired[1]) === fold(person.name) && exactName(paired[2]) && parts(paired[2])
      ? [{ index, alternate: paired[2] }] : []
  })
  if (nameLines.length !== 1 || fold(lines[nameLines[0].index + 1] ?? '') !== fold(person.title)) return held('bio_unconfirmed')
  if (!Array.isArray(bio.profiles) || bio.profiles.length !== 1) return held('profile_unconfirmed')
  const link = bio.profiles[0]
  if (!link || typeof link.url !== 'string' || !LINKEDIN.test(link.url) ||
      !exactName(link.named) || fold(link.named) !== fold(person.name)) return held('profile_unconfirmed')
  if (!await permit('profile')) return held('contact_scope_unavailable')
  const profile = await bounded(abort, () => readers.corroborateProfile(link.url, abort))
  if (await current() !== true) return held('contact_scope_unavailable')
  if (!profile || profile.url !== link.url || profile.current !== true || !exactName(profile.name) || fold(profile.name) !== fold(person.name) ||
      !sane(profile.company) || fold(profile.company) !== fold(company) || !sane(profile.title) || fold(profile.title) !== fold(person.title)) return held('profile_unconfirmed')
  const address = literalNamedAddress(bio, [person.name, ...(nameLines[0].alternate ? [nameLines[0].alternate] : [])],
    page.hostname.replace(/^www\./, ''), dir)
  if (!address) return held('email_unconfirmed')
  return { status: 'contact_proof', buyer: { name: person.name, title: person.title, bioUrl: bioUrl.href, linkedin: link.url },
    published: { address, sourceUrl: bioUrl.href } }
}
