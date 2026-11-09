// #192: the LinkedIn post-engagers reader against SYNTHETIC fixtures (test/fixtures/linkedin-*.json|html). No live request:
// globalThis.fetch is replaced per test and counts every upstream call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { activityId, classifyAnswer, engagersUrl, fetchEngagers, fetchPosts, parseEngagers, postsUrl } from '../src/linkedin-engagers.ts'
import { FetchFailure, MAX_UPSTREAM_BYTES, readCapped } from '../src/util.ts'

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
    // the body is a real stream: the reader must stream it (readCapped), never call text() on the whole thing
    return { status, headers: new Headers(location ? { location } : {}), body: new Response(body).body, text: async () => { throw new Error('text() buffers the whole body') } } as unknown as Response
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

const SEARCH = JSON.stringify({ data: { elements: [] }, included: [{ trackingUrn: 'urn:li:activity:7391234567890123456', commentary: { text: { text: 'Rippling announces its new payroll product for mid-size teams' } } }] })

test('session post search: one GET, manual redirects, posts parsed; login wall / checkpoint / restriction / 999 / 429 are named stops, never [] or a retryable error (#949 review)', async () => {
  stub(200, SEARCH)
  const items = await fetchPosts('Rippling', SESSION)
  assert.deepEqual(items.map(i => i.url), [POST]); assert.deepEqual(calls, [postsUrl('Rippling')])
  for (const [status, body, loc, kind] of [
    [302, '', 'https://www.linkedin.com/checkpoint/challenge/AgF', 'challenge'], [303, '', 'https://www.linkedin.com/authwall?trk=x', 'auth_failed'],
    [302, '', 'https://www.linkedin.com/login?session_redirect=x', 'auth_failed'], [200, fx('linkedin-checkpoint.html'), null, 'challenge'],
    [200, fx('linkedin-authwall.html'), null, 'auth_failed'], [200, '<html><body>Your account has been restricted</body></html>', null, 'challenge'],
    [999, '', null, 'challenge'], [429, '', null, 'throttled'], [401, '', null, 'auth_failed'], [500, '', null, 'upstream_error'], [200, '{"data":{}}', null, 'schema_error'],
  ] as const) {
    stub(status, body, loc)
    await assert.rejects(fetchPosts('Rippling', SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === kind, `${status} ${loc ?? body.slice(0, 30)} -> ${kind}`)
    assert.equal(calls.length, 1, `${kind}: one request, no retry`)
  }
  stub(200, SEARCH)
  await assert.rejects(fetchPosts('Rippling', 'no-cookie'), (e: unknown) => e instanceof FetchFailure && e.kind === 'auth_failed')
  await assert.rejects(fetchPosts('   ', SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === 'schema_error')
  assert.equal(calls.length, 0, 'no request without a cookie or a query')
})

test('a restricted / suspended account page is a challenge (a ban signal stops the run)', () => {
  assert.equal(classifyAnswer(200, null, '<html>This account is temporarily restricted</html>'), 'challenge')
  assert.equal(classifyAnswer(302, 'https://www.linkedin.com/checkpoint/restricted', ''), 'challenge')
  assert.equal(classifyAnswer(200, null, '<html>Account suspended</html>'), 'challenge')
})

test('readCapped: streams, stops and cancels past the byte cap, never buffers the whole body (#949 review)', async () => {
  let pulled = 0, cancelled = false
  const huge = new ReadableStream<Uint8Array>({
    pull(c) { pulled++; if (pulled > 10_000) { c.close(); return } c.enqueue(new Uint8Array(64 * 1024).fill(0x7b)) },
    cancel() { cancelled = true },
  })
  const r = await readCapped({ body: huge })
  assert.equal(r.over, true); assert.equal(r.text.length, MAX_UPSTREAM_BYTES); assert.ok(cancelled, 'the stream is cancelled')
  assert.ok(pulled < 40, `stopped after about 1 MB (${pulled} chunks of 64 KB), not 640 MB`)
  assert.deepEqual(await readCapped({ body: new Response('{"a":1}').body }), { text: '{"a":1}', over: false })
  assert.deepEqual(await readCapped({ body: null }), { text: '', over: false })
  assert.deepEqual(await readCapped({ body: new Response('x'.repeat(11)).body }, 10), { text: 'x'.repeat(10), over: true })
  const broken = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('reset')) } })
  await assert.rejects(readCapped({ body: broken }), (e: unknown) => e instanceof FetchFailure && e.kind === 'upstream_error')
  // non-UTF8 bytes decode with replacement characters, never throw
  assert.equal((await readCapped({ body: new Response(new Uint8Array([0xff, 0xfe, 0x41])).body })).over, false)
})

test('an oversized upstream answer is a schema_error after one request, and a huge checkpoint page is still a challenge', async () => {
  stub(200, '{"included":[' + '"x",'.repeat(300_000) + '"x"]}')
  await assert.rejects(fetchEngagers('commenters', POST, SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === 'schema_error'); assert.equal(calls.length, 1)
  stub(200, '<html>checkpoint ' + 'x'.repeat(1_200_000) + '</html>')
  await assert.rejects(fetchPosts('Rippling', SESSION), (e: unknown) => e instanceof FetchFailure && e.kind === 'challenge')
})
