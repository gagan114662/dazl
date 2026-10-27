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
  user_reported: UserReportedPath[]
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
    -- User-reported mutuals: the user saw the mutual connection themselves (e.g. on the
    -- prospect's LinkedIn profile) and typed it in. Provenance is always 'user_reported',
    -- never verified by dazl. Kept SEPARATE from the CSV import so a replace-import
    -- never deletes them.
    CREATE TABLE IF NOT EXISTS warm_user_paths (
      id           TEXT PRIMARY KEY,
      tenant_id    TEXT NOT NULL,
      lead_id      TEXT NOT NULL,
      contact_url  TEXT NOT NULL,
      mutual_name  TEXT NOT NULL CHECK (length(mutual_name) <= 200),
      note         TEXT CHECK (note IS NULL OR length(note) <= 500),
      created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
      UNIQUE (tenant_id, lead_id, contact_url, mutual_name)
    );
    CREATE INDEX IF NOT EXISTS warm_user_paths_lead ON warm_user_paths (tenant_id, lead_id);
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

// CSV cells are untrusted: neutralize spreadsheet formula injection (leading = + - @)
// and strip control characters before anything is stored or shown.
export function sanitizeCell(v: string | undefined, max = 200): string | null {
  let t = (v ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (/^[=+\-@]/.test(t)) t = "'" + t
  return t === '' || t === '--' ? null : t.slice(0, max)
}
const blank = (v: string | undefined): string | null => sanitizeCell(v)

// Hard cap so a hostile or accidental giant file cannot exhaust the import.
export const MAX_IMPORT_ROWS = 10000

// Import a LinkedIn Connections.csv export for the tenant. Expected header:
// First Name,Last Name,URL,Email Address,Company,Position,Connected On
// (extra columns are ignored, missing optional columns are fine). Returns counts.
export function importConnectionsCsv(db: Database.Database, tenantId: string, csv: string): { imported: number; skipped: number; replaced: number; capped: boolean } {
  migrateWarm(db)
  const all = parseCsv(csv)
  const capped = all.length > MAX_IMPORT_ROWS + 1
  const rows = capped ? all.slice(0, MAX_IMPORT_ROWS + 1) : all
  if (rows.length === 0) return { imported: 0, skipped: 0, replaced: 0, capped: false }
  const header = rows[0].map(h => h.trim().toLowerCase())
  const idx = {
    first: header.indexOf('first name'),
    last: header.indexOf('last name'),
    url: header.indexOf('url'),
    company: header.indexOf('company'),
    position: header.indexOf('position'),
    connected: header.indexOf('connected on'),
  }
  if (idx.url === -1) return { imported: 0, skipped: Math.max(0, rows.length - 1), replaced: 0, capped }
  const ins = db.prepare(
    `INSERT OR REPLACE INTO tenant_connections (tenant_id, name, linkedin_url, company, position, connected_on) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  let imported = 0, skipped = 0
  const replaced = (db.prepare('SELECT COUNT(*) c FROM tenant_connections WHERE tenant_id = ?').get(tenantId) as { c: number }).c
  const replaceAll = db.transaction(() => {
    // Replaces the tenant's CONNECTIONS import only. warm_user_paths and every other
    // table are untouched - the user's own reported mutuals survive a re-import.
    db.prepare('DELETE FROM tenant_connections WHERE tenant_id = ?').run(tenantId)
    for (const r of rows.slice(1)) {
      const url = normalizeLinkedInUrl(r[idx.url] ?? '')
      const name = [idx.first >= 0 ? r[idx.first] : '', idx.last >= 0 ? r[idx.last] : ''].join(' ').trim().replace(/[\u0000-\u001f\u007f]/g, '')
      if (!url || !name || /^[=+\-@]/.test(name)) { skipped++; continue }
      ins.run(tenantId, name.slice(0, 200), url, idx.company >= 0 ? blank(r[idx.company]) : null, idx.position >= 0 ? blank(r[idx.position]) : null, idx.connected >= 0 ? blank(r[idx.connected]) : null)
      imported++
    }
  })
  replaceAll()
  return { imported, skipped, replaced, capped }
}

// Delete control: wipe the tenant's imported connections. User-reported paths are NOT
// touched - they are the user's own notes, deleted per-path or with the lead.
export function deleteConnections(db: Database.Database, tenantId: string): number {
  migrateWarm(db)
  const r = db.prepare('DELETE FROM tenant_connections WHERE tenant_id = ?').run(tenantId)
  return Number(r.changes)
}

export function connectionImportStatus(db: Database.Database, tenantId: string): { count: number; imported_at: number | null } {
  migrateWarm(db)
  const r = db.prepare('SELECT COUNT(*) c, MAX(imported_at) t FROM tenant_connections WHERE tenant_id = ?').get(tenantId) as { c: number; t: number | null }
  return { count: r.c, imported_at: r.t }
}

export interface UserReportedPath {
  id: string
  contact_url: string
  mutual_name: string
  note: string | null
  created_at: number
}

// A mutual the USER saw and reported (e.g. LinkedIn showed "2 mutual connections").
// Stored with provenance 'user_reported' - dazl never verifies or vouches for it.
export function addUserReportedPath(db: Database.Database, tenantId: string, leadId: string, contactUrl: string, mutualName: string, note?: string): UserReportedPath | null {
  migrateWarm(db)
  const url = normalizeLinkedInUrl(contactUrl)
  const name = sanitizeCell(mutualName)
  if (!url || !name) return null
  // Only the caller's own lead: another tenant's lead id is treated like one that does not exist.
  if (!db.prepare('SELECT 1 FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE l.id = ? AND j.user_id = ?').get(leadId, tenantId)) return null
  const id = crypto.randomUUID()
  db.prepare('INSERT OR IGNORE INTO warm_user_paths (id, tenant_id, lead_id, contact_url, mutual_name, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, tenantId, leadId, url, name, sanitizeCell(note, 500))
  const row = db.prepare('SELECT id, contact_url, mutual_name, note, created_at FROM warm_user_paths WHERE tenant_id = ? AND lead_id = ? AND contact_url = ? AND mutual_name = ?')
    .get(tenantId, leadId, url, name) as UserReportedPath | undefined
  return row ?? null
}

export function removeUserReportedPath(db: Database.Database, tenantId: string, id: string): boolean {
  migrateWarm(db)
  return Number(db.prepare('DELETE FROM warm_user_paths WHERE tenant_id = ? AND id = ?').run(tenantId, id).changes) > 0
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
  const user_reported = db.prepare('SELECT id, contact_url, mutual_name, note, created_at FROM warm_user_paths WHERE tenant_id = ? AND lead_id = ? ORDER BY created_at DESC')
    .all(tenantId, leadId) as UserReportedPath[]
  return { first_degree, manual_check, user_reported, imported_connections: conns.size }
}
