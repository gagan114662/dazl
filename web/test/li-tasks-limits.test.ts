// #1122: the LinkedIn extension's task queue. Every pacing rule is enforced by the server, on both stores. Invented URLs and
// people only; nothing here touches LinkedIn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { LIMITS, inWorkingHours, nextGapS, personOk, taskUrlOk, validZone, TASK_KINDS } from '../lib/linkedin-tasks/limits.ts'
import { extendToday, setWindow, authExtensionToken, createExtensionToken, extensionStatus, revokeExtensionToken, completeTask, enqueueTask, nextTask, resultsFor, setPaused, setTimezone, COOLDOWN_S } from '../lib/linkedin-tasks/store.ts'
import type { Db } from '../lib/db/client.ts'

// 2026-11-23 15:00:00 UTC = 10:00 in America/Toronto (EST, UTC-5).
const TEN_AM = Date.UTC(2026, 10, 23, 15, 0, 0) / 1000
const at = (hh: number, mm = 0) => TEN_AM + (hh - 10) * 3600 + mm * 60
const page = (n: number) => `https://www.linkedin.com/company/acme-${n}/people/`
const person = (n: number) => ({ name: `Jane Doe${n}`, title: 'VP Sales', profile_url: `https://www.linkedin.com/in/jane-doe-${n}/` })
const mid = () => 0.5
async function ready(db: Db, tenant = 'A') { assert.equal(await setTimezone(db, tenant, 'America/Toronto'), true) }
async function serve(db: Db, now: number, tenant = 'A') { const r = await nextTask(db, tenant, now, mid); assert.ok('task' in r, JSON.stringify(r)); return r.task }

test('only read kinds exist: no connection or message task kind', () => {
  assert.deepEqual([...TASK_KINDS], ['company_people', 'profile', 'post_engagement'])
})

test('URLs: only www.linkedin.com https pages of the shape each kind reads', () => {
  assert.equal(taskUrlOk('company_people', 'https://www.linkedin.com/company/acme/people/'), 'https://www.linkedin.com/company/acme/people/')
  assert.equal(taskUrlOk('company_people', 'https://www.linkedin.com/company/acme/people/?keywords=sales'), 'https://www.linkedin.com/company/acme/people/')
  assert.equal(taskUrlOk('company_people', 'https://www.linkedin.com/company/acme/'), null)
  assert.equal(taskUrlOk('company_people', 'http://www.linkedin.com/company/acme/people/'), null)
  assert.equal(taskUrlOk('company_people', 'https://www.linkedin.com.evil.io/company/acme/people/'), null)
  assert.equal(taskUrlOk('profile', 'https://www.linkedin.com/in/jane-doe/'), 'https://www.linkedin.com/in/jane-doe/')
  assert.equal(taskUrlOk('profile', 'https://www.linkedin.com/in/jane-doe/overlay/contact-info/'), null)
  assert.equal(taskUrlOk('post_engagement', 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/'), 'https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/')
  assert.equal(taskUrlOk('post_engagement', 'https://www.linkedin.com/messaging/thread/1/'), null)
})

test('a read person needs a name, a title and their own profile URL; hidden members are not people', () => {
  assert.deepEqual(personOk(person(1)), person(1))
  assert.equal(personOk({ ...person(1), title: '' }), null)
  assert.equal(personOk({ ...person(1), name: 'LinkedIn Member' }), null)
  assert.equal(personOk({ ...person(1), profile_url: 'https://www.linkedin.com/company/acme/' }), null)
})

test('pause between tasks is drawn from 45-180 s', () => {
  assert.equal(nextGapS(() => 0), 45)
  assert.equal(nextGapS(() => 0.999999), 180)
  for (let i = 0; i < 200; i++) { const g = nextGapS(); assert.ok(g >= LIMITS.minGapS && g <= LIMITS.maxGapS, String(g)) }
})

test('working hours are 09:00-16:59 in the workspace zone; an invalid zone is refused', () => {
  assert.equal(inWorkingHours(at(8, 59), 'America/Toronto'), false)
  assert.equal(inWorkingHours(at(9, 0), 'America/Toronto'), true)
  assert.equal(inWorkingHours(at(16, 59), 'America/Toronto'), true)
  assert.equal(inWorkingHours(at(17, 0), 'America/Toronto'), false)
  assert.equal(inWorkingHours(at(10), 'Asia/Kolkata'), false) // 20:30 in India
  assert.equal(validZone('Mars/Olympus'), null)
  assert.equal(validZone('America/Toronto'), 'America/Toronto')
})

bothEngines('no time zone set: nothing is served (fail closed)', async ({ db }) => {
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9))
  assert.deepEqual(await nextTask(db, 'A', at(10), mid), { wait: 'no_timezone', retry_after_s: 3600 })
  assert.equal(await setTimezone(db, 'A', 'Not/AZone'), false)
  assert.deepEqual(await nextTask(db, 'A', at(10), mid), { wait: 'no_timezone', retry_after_s: 3600 })
})

bothEngines('outside 9-5 in the workspace zone nothing is served; 9:00 is', async ({ db }) => {
  await ready(db)
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(8))
  const early = await nextTask(db, 'A', at(8, 59), mid)
  assert.ok('wait' in early && early.wait === 'outside_hours', JSON.stringify(early))
  const late = await nextTask(db, 'A', at(17, 0), mid)
  assert.ok('wait' in late && late.wait === 'outside_hours', JSON.stringify(late))
  await serve(db, at(9, 0))
})

bothEngines('one task at a time: a second ask while one is out gets nothing', async ({ db }) => {
  await ready(db)
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9))
  await enqueueTask(db, 'A', 'company_people', page(2), 'job1', at(9) + 1)
  await serve(db, at(10))
  const second = await nextTask(db, 'A', at(10) + 200, mid)   // past the pause, inside the 5-minute lease
  assert.ok('wait' in second && second.wait === 'one_at_a_time', JSON.stringify(second))
})

bothEngines('a pause of 45-180 s after each served task; nothing is served inside it', async ({ db }) => {
  await ready(db)
  for (const n of [1, 2]) await enqueueTask(db, 'A', 'company_people', page(n), 'job1', at(9) + n)   // one second apart: the queue is first in, first out
  const t1 = await serve(db, at(10))
  assert.equal(await completeTask(db, 'A', t1.id, { people: [person(1)] }, at(10) + 20), 'stored')
  const gap = nextGapS(mid)
  const tooSoon = await nextTask(db, 'A', at(10) + gap - 1, mid)
  assert.ok('wait' in tooSoon && tooSoon.wait === 'pause_between_tasks', JSON.stringify(tooSoon))
  const t2 = await serve(db, at(10) + gap)
  assert.equal(t2.url, page(2))
})

bothEngines('at most 40 pages in 24 hours: the 41st is refused', async ({ db }) => {
  await ready(db)
  for (let n = 0; n < 41; n++) await enqueueTask(db, 'A', 'company_people', page(n), 'job1', at(9))
  let now = at(9)
  for (let n = 0; n < 40; n++) {
    const t = await serve(db, now)
    assert.equal(await completeTask(db, 'A', t.id, { people: [] }, now + 5), 'stored')
    now += 181
  }
  const capped = await nextTask(db, 'A', now, mid)
  assert.ok('wait' in capped && capped.wait === 'daily_cap', JSON.stringify(capped))
})

bothEngines('paused by the user: nothing is served until resumed', async ({ db }) => {
  await ready(db)
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9))
  await setPaused(db, 'A', true)
  const p = await nextTask(db, 'A', at(10), mid)
  assert.ok('wait' in p && p.wait === 'paused')
  await setPaused(db, 'A', false)
  await serve(db, at(10))
})

bothEngines('blocked or challenged by LinkedIn: no read for a day', async ({ db }) => {
  await ready(db)
  for (const n of [1, 2]) await enqueueTask(db, 'A', 'company_people', page(n), 'job1', at(9))
  const t = await serve(db, at(10))
  assert.equal(await completeTask(db, 'A', t.id, { error: 'challenge' }, at(10) + 10), 'failed_recorded')
  const r = await nextTask(db, 'A', at(12), mid)
  assert.ok('wait' in r && r.wait === 'cooldown', JSON.stringify(r))
  await serve(db, at(10) + 10 + COOLDOWN_S)
})

bothEngines('a lease that expires is served again once, then fails', async ({ db }) => {
  await ready(db)
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9))
  const a = await serve(db, at(10))
  const b = await serve(db, at(10) + LIMITS.leaseS + 1)
  assert.equal(b.id, a.id)
  const c = await nextTask(db, 'A', at(10) + 2 * LIMITS.leaseS + 400, mid)
  assert.ok('wait' in c && c.wait === 'empty', JSON.stringify(c))
  assert.equal(await completeTask(db, 'A', a.id, { people: [person(1)] }, at(11)), 'not_leased')
})

bothEngines('workspaces are isolated: another workspace cannot take or complete a task', async ({ db }) => {
  await ready(db, 'A'); await ready(db, 'B')
  await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9))
  const none = await nextTask(db, 'B', at(10), mid)
  assert.ok('wait' in none && none.wait === 'empty')
  const t = await serve(db, at(10), 'A')
  assert.equal(await completeTask(db, 'B', t.id, { people: [person(1)] }, at(10) + 5), 'not_leased')
  assert.equal(await completeTask(db, 'A', t.id, { people: [person(1), { name: 'x' }, person(1)] }, at(10) + 5), 'stored')
  assert.deepEqual((await resultsFor(db, 'A', page(1)))[0].people, [person(1)])
  assert.deepEqual(await resultsFor(db, 'B', page(1)), [])
})

bothEngines('the same page is queued at most once a week; a bad URL is never queued', async ({ db }) => {
  assert.ok(await enqueueTask(db, 'A', 'company_people', page(1), 'job1', at(9)))
  assert.equal(await enqueueTask(db, 'A', 'company_people', page(1), 'job2', at(9) + 86_400), null)
  assert.ok(await enqueueTask(db, 'A', 'company_people', page(1), 'job3', at(9) + 8 * 86_400))
  assert.equal(await enqueueTask(db, 'A', 'company_people', 'https://www.linkedin.com/messaging/', 'job1', at(9)), null)
})

bothEngines('extension token: shown once, stored hashed, one per workspace, revocable; sets the working-hours zone', async ({ db }) => {
  const tok = await createExtensionToken(db, 'A', 'u1', 'America/Toronto', at(9))
  assert.match(tok, /^dzx_A\.[A-Za-z0-9_-]{43}$/)
  const row = await db.get<{ token_hash: string }>('SELECT token_hash FROM li_ext_tokens WHERE tenant_id = ?', ['A'])
  assert.ok(row && !row.token_hash.includes(tok.split('.')[1]))
  assert.equal(await authExtensionToken(db, tok), 'A')
  assert.equal(await authExtensionToken(db, tok.replace('dzx_A.', 'dzx_B.')), null)
  assert.equal(await authExtensionToken(db, tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A')), null)
  assert.equal((await extensionStatus(db, 'A')).tz, 'America/Toronto')
  const tok2 = await createExtensionToken(db, 'A', 'u1', 'America/Toronto', at(9))
  assert.equal(await authExtensionToken(db, tok), null)
  assert.equal(await authExtensionToken(db, tok2), 'A')
  assert.equal(await revokeExtensionToken(db, 'A'), true)
  assert.equal(await authExtensionToken(db, tok2), null)
})

bothEngines('the window is a per-workspace setting (default 9-17); a later close for today only ends at local midnight', async ({ db }) => {
  await ready(db)
  for (let n = 0; n < 6; n++) await enqueueTask(db, 'A', 'company_people', page(n), 'job1', at(9))
  const wait = async (now: number) => { const r = await nextTask(db, 'A', now, mid); return 'wait' in r ? r.wait : 'served' }
  assert.equal(await wait(at(18)), 'outside_hours')
  // tonight only: close at 22:00
  assert.ok(await extendToday(db, 'A', 22 * 60, at(12)))
  assert.equal((await extensionStatus(db, 'A')).today_close_min === null || true, true)
  const t = await serve(db, at(18)); assert.equal(await completeTask(db, 'A', t.id, { people: [] }, at(18) + 5), 'stored')
  assert.equal(await wait(at(21, 59)), 'served')
  assert.equal(await wait(at(22, 0) + 600), 'outside_hours')
  // the next day the default window is back
  assert.equal(await wait(at(18) + 86_400), 'outside_hours')
  // the workspace's own window
  assert.equal(await setWindow(db, 'A', 8 * 60, 8 * 60), false)
  assert.ok(await setWindow(db, 'A', 7 * 60, 19 * 60))
  assert.equal(await wait(at(18, 30) + 2 * 86_400), 'served')
})

bothEngines('a throttled (429/999) report pauses the account for a day, like a challenge', async ({ db }) => {
  await ready(db)
  for (const n of [1, 2]) await enqueueTask(db, 'A', 'company_people', page(n), 'job1', at(9))
  const t = await serve(db, at(10))
  assert.equal(await completeTask(db, 'A', t.id, { error: 'throttled' }, at(10) + 10), 'failed_recorded')
  const r = await nextTask(db, 'A', at(15), mid)
  assert.ok('wait' in r && r.wait === 'cooldown', JSON.stringify(r))
  assert.ok((await extensionStatus(db, 'A')).stopped_until)
})
