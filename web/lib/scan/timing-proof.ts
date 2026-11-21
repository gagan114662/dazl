// Durable, versioned machine timing proof (#377). Before this, a machine-verified lead stayed held by the currentness gate
// (lib/outreach/currentness.ts) until a person confirmed it, whatever its evidence: no proof could ever stand in for the
// review. This record is the explicit event-association contract that can: written at the end of a scan, one row per
// machine-verified lead, and honoured only when ALL of these hold, then and again at every read:
//   - timing: a recognized, trigger-compatible event-date proof (page_bound / ats_structured) on a valid past day inside
//     the request's window (proofBackedTiming). Publication, copyright, retrieval and model dates never qualify; a
//     request asking for recency without a numeric window is an unresolved bound and never qualifies;
//   - identity: a company domain the crawl confirmed, on a lead not sent to review and not quarantined;
//   - person + route: the scan's actionability check found a role-matching named person AND a contact route the company
//     published on its own site (lib/scan/actionable.ts);
//   - binding: the recorded event day, proof kind, domain and person/route are still the lead's current ones, and the
//     record is at the current TIMING_PROOF_VERSION. The domain confirmation, person and route are re-read from the CURRENT
//     evidence rows through lib/scan/site-contact.ts (#914), never from the stored actionability summary alone: losing or
//     changing any of them holds even while an old "Actionable" summary remains. Any drift, an older version or no record at all holds (fail closed).
// Model confidence is never an input. Nothing here sets human_confirmed_at, and every other draft / approve / send gate
// (identity review, recipient purpose, suppression, launch authority, caps) still applies on top.
import { createHash } from 'node:crypto'
import type { Db } from '../db/client.ts'
import { domainConfirmedDb } from '../signals/domain-basis.ts'
import type Database from 'better-sqlite3'
import { addEnrichment, INTERNAL_ENRICHMENT_KIND } from '../connectors/store.ts'
import { proofBackedTiming, TIMING_REQUESTED } from './scoreboard.ts'
import { companyFirstJobWindow, jobWindowDays } from './window.ts'
import { currentSiteContact, siteContactFromRows, whoOf, type SiteContact, type SiteRow } from './site-contact.ts'

// v2 (#914): the person/route binding hashes the current evidence rows (value + source page), not the summary label.
export const TIMING_PROOF_VERSION = 2
export const TIMING_PROOF_CONNECTOR = 'scan:timing-proof'
export const TIMING_PROOF_KIND = INTERNAL_ENRICHMENT_KIND // never listed for display (enrichmentsForLeads filters it)
export const TIMING_PROOF_LABEL = `timing-proof:v${TIMING_PROOF_VERSION}`
const ACTIONABLE_CONNECTOR = 'scan:actionable' // lib/scan/actionable.ts ACTIONABLE_CONNECTOR (not imported: avoids its memory/people deps)

export type TimingProofGap = 'no_lead' | 'not_machine_verified' | 'needs_review' | 'quarantined' | 'unresolved_recency_bound' | 'timing_unproven'
  | 'no_domain' | 'domain_unconfirmed' | 'not_actionable' | 'no_record' | 'version_mismatch' | 'binding_changed'

interface Binding { v: number; proof: string; date: string; domain: string; route: string }
type LeadRow = { id: string; source_url: string; company_domain: string | null; event_date: string | null; event_date_proof: string | null; signal: string | null; signal_kind: string | null; review_reason: string | null; quarantined_at: number | null; confidence: number | null; query: string | null; icp: string | null; run_budget: string | null }

const LEAD_SQL = `SELECT l.id, l.source_url, l.company_domain, l.event_date, l.event_date_proof, l.signal, l.signal_kind, l.review_reason, l.quarantined_at, l.confidence, j.query, j.icp, j.run_budget
  FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?`

type ActRow = { value:string; label:string|null }
type Verdict = { gap:TimingProofGap|null; binding:Binding|null }
function eventGap(row:LeadRow|undefined,now:Date):TimingProofGap|null {
  if (!row) return 'no_lead'
  if (row.confidence === null) return 'not_machine_verified'
  if (row.review_reason !== null) return 'needs_review'
  if (row.quarantined_at !== null) return 'quarantined'
  const companyFirst = companyFirstJobWindow(row)
  const windowDays = companyFirst ? companyFirst.days : jobWindowDays(row)
  if (windowDays == null && (companyFirst || TIMING_REQUESTED.test(row.query ?? ''))) return 'unresolved_recency_bound'
  if (!proofBackedTiming(row, windowDays, now)) return 'timing_unproven'
  if (!row.company_domain) return 'no_domain'
  return null
}
// The same current, dated machine evidence requirement, without contact
// route authorization. This is a separate input to the display-only reader.
export function companyFirstEventCurrent(db: Database.Database, tenant: string, leadId: string, now: Date): boolean {
  const row = db.prepare(LEAD_SQL).get(leadId, tenant) as LeadRow | undefined
  return !!row && companyFirstJobWindow(row)?.days != null && eventGap(row, now) === null
}

function bindCurrent(row:LeadRow,site:SiteContact,act:ActRow[]):Verdict{
  if (!site.confirmed) return {gap:'domain_unconfirmed',binding:null}
  if (!site.person || !site.route || act.length !== 1 || !act[0].value.startsWith('Actionable:') || !act[0].label)
    return {gap:'not_actionable',binding:null}
  const facts = [site.domain, site.person.value, site.person.source_url, site.route.kind, site.route.value, site.route.source_url]
  return { gap: null, binding: { v: TIMING_PROOF_VERSION, proof: row.event_date_proof!, date: row.event_date!, domain: row.company_domain!, route: createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16) } }
}
function evaluate(db:Database.Database,tenant:string,row:LeadRow|undefined,now:Date):Verdict{
  const gap=eventGap(row,now)
  if(gap||!row)return {gap,binding:null}
  const site=currentSiteContact(db,tenant,row,whoOf(row.icp)||'founder')
  const act=site.person&&site.route?db.prepare('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? ORDER BY retrieved_at DESC').all(row.id,tenant,ACTIONABLE_CONNECTOR) as ActRow[]:[]
  return bindCurrent(row,site,act)
}

// Scan end, after actionability: replace each machine-verified lead's record with the current verdict. A proven lead's
// record carries its binding; a held lead's record names its gap (so a later read can say why), and is never honoured.
export function recordTimingProof(db: Database.Database, job: { id: string; user_id: string }, now: Date = new Date()): { proven: number; held: number } {
  const ids = db.prepare("SELECT id FROM leads WHERE scan_job_id = ? AND confidence IS NOT NULL AND company <> ''").all(job.id) as { id: string }[]
  const del = db.prepare('DELETE FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ?')
  const read = db.prepare(LEAD_SQL)
  let proven = 0, held = 0
  for (const { id } of ids) {
    const row = read.get(id, job.user_id) as LeadRow | undefined
    const { gap, binding } = evaluate(db, job.user_id, row, now)
    const value = JSON.stringify(binding ? { state: 'proven', ...binding } : { state: 'held', v: TIMING_PROOF_VERSION, gap })
    del.run(id, job.user_id, TIMING_PROOF_CONNECTOR)
    addEnrichment(db, job.user_id, id, { connector: TIMING_PROOF_CONNECTOR, kind: TIMING_PROOF_KIND, value, label: TIMING_PROOF_LABEL, confidence: null, source_url: /^https?:\/\//.test(row?.source_url ?? '') ? row!.source_url.slice(0, 500) : 'https://invalid.example/', source_date: now.toISOString().slice(0, 10), retrieved_at: Math.floor(now.getTime() / 1000) })
    if (binding) proven++; else held++
  }
  return { proven, held }
}

// Read side (the currentness gate, and through it the Leads view, drafts, approvals, sends and follow-ups): null when the
// recorded proof stands right now, else why it does not. Re-evaluates every condition; the record alone is not enough.
export function timingProofGap(db: Database.Database, tenant: string, leadId: string, now: Date = new Date()): TimingProofGap | null {
  const row = db.prepare(LEAD_SQL).get(leadId, tenant) as LeadRow | undefined
  const cur = evaluate(db, tenant, row, now)
  if (cur.gap) return cur.gap
  const recs = db.prepare('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?').all(leadId, tenant, TIMING_PROOF_CONNECTOR, TIMING_PROOF_KIND) as { value: string; label: string | null }[]
  return recordedGap(cur.binding!,recs)
}
function recordedGap(b:Binding,recs:ActRow[]):TimingProofGap|null{
  if (recs.length === 0) return 'no_record'
  if (recs.length !== 1 || recs[0].label !== TIMING_PROOF_LABEL) return 'version_mismatch'
  let rec: Partial<Binding> & { state?: unknown } = {}
  try { rec = JSON.parse(recs[0].value) as typeof rec } catch { return 'binding_changed' }
  if (rec.v !== TIMING_PROOF_VERSION) return 'version_mismatch'
  if (rec.state !== 'proven' || rec.proof !== b.proof || rec.date !== b.date || rec.domain !== b.domain || rec.route !== b.route) return 'binding_changed'
  return null
}

// Async-store reads use the same event, current party/route and fingerprint
// contracts as the scan writer; cached actionability is never sufficient.
export async function timingProofGapDb(db:Db,tenant:string,leadId:string,now:Date):Promise<TimingProofGap|null>{
  const row=await db.get<LeadRow>(LEAD_SQL,[leadId,tenant])
  const gap=eventGap(row,now)
  if(gap||!row)return gap
  const confirmed=await domainConfirmedDb(db,tenant,leadId,row.company_domain)
  const rows=confirmed?await db.all<SiteRow>(
    "SELECT connector, kind, value, label, source_url FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = 'sitecrawl' AND kind IN ('person', 'phone', 'email')",
    [leadId,tenant]):[]
  const site=siteContactFromRows(row.company_domain,confirmed,whoOf(row.icp)||'founder',rows)
  const act=site.person&&site.route?await db.all<ActRow>(
    'SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? ORDER BY retrieved_at DESC',
    [leadId,tenant,ACTIONABLE_CONNECTOR]):[]
  const cur=bindCurrent(row,site,act)
  if(cur.gap)return cur.gap
  const recs=await db.all<ActRow>('SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND tenant_id = ? AND connector = ? AND kind = ?',
    [leadId,tenant,TIMING_PROOF_CONNECTOR,TIMING_PROOF_KIND])
  return recordedGap(cur.binding!,recs)
}
