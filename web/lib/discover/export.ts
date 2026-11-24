import type { Db } from '../db/client.ts'
import { DISCOVER_STATE_LABEL, discoverContact, discoverDateProven, isDiscoverLead, type DiscoverState } from './card.ts'
import { discoverStatesForDb } from './state-db.ts'
import { eventDayVerified } from '../scan/scoreboard.ts'

// The spreadsheet's person and contact columns for a discovery lead: what its card shows (discoverContact), read from the
// same stored rows. Quest on staging 8132d324 (#1571): the card showed a published address and a named person, and every
// Contact and Best Person cell in the download was empty, because the export only read the old engine's people rows.
// Tenant-scoped on both sides, as bestPeople is: the row carries the tenant and its lead belongs to a scan that tenant owns.
// lead_status: the lead's ONE status in the Leads page's words (lib/discover/card.ts discoverState, read by the same reader every counter
// uses, lib/discover/state-db.ts), so the file never disagrees with the page (#1238: the file had no status for these leads at all).
// date_status: 'verified' exactly when the card's date pill says "verified on the cited source" (discoverDateProven); the stored column
// says 'unverified' for every lead that was kept for review, whatever its page printed.
export interface DiscoverExportFields { contact?: string; name?: string; best_person?: string; best_person_title?: string; best_person_link?: string; best_person_found_via?: string; lead_status?: string; date_status?: string }
type Row = { lead_id: string; job_id?: unknown; source_kind?: unknown; name?: unknown; contact?: unknown; event_date?: unknown; event_date_proof?: unknown; signal?: unknown; signal_kind?: unknown }
const CHUNK = 400
const JOBS = 200
const str = (v: unknown): string | null => typeof v === 'string' ? v : null
export async function discoverExportFields(db: Db, tenantId: string, rows: Row[]): Promise<Map<string, DiscoverExportFields>> {
  const out = new Map<string, DiscoverExportFields>()
  const leads = rows.filter(r => isDiscoverLead({ source_kind: typeof r.source_kind === 'string' ? r.source_kind : null }))
  if (leads.length === 0 || !(await db.get('SELECT 1 AS x FROM lead_enrichments LIMIT 0').then(() => true, () => false))) return out
  const byLead = new Map<string, { kind: string; connector: string; value: string; source_url: string | null }[]>()
  for (let i = 0; i < leads.length; i += CHUNK) {
    const ids = leads.slice(i, i + CHUNK).map(r => r.lead_id)
    const enr = await db.all<{ lead_id: string; kind: string; connector: string; value: string; source_url: string | null }>(
      `SELECT e.lead_id, e.kind, e.connector, e.value, e.source_url FROM lead_enrichments e
       JOIN leads l ON l.id = e.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id
       WHERE e.tenant_id = ? AND j.user_id = ? AND l.quarantined_at IS NULL AND e.connector = 'discover'
         AND e.kind IN ('person', 'email', 'linkedin') AND e.lead_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY e.insert_seq`, [tenantId, tenantId, ...ids])
    for (const e of enr) byLead.set(e.lead_id, [...(byLead.get(e.lead_id) ?? []), e])
  }
  const states = new Map<string, DiscoverState>()
  const jobIds = [...new Set(leads.map(r => str(r.job_id)).filter((j): j is string => !!j))]
  for (let i = 0; i < jobIds.length; i += JOBS) for (const job of (await discoverStatesForDb(db, tenantId, jobIds.slice(i, i + JOBS))).values()) for (const [id, s] of job) states.set(id, s)
  for (const r of leads) {
    const c = discoverContact({ source_kind: 'discover', name: typeof r.name === 'string' ? r.name : null, enrichments: byLead.get(r.lead_id) ?? [] })
    if (!c) continue
    const f: DiscoverExportFields = {}
    const state = states.get(r.lead_id), date = str(r.event_date)
    f.lead_status = state ? DISCOVER_STATE_LABEL[state] : ''
    f.date_status = discoverDateProven({ event_date: date, day_verified: eventDayVerified({ event_date: date, event_date_proof: str(r.event_date_proof), signal: str(r.signal), signal_kind: str(r.signal_kind) }) }) ? 'verified' : date ? 'unverified' : 'undated'
    if (c.email && !(typeof r.contact === 'string' && r.contact.trim())) f.contact = c.email.address
    if (c.person) {
      if (!(typeof r.name === 'string' && r.name.trim())) f.name = c.person.name
      f.best_person = c.person.name
      f.best_person_title = c.person.title ?? ''
      f.best_person_link = c.person.linkedin ?? c.person.source ?? ''
      // the stored source is the page that names the person when the run gave one, else the lead's proof page: say only that it is the recorded source
      f.best_person_found_via = c.person.source ? `recorded source: ${c.person.source}` : ''
    }
    out.set(r.lead_id, f)
  }
  return out
}
