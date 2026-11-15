// Research engine: the contact half that replaces the paid vendors (Refs #1099, Gagan's rule 15 Nov: no paid third-party API except Claude;
// lib/paid-vendors.ts). After the runner saved a scan's research leads, each lead gets:
//   1. the addresses company research (part G, lib/research/company.ts) found PRINTED on the company's own pages, each with that page
//      (kind 'email', connector 'research'): published, never guessed. Before this the engine found them and dropped them (contact: null);
//   2. for its named person, when none of those addresses is theirs and guesses are on (EMAIL_GUESS_ENABLED=1, as for every guess):
//      ONE pattern guess from the formats this workspace has already confirmed at that domain (lib/people/email-formats.ts guessFromLearnedFormat, with all its guards; stored apart from the lead as
//      "guessed, unverified", never counted as an email), and only when the domain publishes a mail server (a free DNS MX lookup).
// No paid call and no mailbox check (ZeroBounce stays off): an unverified guess says so.
import type Database from 'better-sqlite3'
import { promises as dns } from 'node:dns'
import type { VerifiedLead } from './types.ts'
import { addEnrichment } from '../connectors/store.ts'
import { guessFromLearnedFormat } from '../people/email-formats.ts'
import { FORMATS, emailGuessEnabled, localFor, splitName } from '../people/email-pattern.ts'

export const MAX_PUBLISHED = 3
export type MxLookup = (domain: string) => Promise<boolean>
// A domain that names at least one mail server can receive mail at all. A lookup that fails or times out is "no" (no guess is made).
// A null MX (RFC 7505: one record, exchange ".") says the domain takes no mail.
export const mxLookup: MxLookup = async domain => {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([dns.resolveMx(domain), new Promise<never>((_, j) => { t = setTimeout(() => j(new Error('timeout')), MX_TIMEOUT_MS) })])
    return Array.isArray(r) && r.some(x => !!x.exchange && x.exchange !== '.')
  } catch { return false } finally { if (t) clearTimeout(t) }
}
export const MX_TIMEOUT_MS = 3000, MX_BUDGET_MS = 8000

const key = (sourceUrl: string, company: string) => `${sourceUrl}|${company.toLowerCase().trim()}`
const host = (u: string | null): string => { try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : '' } catch { return '' } }
// the named person's own address: its local part IS one of the name formats the guesser knows (first.last, flast, f.last, ...), as a whole.
// One-name formats (first@, last@) name nobody in particular and never count; no substring or initial matching (council review: "hello@"
// for "Hannah Lo", "fleet@" for "Fred Lee" are not theirs).
const TWO_NAME = FORMATS.filter(f => f !== 'first' && f !== 'last')
export function isTheirs(email: string, person: string): boolean {
  const n = splitName(person); if (!n) return false
  const local = (email.split('@')[0] ?? '').toLowerCase()
  return TWO_NAME.some(f => localFor(f, n) === local)
}

export interface ContactsResult { published: number; guessed: number; no_mx: number; mx_skipped: number; leads: number }

export async function saveResearchContacts(db: Database.Database, jobId: string, leads: VerifiedLead[], o: { mx?: MxLookup; mxBudgetMs?: number; env?: Record<string, string | undefined>; now?: Date } = {}): Promise<ContactsResult> {
  const out: ContactsResult = { published: 0, guessed: 0, no_mx: 0, mx_skipped: 0, leads: 0 }
  const job = db.prepare('SELECT user_id FROM scan_jobs WHERE id = ?').get(jobId) as { user_id: string } | undefined
  if (!job) return out
  const byKey = new Map(leads.map(l => [key(l.event.sourceUrl, l.event.company), l]))
  const now = o.now ?? new Date()
  const today = now.toISOString().slice(0, 10), at = Math.floor(now.getTime() / 1000)
  const mx = o.mx ?? mxLookup
  // one MX lookup per domain per scan, and all of them inside one budget: the scan is already 'done', this must not hold it open
  const mxSeen = new Map<string, Promise<boolean | null>>()
  const mxBy = o.mxBudgetMs ?? MX_BUDGET_MS, mxStart = Date.now()
  // null: the budget was spent before this domain was asked (no guess; counted apart from a domain that takes no mail)
  const takesMail = (d: string): Promise<boolean | null> => { let p = mxSeen.get(d); if (!p) { p = Date.now() - mxStart > mxBy ? Promise.resolve(null) : mx(d); mxSeen.set(d, p) } return p }
  const guessing = emailGuessEnabled(o.env)
  for (const row of db.prepare('SELECT id, company, source_url FROM leads WHERE scan_job_id = ?').all(jobId) as { id: string; company: string; source_url: string }[]) {
    const l = byKey.get(key(row.source_url, row.company))
    if (!l) continue
    out.leads++
    const site = host(l.company.site)
    const person = l.verification.personOk ? l.company.person : null
    // 1. published: only the company's own domain (company.ts keeps only those), with the page it was printed on
    // the site or its subdomains only: a parent domain can be a hosting platform's (acme.webflow.io is not webflow.io), so it is not the company's.
    // Deliberately stricter than company research's own list (company.ts ownEmails also keeps a parent domain): a lead only keeps what is surely theirs
    const atSite = (email: string) => { const d = (email.split('@')[1] ?? '').toLowerCase(); return !!site && !!d && (d === site || d.endsWith(`.${site}`)) }
    const mine = l.company.emails.filter(e => atSite(e.email)).slice(0, MAX_PUBLISHED)
    for (const e of mine) {
      const theirs = !!person && isTheirs(e.email, person.name)
      try {
        addEnrichment(db, job.user_id, row.id, { connector: 'research', kind: 'email', value: e.email.toLowerCase().slice(0, 254), label: (theirs ? `published: ${person!.name}, printed on the company website` : 'published: printed on the company website').slice(0, 200), confidence: null, source_url: e.url.slice(0, 500), source_date: today, retrieved_at: at })
        out.published++
      } catch { /* one row never stops the rest */ }
    }
    // 2. the named person without an address of their own: one guess from the workspace's learned format, only for a domain that takes mail
    // (guesses are off unless EMAIL_GUESS_ENABLED=1, as everywhere: no DNS lookup is made then)
    if (guessing && person && site && !mine.some(e => isTheirs(e.email, person.name))) {
      const mail = await takesMail(site)
      if (mail === null) { out.mx_skipped++; continue }
      if (!mail) { out.no_mx++; continue }
      try { if (guessFromLearnedFormat(db, job.user_id, row.id, { name: person.name, title: person.title }, site, [], o.env)) out.guessed++ } catch { /* a guess is a bonus */ }
    }
  }
  return out
}

// The research scan's after-save step (registered by default in scan-job.ts, so it runs whichever stages are wired): never fails the scan.
export async function researchContactsAfterSave(db: Database.Database, jobId: string, run: { leads: VerifiedLead[] }): Promise<void> {
  try { console.error(`[research] contacts for job ${jobId}: ${JSON.stringify(await saveResearchContacts(db, jobId, run.leads))}`) }
  catch (e) { console.error(`[research] contacts for job ${jobId} failed: ${String((e as Error)?.message ?? e).slice(0, 120)}`) }
}
