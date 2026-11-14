// Email finder (docs/design/email-finder.md). Part 1 learns a company's address FORMAT from personal addresses it
// publishes on its own site and prepares candidate addresses for people the crawl found on that site. Part 2 (US-only,
// docs/DECISIONS.md 2026-10-26) records candidates only for a lead whose confirmed site states a US address, keeping that
// basis as provenance. Part 3 (mailbox verification) runs a pluggable verifier under a code-enforced per-tenant daily cap
// and fails closed: only an explicit "deliverable" answer from a real check makes a candidate verified; catch-all,
// unknown, refused, errors and a check that never finished stay non-verified and are surfaced as such.
// Nothing here is shown, stored as a contact, or sent: candidates live in their own tables (email_patterns,
// email_candidates), which no page and no outreach path reads. The one wired verifier is ZeroBounce's FREE tier (#899 decision,
// lib/people/zerobounce.ts), used only when ZEROBOUNCE_API_KEY is set and capped at its free monthly allowance. Off unless
// EMAIL_GUESS_ENABLED=1.
import type Database from 'better-sqlite3'
import { ROLE, sameSite } from '../connectors/sitecrawl.ts'
import { US_STATES } from '../scan/place-agreement.ts'
import { countriesIn } from '../scan/countries.ts'
import { VerifierError, zeroBounceVerifier, zeroBounceStagingFetch, ZEROBOUNCE_FREE_MONTHLY, ZEROBOUNCE_STAGING_FAKE } from './zerobounce.ts'
import { isStaging } from '../staging.ts'
import { isSmtpVerifier, smtpConfigFromEnv, smtpMailboxVerifier, smtpMonthlyCap, SMTP_STAGING_FAKE } from './smtp-verify.ts'
import { stagingSmtpEnv } from './smtp-staging-fake.ts'

export const emailGuessEnabled = (env: Record<string, string | undefined> = process.env) => env.EMAIL_GUESS_ENABLED === '1'

export const FORMATS = ['first.last', 'firstlast', 'flast', 'f.last', 'first_last', 'first', 'firstl', 'last.first', 'last', 'lastf'] as const
export type Format = typeof FORMATS[number]
export interface Name { first: string; last: string }

const ascii = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '')
// "Dr. Ana María López-Pérez" -> { first: 'ana', last: 'lopezperez' }. Needs a first and a last name of 2+ letters.
export function splitName(full: string): Name | null {
  const words = full.replace(/^(dr|mr|ms|mrs|prof)\.?\s+/i, '').split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const first = ascii(words[0]), last = ascii(words[words.length - 1])
  return first.length >= 2 && last.length >= 2 ? { first, last } : null
}

export function localFor(f: Format, n: Name): string {
  switch (f) {
    case 'first.last': return `${n.first}.${n.last}`
    case 'firstlast': return `${n.first}${n.last}`
    case 'flast': return `${n.first[0]}${n.last}`
    case 'f.last': return `${n.first[0]}.${n.last}`
    case 'first_last': return `${n.first}_${n.last}`
    case 'first': return n.first
    case 'firstl': return `${n.first}${n.last[0]}`
    case 'last.first': return `${n.last}.${n.first}`
    case 'last': return n.last
    case 'lastf': return `${n.last}${n.first[0]}`
  }
}

// Personal (non-role) local parts of addresses on the company's own domain, as published on one of its pages.
export function personalLocals(html: string, site: string): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/([A-Z0-9._%+-]{2,64})@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const local = m[1].toLowerCase(), domain = m[2].toLowerCase()
    if (!sameSite(domain, site) || ROLE.test(local.replace(/[._-]/g, ''))) continue
    out.add(local)
  }
  return [...out]
}

// The same addresses, kept whole (local part AND domain), for the published tier: a published address is stored lower-cased as
// the site printed it, never rebuilt onto another domain.
// at: where the address is printed on the page (its first 12 places, with the printed length), recorded in this ONE pass so nothing
// ever searches the page again per address (#1036: a staff directory prints 1,500 of them).
export function personalAddresses(html: string, site: string): { local: string; address: string; at: { i: number; len: number }[] }[] {
  const out = new Map<string, { local: string; address: string; at: { i: number; len: number }[] }>()
  for (const m of html.matchAll(/([A-Z0-9._%+-]{2,64})@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const local = m[1].toLowerCase(), domain = m[2].toLowerCase()
    if (!sameSite(domain, site) || ROLE.test(local.replace(/[._-]/g, ''))) continue
    const address = `${local}@${domain}`
    if (address.length > 254) continue
    const had = out.get(address)
    if (!had) out.set(address, { local, address, at: [{ i: m.index, len: m[0].length }] })
    else if (had.at.length < 12) had.at.push({ i: m.index, len: m[0].length })
  }
  return [...out.values()]
}

// A format counts only when it reproduces a published address for a person named on the same site. The best format
// needs 2+ distinct supporting people and must be strictly ahead of the runner-up; anything else is no pattern.
export function inferPattern(locals: string[], people: Name[]): { format: Format; support: number } | null {
  const r = rankPattern(locals, people)
  return r && r.support >= 2 ? { format: r.format, support: r.support } : null
}

// Evidence-based confidence for the winning format (free-first finder, owner direction 2026-11-06):
//   high   - 2+ people support it and no other format is supported at all (score 90, 95 with 3+);
//   medium - 2+ people support it but another format has (fewer) supporters too: mixed formats (score 70 * share);
//   low    - exactly one published address supports it (score 35).
// A tie between formats is no pattern. Only 'high' guesses may ever reach the (optional, capped) mailbox check.
export type Confidence = 'high' | 'medium' | 'low'
export interface RankedPattern { format: Format; support: number; runnerUp: number; confidence: Confidence; score: number; supporters: Name[] }
export function rankPattern(locals: string[], people: Name[]): RankedPattern | null {
  // A printed local part that two named people could both own (e.g. 'asmith' for Anna and Alex Smith) is ambiguous:
  // it proves nothing about whose address it is, so it supports no format and cannot inflate a pattern's support.
  const have = new Set(locals.filter(l => ownersOf(l, people).length <= 1))
  const support = new Map<Format, Map<string, Name>>()
  for (const p of people) for (const f of FORMATS) if (have.has(localFor(f, p))) {
    if (!support.has(f)) support.set(f, new Map())
    support.get(f)!.set(`${p.first} ${p.last}`, p)
  }
  const ranked = [...support.entries()].map(([format, s]) => ({ format, support: s.size, supporters: [...s.values()] })).sort((a, b) => b.support - a.support)
  if (!ranked.length) return null
  const top = ranked[0], runnerUp = ranked[1]?.support ?? 0
  if (runnerUp === top.support) return null // ambiguous (e.g. single-name people fit two formats, or one each)
  const confidence: Confidence = top.support >= 2 ? (runnerUp === 0 ? 'high' : 'medium') : 'low'
  const score = confidence === 'high' ? (top.support >= 3 ? 95 : 90) : confidence === 'medium' ? Math.round(70 * top.support / (top.support + runnerUp)) : 35
  return { format: top.format, support: top.support, runnerUp, confidence, score, supporters: top.supporters }
}

const nameKey = (n: Name) => `${n.first} ${n.last}`
// Every distinct named person with a known format that reproduces this local part. One owner = the page identifies
// the person; two or more = ambiguous (the address could be either's); none = not a named person's address.
export function ownersOf(local: string, people: Name[]): Name[] {
  const out = new Map<string, Name>()
  for (const p of people) if (FORMATS.some(f => localFor(f, p) === local)) out.set(nameKey(p), p)
  return [...out.values()]
}

// Published tier: a person named on the confirmed site whose OWN address is printed on that site (its local part is one of
// the known formats of their name). Stored as printed (lower-cased), with the page it was printed on. Not a guess.
// Attribution needs the page evidence to identify the person unambiguously: when another named person (people) could own
// the same printed address, it is attributed to no one. A published address is never proof of a verified mailbox.
// #1036: a local part that is ONE name alone ('nora@', 'wall@') names whoever on the site shares that name, and the crawl keeps only
// buyer-role people, so the real owner may not be among `people`. Such an address is attributed only on the page's OWN pairing
// (`ctx`: every place the crawl saw the address printed, on any page). Fail closed:
//   - some place must hold this person's first and last name (a middle initial allowed) in the SAME attribute value or text node
//     as the address (a team card's data attribute "Maya Thornton maya@...", or the text "Maya Thornton - maya@..."). Text that is
//     merely nearby (a neighbouring heading or card) is never a pairing;
//   - and the name token must not occur anywhere else, as any word in any case, in that same attribute or text node, in the text
//     around a text-node place, or in the attribute / text node of ANY other place the address is printed ("Maya Ortiz", "maya",
//     "Michael Jordan" for jordan@). Otherwise it is nobody's.
export interface AddressContext { tight: string; wide: string; attr: boolean }
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const nameWords = (text: string): string[] => text.replace(EMAIL_RE, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z]+/).filter(Boolean)
// This person's own name, matched on the RAW text: first and last separated by spaces only (a middle INITIAL allowed, nothing else:
// "Maya Ortiz Thornton Realty" must not read as Maya [Ortiz] Thornton), no punctuation between them ("Maya, Thornton Realty" is a
// first-name-only staffer at a firm named after the owner), and not followed by a company word ("Maya Thornton Realty").
const COMPANY_WORD = 'realty|realtors?|group|team|law|legal|dental|properties|associates|partners|company|co|inc|llc|llp|pllc|ltd|agency|homes|insurance|consulting|capital|firm|office|offices|studio|clinic|construction|services|solutions|advisors|roofing|plumbing|builders|electric|landscaping|mortgage|financial|&|and'
function withoutOwnName(text: string, n: Name): { rest: string[]; found: boolean } {
  const raw = text.replace(EMAIL_RE, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  // #1173: only spaces between the first and the last name (a tab or newline kept from an attribute or a <pre> separates two
  // records: "Ana Maya<tab>Thornton Lee"), and no hyphen or dash of any kind on either side ("Maya Thornton-Ortiz", "Anna-Maya
  // Thornton" are someone else).
  // Known limits, stated rather than guessed at: a preceding name word cannot be told from a label ("Tom Maya Thornton" reads like
  // "Contact Maya Thornton"), and a firm word not on the list below ("Maya Thornton Staffing") is not recognised. Up to 12 places per
  // page are read (72 per site); a page that prints the address more often than that before another person's card is not fully seen.
  const own = new RegExp(`(?<![A-Za-z\u2010-\u2015-])${n.first}(?: +[A-Za-z]\\.?)? +${n.last}(?:['\u2019]s)?(?![A-Za-z\u2010-\u2015-])(?!\\s+(?:${COMPANY_WORD})(?![A-Za-z]))`, 'gi')
  let found = false
  const rest = raw.replace(own, () => { found = true; return ' | ' })
  return { rest: nameWords(rest), found }
}
export function singleNamePairing(local: string, n: Name, ctx: AddressContext[] | undefined): boolean {
  if (!ctx?.length) return false
  let paired = false
  for (const c of ctx) {
    const tight = withoutOwnName(c.tight, n)
    if (tight.rest.includes(local)) return false                                         // someone else sharing the name, in the same attribute / text
    // ... or in the text around the place. Only an attribute that ITSELF pairs the address with this person (a card's own data
    // attribute) stands on its own; a bare mailto in someone else's card is judged by the text around it.
    if (!(c.attr && tight.found) && withoutOwnName(c.wide, n).rest.includes(local)) return false
    if (tight.found) paired = true
  }
  return paired
}
// Addresses whose own shape shows the format: "shannon.spees@" printed with no name near it is still a first.last address. Two or
// more DISTINCT dotted locals (letters.letters, each part 2+ letters, not a known person's) on one site are read as first.last; a
// single one proves nothing (it may be the firm's own name, "whitley.penn@"). The pattern they support is capped at 'medium'.
export function shapeOwners(locals: string[], known: Name[] = []): Name[] {
  const knownLocals = new Set(known.flatMap(k => FORMATS.map(f => localFor(f, k))))
  const dotted = [...new Set(locals)].filter(l => /^[a-z]{2,}\.[a-z]{2,}$/.test(l) && !knownLocals.has(l) && !ROLE.test(l.replace('.', '')))
  if (dotted.length < 2) return []
  return dotted.map(l => { const [first, last] = l.split('.'); return { first, last } })
}
// The people an address is printed with, for learning the site's address FORMAT (never for attributing an address to a buyer).
// For each printed address: the first person-shaped name in its own attribute / text node, else in the text around it, whose name
// reproduces the local part under a format that uses BOTH names ('first.last', 'flast', ...). A one-name local ('maya@') proves
// no format, so it is never used here. Known people are skipped (they are already in the pattern's people).
const TWO_NAME_FORMATS = FORMATS.filter(f => f !== 'first' && f !== 'last')
export function contextOwners(seen: { address: string; ctx?: AddressContext[] }[], known: Name[] = []): Name[] {
  const out = new Map<string, Name>()
  const knownKeys = new Set(known.map(k => `${k.first} ${k.last}`))
  for (const s of seen) {
    const local = s.address.split('@')[0]
    let owner: Name | null = null
    for (const c of s.ctx ?? []) {
      for (const text of [c.tight, c.wide]) {
        const raw = text.replace(EMAIL_RE, ' ').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        for (const m of raw.matchAll(/(?=(?<![A-Za-z-])([A-Z][a-z'’]+)(?: [A-Z]\.?)? ([A-Z][A-Za-z'’-]+)(?![A-Za-z]))/g)) {
          const n = { first: ascii(m[1]), last: ascii(m[2]) }
          if (n.first.length >= 2 && n.last.length >= 2 && TWO_NAME_FORMATS.some(f => localFor(f, n) === local)) { owner = n; break }
        }
        if (owner) break
      }
      if (owner) break
    }
    if (owner && !knownKeys.has(`${owner.first} ${owner.last}`)) out.set(`${owner.first} ${owner.last}`, owner)
  }
  return [...out.values()]
}
export function publishedFor(name: Name, seen: { address: string; url: string; ctx?: AddressContext[] }[], people: Name[] = [name]): { address: string; url: string } | null {
  const mine = new Set(FORMATS.map(f => localFor(f, name)))
  const single = new Set([localFor('first', name), localFor('last', name)])
  const all = people.some(p => nameKey(p) === nameKey(name)) ? people : [...people, name]
  return seen.find(s => {
    const local = s.address.split('@')[0]
    if (!mine.has(local)) return false
    if (single.has(local) && !singleNamePairing(local, name, s.ctx)) return false
    const owners = ownersOf(local, all)
    return owners.length === 1 && nameKey(owners[0]) === nameKey(name)
  }) ?? null
}

export const candidateAddress = (n: Name, site: string, f: Format) => `${localFor(f, n)}@${site}`

export function migrateEmailGuess(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS email_patterns (
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, site TEXT NOT NULL, format TEXT NOT NULL, support INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), PRIMARY KEY (lead_id, site));
    CREATE TABLE IF NOT EXISTS email_candidates (
      tenant_id TEXT NOT NULL, lead_id TEXT NOT NULL, person TEXT NOT NULL CHECK (length(person) <= 120),
      address TEXT NOT NULL CHECK (length(address) <= 254), format TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified')),
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), PRIMARY KEY (lead_id, address));`)
  // Parts 2-3 (Postgres: lib/db/migrations/pg/0050_email_verification.sql; tiers and confidence: 0051_email_free_first.sql). status stays 'unverified' (never a contact);
  // verification is the mailbox check outcome, checked_at / verifier its provenance, country_basis the US evidence.
  const has = (c: string) => (db.prepare('PRAGMA table_info(email_candidates)').all() as { name: string }[]).some(r => r.name === c)
  if (!has('verification')) db.exec(`ALTER TABLE email_candidates ADD COLUMN verification TEXT NOT NULL DEFAULT 'none' CHECK (verification IN (${VERIFICATIONS.map(v => `'${v}'`).join(',')}))`)
  if (!has('verifier')) db.exec('ALTER TABLE email_candidates ADD COLUMN verifier TEXT CHECK (verifier IS NULL OR length(verifier) <= 40)')
  if (!has('checked_at')) db.exec('ALTER TABLE email_candidates ADD COLUMN checked_at INTEGER')
  if (!has('country_basis')) db.exec('ALTER TABLE email_candidates ADD COLUMN country_basis TEXT CHECK (country_basis IS NULL OR length(country_basis) <= 160)')
  // Free-first tiers: 'published' = printed on the confirmed site (source_url is that page); 'guessed' = built from the
  // learned pattern, with the pattern's confidence. Only tier 'guessed' + confidence 'high' is ever mailbox-checked.
  if (!has('tier')) db.exec("ALTER TABLE email_candidates ADD COLUMN tier TEXT NOT NULL DEFAULT 'guessed' CHECK (tier IN ('published','guessed'))")
  if (!has('source_url')) db.exec('ALTER TABLE email_candidates ADD COLUMN source_url TEXT CHECK (source_url IS NULL OR length(source_url) <= 500)')
  if (!has('confidence')) db.exec("ALTER TABLE email_candidates ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'))")
  const hasP = (c: string) => (db.prepare('PRAGMA table_info(email_patterns)').all() as { name: string }[]).some(r => r.name === c)
  if (!hasP('confidence')) db.exec("ALTER TABLE email_patterns ADD COLUMN confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low'))")
  if (!hasP('score')) db.exec('ALTER TABLE email_patterns ADD COLUMN score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100))')
  if (!hasP('runner_up')) db.exec('ALTER TABLE email_patterns ADD COLUMN runner_up INTEGER')
  if (!hasP('evidence')) db.exec('ALTER TABLE email_patterns ADD COLUMN evidence TEXT CHECK (evidence IS NULL OR length(evidence) <= 2000)')
  // #899: the per-tenant daily count reads this index; the verifier's monthly checks are an operator ledger with no tenant data
  // (lib/tenant/scope.ts: global), so a tenant's deletion never frees allowance already spent. Postgres: 0063_email_verify_caps.sql.
  db.exec(`CREATE INDEX IF NOT EXISTS email_candidates_tenant_checked ON email_candidates (tenant_id, checked_at);
    CREATE TABLE IF NOT EXISTS email_verify_usage (
      verifier TEXT NOT NULL CHECK (length(verifier) <= 40), month TEXT NOT NULL CHECK (length(month) = 7),
      n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0), PRIMARY KEY (verifier, month));`)
}

// ---- part 2: US only. Unknown country counts as not US (docs/DECISIONS.md). ----
// The confirmed homepage must state a US street address ("City, ST 12345"), the scan geography must not name another
// country, and the homepage addresses must not include a Canadian postal code. Returns the address as provenance.
const US_ZIP_ADDRESS = /([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/gu
const CA_POSTAL_ADDRESS = /,\s*(?:ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/
export function usEvidence(homeText: string | undefined, where: string[] = []): { us: true; basis: string } | { us: false; reason: string } {
  const foreign = [...new Set(where.flatMap(w => countriesIn(w)))].filter(c => c !== 'US')
  if (foreign.length) return { us: false, reason: `scan geography names ${foreign.join(', ')}` }
  if (!homeText) return { us: false, reason: 'no homepage text: country unknown' }
  if (CA_POSTAL_ADDRESS.test(homeText)) return { us: false, reason: 'homepage states a Canadian address' }
  for (const m of homeText.matchAll(US_ZIP_ADDRESS)) if (m[2] in US_STATES) return { us: true, basis: `homepage address: ${m[0]}`.slice(0, 160) }
  return { us: false, reason: 'no US address on the homepage: country unknown' }
}

// ---- part 3: mailbox verification ----
export const VERIFICATIONS = ['none', 'pending', 'verified', 'catch_all', 'undeliverable', 'uncertain', 'refused'] as const
export type Verification = typeof VERIFICATIONS[number]
// noCall: the answer was reached WITHOUT any request leaving this server (a cached answer, a DNS-only answer, a stop or a backoff already
// in force): the verifier's own allowance is given back, and an 'unknown' one leaves the address unchecked (releaseVerifySlot).
export type VerifyAnswer = { outcome: 'deliverable' | 'catch_all' | 'undeliverable' | 'unknown' | 'refused'; detail?: string; noCall?: boolean }
// A provider adapter. Tests inject a fake. Production: ZeroBounce's free tier when ZEROBOUNCE_API_KEY is set, else none (today's
// behaviour: candidates stay 'guessed', unverified).
// blockedNow (optional, synchronous, no network): why NO check can run right now (port 25 shut, the sending address blocklisted), or null.
// Asked BEFORE a slot is reserved, so a check that cannot run costs nothing.
export interface MailboxVerifier { name: string; verify(address: string, signal?: AbortSignal): Promise<VerifyAnswer>; blockedNow?(): string | null }
// #1036 dazl's own SMTP mailbox check comes first when it is switched on and fully configured (smtp-verify.ts); it needs the database
// for its per-domain cache, rate counters and breaker, so a caller without one cannot get it and falls back to the free-tier provider.
export function verifierFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch, db?: Database.Database): MailboxVerifier | null {
  // TEST-ONLY: staging's fake SMTP server (smtp-verify.ts stagingSmtpEnv), never outside DAZL_ENV=staging. It runs the REAL verifier
  // (cache, rate limit, backoff, catch-all probe) against scripted answers, so the labels can be seen on staging without port 25.
  if (db && isStaging(env) && env.DAZL_STAGING_FAKE_SMTP === '1') return smtpMailboxVerifier(db, { helo: 'staging.dazl.test', mailFrom: 'verify@notify.dazl.ai', egressIp: '192.0.2.1', port: 25, connectMs: 1000, commandMs: 1000 }, stagingSmtpEnv(), SMTP_STAGING_FAKE)
  const smtp = db ? smtpConfigFromEnv(env) : null
  if (db && smtp) return smtpMailboxVerifier(db, smtp)
  // TEST-ONLY: staging's fake verifier (lib/people/zerobounce.ts zeroBounceStagingFetch), never outside DAZL_ENV=staging.
  if (isStaging(env) && env.DAZL_STAGING_FAKE_ZEROBOUNCE === '1') return zeroBounceVerifier('staging-fake', zeroBounceStagingFetch, ZEROBOUNCE_STAGING_FAKE)
  const key = (env.ZEROBOUNCE_API_KEY ?? '').trim()
  return key ? zeroBounceVerifier(key, fetchImpl) : null
}
// The verifier's checks per calendar month (UTC) across every tenant of this database: the free allowance is the provider account's,
// not a tenant's (a second deployment on the same key counts separately; the provider's own refusal stops it).
// Default and ceiling: the provider's free allowance (ZeroBounce 100). EMAIL_VERIFY_MONTHLY_CAP can only lower it; anything that is
// not a plain non-negative integer is 0 (no check). Never raised past the free tier: no setting buys checks (#899 decision).
// The cap that applies to ONE verifier: dazl's own SMTP check has its own (smtp-verify.ts smtpMonthlyCap), a provider's is its free allowance.
export const verifierMonthlyCap = (env: Record<string, string | undefined>, verifier: string): number => isSmtpVerifier(verifier) ? smtpMonthlyCap(env) : verifyMonthlyCap(env)
export function verifyMonthlyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EMAIL_VERIFY_MONTHLY_CAP
  if (raw === undefined || raw.trim() === '') return ZEROBOUNCE_FREE_MONTHLY
  return /^\d{1,6}$/.test(raw.trim()) ? Math.min(Number(raw.trim()), ZEROBOUNCE_FREE_MONTHLY) : 0
}
// Per-tenant checks per UTC day. Default 0: no check runs unless a cap is set explicitly.
export function verifyDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.EMAIL_VERIFY_DAILY_CAP ?? '0')
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 0
}
const OUTCOME: Record<VerifyAnswer['outcome'], Verification> = { deliverable: 'verified', catch_all: 'catch_all', undeliverable: 'undeliverable', unknown: 'uncertain', refused: 'refused' }

export interface VerifyRun { checked: number; verified: number; capped: number; skipped: string | null; stopped?: string; aborted?: boolean }
// Checks a lead's unchecked US candidates, one reserved slot at a time. The slot (verification='pending', checked_at)
// is written and counted inside a transaction BEFORE the provider call, so the cap holds even if the call or the
// process dies; a pending row is never verified.
export async function verifyCandidates(db: Database.Database, tenantId: string, leadId: string, verifier: MailboxVerifier | null, opts: { env?: Record<string, string | undefined>; now?: number; signal?: AbortSignal; alive?: () => boolean } = {}): Promise<VerifyRun> {
  const env = opts.env ?? process.env
  const run: VerifyRun = { checked: 0, verified: 0, capped: 0, skipped: null }
  if (!emailGuessEnabled(env)) return { ...run, skipped: 'EMAIL_GUESS_ENABLED is off' }
  if (!verifier) return { ...run, skipped: 'no verifier configured' }
  const cap = verifyDailyCap(env)
  if (cap === 0) return { ...run, skipped: 'EMAIL_VERIFY_DAILY_CAP is 0' }
  const monthCap = verifierMonthlyCap(env, verifier.name)
  if (monthCap === 0) return { ...run, skipped: isSmtpVerifier(verifier.name) ? 'SMTP_VERIFY_MONTHLY_CAP is 0' : 'EMAIL_VERIFY_MONTHLY_CAP is 0' }
  migrateEmailGuess(db)
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000)
  const vname = verifier.name.slice(0, 40)
  const rows = db.prepare("SELECT address FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND verification = 'none' AND country_basis IS NOT NULL AND tier = 'guessed' AND confidence = 'high' ORDER BY address").all(tenantId, leadId) as { address: string }[]
  const blocked = rows.length ? verifier.blockedNow?.() ?? null : null
  if (blocked) { run.stopped = blocked.slice(0, 160); return run } // nothing reserved, nothing marked: the addresses stay unchecked
  for (const { address } of rows) {
    if (opts.signal?.aborted || (opts.alive && !opts.alive())) { run.aborted = true; break }
    // The reservation (#849 inventory: every provider call is reserved before it is made): refused = no call.
    try {
      await reserveVerifySlot(db, { tenantId, verifier: vname, nowS, dailyCap: cap, monthCap },
        () => db.prepare("UPDATE email_candidates SET verification = 'pending', checked_at = ?, verifier = ? WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'none'").run(nowS, vname, tenantId, leadId, address).changes === 1)
    } catch (e) {
      if (e instanceof VerifySlotRefused && e.reason === 'lost') continue // another run already took this address
      run.capped = rows.length - run.checked
      break
    }
    let v: Verification = 'uncertain'
    let stop: string | null = null
    let noCall = false
    try { const a = await verifier.verify(address, opts.signal); v = OUTCOME[a?.outcome] ?? 'uncertain'; noCall = a?.noCall === true } catch (e) { v = 'uncertain'; noCall = (e as { noCall?: boolean })?.noCall === true; if (e instanceof VerifierError && e.kind === 'stop') stop = e.message.slice(0, 160) }
    // Cut off by our own deadline mid-call: no answer, so the address goes back to unchecked (a later run may check it). Its slot
    // stays counted in both caps (the request may have reached the provider): an over-count, never an under-count.
    if (v === 'uncertain' && !stop && opts.signal?.aborted) {
      db.prepare("UPDATE email_candidates SET verification = 'none' WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'pending'").run(tenantId, leadId, address)
      run.aborted = true; break
    }
    if (noCall) {
      releaseVerifySlot(db, vname, nowS)
      if (v === 'uncertain') { // no request was made and nothing was learned: unchecked again, and it no longer counts against the tenant's day
        db.prepare("UPDATE email_candidates SET verification = 'none', checked_at = NULL WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'pending'").run(tenantId, leadId, address)
        continue
      }
    }
    db.prepare("UPDATE email_candidates SET verification = ? WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'pending'").run(v, tenantId, leadId, address)
    run.checked++
    if (v === 'verified') run.verified++
    // The account cannot check at all (bad key, no free checks left): no further request this run.
    if (stop) { run.stopped = stop; break }
  }
  return run
}

// THE reservation every mailbox check makes before its provider call (#899 free-tier caps; #849 inventory: a provider call is
// never made without a reservation recorded before it). One transaction: the tenant's daily cap (checks already made today), the
// verifier's monthly allowance in the operator ledger (email_verify_usage: no tenant data, so deleting a tenant never frees spent
// allowance; per database - a second deployment on the same key counts its own, the provider's refusal is the backstop), then
// mark() claims the caller's own row and the ledger is incremented. Refused = throws VerifySlotRefused, like reserveCredits.
export class VerifySlotRefused extends Error {
  readonly reason: 'cap' | 'lost'
  constructor(reason: 'cap' | 'lost') { super(`mailbox check refused: ${reason}`); this.reason = reason }
}
// Gives one monthly allowance back (a check that never left this server): never below zero.
export function releaseVerifySlot(db: Database.Database, vname: string, nowS: number): void {
  const monthKey = new Date(nowS * 1000).toISOString().slice(0, 7)
  db.prepare('UPDATE email_verify_usage SET n = n - 1 WHERE verifier = ? AND month = ? AND n > 0').run(vname.slice(0, 40), monthKey)
}
export async function reserveVerifySlot(db: Database.Database, s: { tenantId: string; verifier: string; nowS: number; dailyCap: number; monthCap: number }, mark: () => boolean): Promise<void> {
  const dayStart = s.nowS - (s.nowS % 86_400), monthKey = new Date(s.nowS * 1000).toISOString().slice(0, 7), vname = s.verifier.slice(0, 40)
  const r = db.transaction((): 'ok' | 'cap' | 'lost' => {
    // The tenant's daily cap counts every mailbox check: the scan's guesses and Find work email's checks (#1036) alike.
    let lookupChecks = 0
    try { lookupChecks = (db.prepare('SELECT count(*) AS n FROM work_email_lookups WHERE tenant_id = ? AND mailbox_checked_at >= ?').get(s.tenantId, dayStart) as { n: number }).n }
    catch (e) { if (!/no such (?:table|column)/i.test(String((e as Error)?.message))) throw e }
    const used = (db.prepare('SELECT count(*) AS n FROM email_candidates WHERE tenant_id = ? AND checked_at >= ?').get(s.tenantId, dayStart) as { n: number }).n + lookupChecks
    if (used >= s.dailyCap) return 'cap'
    const month = (db.prepare('SELECT n FROM email_verify_usage WHERE verifier = ? AND month = ?').get(vname, monthKey) as { n: number } | undefined)?.n ?? 0
    if (month >= s.monthCap) return 'cap'
    if (!mark()) return 'lost'
    db.prepare('INSERT INTO email_verify_usage (verifier, month, n) VALUES (?, ?, 1) ON CONFLICT (verifier, month) DO UPDATE SET n = email_verify_usage.n + 1').run(vname, monthKey)
    return 'ok'
  })()
  if (r !== 'ok') throw new VerifySlotRefused(r)
}

// #899: the mailbox check for one scan's leads, run by the scan runner as its LAST post-finish step (lib/scan/runner.ts
// runPostFinishBounded), never inside the crawl: a slow check can then only use time nothing else needs, and can never make a
// finished site read look cut off. Lead by lead under both caps; a stop (bad key, no credits, rate limit) or the cap ends it.
export async function verifyJobCandidates(db: Database.Database, tenantId: string, jobId: string, verifier: MailboxVerifier | null, opts: { env?: Record<string, string | undefined>; now?: number; signal?: AbortSignal; alive?: () => boolean } = {}): Promise<VerifyRun & { leads: number }> {
  const out: VerifyRun & { leads: number } = { checked: 0, verified: 0, capped: 0, skipped: null, leads: 0 }
  if (!emailGuessEnabled(opts.env ?? process.env)) return { ...out, skipped: 'EMAIL_GUESS_ENABLED is off' }
  if (!verifier) return { ...out, skipped: 'no verifier configured' }
  let leadIds: string[]
  try {
    leadIds = (db.prepare(`SELECT DISTINCT c.lead_id FROM email_candidates c JOIN leads l ON l.id = c.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
      WHERE c.tenant_id = ? AND j.user_id = ? AND l.scan_job_id = ? AND c.verification = 'none' AND c.tier = 'guessed' AND c.confidence = 'high' AND c.country_basis IS NOT NULL
      ORDER BY c.lead_id`).all(tenantId, tenantId, jobId) as { lead_id: string }[]).map(r => r.lead_id)
  } catch (e) { if (/no such table/i.test(String((e as Error)?.message))) return out; throw e }
  // alive: the scan is still this attempt's (not cancelled, not taken over): a cancelled scan sends nothing more to the provider.
  for (const leadId of leadIds) {
    if (opts.signal?.aborted || (opts.alive && !opts.alive())) return { ...out, aborted: true }
    const r = await verifyCandidates(db, tenantId, leadId, verifier, opts)
    if (r.skipped) return { ...out, skipped: r.skipped }
    out.leads++; out.checked += r.checked; out.verified += r.verified; out.capped += r.capped
    if (r.stopped) return { ...out, stopped: r.stopped }
    if (r.aborted) return { ...out, aborted: true }
    if (r.capped) break // a cap is reached: later leads would be refused the same way
  }
  return out
}

export type CandidateLabel = 'published' | 'guessed' | 'guessed, verified' | 'guessed, catch-all' | 'guessed, undeliverable' | 'guessed, uncertain' | 'guessed, refused'

// #1036 Find work email, free tier: the PUBLISHED address recorded for one named person on this lead (printed on the
// company's own confirmed site, with the page). Read-only, and only tier 'published' with its page: a guessed row, of any
// verification state, is never returned. The person is matched by the same name split the crawl used. Missing table
// (flag never on) = nothing published, never an error. Kept in this module so it stays the only reader of the table.
export function publishedCandidateFor(db: Database.Database, tenantId: string, leadId: string, fullName: string): { address: string; url: string } | null {
  const want = splitName(fullName)
  if (!want) return null
  let rows: { person: string; address: string; source_url: string | null }[]
  try { rows = db.prepare("SELECT person, address, source_url FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND tier = 'published' AND source_url IS NOT NULL ORDER BY address").all(tenantId, leadId) as typeof rows }
  catch (e) { if (/no such table/i.test(String((e as Error)?.message))) return null; throw e }
  const mine = rows.filter(r => { const n = splitName(r.person.split(',')[0] ?? ''); return !!n && n.first === want.first && n.last === want.last })
  // Two different printed addresses for the same person: which one is theirs is not settled, so neither is offered.
  if (new Set(mine.map(r => r.address)).size !== 1) return null
  return { address: mine[0].address, url: mine[0].source_url! }
}
// The only label a guessed address may carry. "verified" needs the check outcome AND its provenance; never "published".
// 'published' needs tier 'published' AND the page it was printed on; a guess can never become 'published'.
export function candidateLabel(r: { verification: string; checked_at: number | null; verifier: string | null; country_basis: string | null; tier?: string | null; source_url?: string | null }): CandidateLabel {
  if (r.tier === 'published') return r.source_url ? 'published' : 'guessed'
  if (r.verification === 'verified') return r.checked_at && r.verifier && r.country_basis ? 'guessed, verified' : 'guessed, uncertain'
  if (r.verification === 'catch_all') return 'guessed, catch-all'
  if (r.verification === 'undeliverable') return 'guessed, undeliverable'
  if (r.verification === 'refused') return 'guessed, refused'
  if (r.verification === 'uncertain' || r.verification === 'pending') return 'guessed, uncertain'
  return 'guessed'
}

// Called by the crawl for one lead and its confirmed site. people: "Name, Title" values from extractPeople. seen: personal
// addresses printed on the site's own pages, whole, with the page URL (published tier + pattern evidence).
// #1036 (decision 2026-11-12: "checked" = Apollo verified OR an address published on the company's confirmed site; pattern
// guessing stays off): the PUBLISHED tier is recorded whatever the flag says (US evidence still required, as for every recorded
// address); only pattern GUESSES also need EMAIL_GUESS_ENABLED. Before this, the flag being off (prod) also
// dropped every printed address, so Find work email's free tier could never find one.
// Ambiguity (2026-11-06 review): a printed address two named people could own is attributed to neither (counted in
// `ambiguous`, not stored), and a guess is skipped when it collides with another person's guess or with an ambiguous
// printed address, so no address is ever filed under the wrong person.
export function recordEmailGuesses(db: Database.Database, tenantId: string, leadId: string, site: string, locals: string[], people: string[], ctx: { env?: Record<string, string | undefined>; homeText?: string; where?: string[]; seen?: { address: string; url: string; ctx?: AddressContext[] }[] } = {}): { format: Format | null; confidence: Confidence | null; candidates: number; published: number; ambiguous: number } | null {
  const us = usEvidence(ctx.homeText, ctx.where)
  const seenAll = (ctx.seen ?? []).filter(x => x.address.includes('@') && sameSite(x.address.split('@')[1], site))
  const namesAll = people.map(p => ({ person: p, name: splitName(p.split(',')[0] ?? '') })).filter((x): x is { person: string; name: Name } => !!x.name)
  const pubAll = namesAll.map(x => ({ ...x, pub: publishedFor(x.name, seenAll, namesAll.map(n => n.name)) })).filter((x): x is typeof x & { pub: { address: string; url: string } } => !!x.pub)
  // The published tier first, flag on or off (one insert for both paths). US-only like every recorded address (DECISIONS 2026-10-26):
  // a non-US site records nothing, so no non-US person's address is ever kept at rest.
  let pubWritten = 0
  if (pubAll.length && us.us) {
    migrateEmailGuess(db)
    const ins = db.prepare("INSERT INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES (?, ?, ?, ?, 'published', ?, 'published', ?) ON CONFLICT DO NOTHING")
    for (const x of pubAll) pubWritten += ins.run(tenantId, leadId, x.person.slice(0, 120), x.pub.address, us.basis, x.pub.url.slice(0, 500)).changes
  }
  if (!emailGuessEnabled(ctx.env ?? process.env)) {
    if (!pubWritten && !(pubAll.length && us.us)) return null
    const n = pubWritten
    const ambiguousLocals = new Set([...locals, ...seenAll.map(s => s.address.split('@')[0])].filter(l => ownersOf(l, namesAll.map(x => x.name)).length > 1))
    return { format: null, confidence: null, candidates: 0, published: n, ambiguous: new Set(seenAll.filter(s => ambiguousLocals.has(s.address.split('@')[0])).map(s => s.address)).size }
  }
  if (!us.us) {
    // This crawl no longer shows the company in the US: guesses recorded on earlier US evidence lose it, so none of them can be
    // sent to the mailbox check (verification only selects rows with a country_basis). Checked rows keep their history.
    try { db.prepare("UPDATE email_candidates SET country_basis = NULL WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed' AND verification = 'none'").run(tenantId, leadId) }
    catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
    return null
  }
  // This crawl shows the company in the US again: guesses already recorded and still UNCHECKED take this basis back (a crawl that
  // showed no US address cleared it), whatever this crawl's pattern turns out to be. A checked guess keeps its history.
  // Only addresses on the site this crawl read: a basis from one site never vouches for guesses made on another.
  try { db.prepare("UPDATE email_candidates SET country_basis = ? WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed' AND verification = 'none' AND country_basis IS NULL AND lower(address) LIKE ?").run(us.basis, tenantId, leadId, `%@${site.toLowerCase()}`) }
  catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
  const seen = (ctx.seen ?? []).filter(x => x.address.includes('@') && sameSite(x.address.split('@')[1], site))
  const names = people.map(p => ({ person: p, name: splitName(p.split(',')[0] ?? '') })).filter((x): x is { person: string; name: Name } => !!x.name)
  const allNames = names.map(x => x.name)
  const published = names.map(x => ({ ...x, pub: publishedFor(x.name, seen, allNames) })).filter((x): x is typeof x & { pub: { address: string; url: string } } => !!x.pub)
  const ambiguousLocals = new Set([...locals, ...seen.map(s => s.address.split('@')[0])].filter(l => ownersOf(l, allNames).length > 1))
  const ambiguous = new Set(seen.filter(s => ambiguousLocals.has(s.address.split('@')[0])).map(s => s.address)).size
  const ctxOwners = contextOwners(seen, allNames)
  const shaped = shapeOwners(seen.map(s2 => s2.address.split('@')[0]), [...allNames, ...ctxOwners])
  let pattern = rankPattern([...new Set([...locals, ...seen.map(s2 => s2.address.split('@')[0])])], [...allNames, ...ctxOwners, ...shaped])
  // A format that leans on the SHAPE of an address (no name printed with it) for ANY of its supporters is never 'high': medium at most.
  // 'high' is what the mailbox check probes, so every supporter of a 'high' format must be a person named on the site or beside the address.
  const namedOwner = (p2: Name) => [...allNames, ...ctxOwners].some(x => x.first === p2.first && x.last === p2.last)
  if (pattern && pattern.confidence === 'high' && pattern.supporters.some(p2 => !namedOwner(p2) && shaped.some(x => x.first === p2.first && x.last === p2.last))) pattern = { ...pattern, confidence: 'medium', score: 60 }
  if (!pattern && !published.length) return null
  migrateEmailGuess(db)
  const pub = pubWritten; let n = 0 // the published rows were written above, before the US check
  if (!pattern) return { format: null, confidence: null, candidates: 0, published: pub, ambiguous }
  const urlOf = (address: string) => seen.find(s => s.address === address)?.url ?? null
  const evidence: { person: string; address: string; url: string | null }[] = []
  for (const p of pattern.supporters) {
    const address = candidateAddress(p, site, pattern.format)
    const e = { person: `${p.first} ${p.last}`, address, url: urlOf(address) }
    if (JSON.stringify([...evidence, e]).length > 2000) break
    evidence.push(e)
  }
  db.prepare('INSERT OR REPLACE INTO email_patterns (tenant_id, lead_id, site, format, support, confidence, score, runner_up, evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, leadId, site, pattern.format, pattern.support, pattern.confidence, pattern.score, pattern.runnerUp, JSON.stringify(evidence))
  const hasPub = new Set(published.map(x => nameKey(x.name)))
  // One generation of guesses per site (review 4b3b9025 #2). The crawl records guesses twice - after the main read and again after the
  // evidence pages - and a later read can change the format or its confidence. UNCHECKED guesses on this site made under another
  // format are removed, and the ones kept take the pattern's confidence, so the mailbox check (which probes 'high' only) can never
  // be left probing the format the completed read decided against. Checked rows keep their history.
  const onSite = `%@${site.toLowerCase()}`
  db.prepare("DELETE FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed' AND verification = 'none' AND lower(address) LIKE ? AND format <> ?").run(tenantId, leadId, onSite, pattern.format)
  db.prepare("UPDATE email_candidates SET confidence = ? WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed' AND verification = 'none' AND lower(address) LIKE ? AND format = ?").run(pattern.confidence, tenantId, leadId, onSite, pattern.format)
  // Distinct people per guessed local part: a local two different people would both get is nobody's guess.
  const guessOwners = new Map<string, Set<string>>()
  for (const x of names) {
    const l = localFor(pattern.format, x.name)
    if (!guessOwners.has(l)) guessOwners.set(l, new Set())
    guessOwners.get(l)!.add(nameKey(x.name))
  }
  const ins = db.prepare("INSERT OR IGNORE INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES (?, ?, ?, ?, ?, ?, 'guessed', ?)")
  for (const x of names) {
    if (hasPub.has(nameKey(x.name))) continue
    const l = localFor(pattern.format, x.name)
    if (guessOwners.get(l)!.size > 1 || ambiguousLocals.has(l)) continue
    n += ins.run(tenantId, leadId, x.person.slice(0, 120), candidateAddress(x.name, site, pattern.format), pattern.format, us.basis, pattern.confidence).changes
  }
  return { format: pattern.format, confidence: pattern.confidence, candidates: n, published: pub, ambiguous }
}
