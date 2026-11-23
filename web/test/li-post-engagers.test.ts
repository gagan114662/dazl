// People who engaged with a LinkedIn post become leads of the request that found the post (lib/linkedin-tasks/engagers.ts).
// Invented people and posts; nothing here touches LinkedIn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import {completeTask, nextTask } from '../lib/linkedin-tasks/store.ts'
import { pairLinkedIn } from './helpers/li-pair.ts'
import { enqueuePostEngagement, linkedinPostUrls, onPostEngagementResult, MAX_POSTS_PER_SCAN } from '../lib/linkedin-tasks/engagers.ts'
import { heldReason, type PreviewLead } from '../lib/journey.ts'
import type { Db } from '../lib/db/client.ts'

const POST = 'https://www.linkedin.com/posts/acme_sales-coaching-activity-7212345678901234567-AbCd'
const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000   // 10:00 in America/Toronto
const person = (n: number) => ({ name: `Jane Doe${n}`, title: 'VP Sales at Northwind', profile_url: `https://www.linkedin.com/in/jane-doe-${n}/` })

test('linkedinPostUrls: only LinkedIn post pages, one per post, a few per scan', () => {
  const urls = [POST, `${POST}?utm_source=share`, 'https://www.linkedin.com/company/acme/', 'https://news.example/a', null,
    ...[1, 2, 3, 4].map(i => `https://www.linkedin.com/feed/update/urn:li:activity:721234567890123456${i}/`)]
  const out = linkedinPostUrls(urls)
  assert.equal(out[0], POST)
  assert.equal(out.length, MAX_POSTS_PER_SCAN)
  assert.ok(out.every(u => u.startsWith('https://www.linkedin.com/')))
})

async function seed(db: Db) {
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, seller) VALUES ('j1', 'A', 'b', 'i', 'l', 'done', 'People engaging with posts about sales coaching', 'Sales call coaching software')")
}

bothEngines('no connected extension: nothing is queued; with one, each post is queued once', async ({ db }) => {
  await seed(db)
  assert.equal(await enqueuePostEngagement(db, 'A', 'j1', [POST], TEN_AM), 0)
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  assert.equal(await enqueuePostEngagement(db, 'A', 'j1', [POST, POST], TEN_AM), 1)
  assert.equal(await enqueuePostEngagement(db, 'A', 'j1', [POST], TEN_AM + 60), 0, 'the same post is not read twice in a week')
})

bothEngines('the people the extension read become shown leads of the same request, each with their own profile link', async ({ db }) => {
  await seed(db)
  await pairLinkedIn(db, 'A', 'u1', 'America/Toronto', TEN_AM)
  await enqueuePostEngagement(db, 'A', 'j1', [POST], TEN_AM)
  const next = await nextTask(db, 'A', TEN_AM + 5, () => 0.5)
  assert.ok('task' in next, JSON.stringify(next))
  assert.equal(await onPostEngagementResult(db, 'A', next.task.id, TEN_AM + 6), 'not_a_post_task', 'nothing until the read is stored')
  assert.equal(await completeTask(db, 'A', next.task.id, { people: [person(1), person(2), { ...person(3), name: 'LinkedIn Member' }] }, TEN_AM + 30), 'stored')
  assert.deepEqual(await onPostEngagementResult(db, 'A', next.task.id, TEN_AM + 31), { stored: 2 })
  assert.equal(await onPostEngagementResult(db, 'B', next.task.id, TEN_AM + 31), 'not_a_post_task', 'another workspace cannot turn this read into leads')
  const jobs = await db.all<{ id: string; status: string; query: string; seller: string; verified: number }>("SELECT id, status, query, seller, verified FROM scan_jobs WHERE user_id = 'A' AND id <> 'j1'")
  assert.deepEqual(jobs.map(j => [j.status, j.query, j.seller, Number(j.verified)]), [['done', 'People engaging with posts about sales coaching', 'Sales call coaching software', 2]])
  const leads = await db.all<Record<string, unknown> & { id: string; name: string }>('SELECT * FROM leads WHERE scan_job_id = ? ORDER BY name', [jobs[0].id])
  assert.deepEqual(leads.map(l => [l.name, l.source_url, l.source_kind, l.review_reason]), [['Jane Doe1', POST, 'discover', null], ['Jane Doe2', POST, 'discover', null]])
  for (const l of leads) assert.equal(heldReason({ ...l, enrichments: [] } as unknown as PreviewLead), null, 'a LinkedIn signal with a profile link is shown')
  const links = await db.all<{ kind: string; value: string }>("SELECT kind, value FROM lead_enrichments WHERE tenant_id = 'A' AND lead_id = ? ORDER BY kind", [leads[0].id])
  assert.deepEqual(links.map(e => [e.kind, e.value]), [['linkedin', 'https://www.linkedin.com/in/jane-doe-1/'], ['person', 'Jane Doe1, VP Sales at Northwind']])
})
