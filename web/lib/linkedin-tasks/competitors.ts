// #1588: people who engage with the user's own competitors' LinkedIn posts, read by dazl Connect in the user's own browser.
//   1. Every scan re-arms one read of each competitor page Settings carries (enqueueCompetitorPages, called by the scan runner):
//      only when the workspace has connected dazl Connect, at most once a page a week (the queue's own dedup), and never again
//      in that week once a read of that page has failed (an extension build that cannot read the page must not burn the
//      workspace's daily pages on it).
//   2. The page's own recent post links - written BY the configured page (the author is checked against it, a link alone is
//      not proof), dated within 30 days by a timestamp or a relative marker resolved to its OLDEST plausible day, at most a
//      capped few - become post_engagement reads in the same working-hours / one-at-a-time / 40-a-day gate as every other
//      read (onTaskResult's company_posts half). The competitor and its page must still be configured exactly as they were.
//   3. Who the extension saw on the post becomes a lead of a small scan of its own (onTaskResult's post_engagement half):
//      the person, their profile, the post, the competitor and their own comment. Comment > like; a question or complaint
//      comment ranks highest. One lead per person: a person who engages with several of the competitor's posts enriches
//      their existing lead instead of duplicating it. Nothing inferred: no company, no email, no date dazl did not read.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { addEnrichmentTx } from '../connectors/store.ts'
import { DEDUPE_S, enqueueTask } from './store.ts'
import { engagerOk, postOk, type EngagerPerson } from './limits.ts'
import { hasExtension } from './buyers.ts'
import { MAX_COMPETITORS, readCompetitorPages, type CompetitorPage } from '../signals/competitor-reddit.ts'

export const MAX_POSTS_PER_COMPETITOR = 3      // each read is one of the workspace's 40 LinkedIn pages a day
export const MAX_ENGAGERS_PER_POST = 20
const MAX_POST_AGE_DAYS = 30
const LEAD_DEDUP_DAYS = 30                    // one lead per person per month of competitor posts, however many they engaged with
export const COMPETITOR_SOURCE_KIND = 'competitor'
// A comment that asks or complains is the strongest form of this signal: the person is naming a problem with what they
// use today. Deterministic word list, nothing model-judged, so the same comment always ranks the same.
const QUESTION_OR_COMPLAINT = /\?|why|how do|how to|issue|problem|broken|doesn|does not|can't|cannot|fail|crash|bug|help|alternative|switch/i

// The task refs: which competitor page a read belongs to, and which competitor, page and post date a post read belongs to
// (approx marks a day resolved from a relative marker, not a timestamp). Both are checked against current Settings before
// anything is queued or stored, so a competitor removed or re-paged between reads leaves no stale leads.
const pageRef = (name: string) => `competitor_page:${name}`
const postRef = (page: CompetitorPage, date: string | null, approx: boolean) => `competitor_post:${page.name}:${page.page_url}:${date ?? 'nodate'}:${approx ? 'a' : 'e'}`
const POST_REF = /^competitor_post:(.{2,60}):(https:\/\/www\.linkedin\.com\/(?:company|in)\/[A-Za-z0-9%_.-]{2,100}\/?):(nodate|\d{4}-\d{2}-\d{2}):([ae])$/

// One read of every configured competitor page (a company page or a founder profile), at most once a page a week, and
// not at all that week once a read of the page has failed. Nothing is queued until the workspace has connected dazl
// Connect: a read happens in the user's own browser or not at all.
export async function enqueueCompetitorPages(db: Db, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const pages = await readCompetitorPages(db, tenantId)
  if (!pages.length || !(await hasExtension(db, tenantId))) return 0
  let queued = 0
  for (const page of pages.slice(0, MAX_COMPETITORS)) {
    const failed = await db.get<{ id: string }>("SELECT id FROM li_tasks WHERE tenant_id = ? AND kind = 'company_posts' AND url = ? AND status = 'failed' AND created_at > ?", [tenantId, page.page_url, now - DEDUPE_S])
    if (failed) continue
    if (await enqueueTask(db, tenantId, 'company_posts', page.page_url, pageRef(page.name), now)) queued++
  }
  return queued
}

const withinDays = (date: string, now: number, days: number): boolean => {
  const at = new Date(`${date}T00:00:00Z`).getTime() / 1000
  return Number.isFinite(at) && at <= now + 86_400 && at >= now - days * 86_400
}

export type CompetitorTaskOutcome = 'not_a_competitor_task' | { queued: number } | { stored: number }

// What a finished competitor read becomes, by the task's own kind and ref. Any other task (a scan's own post read, a
// People page, a profile) is left to its own lane: this handler claims only competitor_page and competitor_post refs.
export async function onTaskResult(db: Db, tenantId: string, taskId: string, now = Math.floor(Date.now() / 1000)): Promise<CompetitorTaskOutcome> {
  const task = await db.get<{ kind: string; url: string; requested_by: string | null }>("SELECT kind, url, requested_by FROM li_tasks WHERE id = ? AND tenant_id = ? AND status = 'done'", [taskId, tenantId])
  if (task?.kind === 'company_posts') {
    const m = /^competitor_page:(.{2,60})$/.exec(task.requested_by ?? '')
    if (!m) return 'not_a_competitor_task'
    // The competitor must still be configured with exactly this page: a read of a page the user has replaced, or of a
    // competitor the user has removed, queues nothing.
    const current = (await readCompetitorPages(db, tenantId)).find(p => p.name === m[1] && p.page_url === task.url)
    if (!current) return { queued: 0 }
    const res = await db.get<{ payload: string }>('SELECT payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
    let posts: { url: string; date: string | null; approx: boolean; author: string }[] = []
    // Only posts the page itself authored, dated within 30 days, are opened: recency or authorship that cannot be
    // proven is not read.
    try { posts = ((JSON.parse(res?.payload ?? '{}') as { posts?: unknown[] }).posts ?? []).map(postOk).filter((p): p is { url: string; date: string | null; approx: boolean; author: string } => !!p).filter(p => p.author === task.url && p.date != null && withinDays(p.date, now, MAX_POST_AGE_DAYS)) } catch { posts = [] }
    let queued = 0
    for (const p of posts.slice(0, MAX_POSTS_PER_COMPETITOR)) if (await enqueueTask(db, tenantId, 'post_engagement', p.url, postRef(current, p.date, p.approx), now)) queued++
    return { queued }
  }
  if (task?.kind === 'post_engagement') {
    const m = POST_REF.exec(task.requested_by ?? '')
    if (!m) return 'not_a_competitor_task'
    // The competitor and the page the post came from must still be configured as they were when the read was queued.
    const current = (await readCompetitorPages(db, tenantId)).find(p => p.name === m[1] && p.page_url === m[2])
    if (!current) return 'not_a_competitor_task'
    return storeEngagers(db, tenantId, task.url, current, m[3] === 'nodate' ? null : m[3], m[4] === 'a', taskId, now)
  }
  return 'not_a_competitor_task'
}

// The commenters of a competitor's post become leads: the person, their profile, the post and their own words. A person
// who already has a competitor lead from the last month enriches that lead with this post instead of becoming a second row.
async function storeEngagers(db: Db, tenantId: string, postUrl: string, page: CompetitorPage, postDate: string | null, approx: boolean, taskId: string, now: number): Promise<{ stored: number }> {
  const res = await db.get<{ payload: string }>('SELECT payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
  let people: EngagerPerson[] = []
  try { people = ((JSON.parse(res?.payload ?? '{}') as { people?: unknown[] }).people ?? []).map(engagerOk).filter((p): p is EngagerPerson => !!p).slice(0, MAX_ENGAGERS_PER_POST) } catch { people = [] }
  if (!people.length) return { stored: 0 }
  return db.tx(function* (t: Tx): TxBody<{ stored: number }> {
    const competitor = page.name
    const jobId = randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller, offer, status) VALUES (?, ?, ?, '(from request)', '-', ?, NULL, NULL, 'running')",
      [jobId, tenantId, 'LinkedIn: people engaging with a competitor\u2019s post', `People engaging with ${of(competitor)} LinkedIn posts`])
    const day = new Date(now * 1000).toISOString().slice(0, 10)
    let stored = 0
    for (const p of people) {
      const question = p.action === 'comment' && p.comment != null && QUESTION_OR_COMPLAINT.test(p.comment)
      const confidence = p.action === 'like' ? 50 : question ? 80 : 70
      const leadId = randomBytes(12).toString('hex')
      const excerpt = p.action === 'like' ? 'Reacted to the post; no comment of their own.' : p.comment != null ? p.comment.slice(0, 400) : 'Commented; their comment text was not shown on this page.'
      // One lead per person per month: someone who engages with several of the competitor's posts (or several
      // competitors' posts) adds this post to their existing lead's competitor enrichment, not a second row.
      const competitorEnrichment = (leadId: string) => addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'competitor', value: `Engaged with a post by ${competitor} (${postUrl})`.slice(0, 254), label: `${competitor} (your competitor)`, confidence: null, source_url: postUrl, source_date: postDate ?? day, retrieved_at: now })
      const prior = (yield* t.get<{ id: string }>(`SELECT l.id FROM leads l JOIN scan_jobs j ON j.id = l.scan_job_id WHERE j.user_id = ? AND l.dedup_key = ? AND l.source_kind = ? AND l.retrieved_at > ? ORDER BY l.retrieved_at DESC LIMIT 1`,
        [tenantId, `li:${p.profile_url}`, COMPETITOR_SOURCE_KIND, now - LEAD_DEDUP_DAYS * 86_400]))?.id ?? null
      if (prior) {
        yield* competitorEnrichment(prior)
        continue
      }
      const r = yield* t.run(`INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, why, source_kind, timing_note)
        VALUES (?, ?, ?, '', NULL, ?, ?, 55, ?, ?, ?, ?, ?, ?, 3, 3, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [leadId, jobId, p.name.slice(0, 150), p.action === 'like' ? `Liked ${of(competitor)} LinkedIn post` : `Commented on ${of(competitor)} LinkedIn post`, postUrl,
          excerpt, postDate, postDate ? 'unverified' : 'undated', now, confidence, `li:${p.profile_url}`,
          'Read in your own browser by dazl Connect.', COMPETITOR_SOURCE_KIND,
          postDate ? (approx ? 'The post\u2019s age as LinkedIn showed it (a relative age, so the day is the oldest it could mean); LinkedIn does not show when each person engaged.' : 'The post\u2019s own date; LinkedIn does not show when each person engaged.') : 'LinkedIn showed no date on this post.'])
      if (!r.changes) continue
      stored++
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 254), label: 'as shown on LinkedIn', confidence: null, source_url: p.profile_url, source_date: day, retrieved_at: now })
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'linkedin', value: p.profile_url, label: 'their LinkedIn profile', confidence: null, source_url: postUrl, source_date: postDate ?? day, retrieved_at: now })
      yield* competitorEnrichment(leadId)
    }
    yield* t.run("UPDATE scan_jobs SET status = 'done', candidates = ?, verified = ?, needs_review = 0, dropped = 0, finished_at = ? WHERE id = ? AND status = 'running'", [people.length, stored, now, jobId])
    return { stored }
  })
}

// The possessive of the competitor's own name, as English prints it ("Acme Rivals'", "Founder Co's").
const of = (name: string) => /s$/i.test(name) ? `${name}'` : `${name}'s`
