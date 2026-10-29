import type Database from 'better-sqlite3'
import { getMemory, type Memory } from '../memory.ts'
import { draftOffer, isMissingSchema, tenantOffer } from '../scan/play-offer-text.ts'

// The tenant's Memory as written for ONE lead's play (#349): its positioning is that play's effective offer
// (lib/scan/play-offer.ts), so a follow-up never states the tenant-wide offer for a play that sells something else.
// A play whose offer is contested gets no positioning at all: the text then states no offer rather than a guessed one.
// A lead outside any play of this tenant gets the tenant's own context (Memory positioning or, after onboarding only,
// the profile offer). A read failure other than an older schema
// throws (the follow-up and sequence callers then use their template, which states no offer, and make no model call).
export function memoryForLead(db: Database.Database, tenantId: string, leadId: string): Memory | null {
  let memory: Memory | null = null
  try { memory = getMemory(db, tenantId) } catch (e) { if (!isMissingSchema(e)) throw e /* else: no Memory table yet */ }
  let play: { offer: string | null; seller: string | null; query: string | null } | undefined
  try {
    play = db.prepare('SELECT j.offer, j.seller, j.query FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as typeof play
  } catch (e) { if (!isMissingSchema(e)) throw e } // unreadable: the caller drafts nothing from Memory
  const r = draftOffer(play, tenantOffer(memory?.positioning, readProfileSells(db, tenantId)))
  if (!memory && !r.offer) return null // nothing of this tenant's to state
  const base: Memory = memory ?? { icp: '', positioning: '', tone: '', exclusions: [], objections: [], updated_at: 0 }
  return { ...base, positioning: r.offer ?? '' }
}

// What onboarding saved as the tenant's offer (users.sells). '' on a database without it.
export function readProfileSells(db: Database.Database, tenantId: string): string {
  try { return (db.prepare('SELECT sells FROM users WHERE id = ?').get(tenantId) as { sells?: string | null } | undefined)?.sells ?? '' } catch (e) { if (isMissingSchema(e)) return ''; throw e }
}
// The tenant's own selling context (lib/scan/play-offer-text.ts tenantOffer), read from Memory and the profile.
export function readTenantOffer(db: Database.Database, tenantId: string): string | null {
  let positioning = ''
  try { positioning = getMemory(db, tenantId)?.positioning ?? '' } catch (e) { if (!isMissingSchema(e)) throw e /* else: no Memory table yet */ }
  return tenantOffer(positioning, readProfileSells(db, tenantId))
}
