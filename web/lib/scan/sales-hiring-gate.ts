// "Seed funding AND hiring sales": a request whose play needs an event beyond hiring plus sales / GTM hiring is not answered by the
// funding quote alone. After the contact crawl has bound each lead to its company domain, a verified lead keeps its place only when
//   (a) its own saved quote already names a sales / GTM hiring (the source says it), or
//   (b) a dated (inside the window, default 90 days) sales / GTM posting sits on a public Greenhouse / Lever / Ashby board bound to the
//       lead's own domain (lib/signals/ats-gtm.ts).
// Otherwise it moves to review with the distinct reason `no_sales_hiring_evidence` and says so on its card. This only ADDS a requirement:
// the quote, date, identity and place gates that put the lead there are not touched, and nothing here promotes a review row.
import type Database from 'better-sqlite3'
import { addEnrichment, audit } from '../connectors/store.ts'
import { atsGtmHiring, isGtmRole, BOARD_LABEL } from '../signals/ats-gtm.ts'
import { needsEventBeyondHiring } from '../search/page-class.ts'
import { parseWindowDays } from './window.ts'
import { WHY_MAX } from './score.ts'

export const NO_SALES_HIRING = 'no_sales_hiring_evidence'
const HIRING_WORDS = /\bhir(?:e|es|ed|ing)\b|\brecruit\w*|\b(?:new|open|several|two|three|\d+)\s+(?:sales\s+|gtm\s+)?(?:role|position|opening)s?\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)/i
const MAX_LEADS = 20

interface JobLike { id: string; user_id: string; query?: string | null; icp?: string | null }

export function salesHiringRequired(query: string | null | undefined, icp: string | null | undefined): boolean {
  let signals: string[] = []
  try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) signals = j!.signals.filter((x): x is string => typeof x === 'string') } catch { /* no profile */ }
  const text = [...signals, query ?? ''].join(' . ')
  return needsEventBeyondHiring(signals, query ?? '') && HIRING_WORDS.test(text) && isGtmRole(text.replace(/\b(?:hir(?:e|es|ed|ing)|recruit\w*)\b/gi, ' '))
}
// The source quote itself says the company is hiring for a sales / GTM role.
export const quoteNamesSalesHiring = (excerpt: string | null, signal: string | null): boolean => { const t = `${excerpt ?? ''} ${signal ?? ''}`; return HIRING_WORDS.test(t) && isGtmRole(t.replace(HIRING_WORDS, ' ')) }

export async function applySalesHiringGate(db: Database.Database, job: JobLike, fetchImpl: typeof fetch = fetch, opts: { now?: number; hiringKeys?: Map<string, { url: string; date: string | null }> } = {}): Promise<{ required: boolean; checked: number; passed: number; demoted: number }> {
  const none = { required: false, checked: 0, passed: 0, demoted: 0 }
  if (!salesHiringRequired(job.query, job.icp)) return none
  const windowDays = parseWindowDays(job.query ?? '') ?? 90
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const leads = db.prepare(
    `SELECT id, company, company_domain, evidence_excerpt, signal, why, dedup_key FROM leads
     WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> '' ORDER BY score DESC LIMIT ?`,
  ).all(job.id, MAX_LEADS) as { id: string; company: string; company_domain: string | null; evidence_excerpt: string | null; signal: string; why: string | null; dedup_key: string | null }[]
  const setWhy = db.prepare('UPDATE leads SET why = ? WHERE id = ?')
  const demote = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL')
  const counts = db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?')
  let passed = 0, demoted = 0
  for (const l of leads) {
    if (quoteNamesSalesHiring(l.evidence_excerpt, l.signal)) { passed++; continue }
    // Another VERIFIED candidate for the same company (kept out as a duplicate) is the one whose own quote names the sales hiring.
    const other = l.dedup_key ? opts.hiringKeys?.get(l.dedup_key) : undefined
    if (other) {
      let host = ''; try { host = new URL(other.url).hostname.replace(/^www\./, '') } catch { /* keep blank */ }
      setWhy.run((`Hiring sales: named in a verified source${host ? ` (${host})` : ''}${other.date ? `, dated ${other.date}` : ''}. ${l.why ?? ''}`).trim().slice(0, WHY_MAX), l.id)
      passed++; continue
    }
    const g = l.company_domain ? await atsGtmHiring(l.company, l.company_domain, fetchImpl, { windowDays, now: (opts.now ?? Date.now()) }).catch(() => null) : null
    if (g && g.via === 'domain') {
      const p = g.postings[0]
      const line = `Hiring sales: ${p.title} posted ${p.date} on its ${BOARD_LABEL[g.board]} job board (${l.company_domain}). `
      setWhy.run((line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
      addEnrichment(db, job.user_id, l.id, { connector: `signals:${g.board}-gtm`, kind: 'hiring', value: `${g.postings.length} sales/GTM role${g.postings.length === 1 ? '' : 's'} posted, newest ${g.newest}`, label: g.postings.map(x => x.title).slice(0, 3).join('; ').slice(0, 200) || null, confidence: 70, source_url: g.url, source_date: g.newest, retrieved_at: now })
      passed++; continue
    }
    const line = `No sales-hiring evidence: no sales or GTM posting dated in the last ${windowDays} days on a public job board tied to ${l.company_domain ?? 'a confirmed company domain (none found)'}. `
    if (demote.run(NO_SALES_HIRING, (line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++ }
  }
  audit(db, { tenantId: job.user_id, connector: 'scan:sales-hiring-gate', jobId: job.id, lookup: `${leads.length} leads, window ${windowDays}d`.slice(0, 200), status: demoted ? 'demoted' : 'ok', results: passed })
  return { required: true, checked: leads.length, passed, demoted }
}
