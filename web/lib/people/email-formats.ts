// #1036: a company's address FORMAT learned across one tenant's own already-confirmed addresses, and an honestly labelled guess
// built from it for a buyer whose own address is not published. The format is worked out on demand from the confirmed rows and is
// never stored on its own: a stored copy of the evidence would outlive the lead it came from (a lead's deletion removes its candidate
// rows), so what is shown is always what the tenant still holds. Free sources only: nothing here calls a provider, a verifier or
// the network; it reads rows the tenant already holds.
//
// Confirmed addresses (per tenant, per domain):
//   - published-tier email_candidates: an address printed on the company's own confirmed site, with the page it was printed on;
//   - work_email_lookups rows that are 'published' (same thing, with its page) or 'verified' (Apollo's own verified answer on the
//     tenant's own key, already stored).
// The format is ranked by the existing rankPattern (lib/people/email-pattern.ts): one confirmed address is a 'low' pattern, two or more
// different people with no rival format 'high'. A format that names no part of the person but the first or the last name alone
// ('nora@') needs two people before it is learned: one person's address says too little about everyone else's.
// Guards, all fail closed:
//   - US only (docs/DECISIONS.md 2026-10-26): a guess carries the country basis of a supporting published row; no such row, no guess;
//   - never for a person who has a published address (that is the published tier), never a shared inbox, never an address two named
//     people of the lead could both own, never an address someone else already has confirmed;
//   - off unless EMAIL_GUESS_ENABLED=1, like every guessed address;
//   - tenant scoped in every query; the table holds no data of another tenant and is never shared.
// What a guess is: stored in email_candidates as tier 'guessed', verification 'none' (it was not checked) and shown only labelled
// "guessed, unverified" (or "guessed, verified" when a mailbox check really answered valid). It is never a draft recipient and never
// "published" (candidateLabel, email-pattern.ts, decides the label; outreach reads published addresses only).
import type Database from 'better-sqlite3'
import { ROLE } from '../connectors/sitecrawl.ts'
import { candidateLabel, emailGuessEnabled, localFor, ownersOf, rankPattern, splitName, type Confidence, type Format, type Name } from './email-pattern.ts'

export interface Confirmed { name: Name; person: string; address: string; url: string | null; basis: string | null; source: 'published' | 'lookup' }
export interface LearnedFormat { domain: string; format: Format; support: number; confidence: Confidence; score: number; basis: string; evidence: { person: string; address: string; url: string | null }[] }

const noTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message))
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()
// A domain this module is willing to build addresses on: letters, digits, dots and hyphens, at least one dot.
const SAFE_DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/

// Every address this tenant already holds as confirmed at exactly this domain (a subdomain's address does not teach the parent's
// format). Missing tables (a store where the finder never ran) are simply no addresses.
export function confirmedAddressesAt(db: Database.Database, tenantId: string, domain: string): Confirmed[] {
  const d = domain.toLowerCase()
  if (!SAFE_DOMAIN.test(d)) return []
  const out = new Map<string, Confirmed>()
  const add = (c: Confirmed | null) => { if (c && domainOf(c.address) === d && !out.has(c.address)) out.set(c.address, c) }
  try {
    for (const r of db.prepare("SELECT person, address, source_url, country_basis FROM email_candidates WHERE tenant_id = ? AND tier = 'published' AND source_url IS NOT NULL AND lower(address) LIKE ? ORDER BY address LIMIT 200").all(tenantId, `%@${d}`) as { person: string; address: string; source_url: string; country_basis: string | null }[]) {
      const name = splitName(r.person.split(',')[0] ?? '')
      if (name) add({ name, person: r.person, address: r.address.toLowerCase(), url: r.source_url, basis: r.country_basis, source: 'published' })
    }
  } catch (e) { if (!noTable(e)) throw e }
  try {
    for (const r of db.prepare("SELECT target, address, provider, source_url FROM work_email_lookups WHERE tenant_id = ? AND status IN ('published','verified') AND address IS NOT NULL AND lower(address) LIKE ? ORDER BY address LIMIT 200").all(tenantId, `%@${d}`) as { target: string; address: string; provider: string | null; source_url: string | null }[]) {
      const name = splitName((r.target.split('|')[0] ?? ''))
      // a lookup row has no country basis of its own: it teaches the format but cannot vouch for a country
      if (name) add({ name, person: r.target.split('|').join(', '), address: r.address.toLowerCase(), url: r.source_url, basis: null, source: 'lookup' })
    }
  } catch (e) { if (!noTable(e)) throw e }
  return [...out.values()]
}

// The format this tenant's confirmed addresses at `domain` support, or null. Pure over the rows given.
export function rankConfirmed(domain: string, confirmed: Confirmed[]): LearnedFormat | null {
  const people = new Map<string, Name>()
  for (const c of confirmed) people.set(`${c.name.first} ${c.name.last}`, c.name)
  const ranked = rankPattern(confirmed.map(c => c.address.split('@')[0]), [...people.values()])
  if (!ranked) return null
  if ((ranked.format === 'first' || ranked.format === 'last') && ranked.support < 2) return null
  const basis = confirmed.find(c => c.basis && ranked.supporters.some(s => s.first === c.name.first && s.last === c.name.last))?.basis ?? confirmed.find(c => c.basis)?.basis ?? null
  if (!basis) return null // US only: no supporting published row with a US basis, no format worth guessing from
  const evidence: LearnedFormat['evidence'] = []
  for (const c of confirmed) {
    if (!ranked.supporters.some(s => s.first === c.name.first && s.last === c.name.last)) continue
    if (JSON.stringify([...evidence, { person: c.person, address: c.address, url: c.url }]).length > 1900) break
    evidence.push({ person: c.person.slice(0, 120), address: c.address, url: c.url })
  }
  if (!evidence.length) return null
  return { domain, format: ranked.format, support: ranked.support, confidence: ranked.confidence, score: ranked.score, basis, evidence }
}

// The format this tenant's confirmed addresses at `domain` support, or null. Read-only: nothing is stored.
export function learnedFormat(db: Database.Database, tenantId: string, domain: string): LearnedFormat | null {
  const d = domain.toLowerCase()
  return rankConfirmed(d, confirmedAddressesAt(db, tenantId, d))
}

// ---- the guess shown on a lead ------------------------------------------------------------------------------------------------
export type GuessLabel = 'guessed, verified' | 'guessed, unverified'
export interface GuessView {
  person: string; address: string; label: GuessLabel
  // why it is only "unverified" (a catch-all domain, a check that did not finish, none yet) or who checked it and when
  state: 'not_checked' | 'catch_all' | 'uncertain' | 'verified'
  verifier: string | null; checked_at: number | null
  format: string; confidence: Confidence | null; domain: string
  // the confirmed addresses that taught the format, each with the page it was printed on (null for an Apollo-verified one)
  learned_from: { person: string; address: string; url: string | null }[]
}

// Build and store ONE guess for this person from the tenant's learned format at the lead's site. Returns null (and stores nothing)
// unless every guard holds. `others`: the lead's other named people (an address two of them could own is nobody's).
export function guessFromLearnedFormat(db: Database.Database, tenantId: string, leadId: string, p: { name: string; title: string | null }, site: string, others: Name[], env: Record<string, string | undefined> = process.env): GuessView | null {
  if (!emailGuessEnabled(env)) return null
  const domain = site.toLowerCase()
  if (!SAFE_DOMAIN.test(domain)) return null
  const name = splitName(p.name)
  if (!name) return null
  const confirmed = confirmedAddressesAt(db, tenantId, domain)
  const learned = rankConfirmed(domain, confirmed)
  if (!learned) return null
  // this person's own confirmed address is the published tier, not a guess
  if (confirmed.some(c => c.name.first === name.first && c.name.last === name.last)) return null
  const local = localFor(learned.format, name)
  if (ROLE.test(local.replace(/[._-]/g, ''))) return null
  const address = `${local}@${domain}`
  if (address.length > 254) return null
  if (confirmed.some(c => c.address === address)) return null // someone else's confirmed address
  const everyone = [name, ...others.filter(o => !(o.first === name.first && o.last === name.last))]
  if (ownersOf(local, everyone).length > 1) return null // another named person could own it
  try {
    db.prepare("INSERT OR IGNORE INTO email_candidates (tenant_id, lead_id, person, address, format, country_basis, tier, confidence) VALUES (?, ?, ?, ?, ?, ?, 'guessed', ?)")
      .run(tenantId, leadId, `${p.name}${p.title ? `, ${p.title}` : ''}`.slice(0, 120), address, learned.format, learned.basis.slice(0, 160), learned.confidence)
  } catch (e) { if (noTable(e)) return null; throw e }
  return guessFor(db, tenantId, leadId, p.name, env)
}

// The guess stored for this person on this lead, as it may be SHOWN: only with the flag on; an address the mailbox check found does
// not exist or flagged do-not-mail is never returned. Read-only.
export function guessFor(db: Database.Database, tenantId: string, leadId: string, personName: string, env: Record<string, string | undefined> = process.env): GuessView | null {
  if (!emailGuessEnabled(env)) return null
  const want = splitName(personName)
  if (!want) return null
  let rows: { person: string; address: string; format: string; confidence: Confidence | null; verification: string; verifier: string | null; checked_at: number | null; country_basis: string | null; tier: string; source_url: string | null }[]
  try { rows = db.prepare("SELECT person, address, format, confidence, verification, verifier, checked_at, country_basis, tier, source_url FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed' AND country_basis IS NOT NULL ORDER BY address").all(tenantId, leadId) as typeof rows }
  catch (e) { if (noTable(e)) return null; throw e }
  const mine = rows.filter(r => { const n = splitName(r.person.split(',')[0] ?? ''); return !!n && n.first === want.first && n.last === want.last })
  // two different guesses for the same person: which one is theirs is not settled, so neither is shown
  if (new Set(mine.map(r => r.address)).size !== 1) return null
  const r = mine[0]
  if (r.verification === 'undeliverable' || r.verification === 'refused') return null
  const label = candidateLabel(r)
  const verified = label === 'guessed, verified'
  const domain = domainOf(r.address)
  const learned = learnedFormat(db, tenantId, domain)
  return {
    person: r.person.split(',')[0] ?? r.person, address: r.address, label: verified ? 'guessed, verified' : 'guessed, unverified',
    state: verified ? 'verified' : r.verification === 'catch_all' ? 'catch_all' : r.verification === 'uncertain' || r.verification === 'pending' ? 'uncertain' : 'not_checked',
    verifier: verified ? r.verifier : null, checked_at: verified ? r.checked_at : null,
    format: r.format, confidence: r.confidence, domain, learned_from: learned?.evidence ?? [],
  }
}

// Every shown guess of this lead (the GET read that survives a reload).
export function guessesForLead(db: Database.Database, tenantId: string, leadId: string, env: Record<string, string | undefined> = process.env): GuessView[] {
  if (!emailGuessEnabled(env)) return []
  let people: string[]
  try { people = (db.prepare("SELECT DISTINCT person FROM email_candidates WHERE tenant_id = ? AND lead_id = ? AND tier = 'guessed'").all(tenantId, leadId) as { person: string }[]).map(r => r.person.split(',')[0] ?? r.person) }
  catch (e) { if (noTable(e)) return []; throw e }
  return people.map(p => guessFor(db, tenantId, leadId, p, env)).filter((g): g is GuessView => !!g)
}
