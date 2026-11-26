// #1588: people who engage with the user's own competitors' LinkedIn posts, read by dazl Connect in the user's own browser
// (lib/linkedin-tasks/competitors.ts). Each competitor in Settings may carry its LinkedIn page; only when the workspace has
// connected dazl Connect is one page read a week, its recent posts become post_engagement reads inside the same pacing gate,
// and the commenters become leads carrying the competitor, the post, their own comment and a confidence that ranks
// question/complaint comments over plain ones over likes. Invented competitors, people and posts; nothing here touches LinkedIn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { completeTask, nextTask } from '../lib/linkedin-tasks/store.ts'
import { pairLinkedIn } from './helpers/li-pair.ts'
import { enqueueCompetitorPages, onTaskResult, MAX_POSTS_PER_COMPETITOR, MAX_ENGAGERS_PER_POST } from '../lib/linkedin-tasks/competitors.ts'
import { readCompetitorPages, setCompetitors, MAX_COMPETITORS } from '../lib/signals/competitor-reddit.ts'
import type { Db } from '../lib/db/client.ts'

const PAGE = 'https://www.linkedin.com/company/acme-rivals/'
const PROFILE_PAGE = 'https://www.linkedin.com/in/acme-founder/'
const POST = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234567-AbCd'
const POST2 = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234568-BbCd'
const POST3 = 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234569/'
const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000   // 10:00 in America/Toronto
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
const RECENT = day(TEN_AM - 3 * 86400)
const eng = (n: number, extra: Record<string, unknown> = {}) => ({ name: `Jane Doe${n}`, title: 'VP Sales at Northwind', profile_url: `https://www.linkedin.com/in/jane-doe-${n}/`, ...extra })

bothEngines('competitor pages in Settings: a LinkedIn page each, names alone stay names; a bad page is refused', async ({ db }) => {
  assert.equal((await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }, 'Plain Rival', { name: 'Founder Co', page_url: PROFILE_PAGE }])).ok, true)
  assert.deepEqual(await readCompetitorPages(db, 'A'), [{ name: 'Acme Rivals', page_url: PAGE }, { name: 'Founder Co', page_url: PROFILE_PAGE }])
  const bad = await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: 'https://example.com/not-linkedin' }])
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? '', /LinkedIn/)
  const truncated = await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: `${PAGE}?tracking=1` }])
  assert.equal(truncated.ok, true, 'a page link with query junk is cleaned, not refused')
  assert.deepEqual(await readCompetitorPages(db, 'A'), [{ name: 'Acme Rivals', page_url: PAGE }])
})

bothEngines('no connected extension: nothing is queued; with one, each competitor page is read once a week', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }, 'Plain Rival', { name: 'Founder Co', page_url: PROFILE_PAGE }])
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM), 0, 'nothing until the workspace connects dazl Connect')
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM), 2, 'one read per page, none for a competitor with no page')
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM + 60), 0, 'the same page is not read twice in a week')
  assert.equal((await setCompetitors(db, 'A', [])).ok, true)
  const many: string[] = []
  for (let i = 0; i < MAX_COMPETITORS + 2; i++) many.push(`Rival ${i}`)
  assert.equal((await setCompetitors(db, 'A', many)).ok, false, 'the 5-competitor cap still holds')
})

bothEngines("the page read becomes engagement reads of its recent dated posts, then leads carrying competitor, comment and post", async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  let next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next, JSON.stringify(next))
  assert.equal(next.task.kind, 'company_posts')
  assert.equal(next.task.url, PAGE)
  const OLD = day(TEN_AM - 40 * 86400)
  assert.equal(await completeTask(db, 'A', next.task.id, {
    posts: [
      { url: POST, date: RECENT },
      { url: POST2, date: OLD },
      { url: POST3 },                                        // no date shown: recency cannot be proven, so it is not read
      { url: 'https://news.example/x', date: RECENT },       // not a LinkedIn post: never opened
    ],
  }, TEN_AM + 30), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 31), { queued: 1 })
  assert.equal(await onTaskResult(db, 'B', next.task.id, TEN_AM + 31), 'not_a_competitor_task', 'another workspace cannot turn this read into reads')
  next = await nextTask(db, 'A', TEN_AM + 200, () => 0.5)
  assert.ok('task' in next)
  assert.equal(next.task.kind, 'post_engagement')
  assert.equal(next.task.url, POST)
  assert.equal(await completeTask(db, 'A', next.task.id, {
    people: [
      eng(1, { comment: 'Why does it always crash on export? We are looking for an alternative.' }),
      eng(2, { comment: 'Nice post' }),
      eng(3, { action: 'like' }),
      eng(1, { comment: 'duplicate profile URL' }),
    ],
  }, TEN_AM + 250), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 260), { stored: 3 })
  const job = (await db.all<{ id: string; query: string }>("SELECT id, query FROM scan_jobs WHERE user_id = 'A' AND business_name = ?", ['LinkedIn: people engaging with a competitor\u2019s post']))[0]
  assert.ok(job)
  assert.equal(job.query, "People engaging with Acme Rivals' LinkedIn posts")
  const leads = await db.all<Record<string, unknown>>('SELECT * FROM leads WHERE scan_job_id = ? ORDER BY name', [job.id])
  assert.equal(leads.length, 3, 'one lead per person, duplicates by profile URL dropped')
  const [asker, praiser, liker] = leads
  assert.equal(asker.signal, "Commented on Acme Rivals' LinkedIn post")
  assert.equal(asker.evidence_excerpt, 'Why does it always crash on export? We are looking for an alternative.')
  assert.equal(asker.event_date, RECENT)
  assert.equal(asker.date_status, 'unverified')
  assert.equal(asker.confidence, 80, 'a question or complaint comment ranks highest')
  assert.equal(praiser.confidence, 70, 'a plain comment')
  assert.equal(liker.signal, "Liked Acme Rivals' LinkedIn post")
  assert.equal(liker.confidence, 50, 'a like ranks below any comment')
  for (const l of leads) {
    assert.equal(l.source_url, POST)
    assert.equal(l.source_kind, 'competitor')
    assert.match(String(l.timing_note), /does not show when each person engaged/)
    assert.match(String(l.dedup_key), /^li:https:\/\/www\.linkedin\.com\/in\//)
  }
  const enrich = await db.all<{ kind: string; value: string; source_url: string }>('SELECT kind, value, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? ORDER BY kind', ['A', (asker as { id: string }).id])
  assert.deepEqual(enrich.map(e => [e.kind, e.value, e.source_url]), [
    ['competitor', 'Engaged with a post by Acme Rivals', POST],
    ['linkedin', 'https://www.linkedin.com/in/jane-doe-1/', POST],
    ['person', 'Jane Doe1, VP Sales at Northwind', 'https://www.linkedin.com/in/jane-doe-1/'],
  ])
})

bothEngines('undated posts and old posts are never opened; a capped handful of recent posts per competitor', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  const next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next)
  const posts = [...Array(MAX_POSTS_PER_COMPETITOR + 2).keys()].map(i => ({ url: `${POST}-${i}`, date: RECENT }))
  assert.equal(await completeTask(db, 'A', next.task.id, { posts }, TEN_AM + 30), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 31), { queued: MAX_POSTS_PER_COMPETITOR })
  const queued = await db.all<{ url: string }>("SELECT url FROM li_tasks WHERE tenant_id = 'A' AND kind = 'post_engagement' AND status = 'queued'")
  assert.equal(queued.length, MAX_POSTS_PER_COMPETITOR)
  assert.ok(MAX_POSTS_PER_COMPETITOR <= 3 && MAX_ENGAGERS_PER_POST <= 20, 'each competitor costs at most a few of the workspace\u2019s 40 pages a day')
})

bothEngines('a task that is not a competitor read is not claimed by the competitor lane', async ({ db }) => {
  const next = await nextTask(db, 'A', TEN_AM, () => 0.5)
  assert.ok(!('task' in next), `no extension paired, nothing is served at all: ${JSON.stringify(next)}`)
  assert.equal(await onTaskResult(db, 'A', 'nonexistent', TEN_AM), 'not_a_competitor_task')
})
