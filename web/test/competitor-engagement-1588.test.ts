// #1588: people who engage with the user's own competitors' LinkedIn posts, read by dazl Connect in the user's own browser
// (lib/linkedin-tasks/competitors.ts). Each competitor in Settings may carry its LinkedIn page; only when the workspace has
// connected dazl Connect is one page read a week, its own recent authored posts become post_engagement reads inside the same
// pacing gate, and the commenters become leads carrying the competitor, the post, their own comment and a confidence that
// ranks question/complaint comments over plain ones over likes. A competitor removed or re-paged between reads, a post the
// page did not author, or a person who already has this month's competitor lead, all leave no stale or duplicate rows.
// Invented competitors, people and posts; nothing here touches LinkedIn.
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { completeTask, nextTask } from '../lib/linkedin-tasks/store.ts'
import { pairLinkedIn } from './helpers/li-pair.ts'
import { enqueueCompetitorPages, onTaskResult, MAX_POSTS_PER_COMPETITOR, MAX_ENGAGERS_PER_POST } from '../lib/linkedin-tasks/competitors.ts'
import { readCompetitorPages, setCompetitors, MAX_COMPETITORS } from '../lib/signals/competitor-reddit.ts'

const PAGE = 'https://www.linkedin.com/company/acme-rivals/'
const OTHER_PAGE = 'https://www.linkedin.com/company/someone-else/'
const PROFILE_PAGE = 'https://www.linkedin.com/in/acme-founder/'
const POST = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234567-AbCd'
const POST2 = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234568-BbCd'
const POST3 = 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234569/'
const POST4 = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234571-Re'
const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000   // 10:00 in America/Toronto
const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
const RECENT = day(TEN_AM - 3 * 86400)
const eng = (n: number, extra: Record<string, unknown> = {}) => ({ name: `Jane Doe${n}`, title: 'VP Sales at Northwind', profile_url: `https://www.linkedin.com/in/jane-doe-${n}/`, ...extra })

bothEngines('competitor pages in Settings: a LinkedIn page each, names alone stay names; a bad row is refused whole', async ({ db }) => {
  assert.equal((await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }, 'Plain Rival', { name: 'Founder Co', page_url: PROFILE_PAGE }])).ok, true)
  assert.deepEqual(await readCompetitorPages(db, 'A'), [{ name: 'Acme Rivals', page_url: PAGE }, { name: 'Founder Co', page_url: PROFILE_PAGE }])
  const saved = await readCompetitorPages(db, 'A')
  for (const bad of [
    [{ name: 'Acme Rivals', page_url: 'https://example.com/not-linkedin' }],   // not a LinkedIn page
    [{ name: 'Acme Rivals', page_url: 5 }],                                   // not a string
    [{}],                                                                     // a nameless row must not normalize away and wipe the list
    [{ page_url: PAGE }],                                                      // a page without a name
  ] as Parameters<typeof setCompetitors>[2][]) {
    const r = await setCompetitors(db, 'A', bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.match(r.error ?? '', /LinkedIn|name/i)
  }
  assert.deepEqual(await readCompetitorPages(db, 'A'), saved, 'a refused save leaves the stored list alone')
  const truncated = await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: `${PAGE}?tracking=1` }])
  assert.equal(truncated.ok, true, 'a page link with query junk is cleaned, not refused')
  assert.deepEqual(await readCompetitorPages(db, 'A'), [{ name: 'Acme Rivals', page_url: PAGE }])
  const many: string[] = []
  for (let i = 0; i < MAX_COMPETITORS + 2; i++) many.push(`Rival ${i}`)
  assert.equal((await setCompetitors(db, 'A', many)).ok, false, 'the 5-competitor cap still holds')
})

bothEngines('no connected extension: nothing is queued; with one, each competitor page is read once a week', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }, 'Plain Rival', { name: 'Founder Co', page_url: PROFILE_PAGE }])
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM), 0, 'nothing until the workspace connects dazl Connect')
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM), 2, 'one read per page, none for a competitor with no page')
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM + 60), 0, 'the same page is not read twice in a week')
})

bothEngines('a page whose read failed this week is not re-armed every scan', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  let next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next)
  // An extension build that cannot read the page answers something the server refuses: the task fails, and the weekly
  // re-arm must not hand the same page to it again every scan (each attempt costs one of the 40 daily pages).
  assert.equal(await completeTask(db, 'A', next.task.id, { people: [eng(1)] }, TEN_AM + 30), 'bad_result')
  next = await nextTask(db, 'A', TEN_AM + 400, () => 0.5)      // the expired lease is handed out once more
  assert.ok('task' in next)
  assert.equal(await completeTask(db, 'A', next.task.id, { people: [eng(1)] }, TEN_AM + 410), 'bad_result')
  const after = await nextTask(db, 'A', TEN_AM + 900, () => 0.5)
  assert.ok(!('task' in after), JSON.stringify(after))         // second refusal: the task is failed, the queue is empty
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM + 910), 0, 'a failed page read is not re-armed the same week')
  assert.equal(await enqueueCompetitorPages(db, 'A', TEN_AM + 8 * 86400), 1, 'the next week it is')
})

bothEngines("the page read becomes engagement reads of its own recent authored posts, then leads carrying competitor, comment and post", async ({ db }) => {
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
      { url: POST, date: RECENT, approx: false, author: PAGE },
      { url: POST2, date: OLD, approx: false, author: PAGE },                     // too old: never opened
      { url: POST3, author: PAGE },                                               // no date shown: recency unproven, never opened
      { url: POST4, date: RECENT, approx: false, author: OTHER_PAGE },             // another page's post: not this competitor's
      { url: POST4, date: RECENT, approx: false },                                 // author not named: not proof the competitor wrote it
      { url: 'https://news.example/x', date: RECENT, approx: false, author: PAGE }, // not a LinkedIn post
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
      eng(4),                                        // an old extension build: a commenter whose text did not come through
      eng(1, { comment: 'duplicate profile URL' }),
    ],
  }, TEN_AM + 250), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 260), { stored: 4 })
  const job = (await db.all<{ id: string; query: string }>("SELECT id, query FROM scan_jobs WHERE user_id = 'A' AND business_name = ?", ['LinkedIn: people engaging with a competitor\u2019s post']))[0]
  assert.ok(job)
  assert.equal(job.query, "People engaging with Acme Rivals' LinkedIn posts")
  const leads = await db.all<Record<string, unknown>>('SELECT * FROM leads WHERE scan_job_id = ? ORDER BY name', [job.id])
  assert.equal(leads.length, 4, 'one lead per person, duplicates by profile URL dropped')
  const [asker, praiser, liker, noText] = leads
  assert.equal(asker.signal, "Commented on Acme Rivals' LinkedIn post")
  assert.equal(asker.evidence_excerpt, 'Why does it always crash on export? We are looking for an alternative.')
  assert.equal(asker.event_date, RECENT)
  assert.equal(asker.date_status, 'unverified')
  assert.equal(asker.confidence, 80, 'a question or complaint comment ranks highest')
  assert.equal(noText.evidence_excerpt, 'Commented; their comment text was not shown on this page.', 'a missing comment is never shown as the person\u2019s quoted words')
  assert.equal(praiser.confidence, 70, 'a plain comment')
  assert.equal(liker.signal, "Liked Acme Rivals' LinkedIn post")
  assert.equal(liker.confidence, 50, 'a like ranks below any comment')
  for (const l of leads) {
    assert.equal(l.source_url, POST)
    assert.equal(l.source_kind, 'competitor')
    assert.equal(l.company, '', 'no company is invented; the person and their words are what was read')
    assert.match(String(l.timing_note), /does not show when each person engaged/)
    assert.match(String(l.dedup_key), /^li:https:\/\/www\.linkedin\.com\/in\//)
  }
  const enrich = await db.all<{ kind: string; value: string; source_url: string }>('SELECT kind, value, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? ORDER BY kind', ['A', (asker as { id: string }).id])
  assert.deepEqual(enrich.map(e => [e.kind, e.value, e.source_url]), [
    ['competitor', `Engaged with a post by Acme Rivals (${POST})`, POST],
    ['linkedin', 'https://www.linkedin.com/in/jane-doe-1/', POST],
    ['person', 'Jane Doe1, VP Sales at Northwind', 'https://www.linkedin.com/in/jane-doe-1/'],
  ])
})

bothEngines('undated and old posts are never opened; a capped handful of recent posts per competitor', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  const next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next)
  const posts = [...Array(MAX_POSTS_PER_COMPETITOR + 2).keys()].map(i => ({ url: `${POST}-${i}`, date: RECENT, approx: false, author: PAGE }))
  assert.equal(await completeTask(db, 'A', next.task.id, { posts }, TEN_AM + 30), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 31), { queued: MAX_POSTS_PER_COMPETITOR })
  const queued = await db.all<{ url: string }>("SELECT url FROM li_tasks WHERE tenant_id = 'A' AND kind = 'post_engagement' AND status = 'queued'")
  assert.equal(queued.length, MAX_POSTS_PER_COMPETITOR)
  assert.ok(MAX_POSTS_PER_COMPETITOR <= 3 && MAX_ENGAGERS_PER_POST <= 20, 'each competitor costs at most a few of the workspace\u2019s 40 pages a day')
})

bothEngines('a competitor removed or re-paged between reads leaves no reads and no leads', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  let next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next)
  // The competitor's page was replaced while the read was out: the old page's posts are not opened.
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PROFILE_PAGE }])
  assert.equal(await completeTask(db, 'A', next.task.id, { posts: [{ url: POST, date: RECENT, approx: false, author: PAGE }] }, TEN_AM + 30), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 31), { queued: 0 })
  // And a post read whose competitor was removed stores nothing.
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await enqueueCompetitorPages(db, 'A', TEN_AM + 8 * 86400)
  next = await nextTask(db, 'A', TEN_AM + 8 * 86400 + 5, () => 0.5)
  assert.ok('task' in next)
  assert.equal(await completeTask(db, 'A', next.task.id, { posts: [{ url: POST, date: RECENT, approx: false, author: PAGE }] }, TEN_AM + 8 * 86400 + 30), 'stored')
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 8 * 86400 + 31), { queued: 1 })
  next = await nextTask(db, 'A', TEN_AM + 8 * 86400 + 400, () => 0.5)
  assert.ok('task' in next && next.task.kind === 'post_engagement')
  await completeTask(db, 'A', next.task.id, { people: [eng(1, { comment: 'Nice post' })] }, TEN_AM + 8 * 86400 + 500)
  await setCompetitors(db, 'A', [])
  assert.equal(await onTaskResult(db, 'A', next.task.id, TEN_AM + 8 * 86400 + 600), 'not_a_competitor_task', 'a removed competitor stores no leads')
  assert.equal((await db.all('SELECT id FROM leads')).length, 0)
})

bothEngines('one lead per person per month: a second post enriches the first lead, it does not duplicate it', async ({ db }) => {
  await setCompetitors(db, 'A', [{ name: 'Acme Rivals', page_url: PAGE }])
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueueCompetitorPages(db, 'A', TEN_AM)
  let next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next)
  await completeTask(db, 'A', next.task.id, { posts: [{ url: POST, date: RECENT, approx: true, author: PAGE }, { url: POST2, date: RECENT, approx: true, author: PAGE }] }, TEN_AM + 30)
  assert.deepEqual(await onTaskResult(db, 'A', next.task.id, TEN_AM + 31), { queued: 2 })
  let at = TEN_AM + 500
  for (const _ of [POST, POST2]) {
    next = await nextTask(db, 'A', at, () => 0.5)
    assert.ok('task' in next, JSON.stringify({ at, next }))
    await completeTask(db, 'A', next.task.id, { people: [eng(1, { comment: 'Nice post' })] }, at + 100)
    await onTaskResult(db, 'A', next.task.id, at + 200)
    at += 400
  }
  const leads = await db.all<Record<string, unknown>>("SELECT * FROM leads WHERE source_kind = 'competitor'")
  assert.equal(leads.length, 1, 'the same person on two of the competitor\u2019s posts is one lead')
  assert.ok([POST, POST2].includes(String(leads[0].source_url)), 'the lead\u2019s proof is the post read first')
  const enrich = await db.all<{ kind: string; source_url: string }>('SELECT kind, source_url FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ? AND kind = ?', ['A', (leads[0] as { id: string }).id, 'competitor'])
  assert.deepEqual(enrich.map(e => e.source_url).sort(), [POST, POST2].sort(), 'both posts are kept as evidence on the same lead')
  assert.match(String(leads[0].timing_note), /relative age/, 'a day resolved from a relative marker says so')
})

bothEngines('a task that is not a competitor read is not claimed by the competitor lane', async ({ db }) => {
  const next = await nextTask(db, 'A', TEN_AM, () => 0.5)
  assert.ok(!('task' in next), `no extension paired, nothing is served at all: ${JSON.stringify(next)}`)
  assert.equal(await onTaskResult(db, 'A', 'nonexistent', TEN_AM), 'not_a_competitor_task')
})
