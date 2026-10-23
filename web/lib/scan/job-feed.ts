import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fetchPageDetailed, isFail, type FetchFail, type Page } from './fetch-page.ts'
import { companyKey, hasPhrase, norm } from './evidence.ts'
import { crawlJob, type Get } from '../connectors/sitecrawl.ts'
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
export const CRAWL_DEADLINE_MS = 60_000
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

export interface FeedIntakeDeps { fetchFeed?: (url: string) => Promise<string | null>; fetchPage?: (url: string) => Promise<Page | FetchFail>; get?: Get; now?: number; gapMs?: number; env?: Record<string, string | undefined> }
const defaultFeed = async (url: string) => { try { const r = await fetch(url, { headers: { 'user-agent': 'dazl-feed-check/1.0 (+https://dazl.ai/bot)', accept: 'application/rss+xml, application/xml' }, signal: AbortSignal.timeout(15_000) }); return r.ok ? (await r.text()).slice(0, 2_000_000) : null } catch { return null } }

export async function createHiringFeedIntake(db: Database.Database, tenant: string, feed: string, rawWords: unknown, deps: FeedIntakeDeps = {}) {
  if (!Object.hasOwn(FEEDS, feed)) throw new JobFeedError('Pick one of the listed feeds.')
  const words = parseRoleWords(rawWords)
  const xml = await (deps.fetchFeed ?? defaultFeed)(FEEDS[feed])
  if (!xml) return { crawl: Promise.resolve(), job_id: null as string | null, feed_items: 0, matched: 0, leads: [] as { lead_id: string; company: string; role: string; quote_match: boolean; fetch_status: string }[], skipped: [] as { company: string; role: string; fetch_status: string }[], note: 'The feed could not be read. Nothing was saved.' }
  const items = parseFeedItems(xml)
  const matched = matchRoles(items, words)
  // A retry or a second click must not save the same company twice for this account.
  const have = new Set((db.prepare("SELECT l.company FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.source_kind = 'hiring_feed'").all(tenant) as { company: string }[]).map(r => companyKey(r.company)))
  const seen = new Set<string>(have), picked: FeedItem[] = []
  // Postings that state the company's own site come first: the contact read can then start from a named site. Order inside each group is the feed's.
  for (const it of [...matched.filter(i => i.site), ...matched.filter(i => !i.site)]) { const k = companyKey(it.company); if (k.length < 2 || seen.has(k)) continue; seen.add(k); picked.push(it); if (picked.length >= MAX_FEED_LEADS) break }
  if (!picked.length) return { crawl: Promise.resolve(), job_id: null, feed_items: items.length, matched: matched.length, leads: [], skipped: [] as { company: string; role: string; fetch_status: string }[], note: matched.length ? 'Those companies are already saved from an earlier check. Nothing new was saved.' : 'No postings matched those role words. Nothing was saved.' }
  migrateSourceReview(db)
  const fetchP = deps.fetchPage ?? ((u: string) => fetchPageDetailed(u, async () => null))
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const jobId = randomBytes(12).toString('hex')
  const rows: { lead_id: string; company: string; role: string; quote_match: boolean; fetch_status: string; source_url: string }[] = []
  const stmts: (() => void)[] = []
  const skipped: { company: string; role: string; fetch_status: string }[] = []
  for (const it of picked) {
    const page = await fetchP(it.url).catch(() => ({ fail: 'error' as const }))
    const ok = !isFail(page)
    const quote = ok ? postingQuote(it, page) : null
    
    if (!quote) { skipped.push({ company: it.company, role: it.role, fetch_status: ok ? 'fetched' : page.fail }); continue }
    const key = companyKey(it.company)
    const named = ok && key.length >= 2 && (hasPhrase(norm(quote), key) || hasPhrase(norm(page.title), key))
    const leadId = randomBytes(12).toString('hex')
    const signal = `Posted a role titled "${it.role}" (hiring signal only: not buying intent, fit or current need)`
    const status = ok ? 'fetched' : page.fail
    stmts.push(() => {
      // The date is the feed's posting date, kept as an unverified claim; it is not a current-need date.
      db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,evidence_excerpt,contact,event_date,date_status,retrieved_at,confidence,review_reason,source_kind) VALUES(?,?,?,?,?,?,NULL,?,?,?,NULL,'source_review_required','hiring_feed')")
        .run(leadId, jobId, it.company, signal, it.url, quote, it.date, it.date ? 'unverified' : 'undated', ok ? page.retrievedAt : null)
      db.prepare('INSERT INTO source_reviews(id,tenant_id,job_id,lead_id,input_json,fetch_status,quote_match,company_named,contact_match,checked_at) VALUES(?,?,?,?,?,?,?,?,0,?)')
        .run(randomBytes(12).toString('hex'), tenant, jobId, leadId, JSON.stringify({ company: it.company, signal, source_url: it.url, excerpt: quote, contact: null, event_date: it.date, feed }), status, 1, +named, ok ? page.retrievedAt : now)
    })
    rows.push({ lead_id: leadId, company: it.company, role: it.role, quote_match: true, fetch_status: status, source_url: it.url })
  }
  if (!rows.length) return { crawl: Promise.resolve(), job_id: null, feed_items: items.length, matched: matched.length, leads: [], skipped, note: 'The postings were found, but their pages did not show the posting line, so nothing was saved.' }
  db.transaction(() => {
    db.prepare("INSERT INTO scan_jobs(id,user_id,business_name,industry,location,status) VALUES(?,?,'Hiring feed intake','manual','manual','running')").run(jobId, tenant)
    for (const s of stmts) s()
    db.prepare("UPDATE scan_jobs SET status='done',finished_at=?,candidates=?,verified=0,needs_review=?,dropped=0 WHERE id=?").run(now, rows.length, rows.length, jobId)
  })()
  // Published contacts come from each company's own site (same robots/same-site/role rules as scans). Free HTTP only.
  // The leads are already saved, so the answer does not wait on this slow read: it keeps running and fills in contacts later.
  const crawl = crawlJob(db, tenant, jobId, { get: deps.get, gapMs: deps.gapMs, env: deps.env, signal: AbortSignal.timeout(CRAWL_DEADLINE_MS), leads: rows.map(r => ({ id: r.lead_id, company: r.company, source_url: r.source_url })) })
  return { crawl, job_id: jobId, feed_items: items.length, matched: matched.length, leads: rows.map(({ source_url: _s, ...r }) => r), skipped, note: '' }
}
