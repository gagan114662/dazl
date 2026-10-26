// People search: find the RIGHT PERSON at a lead's company for any business, not only companies whose own site lists a
// team. dazl was company-first (a page shows a company signal, the crawl reads that company's site for people); most
// companies list nobody useful there. Gojiberry-class tools are person-first. The free equivalent used here: a web
// search restricted to public LinkedIn profile URLs for the company plus the ICP's buyer roles, read from the SEARCH
// RESULT (title and snippet) only. dazl never fetches, logs into or scrapes LinkedIn; the result line is the evidence.
//
// A person is kept only when the result's own text names the lead's company and a title sharing ICP buyer-role words.
// Stored as a 'person' enrichment labelled "public search result, not verified as current"; never an address, never
// emailed by itself. TinyFish searches count against the same per-tenant daily cap. Kill switch: PEOPLE_SEARCH_ENABLED=0.
import type Database from 'better-sqlite3'
import { tfSearch, tinyfishEnabled, type SearchHit } from '../search/tinyfish.ts'
import { addEnrichment } from '../connectors/store.ts'
import { companyKey, norm } from '../scan/evidence.ts'
import { titleMatches } from './rank.ts'

export const peopleSearchEnabled = (env: Record<string, string | undefined> = process.env) => env.PEOPLE_SEARCH_ENABLED !== '0' && tinyfishEnabled(env)
export const MAX_COMPANIES = 5 // one search per company, best leads first
export const MAX_PEOPLE = 3    // kept per company
export const DEADLINE_MS = 30_000 // whole people pass; the awaited searches run after bounded post-processing, so they get their own wall
export const CONNECTOR = 'search:people'
export const LABEL = 'public search result (profile title), not verified as current staff'

const PROFILE = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/
// A role the result itself marks as past, in any of the title line's languages we search. Such a person is not a buyer now.
const PAST = /\b(?:former|formerly|previous|previously|past|ex|retired|emeritus|ehemalig\w*|ancien\w*|antigu\w*|exdirector\w*)\b|\bex-/i
const NAME = /^(?:(?:Dr|Mr|Ms|Mrs)\.?\s+)?[\p{Lu}][\p{L}'’-]{1,24}(?:\s+[\p{Lu}]\.?)?(?:\s+[\p{Lu}][\p{L}'’-]{1,24}){1,2}$/u

// Query: the company in quotes plus up to 3 buyer roles in quotes. site: restricts to public profiles.
export function peopleQuery(company: string, roles: string[]): string | null {
  const c = company.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()
  const rs = roles.map(r => r.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(r => r.length >= 2 && r.length <= 40).slice(0, 3)
  if (c.length < 2 || rs.length === 0) return null
  return `site:linkedin.com/in "${c}" (${rs.map(r => `"${r}"`).join(' OR ')})`
}

// Profile result titles look like "Jane Doe - Head of HR - Acme Logistics | LinkedIn" or
// "Jane Doe – Head of HR at Acme Logistics | LinkedIn". Returns name and title only when the line itself names the company.
export function parseProfileHit(h: SearchHit, company: string): { name: string; title: string } | null {
  if (!PROFILE.test(h.url.split('?')[0])) return null
  const line = h.title.replace(/\s*[|·]\s*LinkedIn.*$/i, '').trim()
  const parts = line.split(/\s+[-–—]\s+/)
  if (parts.length < 2) return null
  const name = parts[0].trim()
  if (!NAME.test(name)) return null
  // Exactly one role with exactly one employer attached to it (Instinct #193 recheck). Two shapes only:
  //   "Name - Title at Employer"   (2 parts)    and    "Name - Title - Employer"   (3 parts)
  // Any extra fragment ("... - Advisor to Acme", "... - Acme customer") makes the association ambiguous, so it drops: a
  // current Rival Corp employee must not attach to Acme because Acme is mentioned somewhere else on the line.
  // Past role marked on the line: refuse ("Former HR Manager at Acme" is not a current buyer).
  if (PAST.test(parts.slice(1).join(' '))) return null
  let title = parts[1].trim(); let employer = ''
  const at = /^(.*?)\s+(?:at|@|bei|chez|en|em|presso)\s+(.+)$/i.exec(title)
  if (at) { if (parts.length !== 2) return null; title = at[1].trim(); employer = at[2] }
  else { if (parts.length !== 3) return null; employer = parts[2] }
  const key = companyKey(company)
  // The employer attached to the role must BE the lead's company (legal suffixes ignored), not merely contain its words.
  if (key.length < 3 || companyKey(employer) !== key) return null
  if (title.length < 2 || title.length > 80) return null
  return { name, title }
}

type Lead = { id: string; company: string }
// Runs after a scan finishes. Never throws; returns how many people were stored.
export async function findPeople(db: Database.Database, tenantId: string, jobId: string, deps: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; deadlineMs?: number } = {}): Promise<number> {
  try {
    const env = deps.env ?? process.env
    if (!peopleSearchEnabled(env)) return 0
    // Job ownership first: the job id alone must never let one tenant read or write another's leads.
    const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown; country?: unknown; language?: unknown }) : null
    const roles = Array.isArray(who?.who) ? (who!.who as unknown[]).filter((x): x is string => typeof x === 'string') : []
    if (roles.length === 0) return 0 // no buyer roles: nothing to search for
    const roleText = roles.join('; ')
    const geo = { ...(typeof who?.country === 'string' ? { location: who.country } : {}), ...(typeof who?.language === 'string' ? { language: who.language } : {}) }
    const leads = db.prepare("SELECT id, company FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND quarantined_at IS NULL AND company <> '' ORDER BY COALESCE(fit, 0) DESC, score DESC LIMIT ?").all(jobId, MAX_COMPANIES) as Lead[]
    const now = Math.floor((deps.now ?? Date.now()) / 1000); const today = new Date(now * 1000).toISOString().slice(0, 10)
    const spent = { searches: 0 }
    let stored = 0
    const seenCompany = new Set<string>()
    const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS)
    for (const l of leads) {
      if (Date.now() >= deadline) break
      const ck = companyKey(l.company); if (seenCompany.has(ck)) continue; seenCompany.add(ck)
      const q = peopleQuery(l.company, roles); if (!q) continue
      // tfSearch has no abort signal: race it against what is left of the deadline so a hung search cannot stall the scan.
      // The tenant daily/global caps and per-minute rate inside tfSearch are shared with the main scan's searches.
      let timer: ReturnType<typeof setTimeout> | undefined
      const r = await Promise.race([
        tfSearch(db, tenantId, q, geo, spent, { env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }),
        new Promise<null>(res => { timer = setTimeout(() => res(null), Math.max(0, deadline - Date.now())) }),
      ]).finally(() => clearTimeout(timer))
      if (!r) break // deadline hit
      if (!r.ok) { if (r.reason === 'cap' || r.reason === 'quota' || r.reason === 'auth') break; continue }
      const people = r.hits.map(h => ({ h, p: parseProfileHit(h, l.company) }))
        .filter((x): x is { h: SearchHit; p: { name: string; title: string } } => !!x.p && titleMatches(x.p.title, roleText).length > 0)
        .sort((a, b) => titleMatches(b.p.title, roleText).length - titleMatches(a.p.title, roleText).length)
      const seen = new Set<string>()
      for (const { h, p } of people) {
        if (seen.has(p.name.toLowerCase()) || seen.size >= MAX_PEOPLE) continue
        seen.add(p.name.toLowerCase())
        addEnrichment(db, tenantId, l.id, { connector: CONNECTOR, kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 120), label: LABEL, confidence: null, source_url: h.url.split('?')[0].slice(0, 500), source_date: h.date ?? today, retrieved_at: now })
        stored++
      }
    }
    return stored
  } catch (e) {
    console.error('people search failed', e instanceof Error ? e.message : 'error')
    return 0
  }
}
