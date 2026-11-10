// #192: the conformance checks any future transport must pass, and the upstream-status mapping. Stubbed upstreams only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkTransportContract, mapUpstreamStatus } from '../lib/signals/linkedin-transport-contract.ts'
import type { LinkedInTransport } from '../lib/signals/linkedin-people.ts'

const item = (id: string) => ({ url: `https://www.linkedin.com/in/${id}/`, title: id, quote: `${id} said something public`, date: '2026-10-20' })
const good = (up: { requests: number }): LinkedInTransport => ({ fetch: async r => { if (r.signal.aborted) throw new Error('aborted'); up.requests++; return { status: 'ok', items: [item('jane-doe-1')], upstream_requests: 1 } } })

test('a conforming stub transport passes', async () => { assert.deepEqual(await checkTransportContract(good), { ok: true, failures: [] }) })

test('each violation is caught: pagination inside a call, over-long answers, extra fields, non-profile URLs, wrong upstream count, ignoring the abort', async () => {
  const paging = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests += 3; return { status: 'ok', items: [item('a-b')], upstream_requests: 3 } } })
  assert.match((await checkTransportContract(paging)).failures.join('|'), /3 upstream requests \(must be exactly 1\)/)
  const big = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests++; return { status: 'ok', items: Array.from({ length: 40 }, (_, i) => item(`p-${i}`)) } } })
  assert.match((await checkTransportContract(big)).failures.join('|'), /returned 40 items/)
  const extra = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests++; return { status: 'ok', items: [{ ...item('x-y'), email: 'a@b.example', photo: 'u' } as never] } } })
  assert.match((await checkTransportContract(extra)).failures.join('|'), /fields beyond url\/title\/quote\/date: email, photo/)
  const badUrl = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests++; return { status: 'ok', items: [{ ...item('x-y'), url: 'https://evil.example/in/x' }] } } })
  assert.match((await checkTransportContract(badUrl)).failures.join('|'), /not a public profile URL/)
  const lies = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests += 2; return { status: 'ok', items: [item('x-y')], upstream_requests: 1 } } })
  assert.ok((await checkTransportContract(lies)).failures.length > 0)
  const ignoresAbort = (up: { requests: number }): LinkedInTransport => ({ fetch: async () => { up.requests++; return { status: 'ok', items: [item('x-y')] } } })
  assert.match((await checkTransportContract(ignoresAbort)).failures.join('|'), /after the abort signal/)
})

// In-flight abort (#192 review): both stubs check `signal.aborted` on entry, so the already-aborted check passes them. Only the mid-call abort tells them apart.
test('in-flight abort: a transport that checks the signal only on entry and then ignores a later abort is caught; one that stops on abort passes', async () => {
  const slowGood = (up: { requests: number }): LinkedInTransport => ({ fetch: r => new Promise((res, rej) => {
    if (r.signal.aborted) return rej(new Error('aborted')); up.requests++
    const t = setTimeout(() => res({ status: 'ok', items: [item('jane-doe-1')], upstream_requests: 1 }), 400)
    r.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) })
  }) })
  assert.deepEqual(await checkTransportContract(slowGood), { ok: true, failures: [] }, 'stops on abort, no later request')
  const entryOnly = (up: { requests: number }): LinkedInTransport => ({ fetch: async r => { if (r.signal.aborted) throw new Error('aborted'); up.requests++; await new Promise(res => setTimeout(res, 400)); return { status: 'ok', items: [item('jane-doe-1')], upstream_requests: 1 } } })
  assert.match((await checkTransportContract(entryOnly)).failures.join('|'), /still running \d+ ms after the abort signal was raised mid-call/)
  const startsLater = (up: { requests: number }): LinkedInTransport => ({ fetch: async r => { if (r.signal.aborted) throw new Error('aborted'); up.requests++; await new Promise(res => setTimeout(res, 30)); up.requests++; return { status: 'ok', items: [item('jane-doe-1')], upstream_requests: 2 } } })
  assert.match((await checkTransportContract(startsLater)).failures.join('|'), /upstream request after the abort signal was raised mid-call/)
})

test('upstream status mapping: success only for 2xx; 429/503 throttle; 401/403 stop; 999/451 challenge; anything else is an error, never ok or empty', () => {
  assert.deepEqual([200, 204, 429, 503, 401, 403, 999, 451, 500, 404, 302].map(mapUpstreamStatus), ['ok', 'ok', 'throttled', 'throttled', 'unauthorized', 'unauthorized', 'challenge', 'challenge', 'error', 'error', 'error'])
})
