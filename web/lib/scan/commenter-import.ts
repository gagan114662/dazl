// Commenter import (Pro only). The user pastes LinkedIn profile URLs - or uploads a CSV
// with name/title/company/profile-URL columns - for people who engaged with a post, and
// each row becomes a lead written straight from the row. No scraping by design:
//  - only linkedin.com/in/<slug> profile URLs are accepted; every other LinkedIn path is
//    rejected at import;
//  - the profile URL is stored as provenance and is NEVER fetched - the import runs no
//    LLM, no web research, and the contact crawl skips the evidence fetch for these leads
//    (it probes name-derived company domains instead, robots-respecting as always);
//  - names derived from a URL slug are labeled 'derived' - a guess, not profile data.
// One batch = one scan_job (the leads' owner row), no LLM, no TinyFish, no scan quota.
// Enrichment is company-level and free-or-BYOK only: Apollo/PDL org lookup on the
// tenant's own key (1 credit per distinct company, capped), people lookup (no emails),
// contact-page crawl, and SEC/job-board signals.
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { addEnrichment, audit, getEnabledCredential } from '../connectors/store.ts'
import { apolloOrgEnrich, apolloPeopleSearch, EnrichError } from '../enrich/apollo.ts'
import { pdlPeopleSearch } from '../enrich/pdl.ts'
import { getMasterKey } from '../secrets.ts'

export const MAX_PROFILES = 100
export const MAX_COMPANY_LOOKUPS = 50 // Apollo/PDL credit discipline: 1 org credit per distinct company, capped

export function migrateCommenterImport(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commenter_batches (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      context    TEXT NOT NULL CHECK (length(context) BETWEEN 1 AND 500),
      total      INTEGER NOT NULL,
      job_id     TEXT REFERENCES scan_jobs(id) ON DELETE SET NULL,
      note       TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
    );
    CREATE INDEX IF NOT EXISTS commenter_batches_user ON commenter_batches (user_id, created_at);

    CREATE TABLE IF NOT EXISTS commenter_rows (
      id          TEXT PRIMARY KEY,
      batch_id    TEXT NOT NULL REFERENCES commenter_batches(id) ON DELETE CASCADE,
      profile_url TEXT NOT NULL CHECK (length(profile_url) BETWEEN 1 AND 500),
      slug        TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 100),
      name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 150),
      name_source TEXT NOT NULL CHECK (name_source IN ('csv','derived')),
      title       TEXT CHECK (title IS NULL OR length(title) <= 150),
      company     TEXT CHECK (company IS NULL OR length(company) <= 150),
      lead_id     TEXT REFERENCES leads(id) ON DELETE SET NULL,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS commenter_rows_batch ON commenter_rows (batch_id);
  `)
}

// Only personal profile URLs. Posts, articles, companies, schools, groups, feed items -
// anything else on linkedin.com - is rejected, because accepting it would invite a fetch.
const PROFILE_RE = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([a-z0-9][a-z0-9-]{0,98}[a-z0-9])\/?(?:[?#].*)?$/i

export function normalizeProfileUrl(raw: string): { url: string; slug: string } | { reason: string } {
  let s = raw.trim()
  if (!s) return { reason: 'blank' }
  if (/linkedin\.com\/(posts|feed|company|school|groups|jobs|pulse|article)/i.test(s)) {
    return { reason: 'only profile URLs (linkedin.com/in/...) are accepted - posts and pages are never fetched' }
  }
  const m = PROFILE_RE.exec(s)
  if (!m) {
    if (/linkedin\.com/i.test(s)) return { reason: 'not a profile URL - use linkedin.com/in/<name>' }
    return { reason: 'not a linkedin.com profile URL' }
  }
  const slug = m[1].toLowerCase()
  return { url: `https://www.linkedin.com/in/${slug}`, slug }
}

// Slug to display name: 'jane-doe-8a4b2112' -> 'Jane Doe'. Trailing tokens containing
// digits (LinkedIn's member-id suffix) are dropped. A guess from the URL text, always
// labeled 'derived' - never presented as profile data.
export function deriveName(slug: string): string {
  const parts = slug.split('-').filter(Boolean)
  const nameParts = parts.filter(p => !/\d/.test(p))
  const use = (nameParts.length > 0 ? nameParts : parts).slice(0, 4)
  return use.map(p => p[0].toUpperCase() + p.slice(1)).join(' ').slice(0, 150)
}

export interface ImportRow { profile_url: string; slug: string; name: string; name_source: 'csv' | 'derived'; title: string | null; company: string | null }
export interface ParsedImport { mode: 'csv' | 'urls'; valid: ImportRow[]; invalid: { line: string; reason: string }[]; overflow: number }

// Minimal CSV cell reader: quotes, escaped quotes, commas inside quotes.
function cells(line: string): string[] {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false
      else cur += c
    } else if (c === '"' && cur === '') q = true
    else if (c === ',') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out
}

const HEADER_MAP: { key: 'url' | 'name' | 'title' | 'company'; re: RegExp }[] = [
  { key: 'url', re: /^(profile[ _]?url|url|link|linkedin([ _]?url)?|profile[ _]?link)$/i },
  { key: 'name', re: /^(full[ _]?name|name|person)$/i },
  { key: 'title', re: /^(title|position|headline|role|job[ _]?title)$/i },
  { key: 'company', re: /^(company|organization|organisation|employer|org|company[ _]?name)$/i },
]

// Two input shapes. Column mode (primary): a CSV whose header names url/name/title/company
// columns - names come from the file and are labeled 'csv'. URL mode: one profile URL per
// line, name derived from the slug and labeled 'derived'. Both dedupe by profile URL and
// cap at MAX_PROFILES.
export function parseImport(text: string, max = MAX_PROFILES): ParsedImport {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const first = lines[0] ? cells(lines[0]) : []
  const colIdx: Partial<Record<'url' | 'name' | 'title' | 'company', number>> = {}
  let headerHits = 0
  first.forEach((h, i) => {
    for (const m of HEADER_MAP) if (m.re.test(h.replace(/^"|"$/g, ''))) { colIdx[m.key] = i; headerHits++ }
  })
  const columnMode = headerHits >= 1 && colIdx.url !== undefined
  const seen = new Set<string>()
  const valid: ImportRow[] = []
  const invalid: { line: string; reason: string }[] = []

  const pushUrlRow = (rawLine: string) => {
    const r = normalizeProfileUrl(rawLine.split(',')[0])
    if ('reason' in r) { if (r.reason !== 'blank') invalid.push({ line: rawLine.slice(0, 100), reason: r.reason }); return }
    if (seen.has(r.url)) return
    seen.add(r.url)
    valid.push({ profile_url: r.url, slug: r.slug, name: deriveName(r.slug), name_source: 'derived', title: null, company: null })
  }

  if (!columnMode) {
    for (const l of lines) pushUrlRow(l)
  } else {
    for (const l of lines.slice(1)) {
      const c = cells(l)
      const urlCell = c[colIdx.url!] ?? ''
      const r = normalizeProfileUrl(urlCell)
      if ('reason' in r) { invalid.push({ line: l.slice(0, 100), reason: r.reason === 'blank' ? 'missing profile URL' : r.reason }); continue }
      if (seen.has(r.url)) continue
      const csvName = (colIdx.name !== undefined ? c[colIdx.name] : '')?.trim() ?? ''
      const company = (colIdx.company !== undefined ? c[colIdx.company] : '')?.trim().slice(0, 150) || null
      const title = (colIdx.title !== undefined ? c[colIdx.title] : '')?.trim().slice(0, 150) || null
      // The slug always yields a derived fallback name, so a valid URL is enough on its own.
      seen.add(r.url)
      valid.push({
        profile_url: r.url, slug: r.slug,
        name: (csvName || deriveName(r.slug)).slice(0, 150),
        name_source: csvName ? 'csv' : 'derived',
        title, company,
      })
    }
  }
  const overflow = Math.max(0, valid.length - max)
  return { mode: columnMode ? 'csv' : 'urls', valid: valid.slice(0, max), invalid, overflow }
}

export interface ImportResult { batchId: string; jobId: string; imported: number }

// Writes the batch, ONE owning scan_job, and one lead per row - straight from the row,
// no LLM, no research, no verification. The job is born 'running' (the leads trigger
// requires it) and closed 'done' in the same transaction; the runner never sees it.
export function importCommenters(db: Database.Database, userId: string, rows: ImportRow[], context: string): ImportResult {
  const batchId = randomBytes(12).toString('hex')
  const jobId = randomBytes(12).toString('hex')
  const signal = context.trim().slice(0, 500)
  db.transaction(() => {
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, batch_id) VALUES (?, ?, 'Commenter import', '-', '-', 'running', ?)").run(jobId, userId, batchId)
    db.prepare('INSERT INTO commenter_batches (id, user_id, context, total, job_id) VALUES (?, ?, ?, ?, ?)').run(batchId, userId, signal, rows.length, jobId)
    const insRow = db.prepare('INSERT INTO commenter_rows (id, batch_id, profile_url, slug, name, name_source, title, company, lead_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insLead = db.prepare("INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, signal_kind, source_kind) VALUES (?, ?, ?, ?, NULL, ?, ?, 50, 'competitor_complaint', 'commenter')")
    for (const r of rows) {
      const leadId = randomBytes(12).toString('hex')
      const display = (r.title ? `${r.name} - ${r.title}` : r.name).slice(0, 150)
      insLead.run(leadId, jobId, display, (r.company ?? '').slice(0, 150), signal, r.profile_url)
      insRow.run(randomBytes(12).toString('hex'), batchId, r.profile_url, r.slug, r.name, r.name_source, r.title, r.company, leadId)
    }
    db.prepare("UPDATE scan_jobs SET status = 'done', finished_at = CAST(strftime('%s','now') AS INTEGER), candidates = ? WHERE id = ?").run(rows.length, jobId)
  })()
  return { batchId, jobId, imported: rows.length }
}

// Company-level enrichment only: Apollo org (1 credit per distinct company, capped) plus
// people lookup on the tenant's own BYOK key, PDL people as the alternative. No emails are
// stored - people results are name/title strings, same as the scan waterfall. Silent on
// failure: a bonus, never the bar.
export async function enrichCommenters(db: Database.Database, tenantId: string, batchId: string, deps: { fetchImpl?: typeof fetch; master?: Buffer } = {}): Promise<void> {
  const batch = db.prepare('SELECT job_id FROM commenter_batches WHERE id = ? AND user_id = ?').get(batchId, tenantId) as { job_id: string | null } | undefined
  if (!batch?.job_id) return
  const leads = db.prepare("SELECT id, company, company_domain FROM leads WHERE scan_job_id = ? AND company <> ''").all(batch.job_id) as { id: string; company: string; company_domain: string | null }[]
  if (leads.length === 0) return
  const fetchImpl = deps.fetchImpl ?? fetch
  const master = deps.master ?? getMasterKey()
  const apolloKey = getEnabledCredential(db, tenantId, 'enrich:apollo', master)
  const pdlKey = apolloKey ? null : getEnabledCredential(db, tenantId, 'enrich:pdl', master)
  if (!apolloKey && !pdlKey) return
  const now = Math.floor(Date.now() / 1000)
  const today = new Date().toISOString().slice(0, 10)

  const byCompany = new Map<string, { company: string; domain: string | null; leadIds: string[] }>()
  for (const l of leads) {
    const k = l.company.trim().toLowerCase()
    const g = byCompany.get(k) ?? { company: l.company.trim(), domain: l.company_domain, leadIds: [] }
    g.leadIds.push(l.id)
    byCompany.set(k, g)
  }
  for (const g of [...byCompany.values()].slice(0, MAX_COMPANY_LOOKUPS)) {
    if (apolloKey) {
      let org: Awaited<ReturnType<typeof apolloOrgEnrich>> = null
      try {
        org = await apolloOrgEnrich(apolloKey, { domain: g.domain, name: g.company }, fetchImpl)
        if (org && (org.employees || org.industry)) {
          const bits = [org.employees ? `${org.employees} employees` : null, org.industry, org.founded ? `founded ${org.founded}` : null].filter(Boolean).join(' · ')
          for (const leadId of g.leadIds) addEnrichment(db, tenantId, leadId, { connector: 'enrich:apollo', kind: 'firmographic', value: bits.slice(0, 254), label: org.name, confidence: 75, source_url: org.linkedin ?? org.website ?? `https://${g.domain ?? ''}`, source_date: today, retrieved_at: now })
        }
        audit(db, { tenantId, connector: 'enrich:apollo', jobId: batch.job_id, lookup: `org ${g.company}`, status: org ? 'ok' : 'empty', results: org ? 1 : 0 })
      } catch (e) {
        audit(db, { tenantId, connector: 'enrich:apollo', jobId: batch.job_id, lookup: `org ${g.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
      try {
        const orgDomain = g.domain ?? (/^[a-z]+:\/\/([^/?#]+)/i.exec(org?.website ?? '')?.[1]?.replace(/^www\./, '') || null)
        const people = await apolloPeopleSearch(apolloKey, { domain: orgDomain, name: g.company }, fetchImpl, 5)
        for (const leadId of g.leadIds) for (const p of people) addEnrichment(db, tenantId, leadId, { connector: 'enrich:apollo', kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'Apollo', confidence: 70, source_url: p.linkedin ?? `https://${g.domain ?? ''}`, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: 'enrich:apollo', jobId: batch.job_id, lookup: `people ${g.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: 'enrich:apollo', jobId: batch.job_id, lookup: `people ${g.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    } else if (pdlKey) {
      try {
        const people = await pdlPeopleSearch(pdlKey, g.company, fetchImpl, 5)
        for (const leadId of g.leadIds) for (const p of people) addEnrichment(db, tenantId, leadId, { connector: 'enrich:pdl', kind: 'contact', value: `${p.name}${p.title ? ` - ${p.title}` : ''}`.slice(0, 254), label: 'People Data Labs', confidence: 70, source_url: p.linkedin ?? `https://${g.domain ?? ''}`, source_date: today, retrieved_at: now })
        audit(db, { tenantId, connector: 'enrich:pdl', jobId: batch.job_id, lookup: `people ${g.company}`, status: people.length ? 'ok' : 'empty', results: people.length })
      } catch (e) {
        audit(db, { tenantId, connector: 'enrich:pdl', jobId: batch.job_id, lookup: `people ${g.company}`, status: e instanceof EnrichError ? e.code : 'error', results: 0 })
        if (e instanceof EnrichError && e.code === 'auth') return
      }
    }
  }
}

export interface CommenterRowStatus { profile_url: string; name: string; name_source: 'csv' | 'derived'; title: string | null; company: string | null; lead_id: string | null; note: string | null }
export interface CommenterBatchStatus { batch_id: string; context: string; total: number; note: string | null; created_at: number; job_id: string | null; rows: CommenterRowStatus[] }

export function commenterBatchStatus(db: Database.Database, userId: string, batchId: string): CommenterBatchStatus | undefined {
  const batch = db.prepare('SELECT id, context, total, note, created_at, job_id FROM commenter_batches WHERE id = ? AND user_id = ?').get(batchId, userId) as { id: string; context: string; total: number; note: string | null; created_at: number; job_id: string | null } | undefined
  if (!batch) return undefined
  const rows = db.prepare('SELECT profile_url, name, name_source, title, company, lead_id, note FROM commenter_rows WHERE batch_id = ? ORDER BY rowid').all(batchId) as CommenterRowStatus[]
  return { batch_id: batch.id, context: batch.context, total: batch.total, note: batch.note, created_at: batch.created_at, job_id: batch.job_id, rows }
}

// Delete a batch and everything it made: enrichments on its leads first (explicit, per
// the approved design), then the leads, rows, owning job and batch. Tenant-scoped.
export function deleteCommenterBatch(db: Database.Database, userId: string, batchId: string): boolean {
  const batch = db.prepare('SELECT job_id FROM commenter_batches WHERE id = ? AND user_id = ?').get(batchId, userId) as { job_id: string | null } | undefined
  if (!batch) return false
  db.transaction(() => {
    if (batch.job_id) {
      db.prepare('DELETE FROM lead_enrichments WHERE lead_id IN (SELECT id FROM leads WHERE scan_job_id = ?)').run(batch.job_id)
      db.prepare('DELETE FROM leads WHERE scan_job_id = ?').run(batch.job_id)
    }
    db.prepare('DELETE FROM commenter_rows WHERE batch_id = ?').run(batchId)
    db.prepare('DELETE FROM commenter_batches WHERE id = ?').run(batchId)
    if (batch.job_id) db.prepare('DELETE FROM scan_jobs WHERE id = ?').run(batch.job_id)
  })()
  return true
}
