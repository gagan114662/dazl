// Before a contact or company record from an enrichment source (Apollo, People Data Labs, a crawled site) is attached to a lead, it must AGREE
// with the lead: on the company's domain, or on the city/state the scan is about (city-level for New York City and London, see place-agreement.ts).
// A same-name practice in Pico Rivera, CA must never be attached to a New York lead. A refusal carries a plain reason for the audit trail.
import type Database from 'better-sqlite3'
import { placeAgreement, cityScoped, US_STATES } from './place-agreement.ts'
import { addEnrichment } from '../connectors/store.ts'
import { WHY_MAX } from './score.ts'

export interface Candidate { domain?: string | null; place?: string | null; keyedOnLeadDomain?: boolean } // keyedOnLeadDomain: the lookup was made BY the lead's own domain       // place: "City, ST" (or free text) as the source reports it
export interface LeadSide { company_domain?: string | null; where: string[] }
export type Agreement = { ok: true; via: 'domain' | 'location' | 'no_geography' } | { ok: false; reason: string }

const registrable = (d: string | null | undefined): string | null => {
  if (!d) return null
  const host = d.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null
}
const STATE_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([ab, name]) => [name, ab]))
// "Pico Rivera", "California" -> "Pico Rivera, CA"; anything else is kept as the source wrote it.
export function formatPlace(city?: string | null, state?: string | null, country?: string | null): string | null {
  const c = (city ?? '').trim(), st0 = (state ?? '').trim(), co = (country ?? '').trim()
  const st = st0 ? (STATE_ABBR[st0.toLowerCase()] ?? st0) : ''
  const us = !co || /^(us|usa|united states)/i.test(co)
  const out = [c, st, !c && !st ? co : (us || !co ? '' : co)].filter(Boolean).join(', ')
  return out || null
}
// How the lead's side is named in a reason.
export function leadPlaceLabel(where: string[]): string {
  const w = where.find(x => x.trim()) ?? 'the requested place'
  if (/\b(?:new york city|nyc|manhattan|brooklyn|queens|bronx|staten island)\b|new york,\s*(?:ny|new york)/i.test(w)) return 'New York, NY'
  if (/\blondon\b/i.test(w)) return 'London, UK'
  return w.trim()
}

export function contactAgreement(lead: LeadSide, c: Candidate): Agreement {
  const ld = registrable(lead.company_domain), cd = registrable(c.domain)
  if (ld && cd) return ld === cd ? { ok: true, via: 'domain' } : { ok: false, reason: `contact rejected: domain mismatch ${cd} vs ${ld}` }
  if (ld && !cd && c.keyedOnLeadDomain) return { ok: true, via: 'domain' }
  const place = (c.place ?? '').trim()
  const where = lead.where.filter(w => w.trim())
  if (where.length === 0) return { ok: true, via: 'no_geography' } // a request with no place makes no place demand (a domain that DISAGREES was refused above)
  if (!place) return { ok: false, reason: 'contact rejected: no domain or location to confirm the company' }
  const v = placeAgreement(place, where)
  if (v === 'agrees') return { ok: true, via: 'location' }
  const ours = leadPlaceLabel(where)
  // A bare country or a region is context, never a match for a city request.
  return { ok: false, reason: `contact rejected: location ${v === 'mismatch' ? 'mismatch' : 'unconfirmed'} ${place.slice(0, 60)} vs ${ours.slice(0, 60)}` }
}
export { cityScoped }

// The first "City, ST" / "City, England" in a page, to name the other place in a refusal reason. Display only; never decides anything.
const ST_ALT = Object.keys(US_STATES).join('|')
export function firstPlaceLabel(text: string): string | null {
  const m = new RegExp(`\\b([A-Z][\\p{L}'.-]+(?: [A-Z][\\p{L}'.-]+){0,2}),\\s*(${ST_ALT})\\b(?:\\s+\\d{5})?`, 'u').exec(text)
  if (m) return `${m[1]}, ${m[2]}`
  const u = /\b([A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+){0,2}),\s*(England|Scotland|Wales|Northern Ireland|UK|United Kingdom|South Africa|Canada|Ontario)\b/u.exec(text)
  return u ? `${u[1]}, ${u[2]}` : null
}

// ---- the refusal is recorded on the lead, and the lead is regraded from the evidence actually kept ----
export const REJECTED_KIND = 'contact_rejected'
const KEPT_KINDS = ['contact', 'person', 'email', 'phone']
// A refused record is kept as a labelled row beside the lead (shown on the card as the reason, never counted as a contact).
export function recordContactRejection(db: Database.Database, tenantId: string, leadId: string, r: { connector: string; reason: string; sourceUrl: string }): void {
  const url = /^https?:\/\//.test(r.sourceUrl) ? r.sourceUrl : 'https://invalid.example/'
  addEnrichment(db, tenantId, leadId, { connector: r.connector, kind: REJECTED_KIND, value: r.reason.slice(0, 254), label: 'not attached', confidence: null, source_url: url.slice(0, 500), source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) })
}
// "Can the seller act on it" (the action grade, 0-5) assumed a reachable company. When every contact found for a lead was refused (wrong place /
// wrong domain) and nothing else reaches it, reachability is unconfirmed: the grade is capped at 2 (it only ever goes DOWN) and the card says why.
// The list is ranked by fit, then action, so the lead drops below leads that do have a contact. Idempotent.
export const UNCONFIRMED_ACTION_CAP = 2
export function regradeFromKeptContacts(db: Database.Database, tenantId: string, jobId: string): number {
  const rows = db.prepare(
    `SELECT l.id, l.action, l.why, l.contact,
            (SELECT e.value FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.kind = '${REJECTED_KIND}' ORDER BY e.retrieved_at DESC LIMIT 1) AS rejected,
            (SELECT count(*) FROM lead_enrichments e WHERE e.lead_id = l.id AND e.tenant_id = ? AND e.kind IN (${KEPT_KINDS.map(k => `'${k}'`).join(',')})) AS kept
     FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.scan_job_id = ? AND j.user_id = ? AND l.action IS NOT NULL AND l.action > ${UNCONFIRMED_ACTION_CAP}`,
  ).all(tenantId, tenantId, jobId, tenantId) as { id: string; action: number; why: string | null; contact: string | null; rejected: string | null; kept: number }[]
  const upd = db.prepare('UPDATE leads SET action = ?, why = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    if (!r.rejected || r.kept > 0 || (r.contact ?? '').trim()) continue
    const note = `Contact unconfirmed: ${r.rejected.replace(/^contact rejected:\s*/i, '')}. `
    upd.run(UNCONFIRMED_ACTION_CAP, (note + (r.why ?? '')).slice(0, WHY_MAX), r.id); n++
  }
  return n
}
