import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverLeads } from '../lib/discover/agent.ts'
import { runDiscovery } from '../lib/discover/run.ts'

const USAGE = { input_tokens: 160, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const MODEL = 'claude-sonnet-5-5'
const candidate = (company: string, country: string | null, locationEvidence = country === 'US' ? 'United States' : country === 'CA' ? 'Canada' : country === 'GB' ? 'United Kingdom' : null) => ({
  company, country, location_evidence: locationEvidence, signal: 'hiring a sales development representative', evidence_url: `https://proof.example/${company.toLowerCase()}`,
})
type Payload = { model: string; tools?: unknown; messages: unknown; system?: unknown; max_tokens?: number }
type Place = { text: string; city: string | null; region: string | null; country: string | null }

function provider(places: Place[], leads: ReturnType<typeof candidate>[] = [], searches = 0, pauseWithPlan = false) {
  const requests: Payload[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body))
    requests.push(payload)
    const reply = { id: 'msg_test', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: USAGE }
    const plan = { offer: null, buyer_type: 'agencies', industry_code: null, places, signals: [], exclusions: [], language: 'en' }
    if (!payload.tools) return Response.json({ ...reply, model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }] })
    const paused = pauseWithPlan && requests.length === 1
    const output = !pauseWithPlan ? { request_plan: plan, leads } : paused ? { request_plan: plan, leads: [] } : { leads }
    const events = [
      { type: 'message_start', message: { ...reply, model: MODEL } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(output) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: paused ? 'pause_turn' : 'end_turn' }, usage: { ...USAGE, server_tool_use: { web_search_requests: searches } } },
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
  ['Europe with a wrong code', [{ text: 'Europe', city: null, region: null, country: 'US' }]],
  ['London with no typed city', [{ text: 'London', city: null, region: null, country: 'US' }]],
  ['Europe', [{ text: 'Europe', city: null, region: null, country: null }]],
] as const) {
  test(`the Claude plan stops a request for ${target} without web searches`, async () => {
    const query = `Find agencies hiring an SDR in ${target}`
    const { requests, fetchImpl } = provider([...places])
    const run = await runDiscovery({ query }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, MODEL)
    assert.match(JSON.stringify(requests[0].system), /Before using any web tool/)
    assert.ok(JSON.stringify(requests[0].messages).includes(query))
    assert.equal(run.stop, 'unsupported_search_region')
    assert.equal(run.note, 'dazl covers the US and Canada for now. More regions soon.')
    assert.equal(run.searches, 0)
    assert.ok(run.usd > 0, 'the paid discovery response is accounted for')
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
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, MODEL)
    assert.match(JSON.stringify(requests[0].system), /Before using any web tool/)
    assert.match(JSON.stringify(requests[0].tools), /web_search/)
    assert.match(JSON.stringify(requests[0].system), /Search only for targets in the US and Canada/)
    const system = (requests[0].system as Array<{ text: string }>)[0].text
    const example = /<json>(\{.*\})<\/json>/.exec(system)?.[1]
    assert.ok(example)
    assert.ok(Object.hasOwn(JSON.parse(example).leads[0], 'country'))
    assert.ok(Object.hasOwn(JSON.parse(example), 'request_plan'))
    const inScope = country === 'US' ? ['American'] : country === 'CA' ? ['Canadian'] : ['American', 'Canadian']
    assert.deepEqual(result.leads.map(lead => lead.company), inScope)
  })
}

test('the ordinary second pass adds no planner transport', async () => {
  const { requests, fetchImpl } = provider([])
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR' }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(run.passes, 2)
  assert.equal(run.requests, 2)
  assert.equal(requests.filter(request => !request.tools).length, 0)
})

test('both allowed countries survive when Claude groups them under one code', async () => {
  const { fetchImpl } = provider([{ text: 'Canada and US', city: null, region: null, country: 'US' }], [
    candidate('American', 'US'), candidate('Canadian', 'CA'),
  ])
  const result = await discoverLeads({ query: 'Find agencies hiring an SDR in Canada and US' }, { apiKey: 'test', fetch: fetchImpl })
  assert.deepEqual(result.leads.map(lead => lead.company), ['American', 'Canadian'])
})

for (const places of [
  [{ text: 'Newfoundland and Labrador', city: null, region: 'Newfoundland and Labrador', country: 'CA' }],
  [{ text: 'Indianapolis, IN', city: 'Indianapolis', region: 'IN', country: 'US' }],
  [{ text: 'Dallas', city: 'Dallas', region: null, country: 'US' }, { text: 'Austin', city: 'Austin', region: null, country: 'US' }],
  [{ text: 'Toronto', city: 'Toronto', region: null, country: 'CA' }, { text: 'Montreal', city: 'Montreal', region: null, country: 'CA' }],
] satisfies Place[][]) {
  const location = places.map(place => place.text).join(' and ')
  test(`typed coverage admits ${location}`, async () => {
    const { requests, fetchImpl } = provider(places, [candidate('Local', places[0].country)])
    const result = await discoverLeads({ query: `Find agencies hiring an SDR in ${location}` }, { apiKey: 'test', fetch: fetchImpl })
    assert.equal(requests.length, 1)
    assert.match(JSON.stringify(requests[0].tools), /web_search/)
    assert.equal(result.leads.length, 1)
  })
}

test('a search already reported by Claude stays accounted for when its plan is rejected', async () => {
  const { fetchImpl } = provider([{ text: 'UK', city: null, region: null, country: 'GB' }], [candidate('Local', 'US')], 1)
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR in the UK' }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(run.stop, 'unsupported_search_region')
  assert.equal(run.searches, 1)
  assert.deepEqual([run.leads, run.pages], [[], []])
})

test('profile-only locations cannot override an explicitly typed destination', async () => {
  const { fetchImpl } = provider([{ text: 'New York', city: null, region: 'New York', country: 'US' }], [candidate('Local', 'US')])
  const run = await discoverLeads({ query: 'Find agencies hiring an SDR in Toronto', profile: { where: ['New York'] } }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(run.stop, 'search_region_unconfirmed')
  assert.deepEqual(run.leads, [])
})

test('a final response without a repeated plan uses the complete paused plan', async () => {
  const { requests, fetchImpl } = provider([{ text: 'Canada', city: null, region: null, country: 'CA' }], [
    candidate('Canadian', 'CA'), candidate('Outside', 'GB'),
  ], 0, true)
  const result = await discoverLeads({ query: 'Find agencies hiring an SDR in Canada' }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(requests.length, 2)
  assert.equal(result.usage.requests, 2)
  assert.deepEqual(result.leads.map(lead => lead.company), ['Canadian'])
})

test('all rejected leads trigger a US/CA retry with the remaining native search allowance', async () => {
  const first = provider([], [candidate('Outside', 'GB')], 14)
  const second = provider([], [candidate('Local', 'CA')], 1)
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).startsWith('https://proof.example/')) return new Response('Local is hiring a sales development representative.')
    return (first.requests.length === 0 ? first.fetchImpl : second.fetchImpl)(url, init)
  }
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR' }, { maxUsd: 1, maxSearches: 15 }, {
    apiKey: 'test', fetch: fetchImpl, judge: null, enrich: null,
  })
  assert.equal(run.passes, 2)
  assert.equal(run.requests, 2)
  assert.equal(run.searches, 15)
  assert.deepEqual(run.leads.map(lead => lead.company), ['Local'])
  assert.notEqual(run.stop, 'unsupported_search_region')
  assert.match(JSON.stringify(second.requests[0].messages), /retry.*United States and Canada/i)
  assert.equal(second.requests[0].max_tokens, first.requests[0].max_tokens)
  const search = (second.requests[0].tools as Array<{ name: string; max_uses: number }>).find(tool => tool.name === 'web_search')
  assert.equal(search?.max_uses, 1)
})

for (const [limit, maxUsd] of [[14, 1], [15, 0.2]]) {
  test(`the location retry stays within a ${limit}-search and $${maxUsd} budget`, async () => {
    const { requests, fetchImpl } = provider([], [candidate('Outside', 'GB')], 14)
    const run = await runDiscovery({ query: 'Find agencies hiring an SDR' }, { maxUsd, maxSearches: limit }, {
      apiKey: 'test', fetch: fetchImpl, judge: null, enrich: null,
    })
    assert.equal(requests.length, 1)
    assert.equal(run.searches, 14)
    assert.equal(run.stop, 'unsupported_search_region')
    assert.equal(run.note, 'dazl covers the US and Canada for now. More regions soon.')
    assert.deepEqual(run.leads, [])
  })
}

test('a London plan labelled US keeps no UK-evidence leads and returns the coverage message', async () => {
  const { requests, fetchImpl } = provider([{ text: 'London', city: 'London', region: null, country: 'US' }], [
    candidate('UKLead', 'GB'), candidate('MislabelledLead', 'US', 'London, United Kingdom'),
  ], 1)
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR in London' }, { maxUsd: 1 }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(requests.length, 2)
  assert.equal(run.stop, 'unsupported_search_region')
  assert.equal(run.note, 'dazl covers the US and Canada for now. More regions soon.')
  assert.equal(run.searches, 2)
  assert.deepEqual([run.leads, run.pages], [[], []])
})
