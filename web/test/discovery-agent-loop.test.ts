// Launch brief Step 2, first slice: discovery as ONE Claude agent loop (web_search + web_fetch) returning typed leads
// {company, domain, signal, signal_date, evidence_url, person, title, person_source_url, linkedin_url, confidence}.
// The real loop (lib/discovery/agent-loop.ts) against a scripted Messages API: no network, no prod wiring.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscoveryAgent, validateAgentLeads, DiscoveryAgentError } from '../lib/discovery/agent-loop.ts'

const NOW = Date.parse('2026-11-22T12:00:00Z')
type Body = { model: string; tools: { type?: string; name: string; max_uses?: number; strict?: boolean }[]; messages: { role: string; content: unknown }[]; system?: unknown }

// a scripted API: each call returns the next response; every request body is kept
function api(responses: unknown[], status = 200) {
  const bodies: Body[] = []
  // the injected transport: one request body in, the API's Response out (the paid send and its spend gate live in the transport)
  const send = async (body: Record<string, unknown>) => {
    bodies.push(JSON.parse(JSON.stringify(body)))
    const r = responses[Math.min(bodies.length - 1, responses.length - 1)]
    return new Response(JSON.stringify(r), { status, headers: { 'content-type': 'application/json' } })
  }
  return { send, bodies }
}
const usage = (o: Partial<{ input: number; output: number; searches: number; fetches: number }> = {}) => ({ input_tokens: o.input ?? 1000, output_tokens: o.output ?? 200, server_tool_use: { web_search_requests: o.searches ?? 0, web_fetch_requests: o.fetches ?? 0 } })
const searched = (...urls: string[]) => ({ type: 'web_search_tool_result', tool_use_id: 's1', content: urls.map(url => ({ type: 'web_search_result', url, title: 't', encrypted_content: 'x' })) })
const fetched = (url: string) => ({ type: 'web_fetch_tool_result', tool_use_id: 'f1', content: { type: 'web_fetch_result', url, content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '...' } } } })
const submit = (input: unknown) => ({ type: 'tool_use', id: 'tu1', name: 'submit_leads', input })
const PLAN = { service: 'dental clinics', place: 'a region', signal: 'hiring a receptionist', window_days: 90, people: ['practice owner'] }
const lead = (o: Record<string, unknown> = {}) => ({
  company: 'Example Dental', domain: 'exampledental.example', signal: 'Hiring a front desk receptionist', signal_date: '2026-11-10',
  evidence_url: 'https://exampledental.example/careers/receptionist', person: 'Alex Doe', title: 'Practice Owner',
  person_source_url: 'https://exampledental.example/team', linkedin_url: 'https://www.linkedin.com/in/alex-doe-1', confidence: 'high', ...o,
})
const SEEN = ['https://exampledental.example/careers/receptionist', 'https://exampledental.example/team', 'https://www.linkedin.com/in/alex-doe-1']

test('one agent loop: web_search + web_fetch server tools and a strict submit_leads tool; pause_turn continues; the plan and typed leads come back', async () => {
  const { send, bodies } = api([
    { stop_reason: 'pause_turn', content: [searched(SEEN[0], SEEN[2])], usage: usage({ searches: 2 }) },
    { stop_reason: 'tool_use', content: [fetched(SEEN[1]), submit({ plan: PLAN, leads: [lead()] })], usage: usage({ fetches: 1 }) },
  ])
  const r = await runDiscoveryAgent({ request: 'Dental clinics hiring a receptionist', send, now: NOW })
  assert.equal(bodies.length, 2)
  const tools = bodies[0].tools
  assert.deepEqual(tools.map(t => t.type ?? t.name), ['web_search_20260209', 'web_fetch_20260209', 'submit_leads'])
  assert.equal(tools[2].strict, true)
  assert.ok((tools[0].max_uses ?? 0) > 0 && (tools[1].max_uses ?? 0) > 0)
  // pause_turn: the assistant's content is sent back as-is and the turn continues
  assert.deepEqual(bodies[1].messages.at(-1), { role: 'assistant', content: [searched(SEEN[0], SEEN[2])] })
  assert.equal(r.stop, 'submitted')
  assert.deepEqual(r.plan, PLAN)
  assert.equal(r.leads.length, 1)
  assert.deepEqual(r.leads[0], { ...lead(), missing: [] })
  assert.deepEqual([r.usage.turns, r.usage.web_search_requests, r.usage.web_fetch_requests, r.usage.input_tokens, r.usage.output_tokens], [2, 2, 1, 2000, 400])
  assert.ok(r.usage.cost_usd > 0)
})

test('the system prompt reuses cf_runner\'s discover rules and the request is the user message', async () => {
  const { send, bodies } = api([{ stop_reason: 'tool_use', content: [submit({ plan: PLAN, leads: [] })], usage: usage() }])
  await runDiscoveryAgent({ request: 'Dental clinics hiring a receptionist', send, now: NOW })
  assert.match(JSON.stringify(bodies[0].system), /only companies you found evidence for in search results this session; never invent/)
  assert.deepEqual(bodies[0].messages[0], { role: 'user', content: 'Dental clinics hiring a receptionist' })
})

test('show, don\'t hide: a lead needs a real company, a valid past date and an evidence URL the tools returned in THIS loop', () => {
  const seen = new Set(SEEN)
  const { leads, rejected } = validateAgentLeads([
    lead(),
    lead({ company: 'Invented Co', evidence_url: 'https://invented.example/jobs/1' }),
    lead({ company: 'Future Co', signal_date: '2027-01-01' }),
    lead({ company: 'Undated Co', signal_date: null }),
    lead({ company: 'Bad Date Co', signal_date: '2026-13-40' }),
    lead({ company: '', evidence_url: SEEN[0] }),
    lead({ company: 'Http Co', evidence_url: 'http://exampledental.example/careers/receptionist' }),
  ], seen, NOW)
  assert.deepEqual(leads.map(l => l.company), ['Example Dental'])
  assert.deepEqual(rejected.map(r => [r.company, r.reason]), [
    ['Invented Co', 'evidence_url_not_seen'], ['Future Co', 'signal_date_invalid'], ['Undated Co', 'signal_date_invalid'],
    ['Bad Date Co', 'signal_date_invalid'], ['', 'no_company'], ['Http Co', 'evidence_url_not_seen'],
  ])
})

test('a missing or unproven person, domain or LinkedIn lowers confidence and is named in missing; it never hides the lead', () => {
  const seen = new Set(SEEN)
  const { leads } = validateAgentLeads([
    // a person with no source the tools returned is not shown as found
    lead({ company: 'A', person_source_url: 'https://elsewhere.example/about', linkedin_url: null }),
    // a LinkedIn URL that is not a profile, or was not seen, is dropped
    lead({ company: 'B', linkedin_url: 'https://www.linkedin.com/company/example-dental' }),
    lead({ company: 'C', linkedin_url: 'https://www.linkedin.com/in/someone-else' }),
    // a domain no returned URL is on is not shown (an unproven domain could be the wrong company's)
    lead({ company: 'D', domain: 'other-domain.example' }),
    // nothing about a person, and no domain
    lead({ company: 'E', person: null, title: null, person_source_url: null, linkedin_url: null, domain: null }),
  ], seen, NOW)
  const by = Object.fromEntries(leads.map(l => [l.company, l]))
  assert.deepEqual([by.A.person, by.A.title, by.A.confidence, by.A.missing], [null, null, 'medium', ['person', 'linkedin']])
  assert.deepEqual([by.B.linkedin_url, by.B.person, by.B.confidence, by.B.missing], [null, 'Alex Doe', 'high', ['linkedin']])
  assert.deepEqual([by.C.linkedin_url, by.C.missing], [null, ['linkedin']])
  assert.deepEqual([by.D.domain, by.D.confidence, by.D.missing], [null, 'medium', ['domain']])
  assert.deepEqual([by.E.confidence, by.E.missing], ['low', ['domain', 'person', 'linkedin']])
  assert.equal(leads.length, 5, 'every lead with a dated, sourced signal is shown')
})

test('one lead per company: the first, by company and domain', () => {
  const { leads } = validateAgentLeads([lead(), lead({ company: 'example dental ', signal: 'Another post' })], new Set(SEEN), NOW)
  assert.equal(leads.length, 1)
})

test('end_turn without submit_leads: one nudge to submit, then it stops', async () => {
  const { send, bodies } = api([
    { stop_reason: 'end_turn', content: [searched(SEEN[0]), { type: 'text', text: 'I found one clinic.' }], usage: usage({ searches: 1 }) },
    { stop_reason: 'tool_use', content: [submit({ plan: PLAN, leads: [lead({ person_source_url: null, linkedin_url: null, person: null, title: null })] })], usage: usage() },
  ])
  const r = await runDiscoveryAgent({ request: 'q', send, now: NOW })
  assert.equal(bodies.length, 2)
  assert.equal(bodies[1].messages.at(-1)?.role, 'user')
  assert.match(JSON.stringify(bodies[1].messages.at(-1)?.content), /submit_leads/)
  assert.equal(r.stop, 'submitted'); assert.equal(r.leads.length, 1)
  // a second end_turn without a submission ends the loop with nothing invented
  const twice = api([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: usage() }])
  const r2 = await runDiscoveryAgent({ request: 'q', send: twice.send, now: NOW })
  assert.deepEqual([r2.stop, r2.leads.length, twice.bodies.length], ['no_submit', 0, 2])
})

test('the loop stops at the budget (the brief: under $1 a prompt) and at max turns; a refusal stops it', async () => {
  const big = api([{ stop_reason: 'pause_turn', content: [searched(SEEN[0])], usage: usage({ input: 450_000, output: 10_000, searches: 5 }) }])
  const r = await runDiscoveryAgent({ request: 'q', send: big.send, now: NOW, budgetUsd: 1 })
  assert.equal(r.stop, 'budget'); assert.equal(big.bodies.length, 1); assert.ok(r.usage.cost_usd >= 1)
  const loop = api([{ stop_reason: 'pause_turn', content: [searched(SEEN[0])], usage: usage() }])
  const r2 = await runDiscoveryAgent({ request: 'q', send: loop.send, now: NOW, maxTurns: 3 })
  assert.deepEqual([r2.stop, loop.bodies.length], ['max_turns', 3])
  const no = api([{ stop_reason: 'refusal', content: [], usage: usage() }])
  assert.equal((await runDiscoveryAgent({ request: 'q', send: no.send, now: NOW })).stop, 'refusal')
})

test('cost is priced per model from the usage the API reports (tokens + $10 per 1,000 searches)', async () => {
  const { send } = api([{ stop_reason: 'tool_use', content: [submit({ plan: PLAN, leads: [] })], usage: usage({ input: 100_000, output: 10_000, searches: 10 }) }])
  const r = await runDiscoveryAgent({ request: 'q', send, now: NOW, model: 'claude-sonnet-5-5' })
  // 100k * $2/M + 10k * $10/M + 10 * $0.01 = 0.2 + 0.1 + 0.1
  assert.equal(Math.round(r.usage.cost_usd * 1e6) / 1e6, 0.4)
})

test('a rejected key or an API error is an error, never an empty success', async () => {
  for (const [status, code] of [[401, 'key_rejected'], [429, 'rate_limited'], [500, 'api_error']] as const) {
    const { send } = api([{ type: 'error', error: { type: 'x', message: 'y' } }], status)
    await assert.rejects(runDiscoveryAgent({ request: 'q', send, now: NOW }), (e: unknown) => e instanceof DiscoveryAgentError && e.code === code)
  }
  await assert.rejects(runDiscoveryAgent({ request: '', send: api([]).send, now: NOW }), (e: unknown) => e instanceof DiscoveryAgentError && e.code === 'invalid_input')
})
