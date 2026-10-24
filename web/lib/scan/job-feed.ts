import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
import { companyKey, hasPhrase, norm } from './evidence.ts'
import { crawlJob, rawGet, type Get } from '../connectors/sitecrawl.ts'
import { guardedLookup } from './fetch-page.ts'
import { migrateSourceReview } from './source-review.ts'

// A public job feed lists companies that posted a role. A posting is a hiring signal and nothing more: it does not
// show buying intent, fit, current need or that anyone wants to hear from a seller. Every lead made here is saved as
// needs-review, ungraded, with the posting's own words as the quote and the posting page as the source. No model, no
// paid service, no send. The feed list is fixed so a request cannot point this at an arbitrary host.
export const FEEDS: Record<string, string> = {
  'sales-and-marketing': 'https://weworkremotely.com/categories/remote-sales-and-marketing-jobs.rss',
  'business-and-management': 'https://weworkremotely.com/categories/remote-business-and-management-jobs.rss',
  'customer-support': 'https://weworkremotely.com/categories/remote-customer-support-jobs.rss',
}
export const MAX_FEED_LEADS = 6
// Each company's contact read gets its own deadline, and reads use the plain guarded fetch (never the optional render backend),
// so the deadline reaches every request this path makes.
export const CRAWL_DEADLINE_MS = 20_000
export const READING_STALE_S = 150
export const PAGE_PHASE_MS = 20_000
export interface FeedItem { company: string; role: string; url: string; date: string | null; site: string | null }
export class JobFeedError extends Error {}

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim()
const tag = (b: string, n: string) => b.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i'))?.[1]

// Feed titles read "Company: Role". Anything else is skipped, never guessed.
export function parseFeedItems(xml: string, max = 100): FeedItem[] {
  const out: FeedItem[] = []
  for (const m of [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, max)) {
    const title = decode(tag(m[1], 'title') ?? '')
    const i = title.indexOf(': ')
    if (i < 1) continue
    const company = title.slice(0, i).trim(), role = title.slice(i + 2).trim()
    const url = decode(tag(m[1], 'guid') ?? '')
    if (company.length < 2 || company.length > 150 || role.length < 3 || role.length > 200) continue
    let u: URL; try { u = new URL(url) } catch { continue }
    if (u.protocol !== 'https:' || u.hostname !== 'weworkremotely.com' || !u.pathname.startsWith('/remote-jobs/') || u.search || u.username || u.port) continue
    const d = new Date(decode(tag(m[1], 'pubDate') ?? ''))
    // The poster's own site, when the posting states it. Only identity: it says nothing about size or fit.
    const site = (tag(m[1], 'description') ?? '').match(/URL:(?:<|&lt;)\/strong(?:>|&gt;)\s*(?:<|&lt;)a href=["'](https?:\/\/[^"'\s]{3,200})["']/i)?.[1] ?? null
    out.push({ company, role, url: u.toString(), date: Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10), site })
  }
  return out
}

// The seller's own role words, e.g. "account executive, sales development". They pick postings by title; they do not grade fit.
export function parseRoleWords(raw: unknown): string[] {
  if (typeof raw !== 'string') throw new JobFeedError('Enter 1 to 8 role words, separated by commas.')
  const words = [...new Set(raw.toLowerCase().split(',').map(w => w.replace(/\s+/g, ' ').trim()).filter(w => w.length >= 3 && w.length <= 40))]
  if (words.length < 1 || words.length > 8) throw new JobFeedError('Enter 1 to 8 role words, separated by commas.')
  return words
}
export const matchRoles = (items: FeedItem[], words: string[]) => items.filter(i => words.some(w => i.role.toLowerCase().includes(w)))

// The quote is the posting's own words about itself: "<role> at <company>" when the page shows that line, else the role title if it is long enough.
export function postingQuote(item: FeedItem, page: Page): string | null {
  for (const q of [`${item.role} at ${item.company}`, item.role]) if (q.length >= 20 && q.length <= 400 && page.text.includes(q)) return q
  return null
}

export interface FeedIntakeDeps { fetchFeed?: (url: string) => Promise<string | null>; fetchPage?: (url: string) => Promise<Page | FetchFail>; get?: Get; now?: number; gapMs?: number; env?: Record<string, string | undefined>; deadlineMs?: number; pagePhaseMs?: number }
const defaultFeed = async (url: string) => { try { const r = await fetch(url, { headers: { 'user-agent': 'dazl-feed-check/1.0 (+https://dazl.ai/bot)', accept: 'application/rss+xml, application/xml' }, signal: AbortSignal.timeout(10_000) }); return r.ok ? (await r.text()).slice(0, 2_000_000) : null } catch { return null } }

export function migrateHiringFeed(db: Database.Database): void {
  migrateSourceReview(db)
  // One row per saved company, and unique per account and company, so a duplicate is refused by the database itself. It records whether its contact read is running, finished, cut off or failed. A 'reading' row older than READING_STALE_S means the server stopped mid-read.
  db.exec(`CREATE TABLE IF NOT EXISTS hiring_feed_crawl (
    lead_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, company_key TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, claim TEXT
  ); CREATE UNIQUE INDEX IF NOT EXISTS hiring_feed_crawl_company ON hiring_feed_crawl(tenant_id, company_key);
  CREATE INDEX IF NOT EXISTS hiring_feed_crawl_job ON hiring_feed_crawl(tenant_id, job_id)`)
}

interface CrawlTarget { id: string; company: string; source_url: string; job_id: string; claim: string }
const auditCount = (db: Database.Database, jobId: string) => (db.prepare('SELECT count(*) c FROM connector_audit WHERE scan_job_id = ?').get(jobId) as { c: number }).c

// Reads each company's own site one at a time, each with its own deadline. The outcome is recorded per company:
// finished = the read ran to an answer (found or none published), cut_off = the deadline hit, failed = it stopped without any answer.
async function runCrawls(db: Database.Database, tenant: string, targets: CrawlTarget[], deps: FeedIntakeDeps): Promise<void> {
  for (const t of targets) {
    const signal = AbortSignal.timeout(deps.deadlineMs ?? CRAWL_DEADLINE_MS)
    const before = auditCount(db, t.job_id)
    let status: 'finished' | 'cut_off' | 'failed' = 'failed'
    try {
      await crawlJob(db, tenant, t.job_id, { get: deps.get ?? (url => rawGet(url, 0, 10_000, guardedLookup, signal)), gapMs: deps.gapMs, env: deps.env, signal, leads: [{ id: t.id, company: t.company, source_url: t.source_url }] })
      status = signal.aborted ? 'cut_off' : auditCount(db, t.job_id) > before ? 'finished' : 'failed'
    } catch { status = 'failed' }
    // Only the read that still holds this company's claim may record its outcome. A stale worker finishing after a retry took over changes nothing.
    db.prepare("UPDATE hiring_feed_crawl SET status = ?, finished_at = ? WHERE lead_id = ? AND tenant_id = ? AND status = 'reading' AND claim = ?").run(status, Math.floor(Date.now() / 1000), t.id, tenant, t.claim)
  }
}

export async function createHiringFeedIntake(db: Database.Database, tenant: string, feed: string, rawWords: unknown, deps: FeedIntakeDeps = {}) {
  const none = (extra: Partial<{ feed_items: number; matched: number; skipped: { company: string; role: string; fetch_status: string }[]; note: string }>) => ({ crawl: Promise.resolve(), job_id: null as string | null, feed_items: 0, matched: 0, leads: [] as { lead_id: string; company: string; role: string; quote_match: boolean; fetch_status: string }[], skipped: [] as { company: string; role: string; fetch_status: string }[], note: '', ...extra })
  if (!Object.hasOwn(FEEDS, feed)) throw new JobFeedError('Pick one of the listed feeds.')
  const words = parseRoleWords(rawWords)
  const xml = await (deps.fetchFeed ?? defaultFeed)(FEEDS[feed])
  if (!xml) return none({ note: 'The feed could not be read. Nothing was saved.' })
  const items = parseFeedItems(xml)
  const matched = matchRoles(items, words)
  migrateHiringFeed(db)
  const savedKeys = () => new Set((db.prepare("SELECT l.company FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = 'hiring_feed'").all(tenant) as { company: string }[]).map(r => companyKey(r.company)))
  // Postings that state the company's own site come first: identity only, nothing about size or fit.
  const seen = savedKeys(), picked: FeedItem[] = []
  for (const it of [...matched.filter(i => i.site), ...matched.filter(i => !i.site)]) { const k = companyKey(it.company); if (k.length < 2 || seen.has(k)) continue; seen.add(k); picked.push(it); if (picked.length >= MAX_FEED_LEADS) break }
  if (!picked.length) {
    if (!matched.length) return none({ feed_items: items.length, note: 'No postings matched those role words. Nothing was saved.' })
    // Saved before: no new lead. A saved company whose contact read never finished is read again, so dedupe cannot strand it.
    const again = claimUnfinished(db, tenant, deps.now ?? Math.floor(Date.now() / 1000), { keys: new Set(matched.map(m => companyKey(m.company))) })
    return { ...none({ feed_items: items.length, matched: matched.length, note: again.length ? `Those companies are already saved. Nothing new was saved. Reading contacts again for ${again.length} saved ${again.length === 1 ? 'company' : 'companies'} whose earlier read did not finish.` : 'Those companies are already saved. Nothing new was saved.' }), crawl: again.length ? runCrawls(db, tenant, again, deps) : Promise.resolve() }
  }
  const fetchP = deps.fetchPage ?? ((u: string) => fetchPageDetailed(u, async () => null))
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const checked: { it: FeedItem; page: Page; quote: string }[] = []
  const skipped: { company: string; role: string; fetch_status: string }[] = []
  // All posting pages are read at once under one overall limit, so the answer is bounded (feed read + PAGE_PHASE_MS) however slow a site is.
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<{ fail: 'error' }>(res => { timer = setTimeout(() => res({ fail: 'error' as const }), deps.pagePhaseMs ?? PAGE_PHASE_MS); })
  const pages = await Promise.all(picked.map(it => Promise.race([fetchP(it.url).catch(() => ({ fail: 'error' as const })), limit])))
  clearTimeout(timer)
  picked.forEach((it, i) => {
    const page = pages[i]
    const quote = isFail(page) ? null : postingQuote(it, page)
    if (isFail(page) || !quote) { skipped.push({ company: it.company, role: it.role, fetch_status: isFail(page) ? String(page.fail) : 'fetched' }); return }
    checked.push({ it, page, quote })
  })
  if (!checked.length) return none({ feed_items: items.length, matched: matched.length, skipped, note: 'The postings were found, but their pages did not show the posting line, so nothing was saved.' })
  const jobId = randomBytes(12).toString('hex')
  const rows: { lead_id: string; company: string; role: string; quote_match: boolean; fetch_status: string; source_url: string; claim: string }[] = []
  const claimOf = new Map<string, string>()
  // Re-check for already-saved companies inside the same synchronous transaction as the writes, so two overlapping requests cannot both save one company.
  db.transaction(() => {
    const have = savedKeys()
    for (const { it, page, quote } of checked) {
      const k = companyKey(it.company)
      if (have.has(k)) continue
      have.add(k)
      const key = k, leadId = randomBytes(12).toString('hex')
      const named = key.length >= 2 && (hasPhrase(norm(quote), key) || hasPhrase(norm(page.title), key))
      const signal = `Posted a role titled "${it.role}" (hiring signal only: not buying intent, fit or current need)`
      if (db.prepare("INSERT OR IGNORE INTO hiring_feed_crawl(lead_id,tenant_id,job_id,company_key,status,started_at,claim) VALUES(?,?,?,?,'reading',?,?)").run(leadId, tenant, jobId, k, now, claimOf.get(leadId) ?? (claimOf.set(leadId, randomBytes(8).toString('hex')), claimOf.get(leadId)!)).changes !== 1) continue
      if (!rows.length) db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES(?,?,'Hiring feed intake','manual','manual','running')").run(jobId, tenant)
      // The date is the feed's posting date, kept as an unverified claim; it is not a current-need date.
      db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,contact,event_date,date_status,retrieved_at,confidence,review_reason,source_kind) VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL,'source_review_required','hiring_feed')")
        .run(leadId, jobId, it.company, signal, it.url, quote, it.date, it.date ? 'unverified' : 'undated', page.retrievedAt)
      db.prepare('INSERT INTO source_reviews(id,tenant_id,job_id,lead_id,input_json,fetch_status,quote_match,company_named,contact_match,checked_at) VALUES(?,?,?,?,?,?,1,?,0,?)')
        .run(randomBytes(12).toString('hex'), tenant, jobId, leadId, JSON.stringify({ company: it.company, signal, source_url: it.url, excerpt: quote, contact: null, event_date: it.date, feed }), 'fetched', +named, page.retrievedAt)
      rows.push({ lead_id: leadId, company: it.company, role: it.role, quote_match: true, fetch_status: 'fetched', source_url: it.url, claim: claimOf.get(leadId)! })
    }
    if (rows.length) db.prepare("UPDATE scan_jobs SET status='done',finished_at=?,candidates=?,verified=0,needs_review=?,dropped=0 WHERE id=?").run(now, rows.length, rows.length, jobId)
  })()
  if (!rows.length) return none({ feed_items: items.length, matched: matched.length, skipped, note: 'Those companies were saved by another request a moment ago. Nothing new was saved.' })
  // The leads are saved, so the answer does not wait on the slow contact reads. They run on while the server stays up; their per-company state is recorded and readable.
  const crawl = runCrawls(db, tenant, rows.map(r => ({ id: r.lead_id, company: r.company, source_url: r.source_url, job_id: jobId, claim: r.claim })), deps)
  return { crawl, job_id: jobId as string | null, feed_items: items.length, matched: matched.length, leads: rows.map(({ source_url: _s, claim: _c, ...r }) => r), skipped, note: '' }
}

export type CrawlState = 'reading' | 'finished' | 'cut_off' | 'failed' | 'interrupted'
export interface FeedStatusRow { lead_id: string; company: string; state: CrawlState; site: string | null; emails: number }
export function hiringFeedStatus(db: Database.Database, tenant: string, jobId: string, now = Math.floor(Date.now() / 1000)): FeedStatusRow[] {
  migrateHiringFeed(db)
  const rows = db.prepare(`SELECT c.lead_id, l.company, c.status, c.started_at, l.company_domain AS site,
      (SELECT count(*) FROM lead_enrichments e WHERE e.lead_id = c.lead_id AND e.tenant_id = c.tenant_id AND e.kind = 'email') AS emails
    FROM hiring_feed_crawl c JOIN leads l ON l.id = c.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = c.tenant_id
    WHERE c.tenant_id = ? AND c.job_id = ? ORDER BY l.rowid`).all(tenant, jobId) as { lead_id: string; company: string; status: string; started_at: number; site: string | null; emails: number }[]
  return rows.map(r => ({ lead_id: r.lead_id, company: r.company, site: r.site, emails: r.emails, state: (r.status === 'reading' && now - r.started_at > READING_STALE_S ? 'interrupted' : r.status) as CrawlState }))
}

// A no-cost retry for companies whose contact read did not finish. Each company is claimed with one atomic update, so overlapping retries cannot read the same company twice.
function claimUnfinished(db: Database.Database, tenant: string, now: number, where: { jobId?: string; keys?: Set<string> }): CrawlTarget[] {
  const claimed: CrawlTarget[] = []
  db.transaction(() => {
    const rows = db.prepare(`SELECT c.lead_id AS id, l.company, l.source_url, c.job_id FROM hiring_feed_crawl c JOIN leads l ON l.id = c.lead_id JOIN scan_jobs j ON j.id = l.scan_job_id AND j.user_id = c.tenant_id
      WHERE c.tenant_id = ? AND (? IS NULL OR c.job_id = ?) AND (c.status IN ('cut_off','failed') OR (c.status = 'reading' AND ? - c.started_at > ?))`).all(tenant, where.jobId ?? null, where.jobId ?? null, now, READING_STALE_S) as Omit<CrawlTarget, 'claim'>[]
    for (const r of rows) {
      if (where.keys && !where.keys.has(companyKey(r.company))) continue
      const claim = randomBytes(8).toString('hex')
      const u = db.prepare("UPDATE hiring_feed_crawl SET status = 'reading', started_at = ?, finished_at = NULL, claim = ? WHERE lead_id = ? AND tenant_id = ? AND (status IN ('cut_off','failed') OR (status = 'reading' AND ? - started_at > ?))").run(now, claim, r.id, tenant, now, READING_STALE_S)
      if (u.changes === 1) claimed.push({ ...r, claim })
    }
  })()
  return claimed
}
export async function retryHiringFeedContacts(db: Database.Database, tenant: string, jobId: string, deps: FeedIntakeDeps = {}) {
  migrateHiringFeed(db)
  const claimed = claimUnfinished(db, tenant, deps.now ?? Math.floor(Date.now() / 1000), { jobId })
  return { retrying: claimed.length, crawl: claimed.length ? runCrawls(db, tenant, claimed, deps) : Promise.resolve() }
}

// The caller's most recent hiring-feed check, so the state stays visible after a page reload.
export function latestHiringFeedJob(db: Database.Database, tenant: string): string | null {
  migrateHiringFeed(db)
  return (db.prepare('SELECT job_id FROM hiring_feed_crawl WHERE tenant_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(tenant) as { job_id: string } | undefined)?.job_id ?? null
}
