import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { ledger, trialDay, type LedgerRow } from '../lib/billing/trial-budget.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'
import { createQueryJob } from '../lib/scan/store.ts'
import { trialStatus } from '../lib/scan/trial.ts'
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

test('a carried profile cannot override an explicitly typed destination', async () => {
  const { fetchImpl } = provider([{ text: 'New York', city: null, region: 'New York', country: 'US' }], [candidate('Local', 'US')])
  const run = await discoverLeads({ query: 'Find agencies hiring an SDR in Toronto', profile: { where: ['New York'] }, profileCarried: true }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(run.stop, 'search_region_unconfirmed')
  assert.deepEqual(run.leads, [])
})

test('SDR in Toronto searches the typed destination and omits saved New York', async () => {
  const query = 'SDR in Toronto'
  const toronto = { text: 'Toronto', city: 'Toronto', region: null, country: 'CA' }
  const newYork = { text: 'New York', city: null, region: 'New York', country: 'US' }
  const { requests, fetchImpl } = provider([toronto, newYork], [
    candidate('TypedDestination', 'CA', 'Toronto, Canada'),
    candidate('SavedDestination', 'US', 'New York, United States'),
  ])
  const result = await discoverLeads({ query, profile: { where: ['New York'] } }, { apiKey: 'test', fetch: fetchImpl })
  assert.equal(requests.length, 1)
  assert.match(JSON.stringify(requests[0].messages), /Find: SDR in Toronto/)
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /New York/)
  assert.deepEqual(result.leads.map(lead => lead.company), ['TypedDestination'])

  const profileOnly = provider([newYork], [candidate('SavedDestination', 'US', 'New York, United States')])
  const rejected = await discoverLeads({ query, profile: { where: ['New York'] } }, { apiKey: 'test', fetch: profileOnly.fetchImpl })
  assert.equal(rejected.stop, 'search_region_unconfirmed')
  assert.deepEqual(rejected.leads, [])
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

test('an accepted US search with an empty retry finishes normally after two calls', async () => {
  const places = [{ text: 'US', city: null, region: null, country: 'US' }]
  const first = provider(places, [candidate('Outside', 'GB')], 1)
  const second = provider(places, [], 1)
  const fetchImpl: typeof fetch = (url, init) =>
    (first.requests.length === 0 ? first.fetchImpl : second.fetchImpl)(url, init)
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR in the US' }, { maxUsd: 1 }, {
    apiKey: 'test', fetch: fetchImpl, judge: null, enrich: null,
  })
  assert.equal(run.requests, 2)
  assert.equal(run.passes, 2)
  assert.equal(run.stop, 'end_turn')
  assert.doesNotMatch(run.note ?? '', /covers the US and Canada/)
  assert.deepEqual(run.leads, [])
})

test('an explicitly UK plan stops with the coverage message and sends no retry', async () => {
  const { requests, fetchImpl } = provider([{ text: 'UK', city: null, region: null, country: 'GB' }])
  const run = await runDiscovery({ query: 'Find agencies hiring an SDR in the UK' }, { maxUsd: 1 }, {
    apiKey: 'test', fetch: fetchImpl, judge: null, enrich: null,
  })
  assert.equal(requests.length, 1)
  assert.equal(run.stop, 'unsupported_search_region')
  assert.match(run.note ?? '', /covers the US and Canada/)
  assert.deepEqual(run.leads, [])
})

test('city-only and grouped covered plans reach the region result filter', async () => {
  for (const [text, country] of [['Austin', 'US'], ['Toronto and Ottawa', 'CA']]) {
    const { fetchImpl } = provider([{ text, country, city: null, region: null }], [candidate('Local', country)])
    const run = await discoverLeads({ query: `Find agencies in ${text}` }, { apiKey: 'test', fetch: fetchImpl })
    assert.deepEqual(run.leads.map(lead => lead.company), ['Local'], text)
  }
})

test('an untyped covered metro is admitted when the returned lead evidence confirms coverage', async () => {
  const { fetchImpl } = provider([{ text: 'Greater Boston', country: 'US', city: null, region: null }], [candidate('Local', 'US')])
  const result = await discoverLeads({ query: 'Find agencies in Greater Boston' }, { apiKey: 'test', fetch: fetchImpl })
  assert.deepEqual(result.leads.map(lead => lead.company), ['Local'])
})

test('an employer name that contains an ambiguous city keeps the saved destination', async () => {
  const places = [{ text: 'Toronto', country: 'CA', city: 'Toronto', region: null }]
  for (const employer of ['Hamilton Insurance', 'London Insurance']) {
    const { requests, fetchImpl } = provider(places, [candidate('Local', 'CA'), candidate('OutsideProfile', 'US')])
    const result = await discoverLeads({ query: `VP Sales at ${employer}`, profile: { where: ['Toronto'] } }, { apiKey: 'test', fetch: fetchImpl })
    assert.match(JSON.stringify(requests[0].messages), /Locations .*Toronto/)
    assert.deepEqual(result.leads.map(lead => lead.company), ['Local'])
  }
})

test('an explicit ambiguous city still takes priority over the saved destination', async () => {
  const places = [{ text: 'Hamilton', country: 'CA', city: 'Hamilton', region: null }]
  const { requests, fetchImpl } = provider(places, [candidate('Local', 'CA'), candidate('OutsideProfile', 'US')])
  const result = await discoverLeads({ query: 'VP Sales in Hamilton', profile: { where: ['New York'] } }, { apiKey: 'test', fetch: fetchImpl })
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /New York/)
  assert.deepEqual(result.leads.map(lead => lead.company), ['Local'])
})

test('the saved profile grounds a place when the request leaves geography unspecified', async () => {
  const places = [{ text: 'Toronto', country: 'CA', city: 'Toronto', region: null }]
  const { fetchImpl } = provider(places, [candidate('Local', 'CA'), candidate('OutsideProfile', 'US')])
  const result = await discoverLeads({ query: 'Find agencies hiring an SDR', profile: { where: ['Toronto'] } }, { apiKey: 'test', fetch: fetchImpl })
  assert.deepEqual(result.leads.map(lead => lead.company), ['Local'])
})

test('a geography refusal is a terminal stopped scan and its settled free allowance is reusable', async () => {
  const db = new Database(':memory:')
  try {
    migrateAllSqlite(db)
    const master = randomBytes(32), tenant = 'geo-fixture'
    saveKey(db, tenant, 'anthropic', 'synthetic-fixture', master)
    const id = createQueryJob(db, tenant, { query: 'Find agencies in the UK' })
    const job = claimKeyedJob(db, id)
    assert.ok(job)
    const { fetchImpl } = provider([{ text: 'UK', country: 'GB', city: null, region: null }])
    const status = await runJob(db, job, { master, discover: true, fetchImpl })
    const row = db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null }
    assert.deepEqual([status, row.status, row.error], ['failed', 'failed', 'unsupported_search_region'])
    const result = scanOutcome({ id, ...row })
    assert.equal(result.kind, 'stopped')
    assert.match(result.label, /covers the US and Canada/)
    const now = Math.floor(Date.now() / 1000), day = trialDay(now)
    const settled: LedgerRow = { tenant_id: tenant, kind: 'scan', reserve_usd: 0.3, spent_usd: null,
      day, created_at: now, settled_at: now, settled_attempt: job.attempts, attempts: job.attempts,
      status: 'failed', error: row.error, spend_reserved_usd: 0.02 }
    assert.deepEqual(ledger([settled], tenant, day), { attempts: 0, account: 0.02, today: 0.02 })
    db.prepare('UPDATE scan_jobs SET spend_reserved_usd = 0.02 WHERE id = ?').run(id)
    db.prepare('INSERT INTO trial_scans (job_id, tenant_id, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(id, tenant, 'ip-fixture', now)
    db.prepare('INSERT INTO trial_reservations (id, job_id, tenant_id, reserve_usd, day, created_at, settled_at, settled_attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('held', id, tenant, 0.3, day, now, now, job.attempts)
    const attempt = trialStatus(db, tenant, '192.0.2.1', new Date(), { NODE_ENV: 'test', DAZL_TRIAL_ANTHROPIC_KEY: 'synthetic-fixture' })
    assert.equal(attempt.funded, true)
    assert.equal(attempt.used, 0)
    assert.equal(ledger([{ ...settled, settled_attempt: null }], tenant, day).attempts, 1)
  } finally { db.close() }
})
