import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiscoveredLead } from '../lib/discover/agent.ts'
import { enrichLeads } from '../lib/discover/enrich.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

async function enrich(lead: DiscoveredLead, source: string, pageText: string, email: string, proposedPerson: string) {
  const result = await enrichLeads([lead], {}, {
    apiKey: 'fixture-only',
    fetch: async () => sseResponse(sseEvents({
      id: 'msg_source', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
      content: [
        { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fixture',
          content: { type: 'web_fetch_result', url: source, content: { source: { type: 'text', data: pageText } } } },
        { type: 'text', text: JSON.stringify({ person: proposedPerson, title: lead.title,
          person_source_url: lead.person_source_url, email, email_source_url: source }) },
      ],
      usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
    })),
  })
  assert.equal(result.accountingUncertain, false)
  return result.leads[0]
}

const known = (domain: string, person: string, title: string): DiscoveredLead => ({
  company: domain, domain, signal: 'Named leadership', signal_date: null,
  evidence_url: `https://${domain}/news`, evidence_quote: null, person, title,
  person_source_url: `https://${domain}/news/appointment`,
  linkedin_url: null, email: null, email_source_url: null, confidence: 'high', why: '',
})

test('keeps an existing buyer’s own address from their published profile when the old person citation was not re-fetched', async () => {
  // Name and email from the public Akin profile. The prior citation is a fixture.
  const source = 'https://www.akingump.com/en/lawyers-advisors/graham-lovett'
  const email = 'glovett@akingump.com'
  const lead = known('akingump.com', 'Graham Lovett', 'Partner')
  const result = await enrich(lead, source, `Graham Lovett\nPartner, Commercial Arbitration & Litigation\nSend Email (${email})`, email, 'Graham Lovett')
  assert.deepEqual([result.person, result.person_source_url, result.email, result.email_source_url],
    [lead.person, lead.person_source_url, email, source])
})

test('a different proposed person cannot supply an address for an existing buyer', async () => {
  const lead = known('example.test', 'Casey Olsen', 'Operations Director')
  const result = await enrich(lead, 'https://example.test/team', 'Casey Olsen: colsen@example.test',
    'colsen@example.test', 'Elaine Davis')
  assert.equal(result.person, lead.person)
  assert.equal(result.email, null)
})
