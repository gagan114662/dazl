// When a candidate's OWN source page blocks us (bot-blocked, JavaScript-only) it is held in review and nothing downstream can read it: no quote check, no date, no domain, no contact. Instead of
// leaving it there, look for the SAME company and event in sources that do not need the blocked page: other press (the free news search), whose pages go through the normal extraction and the
// SAME verifier (quote on the page, company named, place, date window, counterparty) as any candidate. Only a candidate that verifies for the SAME company replaces the held row; the sales-hiring
// half is supplied separately by the public ATS boards (found by company name) through the normal merge of verified quotes. Nothing here relaxes a check, and nothing is guessed.
import type Database from 'better-sqlite3'
import { addEnrichment } from '../connectors/store.ts'
import { companyKey, dedupKey } from './evidence.ts'

export const BLOCKED_REASONS = new Set(['blocked_by_site', 'needs_javascript'])
export const MAX_FALLBACK = 3
export const FALLBACK_CONNECTOR = 'scan:fallback'
export interface Held { company: string; signal: string; source_url: string; review_reason?: string | null }
export interface FallbackTarget { company: string; reason: string; url: string; query: string }
export interface FallbackNote { company: string; key: string; reason: string; blocked_url: string; via_url: string }
const BLOCKED_FETCH: Record<string, string> = { blocked: 'blocked_by_site', js_required: 'needs_javascript' }

// Every company whose own cited page was blocked and which now stands as a VERIFIED lead on a different page (other press, a job board posting, a merged quote): the fallback that rescued it, for the
// record. `fetchOf` is the verifier's own fetch outcome per URL.
export function rescuedNotes(candidates: { company: string; source_url: string }[], fetchOf: (url: string) => string | null, leads: { company: string; source_url: string }[]): FallbackNote[] {
  const byKey = new Map(leads.map(l => [dedupKey(l as never), l]))
  const out: FallbackNote[] = [], seen = new Set<string>()
  for (const c of candidates) {
    const reason = BLOCKED_FETCH[fetchOf(c.source_url) ?? '']; if (!reason) continue
    const key = dedupKey(c as never), lead = byKey.get(key)
    if (!lead || lead.source_url === c.source_url || seen.has(key)) continue
    seen.add(key); out.push({ company: c.company, key, reason, blocked_url: c.source_url, via_url: lead.source_url })
  }
  return out
}

export function fallbackTargets(review: Held[], where: string[]): FallbackTarget[] {
  const out: FallbackTarget[] = [], seen = new Set<string>()
  for (const r of review) {
    if (!r.review_reason || !BLOCKED_REASONS.has(r.review_reason)) continue
    const k = companyKey(r.company); if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({ company: r.company, reason: r.review_reason, url: r.source_url, query: `"${r.company.replace(/["\n]/g, ' ').trim()}" ${r.signal.slice(0, 60)} ${(where[0] ?? '').split(',')[0]}`.replace(/\s+/g, ' ').trim().slice(0, 150) })
    if (out.length >= MAX_FALLBACK) break
  }
  return out
}

// Merges the verified other-press candidates for THE BLOCKED COMPANIES into the first outcome: a verified lead replaces that company's held row (the same rule the verifier applies to duplicates);
// a candidate for any other company is ignored, and an unverified one changes nothing.
export function mergeFallback<L extends { company: string; source_url: string }, R extends { company: string; source_url: string }>(
  outcome: { leads: L[]; review: R[]; dropped: Record<string, number>; quotes?: Map<string, { url: string; excerpt: string; date: string | null }[]> },
  extra: { leads: L[]; dropped: Record<string, number>; quotes?: Map<string, { url: string; excerpt: string; date: string | null }[]> },
  targets: FallbackTarget[],
): FallbackNote[] {
  const wanted = new Map(targets.map(t => [companyKey(t.company), t]))
  const notes: FallbackNote[] = []
  const have = new Set(outcome.leads.map(l => dedupKey(l as never)))
  for (const l of extra.leads) {
    const k = dedupKey(l as never), t = wanted.get(k)
    if (!t || have.has(k)) continue
    have.add(k); outcome.leads.push(l)
    const i = outcome.review.findIndex(r => dedupKey(r as never) === k); if (i >= 0) outcome.review.splice(i, 1)
    for (const q of extra.quotes?.get(k) ?? []) outcome.quotes?.set(k, [...(outcome.quotes.get(k) ?? []), q])
    notes.push({ company: t.company, key: k, reason: t.reason, blocked_url: t.url, via_url: l.source_url })
  }
  for (const [r, n] of Object.entries(extra.dropped)) outcome.dropped[r] = (outcome.dropped[r] ?? 0) + n
  return notes
}

// Beside each rescued lead: which fallback replaced the blocked page and where the evidence came from (the resolution record shows it).
export function recordFallbacks(db: Database.Database, job: { id: string; user_id: string }, notes: FallbackNote[]): void {
  const find = db.prepare('SELECT id FROM leads WHERE scan_job_id = ? AND dedup_key = ?')
  for (const n of notes) {
    try {
      const row = find.get(job.id, n.key) as { id: string } | undefined; if (!row) continue
      db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?').run(row.id, job.user_id, FALLBACK_CONNECTOR)
      addEnrichment(db, job.user_id, row.id, { connector: FALLBACK_CONNECTOR, kind: 'fallback', value: `Own site blocked (${n.reason}): verified from other sources instead (${(() => { try { return new URL(n.via_url).hostname.replace(/^www\./, '') } catch { return 'another page' } })()})`.slice(0, 254), label: 'other_sources', confidence: null, source_url: n.via_url, source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
    } catch { /* an old schema never blocks the scan */ }
  }
}
