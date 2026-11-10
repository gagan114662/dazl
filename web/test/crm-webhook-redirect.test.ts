// #926: the generic CRM webhook never follows a redirect. Exactly one POST goes to the approved URL; a 3xx is
// reported as an unknown outcome (the original endpoint received the payload) and nothing reaches the Location.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pushLead, CrmPushError } from '../lib/crm/index.ts'
import { fetchPublicHtml, type Lookup } from '../lib/net/public-fetch.ts'

const LEAD = { company: 'Acme Co', name: 'Ada Lovelace', contact: 'ada@acme.example', signal: 'hired VP Sales', source_url: 'https://x.com/1', fit: 5, intent: 4, why: 'why now' }
const pub: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const lookupFor = (map: Record<string, string>): Lookup => async (h) => [{ address: map[h] ?? '93.184.216.34', family: 4 }]

function stub(first: Response) {
  const calls: { url: string; method?: string; body?: unknown }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body })
    return calls.length === 1 ? first : new Response(null, { status: 204 })
  }) as unknown as typeof fetch
  return { f, calls }
}

for (const status of [301, 302, 303, 307, 308]) {
  for (const [label, target] of [['same host', 'https://hooks.example/moved'], ['other host', 'https://other.example/receive']]) {
    test(`webhook ${status} to ${label}: one POST, nothing forwarded, outcome unknown`, async () => {
      const { f, calls } = stub(new Response(null, { status, headers: { location: target } }))
      await assert.rejects(() => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, f, { lookup: pub }), (e: unknown) => {
        assert.ok(e instanceof CrmPushError)
        assert.equal(e.outcome, 'unknown')
        assert.match(e.message, new RegExp(`redirect \\(${status}\\)`))
        return true
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://hooks.example/dazl')
      assert.equal(calls[0].method, 'POST')
      assert.ok(String(calls[0].body).includes('ada@acme.example'))
    })
  }
}

test('webhook redirect to a private address: target is never touched', async () => {
  const { f, calls } = stub(new Response(null, { status: 307, headers: { location: 'https://internal.example/x' } }))
  const looked: string[] = []
  const lk: Lookup = async (h) => { looked.push(h); return lookupFor({ 'internal.example': '10.0.0.5' })(h) }
  await assert.rejects(() => pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, f, { lookup: lk }), CrmPushError)
  assert.equal(calls.length, 1)
  assert.deepEqual(looked, ['hooks.example'])
})

test('webhook direct 204 still succeeds with one POST', async () => {
  const { f, calls } = stub(new Response(null, { status: 204 }))
  assert.deepEqual(await pushLead({ provider: 'webhook', url: 'https://hooks.example/dazl' }, LEAD, f, { lookup: pub }), { message: 'Lead sent to your webhook', externalId: null })
  assert.equal(calls.length, 1)
})

test('page reads keep following redirects (default unchanged)', async () => {
  const calls: string[] = []
  const f = (async (url: string) => { calls.push(url); return calls.length === 1 ? new Response(null, { status: 301, headers: { location: 'https://www.site.example/' } }) : new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }) as unknown as typeof fetch
  const r = await fetchPublicHtml('https://site.example/', { fetchImpl: f, lookup: pub })
  assert.ok(!('error' in r) && r.finalUrl === 'https://www.site.example/')
  assert.equal(calls.length, 2)
})
