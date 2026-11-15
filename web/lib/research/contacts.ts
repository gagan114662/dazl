// Research engine: the contact half that replaces the paid vendors (Refs #1099, Gagan's rule 15 Nov: no paid third-party API except Claude;
// lib/paid-vendors.ts). After the runner saved a scan's research leads, each lead gets:
//   1. the addresses company research (part G, lib/research/company.ts) found PRINTED on the company's own pages, each with that page
//      (kind 'email', connector 'research'): published, never guessed. Before this the engine found them and dropped them (contact: null);
//   2. for its named person, when none of those addresses is theirs: ONE pattern guess from the formats this workspace has already
//      confirmed at that domain (lib/people/email-formats.ts guessFromLearnedFormat, with all its guards; stored apart from the lead as
//      "guessed, unverified", never counted as an email), and only when the domain publishes a mail server (a free DNS MX lookup).
// No paid call and no mailbox check (ZeroBounce stays off): an unverified guess says so.
import type Database from 'better-sqlite3'
import { promises as dns } from 'node:dns'
import type { VerifiedLead } from './types.ts'
import { addEnrichment } from '../connectors/store.ts'
import { guessFromLearnedFormat } from '../people/email-formats.ts'
import { splitName } from '../people/email-pattern.ts'

export const MAX_PUBLISHED = 3
export type MxLookup = (domain: string) => Promise<boolean>
// A domain that names at least one mail server can receive mail at all. A lookup that fails or times out is "no" (no guess is made).
export const mxLookup: MxLookup = async domain => {
  try { const r = await Promise.race([dns.resolveMx(domain), new Promise<never>((_, j) => setTimeout(() => j(new Error('timeout')), 3000))]); return Array.isArray(r) && r.some(x => !!x.exchange) }
  catch { return false }
}

const key = (sourceUrl: string, company: string) => `${sourceUrl}|${company.toLowerCase().trim()}`
const host = (u: string | null): string => { try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : '' } catch { return '' } }
// the named person's own address: its local part carries their last name, or first initial + last name, or first.last
function isTheirs(email: string, person: string): boolean {
  const n = splitName(person); if (!n) return false
  const local = (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-z]/g, '')
  return local.includes(n.last) && (local.length > n.last.length ? local.includes(n.first) || local.startsWith(n.first[0]) : true)
}

export interface ContactsResult { published: number; guessed: number; no_mx: number; leads: number }

export async function saveResearchContacts(db: Database.Database, jobId: string, leads: VerifiedLead[], o: { mx?: MxLookup; env?: Record<string, string | undefined>; now?: Date } = {}): Promise<ContactsResult> {
  const out: ContactsResult = { published: 0, guessed: 0, no_mx: 0, leads: 0 }
  const job = db.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(jobId) as { user_id: string } | undefined
  if (!job) return out
  const byKey = new Map(leads.map(l => [key(l.event.sourceUrl, l.event.company), l]))
  const now = o.now ?? new Date()
  const today = now.toISOString().slice(0, 10), at = Math.floor(now.getTime() / 1000)
  const mx = o.mx ?? mxLookup
  for (const row of db.prepare('SELECT id, company, source_url FROM leads WHERE scan_job_id = ?').all(jobId) as { id: string; company: string; source_url: string }[]) {
    const l = byKey.get(key(row.source_url, row.company))
    if (!l) continue
    out.leads++
    const site = host(l.company.site)
    const person = l.verification.personOk ? l.company.person : null
    // 1. published: only the company's own domain (company.ts keeps only those), with the page it was printed on
    const atSite = (email: string) => { const d = (email.split('@')[1] ?? '').toLowerCase(); return !!site && (d === site || d.endsWith(`.${site}`)) }
    const mine = l.company.emails.filter(e => atSite(e.email)).slice(0, MAX_PUBLISHED)
    for (const e of mine) {
      const theirs = !!person && isTheirs(e.email, person.name)
      try {
        addEnrichment(db, job.user_id, row.id, { connector: 'research', kind: 'email', value: e.email.toLowerCase().slice(0, 254), label: (theirs ? `published: ${person!.name}, printed on the company website` : 'published: printed on the company website').slice(0, 200), confidence: null, source_url: e.url.slice(0, 500), source_date: today, retrieved_at: at })
        out.published++
      } catch { /* one row never stops the rest */ }
    }
    // 2. the named person without an address of their own: one guess from the workspace's learned format, only for a domain that takes mail
    if (person && site && !mine.some(e => isTheirs(e.email, person.name))) {
      if (!(await mx(site))) { out.no_mx++; continue }
      try { if (guessFromLearnedFormat(db, job.user_id, row.id, { name: person.name, title: person.title }, site, [], o.env)) out.guessed++ } catch { /* a guess is a bonus */ }
    }
  }
  return out
}
