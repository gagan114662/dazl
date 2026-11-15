// MISSION v2 part D (Refs #1099): the proof rows a research-verified lead carries, and the one read that lets the Ready gate honour them.
//
// The old engine's machine path to Ready (lib/scan/timing-proof.ts, #377) needs a proven day + a confirmed domain + a named person + a
// published route. The research engine's definition of ready (ai-research prototype, MISSION v2) is: an event proven by a verbatim quote on
// the opened page AND confirmed by a second model, its day stated on that page inside 90 days, and a named decision-maker proven on the page
// they were found on - every claim with its citation. `writeResearchProof` stores exactly that, only for a verdict verify.ts called ready:
//   - the lead's own fields: event_date + event_date_proof 'page_bound' (what the lead card's "verified on the cited source" reads);
//   - a person row (kind 'person', connector RESEARCH_CONNECTOR) with the person's role and the page that names them;
//   - one internal binding record (never displayed) holding what was proven: the day, a hash of the quote and of the cited URL, the person.
// `researchProofGap` re-checks the binding against the lead AS IT IS NOW at every read (the day, the quote, the source, the person row, the
// window): any drift, a missing row or another version holds the lead (fail closed), exactly as the timing proof does.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { addEnrichment, INTERNAL_ENRICHMENT_KIND } from '../connectors/store.ts'
import { inWindow, WINDOW_DAYS, type EventToVerify, type PersonToVerify, type Verdict } from './verify.ts'

export const RESEARCH_CONNECTOR = 'research:verify'
export const RESEARCH_PROOF_VERSION = 1
export const RESEARCH_PROOF_LABEL = `research-proof:v${RESEARCH_PROOF_VERSION}`
export type ResearchProofGap = 'no_lead' | 'no_record' | 'version_mismatch' | 'binding_changed' | 'person_missing' | 'out_of_window' | 'needs_review' | 'quarantined'

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)
interface Binding { v: number; date: string; quote: string; source: string; person: string; personUrl: string }
type LeadRow = { id: string; event_date: string | null; event_date_proof: string | null; evidence_excerpt: string | null; source_url: string; review_reason: string | null; quarantined_at: number | null }
const LEAD_SQL = 'SELECT l.id, l.event_date, l.event_date_proof, l.evidence_excerpt, l.source_url, l.review_reason, l.quarantined_at FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?'

// Write the proof of a READY verdict onto the stored lead (its own tenant only). A verdict that is not ready writes nothing and returns false.
// The lead row must already carry the event's quote as its evidence_excerpt and its cited page as source_url (the store wrote it).
export function writeResearchProof(db: Database.Database, tenant: string, leadId: string, v: Verdict, ev: EventToVerify, person: PersonToVerify, now: Date = new Date()): boolean {
  if (!v.ready || !v.day.date || !v.person.ok) return false
  const lead = db.prepare(LEAD_SQL).get(leadId, tenant) as LeadRow | undefined
  if (!lead || lead.evidence_excerpt !== ev.quote || lead.source_url !== ev.sourceUrl) return false   // the proof is bound to this row's own quote and page
  const day = now.toISOString().slice(0, 10), at = Math.floor(now.getTime() / 1000)
  db.transaction(() => {
    db.prepare("UPDATE leads SET event_date = ?, event_date_proof = 'page_bound', event_date_proof_note = ? WHERE id = ?").run(v.day.date, 'the day is stated on the cited page (research verify)', leadId)
    addEnrichment(db, tenant, leadId, { connector: RESEARCH_CONNECTOR, kind: 'person', value: person.name.slice(0, 254), label: (person.title ?? 'named on the cited page').slice(0, 200), confidence: null, source_url: person.sourceUrl.slice(0, 500), source_date: day, retrieved_at: at })
    db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').run(leadId, tenant, RESEARCH_CONNECTOR, INTERNAL_ENRICHMENT_KIND)
    const b: Binding = { v: RESEARCH_PROOF_VERSION, date: v.day.date!, quote: sha(ev.quote), source: sha(ev.sourceUrl), person: person.name, personUrl: person.sourceUrl }
    addEnrichment(db, tenant, leadId, { connector: RESEARCH_CONNECTOR, kind: INTERNAL_ENRICHMENT_KIND, value: JSON.stringify(b), label: RESEARCH_PROOF_LABEL, confidence: null, source_url: ev.sourceUrl.slice(0, 500), source_date: day, retrieved_at: at })
  })()
  return true
}

// null when the lead's research proof stands right now; otherwise why not. Read by the currentness gate (lib/outreach/currentness.ts).
export function researchProofGap(db: Database.Database, tenant: string, leadId: string, now: Date = new Date(), windowDays = WINDOW_DAYS): ResearchProofGap | null {
  const lead = db.prepare(LEAD_SQL).get(leadId, tenant) as LeadRow | undefined
  if (!lead) return 'no_lead'
  if (lead.quarantined_at !== null) return 'quarantined'
  if (lead.review_reason !== null) return 'needs_review'
  const recs = db.prepare('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').all(leadId, tenant, RESEARCH_CONNECTOR, INTERNAL_ENRICHMENT_KIND) as { value: string; label: string | null }[]
  if (recs.length === 0) return 'no_record'
  if (recs.length !== 1 || recs[0].label !== RESEARCH_PROOF_LABEL) return 'version_mismatch'
  let b: Partial<Binding> = {}
  try { b = JSON.parse(recs[0].value) as Partial<Binding> } catch { return 'binding_changed' }
  if (b.v !== RESEARCH_PROOF_VERSION) return 'version_mismatch'
  if (lead.event_date !== b.date || lead.event_date_proof !== 'page_bound' || sha(lead.evidence_excerpt ?? '') !== b.quote || sha(lead.source_url) !== b.source) return 'binding_changed'
  const p = db.prepare('SELECT 1 FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ? AND value = ? AND source_url = ?').get(leadId, tenant, RESEARCH_CONNECTOR, 'person', b.person ?? '', b.personUrl ?? '')
  if (!p) return 'person_missing'
  if (!inWindow(lead.event_date, now.getTime(), windowDays)) return 'out_of_window'
  return null
}
