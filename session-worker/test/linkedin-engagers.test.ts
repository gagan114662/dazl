// #192: the LinkedIn post-engagers reader against SYNTHETIC fixtures (test/fixtures/linkedin-*.json|html). No live request:
// globalThis.fetch is replaced per test and counts every upstream call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { activityId, classifyAnswer, engagersUrl, fetchEngagers, parseEngagers } from '../src/linkedin-engagers.ts'
import { FetchFailure } from '../src/util.ts'

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const POST = 'https://www.linkedin.com/feed/update/urn:li:activity:7391234567890123456/'
const SESSION = 'li_at=AQEDthrowaway; JSESSIONID="ajax:123"'
const real = globalThis.fetch
let calls: string[] = []
const stub = (status: number, body: string, location: string | null = null) => {
  calls = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(String(url)); assert.equal(init?.redirect, 'manual', 'redirects are inspected, never followed')
    assert.ok(!(init?.method && init.method !== 'GET'), 'read-only: GET only')
    // a plain Response-like answer: LinkedIn's 999 bot block is outside what the Response constructor accepts
    return { status, headers: new Headers(location ? { location } : {}), text: async () => body } as unknown as Response
  }) as typeof fetch
}
test.afterEach(() => { globalThis.fetch = real })

test('activity id: feed URLs and URNs only', () => {
  assert.equal(activityId(POST), '7391234567890123456')
  assert.equal(activityId('urn:li:activity:7391234567890123456'), '7391234567890123456')
  assert.equal(activityId('Rippling'), null)
  assert.match(engagersUrl('commenters', '7391234567890123456'), /^https:\/\/www\.linkedin\.com\/voyager\/api\/feed\/comments\?.*updateId=activity:7391234567890123456$/)
  assert.match(engagersUrl('reactors', '7391234567890123456'), /voyagerSocialDashReactions\?.*threadUrn=urn%3Ali%3Aactivity%3A7391234567890123456$/)
})

test('commenters: one item per person, profile URL, their own comment as a dated quote with the post link', () => {
  const items = parseEngagers('commenters', JSON.parse(fx('linkedin-comments.json')), '7391234567890123456')
  assert.deepEqual(items.map(i => i.url), ['https://www.linkedin.com/in/jane-example-1', 'https://www.linkedin.com/in/raj-sample-2'])
  assert.equal(items[0].title, 'Jane Example - VP People at Northwind Payroll')
  assert.match(items[0].quote, /^Commented on https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:7391234567890123456\/: "We switched off this vendor/)
  assert.match(items[0].date ?? '', /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(items.every(i => i.login_walled))
})

test('reactors: lockup and referenced-profile shapes both read; reactors carry the post link and headline', () => {
  const items = parseEngagers('reactors', JSON.parse(fx('linkedin-reactions.json')), '7391234567890123456')
  assert.deepEqual(items.map(i => i.url), ['https://www.linkedin.com/in/maria-placeholder-7', 'https://www.linkedin.com/in/tom-fixture-8'])
  assert.match(items[0].quote, /^Reacted \(like\) to https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:activity:7391234567890123456\/\. Headline: Head of Finance/)
  assert.match(items[1].quote, /empathy/)
})

test('an explicit zero-engager page is [], an empty or error envelope is a failure, never []', () => {
  assert.deepEqual(parseEngagers('commenters', { data: { '*elements': [], paging: { total: 0 } }, included: [] }, '1'), [])
  assert.throws(() => parseEngagers('commenters', { data: {} }, '1'), (e: unknown) => e instanceof FetchFailure && e.kind === 'schema_error')
  assert.throws(() => parseEngagers('reactors', { status: 429 }, '1'), (e: unknown) => e instanceof FetchFailure && e.kind === 'throttled')
})

test('classify: login wall, checkpoint/captcha, bot block and rate limit are named, never an empty result', () => {
  assert.equal(classifyAnswer(302, 'https://www.linkedin.com/checkpoint/challenge/AgF', ''), 'challenge')
  assert.equal(classifyAnswer(302, 'https://www.linkedin.com/authwall?trk=x', ''), 'auth_failed')
  assert.equal(classifyAnswer(303, 'https://www.linkedin.com/login', ''), 'auth_failed')
  assert.equal(classifyAnswer(999, null, ''), 'challenge')
  assert.equal(classifyAnswer(429, null, ''), 'throttled')
  assert.equal(classifyAnswer(200, null, fx('linkedin-checkpoint.html')), 'challenge')
  assert.equal(classifyAnswer(200, null, fx('linkedin-authwall.html')), 'auth_failed')
  assert.equal(classifyAnswer(200, null, '<html>maintenance</html>'), 'schema_error')
  assert.equal(classifyAnswer(200, null, '{"included":[]}'), null)
})

test('fetch: exactly ONE upstream GET per call, cookie-gated, failures thrown with their kind', async () => {
  stub(200, fx('linkedin-comments.json'))
  assert.equal((await fetchEngagers('commenters', POST, SESSION)).length, 2); assert.equal(calls.length, 1)
  for (const [status, body, loc, kind] of [[302, '', 'https://www.linkedin.com/checkpoint/challenge/x', 'challenge'], [200, fx('linkedin-authwall.html'), null, 'auth_failed'], [429, '', null, 'throttled'], [999, '', null, 'challenge']] as const) {
    stub(status, body, loc)
    await assert.rejects(fetchEngagers('reactors', POST, SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === kind)
    assert.equal(calls.length, 1, `${kind}: one request, no retry`)
  }
  stub(200, '{}')
  await assert.rejects(fetchEngagers('commenters', POST, 'no-cookie'), (e: unknown) => e instanceof FetchFailure && e.kind === 'auth_failed')
  await assert.rejects(fetchEngagers('commenters', 'Rippling', SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === 'schema_error')
  assert.equal(calls.length, 0, 'no request without a session cookie or a post id')
})
