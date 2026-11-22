import { migrateCompanyFirstPublishedDisplay } from './company-first-published-display.ts'
import type Database from 'better-sqlite3'
import { sameSite } from '../connectors/sitecrawl.ts'
import { qaClaudeOnlyJob } from '../scan/qa-provider-policy.ts'
import { countriesIn, regionsIn, countryOfRegion } from '../scan/countries.ts'
import { publishedFor, sameNamedPublication, cardNamedPublication, splitName, type AddressContext, type PublishedCandidateRow } from './email-pattern.ts'

export function publishedDisplayCountry(where: string[]): 'CA' | 'GB' | null {
  // #1208: "Toronto, ON" names Canada by its province (a CA / GB region implies its country); a US state counts as the US, so it is never CA / GB.
  const codes = [...new Set(where.flatMap(w => [...countriesIn(w), ...regionsIn(w).map(countryOfRegion)]))]
  return codes.length === 1 && (codes[0] === 'CA' || codes[0] === 'GB') ? codes[0] : null
}

// Dedicated table: no ordinary lookup, candidate learning, verifier, contact promotion, or sender reads it.
export function migratePublishedDisplay(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS published_work_email_display (
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('CA','GB')),
    person TEXT NOT NULL CHECK (length(person) <= 120),
    address TEXT NOT NULL CHECK (length(address) <= 254),
    source_url TEXT NOT NULL CHECK (length(source_url) <= 500),
    PRIMARY KEY (tenant_id, lead_id, person, address)
  )`)
  migrateCompanyFirstPublishedDisplay(db)
}

// A selected recrawl supersedes the old snapshot before any fetch: a blocked/failed/aborted recheck
// is not evidence that an address remains published. A later successful crawl can re-record it.
export function withdrawPublishedDisplay(db: Database.Database, tenantId: string, leadIds: string[]): void {
  if (!leadIds.length) return
  try {
    db.prepare(`DELETE FROM published_work_email_display WHERE tenant_id = ? AND lead_id IN (${leadIds.map(() => '?').join(',')})`).run(tenantId, ...leadIds)
  } catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
}

type Seen = { address: string; url: string; ctx?: AddressContext[]; literalLocals?: Set<string> }
export function recordPublishedDisplay(db: Database.Database, tenantId: string, leadId: string, site: string, where: string[],
  people: { value: string; url: string }[], seen: Seen[]): void {
  const country = publishedDisplayCountry(where)
  if (!country) return
  const named = people.flatMap(p => {
    const name = splitName(p.value.split(',')[0] ?? '')
    return name ? [{ ...p, name }] : []
  })
  const clean = seen.filter(s => {
    try {
      const u = new URL(s.url)
      return s.url.length <= 500 && u.protocol === 'https:' && !u.username && !u.password && !u.port && sameSite(u.hostname, site)
        && s.address.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s.address) && sameSite(s.address.split('@')[1], site)
    } catch { return false }
  })
  db.transaction(() => {
    const owned = db.prepare('SELECT j.run_budget, j.icp FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId) as { run_budget: string | null; icp: string | null } | undefined
    if (!owned || !qaClaudeOnlyJob(owned.run_budget)) return
    let persisted: unknown
    try { persisted = (JSON.parse(owned.icp ?? '{}') as { where?: unknown })?.where } catch { return }
    if (!Array.isArray(persisted) || !persisted.every(w => typeof w === 'string') || publishedDisplayCountry(persisted) !== country) return
    db.prepare('DELETE FROM published_work_email_display WHERE tenant_id = ? AND lead_id = ?').run(tenantId, leadId)
    const insert = db.prepare(`INSERT INTO published_work_email_display (tenant_id,lead_id,jurisdiction,person,address,source_url)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?)
       AND NOT EXISTS (SELECT 1 FROM suppressions WHERE tenant_id = ? AND email = ?) ON CONFLICT DO NOTHING`)
    for (const p of named) {
      if (p.value.length > 120 || named.filter(n => n.name.first === p.name.first && n.name.last === p.name.last).length !== 1) continue
      for (const s of clean) {
        const sameAddress = clean.filter(other => other.address.toLowerCase() === s.address.toLowerCase())
        const literalLocals = new Set(sameAddress.flatMap(other => [...(other.literalLocals ?? new Set([other.address.split('@')[0]]))]))
        if (literalLocals.size !== 1) continue
        // #1208: her own team card (heading = her name, only her recorded title between, a bare mailto naming nobody) names her as well as her name in the text does.
        const title = p.value.split(',').slice(1).join(',').trim() || undefined
        if (s.url !== p.url || !(sameNamedPublication(p.name, s.ctx) || cardNamedPublication(p.name, s.ctx, title)) ||
            sameAddress.some(other => named.some(n => n !== p && (sameNamedPublication(n.name, other.ctx) || cardNamedPublication(n.name, other.ctx, n.value.split(',').slice(1).join(',').trim() || undefined)))) || !publishedFor(p.name, [s], named.map(n => n.name), title)) continue
        const address = `${[...literalLocals][0]}@${s.address.split('@')[1].toLowerCase()}`
        insert.run(tenantId, leadId, country, p.value, address, s.url, leadId, tenantId, tenantId, address.toLowerCase())
      }
    }
  }).immediate()
}

export function publishedDisplayRows(db: Database.Database, tenantId: string, country: 'CA' | 'GB', ids: string[]): Record<string, PublishedCandidateRow[]> {
  const out: Record<string, PublishedCandidateRow[]> = {}
  if (!ids.length) return out
  try {
    const rows = db.prepare(`SELECT d.lead_id,d.person,d.address,d.source_url FROM published_work_email_display d
     WHERE d.tenant_id = ? AND d.jurisdiction = ? AND d.lead_id IN (${ids.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=d.tenant_id AND s.email=lower(d.address))
     ORDER BY d.address`).all(tenantId,country,...ids) as (PublishedCandidateRow & { lead_id: string })[]
    for (const { lead_id, ...row } of rows) (out[lead_id] ??= []).push(row)
  } catch (e) { if (!/no such table/i.test(String((e as Error)?.message))) throw e }
  return out
}
