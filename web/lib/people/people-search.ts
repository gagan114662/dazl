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
import { tfSearch, tinyfishEnabled, limits, TINYFISH_TIMEOUT_MS, type SearchHit } from '../search/tinyfish.ts'
import { addEnrichment } from '../connectors/store.ts'
import { companyKey } from '../scan/evidence.ts'
import { titleMatches } from './rank.ts'
import { leadPerson } from './lead-person.ts'
import { placeAgreement } from '../scan/place-agreement.ts'
import { firstPlaceLabel, leadPlaceLabel, recordContactRejection } from '../scan/contact-agreement.ts'

export const peopleSearchEnabled = (env: Record<string, string | undefined> = process.env) => env.PEOPLE_SEARCH_ENABLED !== '0' && tinyfishEnabled(env)
export const MAX_COMPANIES = 5 // one search per company, best leads first
export const MAX_PEOPLE = 3    // kept per company
export const DEADLINE_MS = 30_000 // whole people pass; the awaited searches run after bounded post-processing, so they get their own wall
export const CONNECTOR = 'search:people'
export const LABEL = 'public search result (profile title), not verified as current staff'
export { FIRST_PLAY_MAX, firstPlayPeopleCap } from './first-play-cap.ts'
import { FIRST_PLAY_MAX } from './first-play-cap.ts'

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
  const v = profileHit(h, company)
  return typeof v === 'string' ? null : v
}
// Why a search result was not read as a person at the company (the run report counts these per cause, PeopleStats.refused):
//   not_profile     the result is not a public profile URL
//   unreadable      the result line is not "Name - Title - Employer" / "Name - Title at Employer" with a plausible full name
//   past_role       the line marks the role as past
//   other_employer  the employer attached to the role is not the lead's company (or the line names more than one)
export type ProfileRefusal = 'not_profile' | 'unreadable' | 'past_role' | 'other_employer'
export function profileHit(h: SearchHit, company: string): { name: string; title: string } | ProfileRefusal {
  if (!PROFILE.test(h.url.split('?')[0])) return 'not_profile'
  const line = h.title.replace(/\s*[|·]\s*LinkedIn.*$/i, '').trim()
  const parts = line.split(/\s+[-–—]\s+/)
  if (parts.length < 2) return 'unreadable'
  const name = parts[0].trim()
  if (!NAME.test(name)) return 'unreadable'
  // Exactly one role with exactly one employer attached to it (Instinct #193 recheck). Two shapes only:
  //   "Name - Title at Employer"   (2 parts)    and    "Name - Title - Employer"   (3 parts)
  // Any extra fragment ("... - Advisor to Acme", "... - Acme customer") makes the association ambiguous, so it drops: a
  // current Rival Corp employee must not attach to Acme because Acme is mentioned somewhere else on the line.
  // Past role marked on the line: refuse ("Former HR Manager at Acme" is not a current buyer).
  if (PAST.test(parts.slice(1).join(' '))) return 'past_role'
  let title = parts[1].trim(); let employer = ''
  const at = /^(.*?)\s+(?:at|@|bei|chez|en|em|presso)\s+(.+)$/i.exec(title)
  if (at) { if (parts.length !== 2) return 'other_employer'; title = at[1].trim(); employer = at[2] }
  else { if (parts.length !== 3) return 'other_employer'; employer = parts[2] }
  const key = companyKey(company)
  // The employer attached to the role must BE the lead's company (legal suffixes ignored), not merely contain its words.
  if (key.length < 3 || companyKey(employer) !== key) return 'other_employer'
  if (title.length < 2 || title.length > 80) return 'unreadable'
  return { name, title }
}

import { SEARCHABLE_HOLDS } from './searchable-holds.ts'
export { SEARCHABLE_HOLDS, peopleSearchable } from './searchable-holds.ts'
const SEARCHABLE_SQL = `(review_reason IS NULL OR review_reason IN (${SEARCHABLE_HOLDS.map(r => `'${r}'`).join(',')}))`

// What one pass did, for the run report (#1037): a pass that searched nothing must never read as "searched, found nobody".
//   eligible        leads the pass could search (ready first, then held ones); held = how many of those are held for review
//   already_named   leads skipped because the row already names its person (first play / trial only)
//   searched        searches sent; results = results returned; profiles = results read as a person at the lead's company
//   refused         results not kept, by cause: the ProfileRefusal causes, role (title shares no buyer-role word) and place
//   failed          searches sent (or stopped at our own gate) that got no answer, by cause (FAILED_SEARCH); searched counts them too
//   no_roles        the request names no buyer role, so the pass had nothing to search for and read no lead
export interface PeopleStats { eligible: number; held: number; already_named: number; searched: number; results: number; profiles: number; refused: Record<string, number>; failed: Record<string, number>; no_roles?: boolean }
const FAILED_SEARCH: readonly string[] = ['unavailable', 'rate', 'cap', 'quota', 'auth', 'disabled']
const failedSearches = (s: PeopleStats): number => { let t = 0; for (const k of [...FAILED_SEARCH, 'other']) { const v = s.failed?.[k]; if (Number.isSafeInteger(v) && v > 0) t += v } return t }
const failedCauses = (s: PeopleStats): string => [...FAILED_SEARCH, 'other'].filter(k => Number.isSafeInteger(s.failed?.[k]) && s.failed[k] > 0).map(k => `${k} x${s.failed[k]}`).join(', ')
export const newPeopleStats = (): PeopleStats => ({ eligible: 0, held: 0, already_named: 0, searched: 0, results: 0, profiles: 0, refused: {}, failed: {} })
// The flat detail the trace stores (numbers only; a cause with no refusal is left out).
export function peopleStatsDetail(s: PeopleStats): Record<string, number> {
  const n = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 ? v as number : 0
  const out: Record<string, number> = { eligible: n(s.eligible), held_eligible: n(s.held), searched: n(s.searched), results: n(s.results), profile_results: n(s.profiles) }
  if (n(s.already_named) > 0) out.already_named = n(s.already_named)
  for (const k of ['not_profile', 'unreadable', 'past_role', 'other_employer', 'role', 'place']) if (n(s.refused?.[k]) > 0) out[`refused_${k}`] = n(s.refused[k])
  for (const k of [...FAILED_SEARCH, 'other']) if (n(s.failed?.[k]) > 0) out[`search_failed_${k}`] = n(s.failed[k])
  return out
}

type Lead = { id: string; company: string; review_reason: string | null }
// First-play options (#1037). maxCompanies: searches allowed in this pass (one per company), replacing MAX_COMPANIES.
// skipNamed: leads that already have a titled person stored (e.g. listed on their own site) get no search.
// charge: the free-trial scan's per-search charge (runner trialCharges); canSearch: checked before every search, false
// stops the pass (a trial scan keeps budget for the checks that run after it). onStop records why the pass stopped early.
// alive: the job attempt still owns the run (runner postFinishAlive); checked before every search and before writing its result.
// stats: filled in as the pass runs (newPeopleStats()), for the run report.
// drainMs: how long the pass waits, after its deadline, for the search still in flight (default: the TinyFish transport timeout
// plus 1 s, by which the real transport has given up; a fetch stub that ignores its abort signal is abandoned after it).
export interface PeopleOpts { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; deadlineMs?: number; drainMs?: number; aliveEveryMs?: number; maxCompanies?: number; skipNamed?: boolean; charge?: (kind: 'search' | 'fetch', units: number) => Promise<void>; canSearch?: () => boolean; alive?: () => boolean; onStop?: (why: string) => void; stats?: PeopleStats }
// A lead graded out (fit 0-1) is hidden from the list (store.ts countHiddenLeads): no search is spent on it, on any scan.
const NOT_GRADED_OUT = 'AND (fit IS NULL OR fit > 1)'
// The first play's own lead list (lib/scan/first5.ts first5LeadSql) also leaves out a lead held by a failed required gate.
const NOT_GATE_HELD = "AND NOT EXISTS (SELECT 1 FROM lead_enrichments h WHERE h.lead_id = leads.id AND h.connector = 'scan:gate' AND h.kind = 'gate_failed')"
// The people step's trace status: a stop the pass did not choose (an error, a lost job, or the search provider refusing it:
// auth = the key was rejected, quota = the provider's quota is used up) wins over a partial count, so a pass cut short is
// never reported as a clean success (people_stored stays in the detail). Our own limits (deadline = the pass's time budget,
// cap = the per-scan / daily search cap, budget_kept = a trial scan keeping its reserve) are planned stops: the status
// follows the count, and peopleTraceMessage names the stop.
const FAILED_STOPS: Record<string, string> = {
  error: 'the people search stopped on an error (logged)',
  ownership_lost: 'the job was cancelled or re-claimed during the people search: it stopped',
  auth: 'the search provider refused the people search (its key was rejected): it stopped',
  quota: 'the search provider refused the people search (its quota is used up): it stopped',
}
const failedStop = (stopped: unknown): stopped is string => typeof stopped === 'string' && Object.hasOwn(FAILED_STOPS, stopped)
export function peopleTraceStatus(stored: number, stopped: string | null): 'ok' | 'failed' | 'attempted_no_result' {
  if (failedStop(stopped)) return 'failed'
  return Number.isSafeInteger(stored) && stored > 0 ? 'ok' : 'attempted_no_result'
}
// The trace message for peopleTraceStatus: every stop, failed or planned, is named with the count stored before it, so a
// cut-short pass never reads as complete. null only for a pass that ran to its end and stored at least one person.
export function peopleTraceMessage(stored: number, stopped: string | null, stats?: PeopleStats): string | null {
  const n = Number.isSafeInteger(stored) && stored > 0 ? stored : 0
  // Nothing was searched and nothing stopped the pass: say which, never "no profile results" (no search asked for any).
  if (stats && n === 0 && (stopped === null || stopped === undefined) && !(stats.searched > 0)) {
    if (stats.no_roles) return 'the request names no buyer role to search for (0 searches run)'
    if (!(stats.eligible > 0)) return 'no lead was eligible for a people search (0 searches run)'
    if (stats.already_named >= stats.eligible) return 'every eligible lead already names its person (0 searches run)'
    return '0 searches run: no eligible lead had a company name and buyer roles to search for'
  }
  const count = `${n} person(s) stored before it stopped`
  if (failedStop(stopped)) return `${FAILED_STOPS[stopped]}; ${count}`
  if (stopped === 'deadline') return `the people search stopped at its time budget; ${count}`
  if (stopped === 'cap') return `the people search stopped at the search limit (per-scan or daily cap); ${count}`
  if (stopped === 'budget_kept') return `the trial scan kept its remaining budget for the checks after this step; ${count}`
  if (stopped !== null && stopped !== undefined) return `the people search stopped early (${String(stopped).slice(0, 40)}); ${count}`
  if (n > 0) return null
  if (!(stats && stats.searched > 0)) return 'no profile results named a role-matching person at a verified company'
  const failed = failedSearches(stats)
  if (failed >= stats.searched) return `${stats.searched} search(es) attempted, none got an answer (${failedCauses(stats)}): nothing was learned about who to contact`
  return `${stats.searched} search(es) run${failed > 0 ? ` (${failed} got no answer)` : ''}, ${stats.results > 0 ? stats.results : 0} result(s): none named a role-matching person at the lead's company`
}
// A lead that already names its person (lead-person.ts leadPerson: the SAME rule the lead row uses) gets no first-play
// search: a titled, role-matching, non-historical person with a checkable link is already stored (e.g. its own site).
const ROWS_SQL = "SELECT kind, value, label, source_url, connector, retrieved_at FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND kind IN ('person','contact') ORDER BY insert_seq LIMIT 500"
// Runs after a scan finishes. Never throws; returns how many people were stored (also when it stopped on an error).
export async function findPeople(db: Database.Database, tenantId: string, jobId: string, deps: PeopleOpts = {}): Promise<number> {
  let stored = 0
  try {
    const env = deps.env ?? process.env
    if (!peopleSearchEnabled(env)) return 0
    // Default: the ordinary scan's MAX_COMPANIES. A first-play cap must be a positive safe integer, at most FIRST_PLAY_MAX; anything else is 0 (no search).
    let cap = deps.maxCompanies === undefined ? MAX_COMPANIES : Number.isSafeInteger(deps.maxCompanies) && deps.maxCompanies > 0 ? Math.min(deps.maxCompanies, FIRST_PLAY_MAX) : 0
    // An operator's own per-scan TinyFish search limit, when set, still binds this pass (it can only lower the cap).
    if (env.TINYFISH_SEARCHES_PER_SCAN !== undefined) cap = Math.min(cap, limits(env).searchesPerScan)
    if (cap === 0) return 0
    // Job ownership first: the job id alone must never let one tenant read or write another's leads.
    const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown; country?: unknown; language?: unknown; where?: unknown }) : null
    const where = Array.isArray(who?.where) ? (who!.where as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const roles = Array.isArray(who?.who) ? (who!.who as unknown[]).filter((x): x is string => typeof x === 'string') : []
    if (roles.length === 0) { if (deps.stats) deps.stats.no_roles = true; return 0 } // no buyer roles: nothing to search for
    const roleText = roles.join('; ')
    const geo = { ...(typeof who?.country === 'string' ? { location: who.country } : {}), ...(typeof who?.language === 'string' ? { language: who.language } : {}) }
    // Ready leads first (best fit first), then the held leads a search still makes sense for (SEARCHABLE_HOLDS), all inside the
    // one cap, and never a lead graded out of the list: a held lead never takes a search from a ready one. The job id is the tenant's own (checked above).
    const leads = db.prepare(`SELECT id, company, review_reason FROM leads WHERE scan_job_id = ? AND ${SEARCHABLE_SQL} AND quarantined_at IS NULL AND company <> '' ${NOT_GRADED_OUT} ${deps.skipNamed ? NOT_GATE_HELD : ''} ORDER BY (review_reason IS NULL) DESC, COALESCE(fit, 0) DESC, score DESC, id LIMIT 200`).all(jobId) as Lead[]
    const stats = deps.stats
    if (stats) { stats.eligible = leads.length; stats.held = leads.filter(l => l.review_reason !== null).length }
    const refuse = (why: string) => { if (stats) stats.refused[why] = (stats.refused[why] ?? 0) + 1 }
    const now = Math.floor((deps.now ?? Date.now()) / 1000); const today = new Date(now * 1000).toISOString().slice(0, 10)
    const spent = { searches: 0 }
    const seenCompany = new Set<string>()
    const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS)
    // This pass's own TinyFish count: the per-scan search count starts at 0 here and allows exactly `cap` searches (already
    // no more than an operator-set TINYFISH_SEARCHES_PER_SCAN; the tenant / global daily caps and per-minute rate still apply).
    const tfEnv = { ...env, TINYFISH_SEARCHES_PER_SCAN: String(cap) }
    const rowsOf = deps.skipNamed ? db.prepare(ROWS_SQL) : null
    let searched = 0
    for (const l of leads) {
      if (Date.now() >= deadline) { deps.onStop?.('deadline'); break }
      if (searched >= cap) break
      if (rowsOf && leadPerson(rowsOf.all(l.id, tenantId), roleText, now * 1000)) { if (stats) stats.already_named++; continue } // already names its person: no search spent on it
      const ck = companyKey(l.company); if (seenCompany.has(ck)) continue; seenCompany.add(ck)
      const q = peopleQuery(l.company, roles); if (!q) continue
      if (deps.alive && !deps.alive()) { deps.onStop?.('ownership_lost'); break }
      if (deps.canSearch && !deps.canSearch()) { deps.onStop?.('budget_kept'); break }
      searched++; if (stats) stats.searched = searched
      // tfSearch has no abort signal: race it against what is left of the deadline so a hung search cannot stall the scan.
      // The tenant daily/global caps and per-minute rate inside tfSearch are shared with the main scan's searches.
      // On the deadline the in-flight search is still AWAITED (its transport gives up after TINYFISH_TIMEOUT_MS) and its
      // result dropped: the pass never returns, and the runner never settles a trial ledger, while a paid call is in flight.
      let timer: ReturnType<typeof setTimeout> | undefined
      // The request itself is aborted when the pass deadline hits or the job is no longer ours (polled while it is in flight),
      // so a reclaimed/cancelled job stops spending instead of waiting out the transport timeout.
      const ctl = new AbortController()
      const watch = deps.alive ? setInterval(() => { try { if (!deps.alive!()) ctl.abort() } catch { ctl.abort() } }, deps.aliveEveryMs ?? 500) : undefined
      const pending = tfSearch(db, tenantId, q, geo, spent, { env: tfEnv, signal: ctl.signal, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.charge ? { charge: deps.charge } : {}) })
      const r = await Promise.race([
        pending,
        new Promise<null>(res => { timer = setTimeout(() => res(null), Math.max(0, deadline - Date.now())) }),
      ]).finally(() => { clearTimeout(timer); if (watch) clearInterval(watch) })
      if (!r) { ctl.abort() // deadline hit: wait for the search in flight (bounded), drop its result
        let drain: ReturnType<typeof setTimeout> | undefined
        await Promise.race([pending.catch(() => null), new Promise<null>(res => { drain = setTimeout(() => res(null), Math.max(0, deps.drainMs ?? TINYFISH_TIMEOUT_MS + 1_000)) })]).finally(() => clearTimeout(drain))
        deps.onStop?.('deadline'); break
      }
      if (deps.alive && !deps.alive()) { deps.onStop?.('ownership_lost'); break } // lost the job while searching: nothing written
      // A search that got no answer (provider unavailable, our per-minute rate gate, a cap) is counted as failed, never as "searched, found nobody".
      if (!r.ok) { if (stats) { const why = FAILED_SEARCH.includes(r.reason) ? r.reason : 'other'; stats.failed[why] = (stats.failed[why] ?? 0) + 1 } if (r.reason === 'cap' || r.reason === 'quota' || r.reason === 'auth') { deps.onStop?.(r.reason); break } continue }
      const refused = new Set<string>()
      if (stats) stats.results += r.hits.length
      const people = r.hits.map(h => ({ h, p: profileHit(h, l.company) }))
        .filter((x): x is { h: SearchHit; p: { name: string; title: string } } => {
          if (typeof x.p === 'string') { refuse(x.p); return false }
          if (stats) stats.profiles++
          if (titleMatches(x.p.title, roleText).length === 0) { refuse('role'); return false }
          return true
        })
        // Same company NAME is not the same company: when the request names a place, the result's own text must name it (a same-name
        // practice in another state is a different business). No place named in the result = unconfirmed = not attached; the refusal is
        // recorded on the lead (contact_location_mismatch / contact_location_unconfirmed) and the other results are still looked at.
        .filter(x => {
          const v = placeAgreement(`${x.h.title} ${x.h.snippet ?? ''}`, where, l.company)
          if (v === 'agrees' || v === 'no_geography') return true
          const reason = `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${(firstPlaceLabel(`${x.h.title} ${x.h.snippet ?? ''}`) ?? /^([A-Z][\p{L} .'-]+,\s*[A-Z][\p{L} .'-]+)/u.exec(x.h.snippet ?? '')?.[1] ?? (v === 'mismatch' ? 'another place' : 'no place named')).slice(0, 60)} vs ${leadPlaceLabel(where).slice(0, 60)}`
          refuse('place')
          if (!refused.has(reason) && !(deps.alive && !deps.alive())) { refused.add(reason); try { recordContactRejection(db, tenantId, l.id, { connector: CONNECTOR, reason, sourceUrl: x.h.url.split('?')[0] }) } catch { /* the refusal note never blocks the search */ } }
          return false
        })
        .sort((a, b) => titleMatches(b.p.title, roleText).length - titleMatches(a.p.title, roleText).length)
      const seen = new Set<string>()
      for (const { h, p } of people) {
        if (seen.has(p.name.toLowerCase()) || seen.size >= MAX_PEOPLE) continue
        seen.add(p.name.toLowerCase())
        if (deps.alive && !deps.alive()) { deps.onStop?.('ownership_lost'); return stored } // re-checked before EVERY write: another process may reclaim the job mid-loop
        addEnrichment(db, tenantId, l.id, { connector: CONNECTOR, kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 120), label: LABEL, confidence: null, source_url: h.url.split('?')[0].slice(0, 500), source_date: h.date ?? today, retrieved_at: now })
        stored++
      }
    }
    return stored
  } catch (e) {
    console.error('people search failed', e instanceof Error ? e.message : 'error')
    deps.onStop?.('error')
    return stored
  }
}
