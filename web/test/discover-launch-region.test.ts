import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverLeads } from '../lib/discover/agent.ts'
import { runDiscovery } from '../lib/discover/run.ts'

const USAGE = { input_tokens: 160, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MODEL = 'claude-sonnet-5-5'
const candidate = (company: string, country: string | null) => ({
  company, country, signal: 'hiring a sales development representative', evidence_url: `https://proof.example/${company.toLowerCase()}`,
})
type Payload = { tools?: unknown; messages: unknown; system?: unknown }
type Place = { text: string; city: string | null; region: string | null; country: string | null }

function provider(places: Place[], leads: ReturnType<typeof candidate>[] = []) {
  const requests: Payload[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body))
    requests.push(payload)
    const reply = { id: 'msg_test', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: USAGE }
    if (!payload.tools) {
      const plan = { offer: null, buyer_type: 'agencies', industry_code: null, places, signals: [], exclusions: [], language: 'en' }
      return Response.json({ ...reply, model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] })
    }
    const events = [
      { type: 'message_start', message: { ...reply, model: MODEL } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify({ leads }) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { ...USAGE, server_tool_use: { web_search_requests: 0 } } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  return { requests, fetchImpl }
}

for (const [target, places] of [
  ['the UK', [{ text: 'UK', city: null, region: null, country: 'GB' }]],
  ['the US and UK', [{ text: 'US', city: null, region: null, country: 'US' }, { text: 'UK', city: null, region: null, country: 'GB' }]],
  ['the UK and US in one place', [{ text: 'UK and US', city: null, region: null, country: 'US' }]],
  ['the US and Europe', [{ text: 'US and Europe', city: null, region: null, country: 'US' }]],
  ['the US, Europe', [{ text: 'US, Europe', city: null, region: null, country: 'US' }]],
  ['Europe', [{ text: 'Europe', city: null, region: null, country: null }]],
] as const) {
  test(`the Claude plan stops a request for ${target} before web tools are offered`, async () => {
    const query = `Find agencies hiring an SDR in ${target}`
    const { requests, fetchImpl } = provider([...places])
    const run = await runDiscovery({ query }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].tools, undefined)
    assert.ok(JSON.stringify(requests[0].messages).includes(query))
    assert.equal(run.stop, 'unsupported_search_region')
    assert.equal(run.note, 'dazl covers the US and Canada for now. More regions soon.')
    assert.equal(run.searches, 0)
    assert.ok(run.usd > 0, 'the paid plan call is accounted for')
    assert.deepEqual([run.pages, run.leads], [[], []])
  })
}

for (const [target, country] of [['US', 'US'], ['Canada', 'CA'], ['', null]] as const) {
  test(`requests for ${target || 'an unspecified location'} get US/Canada search scope and retain only in-coverage leads`, async () => {
    const query = `Find agencies hiring an SDR${target ? ` in ${target}` : ''}`
    const { requests, fetchImpl } = provider(country ? [{ text: target, city: null, region: null, country }] : [], [
      candidate('Outside', 'GB'), candidate('Unknown', null), candidate('American', 'US'), candidate('Canadian', 'CA'),
    ])
    const result = await discoverLeads({ query, maxLeads: 2 }, { apiKey: 'test', fetch: fetchImpl })
    assert.equal(requests.length, 2)
    assert.equal(requests[0].tools, undefined)
    assert.match(JSON.stringify(requests[1].tools), /web_search/)
    assert.match(JSON.stringify(requests[1].system), /Search only for targets in the US and Canada/)
    const system = (requests[1].system as Array<{ text: string }>)[0].text
    const example = /<json>(\{.*\})<\/json>/.exec(system)?.[1]
    assert.ok(example)
    assert.ok(Object.hasOwn(JSON.parse(example).leads[0], 'country'))
    if (country) assert.match(JSON.stringify(requests[1].messages), /Confirmed target locations/)
    const inScope = country === 'US' ? ['American'] : country === 'CA' ? ['Canadian'] : ['American', 'Canadian']
    assert.deepEqual(result.leads.map(lead => lead.company), inScope)
  })
}

test('a second discovery pass reuses the tool-free plan and accounts for it once', async () => {
  const { requests, fetchImpl } = provider([])
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR' }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(run.passes, 2)
  assert.equal(run.requests, 3)
  assert.equal(requests.filter(request => !request.tools).length, 1)
})
