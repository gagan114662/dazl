// People who engaged with a LinkedIn post, as leads (launch brief, Step 4: a LinkedIn signal plus a profile link is a shown lead).
//   1. A discovery run that turns up public LinkedIn posts about what the user asked for queues one read of each post's comments
//      (enqueuePostEngagement). Only when the workspace has connected dazl Connect: the read happens in the user's own browser.
//   2. When the extension posts who it saw (onPostEngagementResult), each person becomes a lead of the same request: their name and
//      headline as LinkedIn printed them, their own profile link, and the post as the proof of the signal.
// Leads can only be added to a running scan, and the read arrives minutes or hours after the scan ended, so the people land in a
// small scan of their own that carries the original request. Nothing is inferred: no company, no email, no date dazl did not read.
import { randomBytes } from 'node:crypto'
import type { Db, Tx, TxBody } from '../db/client.ts'
import { addEnrichmentTx } from '../connectors/store.ts'
import { enqueueTask } from './store.ts'
import { personOk, taskUrlOk, type ReadPerson } from './limits.ts'
import { hasExtension } from './buyers.ts'

export const MAX_POSTS_PER_SCAN = 3      // each read is one of the workspace's 40 LinkedIn pages a day
export const MAX_PEOPLE_PER_POST = 20
export const ENGAGER_SOURCE_KIND = 'discover'
const ref = (jobId: string) => `post:${jobId}`

// The LinkedIn post pages among the URLs a run saw, in the shape the extension may open; one per post, at most MAX_POSTS_PER_SCAN.
export function linkedinPostUrls(urls: Iterable<string | null | undefined>): string[] {
  const out: string[] = []
  for (const u of urls) {
    const ok = taskUrlOk('post_engagement', u)
    if (ok && !out.includes(ok)) out.push(ok)
    if (out.length >= MAX_POSTS_PER_SCAN) break
  }
  return out
}

export async function enqueuePostEngagement(db: Db, tenantId: string, jobId: string, urls: Iterable<string | null | undefined>, now?: number): Promise<number> {
  const posts = linkedinPostUrls(urls)
  if (!posts.length || !(await hasExtension(db, tenantId))) return 0
  let queued = 0
  for (const url of posts) if (await enqueueTask(db, tenantId, 'post_engagement', url, ref(jobId), now)) queued++
  return queued
}

export type EngagerOutcome = { stored: number } | 'not_a_post_task'
export async function onPostEngagementResult(db: Db, tenantId: string, taskId: string, now = Math.floor(Date.now() / 1000)): Promise<EngagerOutcome> {
  return db.tx(function* (t: Tx): TxBody<EngagerOutcome> {
    const task = yield* t.get<{ kind: string; url: string; requested_by: string | null }>("SELECT kind, url, requested_by FROM li_tasks WHERE id = ? AND tenant_id = ? AND status = 'done'", [taskId, tenantId])
    const m = task?.kind === 'post_engagement' ? /^post:([^:]{1,80})$/.exec(task.requested_by ?? '') : null
    if (!task || !m) return 'not_a_post_task'
    const origin = yield* t.get<{ query: string | null; seller: string | null; offer: string | null }>('SELECT query, seller, offer FROM scan_jobs WHERE id = ? AND user_id = ?', [m[1], tenantId])
    if (!origin) return 'not_a_post_task'
    const res = yield* t.get<{ payload: string }>('SELECT payload FROM li_results WHERE task_id = ? AND tenant_id = ?', [taskId, tenantId])
    let people: ReadPerson[] = []
    try { people = ((JSON.parse(res?.payload ?? '{}') as { people?: unknown[] }).people ?? []).map(personOk).filter((p): p is ReadPerson => !!p).slice(0, MAX_PEOPLE_PER_POST) } catch { people = [] }
    if (!people.length) return { stored: 0 }
    const jobId = randomBytes(12).toString('hex')
    yield* t.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, seller, offer, status) VALUES (?, ?, ?, '(from request)', '-', ?, ?, ?, 'running')",
      [jobId, tenantId, 'LinkedIn: people engaging with a post', origin.query, origin.seller, origin.offer])
    const day = new Date(now * 1000).toISOString().slice(0, 10)
    let stored = 0
    for (const p of people) {
      const leadId = randomBytes(12).toString('hex')
      const r = yield* t.run(`INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, score, evidence_excerpt, event_date, date_status, retrieved_at, confidence, dedup_key, fit, intent, why, source_kind, timing_note)
        VALUES (?, ?, ?, '', NULL, ?, ?, 55, ?, NULL, 'undated', ?, 55, ?, 3, 3, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [leadId, jobId, p.name.slice(0, 150), 'Engaged with this LinkedIn post (a comment or a reaction).', task.url, p.title.slice(0, 400), now, `li:${p.profile_url}`,
          'Read in your own browser by dazl Connect.', ENGAGER_SOURCE_KIND, 'LinkedIn shows who engaged, not when. Open the post to see its date.'])
      if (!r.changes) continue
      stored++
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'person', value: `${p.name}, ${p.title}`.slice(0, 254), label: 'as shown on LinkedIn', confidence: null, source_url: p.profile_url, source_date: day, retrieved_at: now })
      yield* addEnrichmentTx(t, tenantId, leadId, { connector: 'discover', kind: 'linkedin', value: p.profile_url, label: 'their LinkedIn profile', confidence: null, source_url: task.url, source_date: day, retrieved_at: now })
    }
    yield* t.run("UPDATE scan_jobs SET status = 'done', candidates = ?, verified = ?, needs_review = 0, dropped = 0, finished_at = ? WHERE id = ? AND status = 'running'", [people.length, stored, now, jobId])
    return { stored }
  })
}
