// Email finder, part 1 (docs/design/email-finder.md). Learns a company's address FORMAT from personal addresses it
// publishes on its own site, and prepares candidate addresses for people the crawl found on that site.
// Nothing here is shown, stored as a contact, or sent: candidates are UNVERIFIED and live in their own tables
// (email_patterns, email_candidates), which no page and no outreach path reads. Showing a guessed address needs
// mailbox verification and the US-only rule (docs/DECISIONS.md), which are parts 2-3 and not built.
// Off unless EMAIL_GUESS_ENABLED=1.
import type Database from 'better-sqlite3'
import { ROLE, sameSite } from '../connectors/sitecrawl.ts'

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

// A format counts only when it reproduces a published address for a person named on the same site. The best format
// needs 2+ distinct supporting people and must be strictly ahead of the runner-up; anything else is no pattern.
export function inferPattern(locals: string[], people: Name[]): { format: Format; support: number } | null {
  const have = new Set(locals)
  const support = new Map<Format, Set<string>>()
  for (const p of people) for (const f of FORMATS) if (have.has(localFor(f, p))) {
    if (!support.has(f)) support.set(f, new Set())
    support.get(f)!.add(`${p.first} ${p.last}`)
  }
  const ranked = [...support.entries()].map(([format, s]) => ({ format, support: s.size })).sort((a, b) => b.support - a.support)
  if (!ranked.length || ranked[0].support < 2) return null
  if (ranked[1] && ranked[1].support === ranked[0].support) return null // ambiguous (e.g. single-name people fit two formats)
  return ranked[0]
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
}

// Called by the crawl for one lead and its confirmed site. people: "Name, Title" values from extractPeople.
export function recordEmailGuesses(db: Database.Database, tenantId: string, leadId: string, site: string, locals: string[], people: string[]): { format: Format; candidates: number } | null {
  const names = people.map(p => ({ person: p, name: splitName(p.split(',')[0] ?? '') })).filter((x): x is { person: string; name: Name } => !!x.name)
  const pattern = inferPattern(locals, names.map(x => x.name))
  if (!pattern) return null
  migrateEmailGuess(db)
  db.prepare('INSERT OR REPLACE INTO email_patterns (tenant_id, lead_id, site, format, support) VALUES (?, ?, ?, ?, ?)').run(tenantId, leadId, site, pattern.format, pattern.support)
  const ins = db.prepare("INSERT OR IGNORE INTO email_candidates (tenant_id, lead_id, person, address, format) VALUES (?, ?, ?, ?, ?)")
  let n = 0
  for (const x of names) n += ins.run(tenantId, leadId, x.person.slice(0, 120), candidateAddress(x.name, site, pattern.format), pattern.format).changes
  return { format: pattern.format, candidates: n }
}
