// Connect LinkedIn (#1037, F-go step 2): one read that names the session's account. SYNTHETIC answers (invented member) in the two
// shapes voyager returns; no live request: globalThis.fetch is replaced and counts every upstream call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchMe, ME_URL, parseMe } from '../src/linkedin-engagers.ts'
import { FetchFailure } from '../src/util.ts'

const SESSION = 'li_at=AQEDthrowaway; JSESSIONID="ajax:123"'
const real = globalThis.fetch
let calls: { url: string; init?: RequestInit }[] = []
const stub = (status: number, body: string, location: string | null = null) => {
  calls = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return { status, headers: new Headers(location ? { location } : {}), body: new Response(body).body, text: async () => { throw new Error('streamed only') } } as unknown as Response
  }) as typeof fetch
}
test.afterEach(() => { globalThis.fetch = real })
const kind = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof FetchFailure ? e.kind : `other:${String(e)}` } }

const NORMALIZED = { data: { plainId: 1, '*miniProfile': 'urn:li:fs_miniProfile:ACo' }, included: [{ $type: 'com.linkedin.voyager.common.Me' }, { $type: 'com.linkedin.voyager.identity.shared.MiniProfile', firstName: 'Dana', lastName: 'Okoye', publicIdentifier: 'dana-okoye-test', entityUrn: 'urn:li:fs_miniProfile:ACo' }] }
const PLAIN = { plainId: 1, miniProfile: { firstName: ' Dana\u0007', lastName: 'Okoye ', publicIdentifier: 'dana-okoye-test' } }

test('the account name from either shape; nothing but the name and public id is returned', () => {
  assert.deepEqual(parseMe(NORMALIZED), { name: 'Dana Okoye', public_id: 'dana-okoye-test' })
  assert.deepEqual(parseMe(PLAIN), { name: 'Dana Okoye', public_id: 'dana-okoye-test' }, 'control characters and spaces are cleaned')
  for (const bad of [null, [], {}, { included: [] }, { miniProfile: { firstName: '', lastName: '' } }, { included: [{ $type: 'x.Profile', firstName: 'Not', lastName: 'Mini' }] }])
    assert.throws(() => parseMe(bad), (e: unknown) => e instanceof FetchFailure && e.kind === 'schema_error', JSON.stringify(bad))
  assert.throws(() => parseMe({ status: 401 }), (e: unknown) => e instanceof FetchFailure && e.kind === 'auth_failed')
  assert.throws(() => parseMe({ status: 999 }), (e: unknown) => e instanceof FetchFailure && e.kind === 'challenge')
})

test('one GET to /voyager/api/me with the session, redirects inspected; refusals are typed, never a name', async () => {
  stub(200, JSON.stringify(NORMALIZED))
  assert.deepEqual(await fetchMe(SESSION), { name: 'Dana Okoye', public_id: 'dana-okoye-test' })
  assert.equal(calls.length, 1); assert.equal(calls[0].url, ME_URL)
  assert.equal(calls[0].init?.redirect, 'manual'); assert.ok(!calls[0].init?.method || calls[0].init.method === 'GET')
  const h = calls[0].init?.headers as Record<string, string>
  assert.equal(h.cookie, 'li_at=AQEDthrowaway; JSESSIONID="ajax:123"'); assert.equal(h['csrf-token'], 'ajax:123')
  for (const [status, body, loc, want] of [
    [302, '', 'https://www.linkedin.com/login?session_redirect=x', 'auth_failed'], [302, '', 'https://www.linkedin.com/checkpoint/challenge/x', 'challenge'],
    [999, '', null, 'challenge'], [429, '', null, 'throttled'], [200, '<html>Sign in to LinkedIn</html>', null, 'auth_failed'], [200, '{"status":403}', null, 'auth_failed'],
  ] as [number, string, string | null, string][]) { stub(status, body, loc); assert.equal(await kind(fetchMe(SESSION)), want, `${status} ${loc ?? body}`) }
  assert.equal(await kind(fetchMe('li_at=only')), 'auth_failed', 'no JSESSIONID: no request')
})
