// One bounded completion step before a scan returns: every KEPT lead (verified, not held) is measured for the four things a seller needs - a dated source, the company's domain, a named decision-maker, a
// published route - before the post-finish enrichment (company-site crawl, domain identity check, own-site date lookup) and again after it. Per lead we record what was FILLED and what is STILL MISSING, and the
// lead's score is recomputed from the evidence it actually has (the model's candidate score is replaced; nothing is added that was not found). No gate is touched: the domain still passes the identity check,
// the date is only ever a structured date on a page about the SAME event, and a lead is never promoted or demoted here.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { NOT_A_FOUNDER_ROUTE, personMatchesRole, whoOf } from './actionable.ts'
import type { ResolutionSummary } from './resolution.ts'

export const COMPLETION_CONNECTOR = 'scan:completion'
export type Fact = 'date' | 'domain' | 'person' | 'route'
export interface Facts { date: boolean; domain: boolean; person: boolean; route: boolean }
export interface Snapshot extends Facts { id: string; company: string; score: number }
export interface CompletionRecord { lead_id: string; company: string; before: Facts; after: Facts; filled: Fact[]; missing: Fact[]; score_before: number; score_after: number }
export const FACT_LABEL: Record<Fact, string> = { date: 'source date', domain: 'company domain', person: 'named decision-maker', route: 'published contact route' }

// The evidence score, 0-100, from what the lead actually has: the verified quote (every kept lead has one) 40, a real event date 15, a confirmed company domain 15, a named decision-maker for the requested role 15,
// a published contact route 10, and a graded fit of 4+ 5. A pure function of its inputs.
export function evidenceScore(f: Facts, fit: number | null): number {
  return 40 + (f.date ? 15 : 0) + (f.domain ? 15 : 0) + (f.person ? 15 : 0) + (f.route ? 10 : 0) + (fit !== null && fit >= 4 ? 5 : 0)
}
const realDay = (d: string | null): boolean => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 86_400_000

type LeadRow = { id: string; company: string; event_date: string | null; company_domain: string | null; score: number; fit: number | null }
function kept(db: Database.Database, tenantId: string, jobId: string): (LeadRow & { who: string })[] {
  const who = whoOf((db.prepare('SELECT icp FROM scan_jobs WHERE id = ? AND user_id = ?').get(jobId, tenantId) as { icp: string | null } | undefined)?.icp) || 'founder'
  return (db.prepare(`SELECT l.id, l.company, l.event_date, l.company_domain, l.score, l.fit FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id
    WHERE l.scan_job_id = ? AND j.user_id = ? AND l.review_reason IS NULL AND l.confidence IS NOT NULL AND l.quarantined_at IS NULL AND l.company <> '' ORDER BY l.score DESC`).all(jobId, tenantId) as LeadRow[]).map(r => ({ ...r, who }))
}
function factsOf(db: Database.Database, tenantId: string, l: LeadRow & { who: string }): Facts {
  const rows = db.prepare("SELECT kind, value FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'phone', 'email')").all(l.id, tenantId) as { kind: string; value: string }[]
  return {
    date: realDay(l.event_date), domain: !!l.company_domain,
    person: rows.some(r => r.kind === 'person' && personMatchesRole(r.value, l.who)),
    route: rows.some(r => r.kind === 'phone' || (r.kind === 'email' && !NOT_A_FOUNDER_ROUTE.test(r.value.split('@')[0].replace(/[._-]/g, '')))),
  }
}
export function snapshotLeads(db: Database.Database, tenantId: string, jobId: string): Snapshot[] {
  try { return kept(db, tenantId, jobId).map(l => ({ id: l.id, company: l.company, score: l.score, ...factsOf(db, tenantId, l) })) } catch { return [] }
}

// Runs after the post-finish enrichment. With NO date window, an own-site structured date found by the resolution lookup (same event, place-checked) fills a lead's missing date; with a window the date gate already
// ran and decided, so it is left alone. Recomputes each kept lead's score and writes the per-lead record. Idempotent; never throws.
export function completeLeads(db: Database.Database, job: { id: string; user_id: string }, before: Snapshot[], opts: { windowed: boolean; resolution?: ResolutionSummary | null; datesFilled?: string[] } = { windowed: false }): CompletionRecord[] {
  const out: CompletionRecord[] = []
  try {
    const late = new Map((opts.resolution?.leads ?? []).filter(r => r.late_date).map(r => [r.lead_id, r.late_date!]))
    // A date the pass itself read from the cited page's structured data (before the leads were stored) counts as FILLED by the pass, not as already there.
    const stamped = new Set(opts.datesFilled ?? [])
    const was = new Map(before.map(b => [b.id, stamped.has(b.company) ? { ...b, date: false } : b]))
    for (const l of kept(db, job.user_id, job.id)) {
      const b = was.get(l.id); if (!b) continue
      const lt = late.get(l.id)
      if (!opts.windowed && !realDay(l.event_date) && lt && realDay(lt.date)) {
        db.prepare("UPDATE leads SET event_date = ?, date_status = 'unverified', timing_note = ? WHERE id = ? AND event_date IS NULL").run(lt.date, `event date ${lt.date} read from ${lt.url} (structured data, same event) after the scan`.slice(0, 300), l.id)
        l.event_date = lt.date
      }
      const after = factsOf(db, job.user_id, l)
      const filled = (Object.keys(after) as Fact[]).filter(k => after[k] && !b[k]), missing = (Object.keys(after) as Fact[]).filter(k => !after[k])
      const score_after = evidenceScore(after, l.fit)
      db.prepare('UPDATE leads SET score = ? WHERE id = ?').run(score_after, l.id)
      const value = `${filled.length ? `Filled: ${filled.map(f => FACT_LABEL[f]).join(', ')}.` : 'Nothing new was found.'} ${missing.length ? `Still missing: ${missing.map(f => FACT_LABEL[f]).join(', ')}.` : 'Nothing missing.'} Evidence score ${b.score} -> ${score_after}.`
      const rec: CompletionRecord = { lead_id: l.id, company: l.company, before: { date: b.date, domain: b.domain, person: b.person, route: b.route }, after, filled, missing, score_before: b.score, score_after }
      out.push(rec)
      try {
        db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?').run(l.id, job.user_id, COMPLETION_CONNECTOR)
        addEnrichment(db, job.user_id, l.id, { connector: COMPLETION_CONNECTOR, kind: 'completion', value: value.slice(0, 254), label: JSON.stringify({ filled, missing, score: [b.score, score_after] }).slice(0, 200), confidence: null, source_url: 'https://dazl.ai/scan', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
      } catch { /* an old schema never blocks the scan */ }
    }
  } catch (e) { console.error('lead completion failed', e instanceof Error ? e.message : 'error') }
  return out
}
