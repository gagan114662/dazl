import type Database from 'better-sqlite3'

// Warm path: before a cold sequence starts, check whether the user already has a
// first-degree path to the lead's contacts. Grounded ONLY in data the user gives us:
// their own LinkedIn connections export (LinkedIn: Settings -> Data privacy -> Get a
// copy of your data -> Connections.csv). No scraping, no LinkedIn API, no autopost.
//
// Honesty rules:
// - We only ever claim FIRST-DEGREE: "you are already connected to X" - because that is
//   what the export proves. Second-degree mutuals are NOT in the export, so we never
//   claim them. For unmatched contacts with a LinkedIn URL we hand back a manual_check
//   item: the profile link where the user can see mutual connections themselves.
// - An import REPLACES the tenant's previous import so stale connections never linger.
// - Rows without a profile URL are skipped and counted, never guessed.
// - Matching is by normalized profile URL only - never by name (names collide).

export interface WarmPathMatch {
  contact_name: string
  contact_title: string | null
  linkedin_url: string
  connection_name: string
  connection_position: string | null
  connection_company: string | null
}

export interface ManualCheck {
  contact_name: string
  contact_title: string | null
  linkedin_url: string
}

export interface WarmPathResult {
  first_degree: WarmPathMatch[]
  manual_check: ManualCheck[]
  imported_connections: number
}

export function migrateWarm(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_connections (
      tenant_id    TEXT NOT NULL,
      name         TEXT NOT NULL CHECK (length(name) <= 200),
      linkedin_url TEXT NOT NULL,
      company      TEXT CHECK (company IS NULL OR length(company) <= 200),
      position     TEXT CHECK (position IS NULL OR length(position) <= 200),
      connected_on TEXT CHECK (connected_on IS NULL OR length(connected_on) <= 20),
      imported_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      PRIMARY KEY (tenant_id, linkedin_url)
    );
    CREATE INDEX IF NOT EXISTS tenant_connections_tenant ON tenant_connections (tenant_id);
  `)
}

// Normalize a LinkedIn profile URL to a comparable key: lowercase, no scheme, no www,
// no query/fragment, single trailing path without the final slash. Only /in/ and /pub/
// profile URLs normalize; anything else returns null (company pages etc. are not people).
export function normalizeLinkedInUrl(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(in|pub)\/([^?#/]+)/)
  return m ? `linkedin.com/${m[1]}/${m[2]}` : null
}

// Minimal CSV parser: quoted fields, embedded commas/quotes/newlines. No guessing.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = '', row: string[] = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row) }
      row = []
    } else field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

const blank = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' || t === '--' ? null : t.slice(0, 200)
}

// Import a LinkedIn Connections.csv export for the tenant. Expected header:
// First Name,Last Name,URL,Email Address,Company,Position,Connected On
// (extra columns are ignored, missing optional columns are fine). Returns counts.
export function importConnectionsCsv(db: Database.Database, tenantId: string, csv: string): { imported: number; skipped: number } {
  migrateWarm(db)
  const rows = parseCsv(csv)
  if (rows.length === 0) return { imported: 0, skipped: 0 }
  const header = rows[0].map(h => h.trim().toLowerCase())
  const idx = {
    first: header.indexOf('first name'),
    last: header.indexOf('last name'),
    url: header.indexOf('url'),
    company: header.indexOf('company'),
    position: header.indexOf('position'),
    connected: header.indexOf('connected on'),
  }
  if (idx.url === -1) return { imported: 0, skipped: Math.max(0, rows.length - 1) }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO tenant_connections (tenant_id, name, linkedin_url, company, position, connected_on) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  let imported = 0, skipped = 0
  const replaceAll = db.transaction(() => {
    db.prepare('DELETE FROM tenant_connections WHERE tenant_id = ?').run(tenantId)
    for (const r of rows.slice(1)) {
      const url = normalizeLinkedInUrl(r[idx.url] ?? '')
      const name = [idx.first >= 0 ? r[idx.first] : '', idx.last >= 0 ? r[idx.last] : ''].join(' ').trim()
      if (!url || !name) { skipped++; continue }
      ins.run(tenantId, name, url, idx.company >= 0 ? blank(r[idx.company]) : null, idx.position >= 0 ? blank(r[idx.position]) : null, idx.connected >= 0 ? blank(r[idx.connected]) : null)
      imported++
    }
  })
  replaceAll()
  return { imported, skipped }
}

// Warm paths to one lead's enriched contacts. Contacts come from lead_enrichments
// (kind='contact', value "Name - Title", source_url = profile link). Never invents a
// path: first_degree only on a normalized-URL match in the tenant's import.
export function warmPathsForLead(db: Database.Database, tenantId: string, leadId: string): WarmPathResult {
  migrateWarm(db)
  const rows = db.prepare(
    `SELECT value, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND kind = 'contact'`,
  ).all(tenantId, leadId) as { value: string; source_url: string }[]
  const conns = new Map(
    (db.prepare('SELECT name, linkedin_url, company, position FROM tenant_connections WHERE tenant_id = ?').all(tenantId) as
      { name: string; linkedin_url: string; company: string | null; position: string | null }[])
      .map(c => [c.linkedin_url, c]),
  )
  const first_degree: WarmPathMatch[] = []
  const manual_check: ManualCheck[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    const url = normalizeLinkedInUrl(r.source_url)
    if (!url || seen.has(url)) continue
    seen.add(url)
    const dash = r.value.indexOf(' - ')
    const contact_name = (dash === -1 ? r.value : r.value.slice(0, dash)).trim()
    const contact_title = dash === -1 ? null : r.value.slice(dash + 3).trim() || null
    const hit = conns.get(url)
    if (hit) first_degree.push({ contact_name, contact_title, linkedin_url: r.source_url, connection_name: hit.name, connection_position: hit.position, connection_company: hit.company })
    else manual_check.push({ contact_name, contact_title, linkedin_url: r.source_url })
  }
  return { first_degree, manual_check, imported_connections: conns.size }
}
