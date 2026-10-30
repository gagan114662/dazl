// A proof-of-value preview (#403): the companies one finished discovery run found for a prospect's own offer, shown
// to that prospect. It is built only from that run's own leads, owned by the tenant asking, and only from leads that
// passed the run's gates: no review reason, not quarantined, a verified event date inside the evidence window, an
// unpurged quote and an https source the reader can open. Contact details never enter a preview: a person's name,
// email or phone is private to the run. The prospect's offer is shown as an inference from their public pages, never
// as their own words. Homepage illustrations (*.example) can never become evidence. A run with nothing usable is a
// hold: no proof message is built and nothing invented takes its place.
import type { Db } from '../db/client.ts'

export const PROOF_MAX_COMPANIES = 5
export const PROOF_EVIDENCE_DAYS = 90

export interface ProofLeadRow {
  id: string; company: string; signal: string; source_url: string; evidence_excerpt: string | null
  event_date: string | null; date_status: string | null; review_reason: string | null; quarantined_at: number | null
  evidence_purged_at: number | null; confidence: number | null; score: number
}
export interface ProofRun { jobId: string; tenantId: string; status: string; finishedAt: number | null; spendUsd: number | null }
export interface ProofInput { run: ProofRun; inferredOffer: { text: string; sourceUrl: string } | null; leads: ProofLeadRow[] }

export interface ProofCompany { company: string; event: string; quote: string; eventDate: string; sourceUrl: string }
export type ProofPreview =
  | { status: 'ready'; runId: string; builtAt: number; expiresAt: number; spendUsd: number | null
      offer: { inferred: true; text: string; sourceUrl: string }; companies: ProofCompany[]; disclaimer: string }
  | { status: 'hold'; runId: string; reason: 'run_not_finished' | 'no_inferred_offer' | 'no_usable_results' }

const DISCLAIMER = 'Found by one dazl run for the offer we inferred from your public pages. These are signals, not guaranteed customers.'
const CONTACT = /[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{7,}\d/g

const isHttps = (u: string) => { try { return new URL(u).protocol === 'https:' } catch { return false } }
const isIllustration = (u: string) => { try { return /(^|\.)example$|(^|\.)example\.(com|org|net)$/i.test(new URL(u).hostname) } catch { return true } }
const clean = (s: string) => s.replace(CONTACT, '[removed]').replace(/\s+/g, ' ').trim()
const EMAIL_IN = /[\w.+-]+@[\w-]+\.[\w.-]+/
const PHONE_IN = /\+?\d[\d\s().-]{7,}\d/
// A URL is emitted exactly as recorded or not at all (rewriting it would invent evidence). It may not carry contact
// details: no email anywhere once decoded, and no phone number in its query or fragment (path digits are page ids).
function urlCarriesContact(u: string): boolean {
  let x: URL, whole: string, tail: string
  try {
    x = new URL(u)
    whole = decodeURIComponent(u)
    tail = decodeURIComponent((x.search + ' ' + x.hash).replace(/\+/g, ' '))
  } catch { return true } // undecodable: cannot be shown to be clean
  return EMAIL_IN.test(whole) || /^(?:mailto|tel):/i.test(u) || PHONE_IN.test(tail)
}
// A calendar date exactly as YYYY-MM-DD that exists: never a date the parser had to normalise ("2026-09-31" is not October 1).
function strictDay(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null
}

export function buildProofPreview(input: ProofInput, now = Date.now()): ProofPreview {
  const { run } = input
  if (run.status !== 'done') return { status: 'hold', runId: run.jobId, reason: 'run_not_finished' }
  const offer = input.inferredOffer
  if (!offer || !offer.text.trim() || !isHttps(offer.sourceUrl) || isIllustration(offer.sourceUrl) || urlCarriesContact(offer.sourceUrl)) return { status: 'hold', runId: run.jobId, reason: 'no_inferred_offer' }
  const oldest = now - PROOF_EVIDENCE_DAYS * 86400_000
  const seen = new Set<string>()
  const companies: ProofCompany[] = []
  for (const l of [...input.leads].sort((a, b) => b.score - a.score)) {
    if (l.review_reason !== null || l.quarantined_at !== null || l.evidence_purged_at !== null || l.confidence === null) continue
    // every emitted field obeys the privacy contract: text is scrubbed; a URL with contact details drops the lead
    const company = clean(l.company).replace(/\[removed\]/g, '').replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s+/g, ' ').trim()
    if (!company || !l.evidence_excerpt?.trim()) continue
    if (!isHttps(l.source_url) || isIllustration(l.source_url) || urlCarriesContact(l.source_url)) continue
    if (l.date_status !== 'verified' || !l.event_date) continue
    const t = strictDay(l.event_date)
    if (t === null || t < oldest || t > now) continue
    const key = company.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    companies.push({ company, event: clean(l.signal), quote: clean(l.evidence_excerpt), eventDate: l.event_date, sourceUrl: l.source_url })
    if (companies.length === PROOF_MAX_COMPANIES) break
  }
  if (companies.length === 0) return { status: 'hold', runId: run.jobId, reason: 'no_usable_results' }
  // The preview expires with its oldest piece of evidence, so a stale signal is never shown as current.
  const expiresAt = Math.min(...companies.map(c => strictDay(c.eventDate)!)) + PROOF_EVIDENCE_DAYS * 86400_000
  return {
    status: 'ready', runId: run.jobId, builtAt: now, expiresAt, spendUsd: run.spendUsd,
    offer: { inferred: true, text: clean(offer.text), sourceUrl: offer.sourceUrl }, companies, disclaimer: DISCLAIMER,
  }
}

const RUN_SQL = 'SELECT id, user_id, status, finished_at FROM scan_jobs WHERE id = ? AND user_id = ?'
const LEADS_SQL = `SELECT id, company, signal, source_url, evidence_excerpt, event_date, date_status, review_reason, quarantined_at,
  evidence_purged_at, confidence, score FROM leads WHERE scan_job_id = ?`

// Load one run for the tenant that owns it. Another tenant's run id reads as not found: a preview never crosses tenants.
export async function loadProofInput(db: Db, tenantId: string, jobId: string, extra: { inferredOffer: ProofInput['inferredOffer']; spendUsd: number | null }): Promise<ProofInput | null> {
  const job = await db.get<{ id: string; user_id: string; status: string; finished_at: number | null }>(RUN_SQL, [jobId, tenantId])
  if (!job) return null
  const leads = await db.all<ProofLeadRow>(LEADS_SQL, [job.id])
  return {
    run: { jobId: job.id, tenantId, status: job.status, finishedAt: job.finished_at === null ? null : Number(job.finished_at), spendUsd: extra.spendUsd },
    inferredOffer: extra.inferredOffer,
    leads: leads.map(l => ({ ...l, score: Number(l.score), confidence: l.confidence === null ? null : Number(l.confidence), quarantined_at: l.quarantined_at === null ? null : Number(l.quarantined_at), evidence_purged_at: l.evidence_purged_at === null ? null : Number(l.evidence_purged_at) })),
  }
}
