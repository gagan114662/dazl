import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverLeads } from '../lib/discover/agent.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

async function discoveryRequest(query: string) {
  const requests: {
    model: string
    system: { text: string }[]
    messages: { content: string }[]
    tools: { name: string; max_uses: number }[]
  }[] = []
  await discoverLeads({ query, maxSearches: 2, maxFetches: 3 }, {
    apiKey: 'synthetic-test-key',
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number]
      requests.push(request)
      return sseResponse(sseEvents({
        id: 'msg_intent_plan_fixture', model: request.model, stop_reason: 'end_turn',
        content: [{ type: 'text', text: '<json>{"leads":[]}</json>' }],
        usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } },
      }))
    },
  })
  assert.equal(requests.length, 1)
  return requests[0]
}

test('#1726 Discovery plans separate evidence searches for compound and person-first intent', async () => {
  const request = await discoveryRequest('Find people who publicly asked about managing venue bookings at organizations that just opened a new location')
  const system = request.system.map(block => block.text).join('\n')
  assert.match(system, /search for each required event separately/i)
  assert.match(system, /confirm that they refer to the same buyer/i)
  assert.match(system, /find the public action first/i)
  assert.match(system, /verify the person's organization independently/i)
  assert.match(system, /a profile or a post about the same topic is not evidence of an engagement/i)
})

test('an unrelated company search retains its request and existing tool limits', async () => {
  const query = 'Independent publishers opening an office in Lisbon'
  const request = await discoveryRequest(query)
  assert.ok(request.messages[0].content.includes(`Find: ${query}`))
  assert.deepEqual(request.tools.map(tool => [tool.name, tool.max_uses]), [['web_search', 2], ['web_fetch', 3]])
  assert.match(request.system[0].text, /Every qualifier in the request is a requirement/)
})
