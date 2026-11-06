// Email finder (docs/design/email-finder.md). Part 1 learns a company's address FORMAT from personal addresses it
// publishes on its own site and prepares candidate addresses for people the crawl found on that site. Part 2 (US-only,
// docs/DECISIONS.md 2026-10-26) records candidates only for a lead whose confirmed site states a US address, keeping that
// basis as provenance. Part 3 (mailbox verification) runs a pluggable verifier under a code-enforced per-tenant daily cap
// and fails closed: only an explicit "deliverable" answer from a real check makes a candidate verified; catch-all,
// unknown, refused, errors and a check that never finished stay non-verified and are surfaced as such.
// Nothing here is shown, stored as a contact, or sent: candidates live in their own tables (email_patterns,
// email_candidates), which no page and no outreach path reads. No verifier provider is wired (verifierFromEnv returns
// null): choosing and paying for one is the owner's call. Off unless EMAIL_GUESS_ENABLED=1.
import type Database from 'better-sqlite3'
import { ROLE, sameSite } from '../connectors/sitecrawl.ts'
import { US_STATES } from '../scan/place-agreement.ts'
import { countriesIn } from '../scan/countries.ts'

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

// The same addresses, kept whole (local part AND domain), for the published tier: a published address is stored exactly as
// the site printed it, never rebuilt onto another domain.
export function personalAddresses(html: string, site: string): { local: string; address: string }[] {
  const out = new Map<string, { local: string; address: string }>()
  for (const m of html.matchAll(/([A-Z0-9._%+-]{2,64})@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const local = m[1].toLowerCase(), domain = m[2].toLowerCase()
    if (!sameSite(domain, site) || ROLE.test(local.replace(/[._-]/g, ''))) continue
    const address = `${local}@${domain}`
    if (address.length <= 254) out.set(address, { local, address })
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
  const have = new Set(locals)
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

// Published tier: a person named on the confirmed site whose OWN address is printed on that site (its local part is one of
// the known formats of their name). Stored exactly as printed, with the page it was printed on. Not a guess.
export function publishedFor(name: Name, seen: { address: string; url: string }[]): { address: string; url: string } | null {
  const mine = new Set(FORMATS.map(f => localFor(f, name)))
  return seen.find(s => mine.has(s.address.split('@')[0])) ?? null
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
  // Parts 2-3 (Postgres: lib/db/migrations/pg/0050_email_verification.sql). status stays 'unverified' (never a contact);
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
export type VerifyAnswer = { outcome: 'deliverable' | 'catch_all' | 'undeliverable' | 'unknown' | 'refused'; detail?: string }
// A provider adapter. Tests inject a fake; production has none until the owner picks and approves a provider.
export interface MailboxVerifier { name: string; verify(address: string, signal?: AbortSignal): Promise<VerifyAnswer> }
export function verifierFromEnv(env: Record<string, string | undefined> = process.env): MailboxVerifier | null { void env; return null }
// Per-tenant checks per UTC day. Default 0: no check runs unless a cap is set explicitly.
export function verifyDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.EMAIL_VERIFY_DAILY_CAP ?? '0')
  return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : 0
}
const OUTCOME: Record<VerifyAnswer['outcome'], Verification> = { deliverable: 'verified', catch_all: 'catch_all', undeliverable: 'undeliverable', unknown: 'uncertain', refused: 'refused' }

export interface VerifyRun { checked: number; verified: number; capped: number; skipped: string | null }
// Checks a lead's unchecked US candidates, one reserved slot at a time. The slot (verification='pending', checked_at)
// is written and counted inside a transaction BEFORE the provider call, so the cap holds even if the call or the
// process dies; a pending row is never verified.
export async function verifyCandidates(db: Database.Database, tenantId: string, leadId: string, verifier: MailboxVerifier | null, opts: { env?: Record<string, string | undefined>; now?: number; signal?: AbortSignal } = {}): Promise<VerifyRun> {
  const env = opts.env ?? process.env
  const run: VerifyRun = { checked: 0, verified: 0, capped: 0, skipped: null }
  if (!emailGuessEnabled(env)) return { ...run, skipped: 'EMAIL_GUESS_ENABLED is off' }
  if (!verifier) return { ...run, skipped: 'no verifier configured' }
  const cap = verifyDailyCap(env)
  if (cap === 0) return { ...run, skipped: 'EMAIL_VERIFY_DAILY_CAP is 0' }
  migrateEmailGuess(db)
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000), dayStart = nowS - (nowS % 86_400)
  const rows = db.prepare("SELECT address FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND verification = 'none' AND country_basis IS NOT NULL AND tier = 'guessed' AND confidence = 'high' ORDER BY address").all(tenantId, leadId) as { address: string }[]
  const reserve = db.transaction((address: string): boolean => {
    const used = (db.prepare('SELECT count(*) AS n FROM email_candidates WHERE tenant_id = ? AND checked_at >= ?').get(tenantId, dayStart) as { n: number }).n
    if (used >= cap) return false
    return db.prepare("UPDATE email_candidates SET verification = 'pending', checked_at = ?, verifier = ? WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'none'").run(nowS, verifier.name.slice(0, 40), tenantId, leadId, address).changes === 1
  })
  for (const { address } of rows) {
    if (opts.signal?.aborted) break
    if (!reserve(address)) { run.capped = rows.length - run.checked; break }
    let v: Verification = 'uncertain'
    try { const a = await verifier.verify(address, opts.signal); v = OUTCOME[a?.outcome] ?? 'uncertain' } catch { v = 'uncertain' }
    db.prepare("UPDATE email_candidates SET verification = ? WHERE tenant_id = ? AND lead_id = ? AND address = ? AND verification = 'pending'").run(v, tenantId, leadId, address)
    run.checked++
    if (v === 'verified') run.verified++
  }
  return run
}

export type CandidateLabel = 'published' | 'guessed' | 'guessed, verified' | 'guessed, catch-all' | 'guessed, undeliverable' | 'guessed, uncertain' | 'guessed, refused'
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
// Writes nothing when the flag is off or the lead is not shown to be in the US.
export function recordEmailGuesses(db: Database.Database, tenantId: string, leadId: string, site: string, locals: string[], people: string[], ctx: { env?: Record<string, string | undefined>; homeText?: string; where?: string[]; seen?: { address: string; url: string }[] } = {}): { format: Format | null; confidence: Confidence | null; candidates: number; published: number } | null {
  if (!emailGuessEnabled(ctx.env ?? process.env)) return null
  const us = usEvidence(ctx.homeText, ctx.where)
  if (!us.us) return null
  const seen = (ctx.seen ?? []).filter(x => x.address.includes('@') && sameSite(x.address.split('@')[1], site))
  const names = people.map(p => ({ person: p, name: splitName(p.split(',')[0] ?? '') })).filter((x): x is { person: string; name: Name } => !!x.name)
  const published = names.map(x => ({ ...x, pub: publishedFor(x.name, seen) })).filter((x): x is typeof x & { pub: { address: string; url: string } } => !!x.pub)
  const pattern = rankPattern(locals, names.map(x => x.name))
  if (!pattern && !published.length) return null
  migrateEmailGuess(db)
  let pub = 0, n = 0
  const insPub = db.prepare("INSERT OR IGNORE INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, source_url) VALUES (?, ?, ?, ?, 'published', ?, 'published', ?)")
  for (const x of published) pub += insPub.run(tenantId, leadId, x.person.slice(0, 120), x.pub.address, us.basis, x.pub.url.slice(0, 500)).changes
  if (!pattern) return { format: null, confidence: null, candidates: 0, published: pub }
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
  const hasPub = new Set(published.map(x => x.person))
  const ins = db.prepare("INSERT OR IGNORE INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES (?, ?, ?, ?, ?, ?, 'guessed', ?)")
  for (const x of names) if (!hasPub.has(x.person)) n += ins.run(tenantId, leadId, x.person.slice(0, 120), candidateAddress(x.name, site, pattern.format), pattern.format, us.basis, pattern.confidence).changes
  return { format: pattern.format, confidence: pattern.confidence, candidates: n, published: pub }
}
