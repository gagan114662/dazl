// #1102: the grounded named-person step of a scan. For the leads that still name nobody after the crawl and the profile search, ONE
// grounded lookup each (lib/people/contact-research.ts: at most 2 searches, 1 page read, 1 Haiku call; every field checked in code
// against the text of a source that was shown). A person is stored only when the lookup keeps one, with the source it was read from.
// Inside the scan's own caps: at most MAX_LEADS leads, one lookup per company, a wall-clock deadline, and the scan's spend ledger
// still binds every search and model call (a refusal stops the pass, it is not an error).
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { SpendRefused } from '../llm/spend-guard.ts'
import type { Provider } from '../llm/provider.ts'
import { companyKey } from '../scan/evidence.ts'
import { domainConfirmed } from '../signals/domain-basis.ts'
import { leadPerson } from './lead-person.ts'
import { researchContact, type ResearchResult } from './contact-research.ts'
import { NOT_GRADED_OUT, ROWS_SQL, SEARCHABLE_SQL } from './people-search.ts'

export const GROUNDED_CONNECTOR = 'research:person'
export const GROUNDED_LABEL = 'quoted from a public source the lookup read (not verified as current staff)'
export const MAX_LEADS = 5          // lookups per scan, best leads first
export const CONCURRENCY = 3
export const DEADLINE_MS = 100_000  // the whole pass; a scan must finish in minutes

export interface GroundedStats { eligible: number; looked_up: number; found: number; none: number; refused: Record<string, number>; failed: Record<string, number> }
export const newGroundedStats = (): GroundedStats => ({ eligible: 0, looked_up: 0, found: 0, none: 0, refused: {}, failed: {} })
export interface GroundedOpts { provider: Provider; apiKey: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; now?: number; maxLeads?: number; deadlineMs?: number; alive?: () => boolean; stats?: GroundedStats; onStop?: (why: string) => void }

export async function findGroundedPeople(db: Database.Database, tenantId: string, jobId: string, deps: GroundedOpts): Promise<number> {
  let stored = 0
  const stats = deps.stats ?? newGroundedStats()
  try {
    const j = db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined
    const who = j?.icp ? (JSON.parse(j.icp) as { who?: unknown; where?: unknown }) : null
    const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    const roles = strs(who?.who), where = strs(who?.where)
    if (roles.length === 0) return 0
    const roleText = roles.join('; ')
    const now = deps.now ?? Date.now()
    const leads = db.prepare(`SELECT id, company, company_domain FROM leads WHERE scan_job_id = ? AND ${SEARCHABLE_SQL} AND quarantined_at IS NULL AND company <> '' ${NOT_GRADED_OUT} ORDER BY (review_reason IS NOT NULL), COALESCE(fit, 0) DESC, rowid`).all(jobId) as { id: string; company: string; company_domain: string | null }[]
    const rowsOf = db.prepare(ROWS_SQL)
    const seen = new Set<string>()
    const todo = leads.filter(l => {
      const ck = companyKey(l.company); if (seen.has(ck)) return false; seen.add(ck)
      return !leadPerson(rowsOf.all(l.id, tenantId), roleText, now)   // already names its person: nothing to look up
    }).slice(0, deps.maxLeads ?? MAX_LEADS)
    stats.eligible = todo.length
    const deadline = Date.now() + (deps.deadlineMs ?? DEADLINE_MS)
    let stop: string | null = null, next = 0
    const one = async (l: { id: string; company: string; company_domain: string | null }) => {
      const domain = l.company_domain && domainConfirmed(db, tenantId, l.id, l.company_domain) ? l.company_domain : null
      stats.looked_up++
      let r: ResearchResult
      try { r = await researchContact({ company: l.company, domain, roles, where }, { db, tenantId, provider: deps.provider, apiKey: deps.apiKey, env: deps.env, fetchImpl: deps.fetchImpl, signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())) }) }
      catch (e) {
        if (e instanceof SpendRefused) { stop ??= `spend:${e.reason}`; stats.failed[`spend_${e.reason}`] = (stats.failed[`spend_${e.reason}`] ?? 0) + 1; return }
        stats.failed.error = (stats.failed.error ?? 0) + 1; return
      }
      if (r.status === 'found' && r.person) {
        if (deps.alive && !deps.alive()) { stop ??= 'ownership_lost'; return }   // re-checked before the write: another process may hold the job now
        const p = r.person
        addEnrichment(db, tenantId, l.id, { connector: GROUNDED_CONNECTOR, kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 120), label: GROUNDED_LABEL, confidence: null, source_url: (p.linkedin ?? p.source_url).split('?')[0].slice(0, 500), source_date: new Date(now).toISOString().slice(0, 10), retrieved_at: Math.floor(now / 1000) })
        stored++; stats.found++
      } else if (r.status === 'none') stats.none++
      else if (r.status === 'not_grounded') stats.refused[r.refused ?? 'other'] = (stats.refused[r.refused ?? 'other'] ?? 0) + 1
      else stats.failed[r.refused ?? r.status] = (stats.failed[r.refused ?? r.status] ?? 0) + 1
    }
    const worker = async () => { for (;;) { if (stop || Date.now() >= deadline) { stop ??= 'deadline'; return } if (deps.alive && !deps.alive()) { stop ??= 'ownership_lost'; return } const l = todo[next++]; if (!l) return; await one(l) } }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))
    if (stop) deps.onStop?.(stop)
    return stored
  } catch (e) {
    console.error('grounded people failed', e instanceof Error ? e.message : 'error')
    deps.onStop?.('error')
    return stored
  }
}
