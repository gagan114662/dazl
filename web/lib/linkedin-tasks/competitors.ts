// #1588: people who engage with the user's own competitors' LinkedIn posts, read by dazl Connect in the user's own browser.
//   1. Every scan re-arms one read of each competitor page Settings carries (enqueueCompetitorPages, called by the scan runner):
//      only when the workspace has connected dazl Connect, and at most once a page a week (the queue's own dedup).
//   2. The page's own recent post links (up to 30 days old, a capped few per competitor, never an undated one) become
//      post_engagement reads in the same working-hours / one-at-a-time / 40-a-day gate as every other read
//      (onTaskResult's company_posts half).
//   3. Who the extension saw on the post becomes a lead of a small scan of its own (onTaskResult's post_engagement half):
//      the person, their profile, the post, the competitor and their own comment. Comment > like; a question or complaint
//      comment ranks highest. Nothing inferred: no company, no email, no date dazl did not read, no hardcoded names.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { addEnrichmentTx } from '../connectors/store.ts'
import { enqueueTask } from './store.ts'
import { engagerOk, postOk, type EngagerPerson } from './limits.ts'
import { hasExtension } from './buyers.ts'
import { MAX_COMPETITORS, readCompetitorPages } from '../signals/competitor-reddit.ts'

export const MAX_POSTS_PER_COMPETITOR = 3      // each read is one of the workspace's 40 LinkedIn pages a day
export const MAX_ENGAGERS_PER_POST = 20
const MAX_POST_AGE_DAYS = 30
export const COMPETITOR_SOURCE_KIND = 'competitor'
// A comment that asks or complains is the strongest form of this signal: the person is naming a problem with what they
// use today. Deterministic word list, nothing model-judged, so the same comment always ranks the same.
const QUESTION_OR_COMPLAINT = /\?|why|how do|how to|issue|problem|broken|doesn|does not|can't|cannot|fail|crash|bug|help|alternative|switch/i

const pageRef = (name: string) => `competitor_page:${name}`
const postRef = (name: string, date: string | null) => `competitor_post:${name}:${date ?? 'nodate'}`
// The possessive of the competitor's own name, as English prints it ("Acme Rivals'", "Founder Co's").
const of = (name: string) => /s$/i.test(name) ? `${name}'` : `${name}'s`

// One read of every configured competitor page (a company page or a founder profile), at most once a page a week.
// Nothing is queued until the workspace has connected dazl Connect: a read happens in the user's own browser or not at all.
export async function enqueueCompetitorPages(db: Db, tenantId: string, now = Math.floor(Date.now() / 1000)): Promise<number> {
  const pages = await readCompetitorPages(db, tenantId)
  if (!pages.length || !(await hasExtension(db, tenantId))) return 0
  let queued = 0
  for (const { name, page_url } of pages.slice(0, MAX_COMPETITORS)) {
    if (await enqueueTask(db, tenantId, 'company_posts', page_url, pageRef(name), now)) queued++
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
    const competitor = m[1]
    // The competitor was removed from Settings while the read was out: its posts are not opened.
    const still = await readCompetitorPages(db, tenantId)
    if (!still.some(p => p.name === competitor)) return { queued: 0 }
    const res = await db.get<{ payload: string }>('SELECT payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
    let posts: { url: string; date: string | null }[] = []
    // Only posts that carry their own date within 30 days are opened: recency that cannot be proven is not read.
    try { posts = ((JSON.parse(res?.payload ?? '{}') as { posts?: unknown[] }).posts ?? []).map(postOk).filter((p): p is { url: string; date: string | null } => !!p).filter(p => p.date != null && withinDays(p.date, now, MAX_POST_AGE_DAYS)) } catch { posts = [] }
    let queued = 0
    for (const p of posts.slice(0, MAX_POSTS_PER_COMPETITOR)) if (await enqueueTask(db, tenantId, 'post_engagement', p.url, postRef(competitor, p.date), now)) queued++
    return { queued }
  }
  if (task?.kind === 'post_engagement') {
    const m = /^competitor_post:(.{2,60}):(nodate|\d{4}-\d{2}-\d{2})$/.exec(task.requested_by ?? '')
    if (!m) return 'not_a_competitor_task'
    return storeEngagers(db, tenantId, task.url, m[1], m[2] === 'nodate' ? null : m[2], taskId, now)
  }
  return 'not_a_competitor_task'
}

// The commenters of a competitor's post become leads: the person, their profile, the post and their own words.
async function storeEngagers(db: Db, tenantId: string, postUrl: string, competitor: string, postDate: string | null, taskId: string, now: number): Promise<{ stored: number }> {
  const res = await db.get<{ payload: string }>('SELECT payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
  let people: EngagerPerson[] = []
  try { people = ((JSON.parse(res?.payload ?? '{}') as { people?: unknown[] }).people ?? []).map(engagerOk).filter((p): p is EngagerPerson => !!p).slice(0, MAX_ENGAGERS_PER_POST) } catch { people = [] }
  if (!people.length) return { stored: 0 }
  return db.tx(function* (t: Tx): TxBody<{ stored: number }> {
    const jobId = randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller, offer, status) VALUES (?, ?, ?, '(from request)', '-', ?, NULL, NULL, 'running')",
      [jobId, tenantId, 'LinkedIn: people engaging with a competitor\u2019s post', `People engaging with ${of(competitor)} LinkedIn posts`])
    const day = new Date(now * 1000).toISOString().slice(0, 10)
    let stored = 0
    for (const p of people) {
      const question = p.action === 'comment' && p.comment != null && QUESTION_OR_COMPLAINT.test(p.comment)
      const confidence = p.action === 'like' ? 50 : question ? 80 : 70
      const leadId = randomBytes(12).toString('hex')
      const r = yield* t.run(`INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, why, source_kind, timing_note)
        VALUES (?, ?, ?, '', NULL, ?, ?, 55, ?, ?, ?, ?, ?, ?, 3, 3, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [leadId, jobId, p.name.slice(0, 150), p.action === 'like' ? `Liked ${of(competitor)} LinkedIn post` : `Commented on ${of(competitor)} LinkedIn post`, postUrl,
          p.action === 'like' ? 'Reacted to the post; no comment of their own.' : (p.comment ?? p.title).slice(0, 400),
          postDate, postDate ? 'unverified' : 'undated', now, confidence, `li:${p.profile_url}`,
          'Read in your own browser by dazl Connect.', COMPETITOR_SOURCE_KIND,
          postDate ? 'The post\u2019s own date; LinkedIn does not show when each person engaged.' : 'LinkedIn showed no date on this post.'])
      if (!r.changes) continue
      stored++
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 254), label: 'as shown on LinkedIn', confidence: null, source_url: p.profile_url, source_date: day, retrieved_at: now })
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'linkedin', value: p.profile_url, label: 'their LinkedIn profile', confidence: null, source_url: postUrl, source_date: postDate ?? day, retrieved_at: now })
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'competitor', value: `Engaged with a post by ${competitor}`.slice(0, 254), label: `${competitor} (your competitor)`, confidence: null, source_url: postUrl, source_date: postDate ?? day, retrieved_at: now })
    }
    yield* t.run("UPDATE scan_jobs SET status = 'done', candidates = ?, verified = ?, needs_review = 0, dropped = 0, finished_at = ? WHERE id = ? AND status = 'running'", [people.length, stored, now, jobId])
    return { stored }
  })
}
