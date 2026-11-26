import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiscoveredLead } from '../lib/discover/agent.ts'
import { enrichLeads } from '../lib/discover/enrich.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

const lead: DiscoveredLead = {
  company: 'Cedar Dental', domain: 'cedar.example', signal: 'Hiring', signal_date: null,
  evidence_url: 'https://cedar.example/jobs', evidence_quote: null, person: null, title: null,
  person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
  confidence: 'high', why: '',
}
const team = 'https://cedar.example/team'
const registry = 'https://registry.example/cedar'
const name = 'Dana Ruiz'
const title = 'Practice Manager'
const email = 'dana@cedar.example'
const personText = 'Dana Ruiz, Practice Manager at Cedar Dental.'
const page = (url: string, data: string) => ({
  type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_fixture',
  content: { type: 'web_fetch_result', url, content: { source: { type: 'text', data } } },
})
async function lookup(overrides = {}, sources = [page(team, `${personText} ${email}`)], original = lead) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).hostname, 'api.anthropic.com')
    assert.equal(JSON.parse(String(init?.body)).model, 'claude-haiku-5-5')
    return sseResponse(sseEvents({
      id: 'msg_fixture', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
      content: [...sources, { type: 'text', text: JSON.stringify({
        domain: lead.domain, person: name, title, person_source_url: team,
        email, email_source_url: team, ...overrides,
      }) }],
      usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 1 } },
    }))
  }
  const result = await enrichLeads([original], {}, { apiKey: 'fixture-only', fetch })
  assert.equal(result.accountingUncertain, false)
  return result.leads[0]
}

test('S3 keeps a named local manager and their own-site address with separate public sources', async () => {
  const result = await lookup({ person_source_url: registry }, [page(registry, personText), page(team, `${personText} ${email}`)])
  assert.deepEqual([result.person, result.title, result.person_source_url, result.email, result.email_source_url],
    [name, title, registry, email, team])
})

for (const [label, proposal, sources] of [
  ['a role inbox', { email: 'office@cedar.example' }, [page(team, `${personText} office@cedar.example`)]],
  ['a group mailbox', { email: 'founders@cedar.example' }, [page(team, `${personText} founders@cedar.example`)]],
  ['an off-domain address', { email: 'dana@other.example' }, [page(team, `${personText} dana@other.example`)]],
  ['an address only on a registry', { email_source_url: registry }, [page(team, personText), page(registry, `${personText} ${email}`)]],
  ['an address missing from the fetched page', {}, [page(team, personText)]],
  ['a different person’s address', {}, [page(team, `${personText}\n\nAnother Person: ${email}`)]],
] as const) {
  test(`S3 refuses ${label} while keeping the proven name`, async () => {
    const result = await lookup(proposal, [...sources])
    assert.deepEqual([result.person, result.email, result.email_source_url], [name, null, null])
  })
}

test('S3 does not attach an address for another person to the existing buyer', async () => {
  const result = await lookup({}, undefined, { ...lead, person: 'Morgan Lee', title, person_source_url: team })
  assert.deepEqual([result.person, result.email], ['Morgan Lee', null])
})

test('S3 does not accept a proposed domain from a same-name person at an unrelated business', async () => {
  const result = await lookup({}, [page(team, `Dana Ruiz, Practice Manager at Fir Dental. ${email}`)], {
    ...lead, domain: null, evidence_url: 'https://news.example/clinic',
  })
  assert.deepEqual([result.person, result.email], [null, null])
})

test('S3 needs the registry to tie the person to this business in the same entry', async () => {
  const result = await lookup({ person_source_url: registry }, [
    page(registry, 'Cedar Dental: Taylor Kay, Dentist.\n\nFir Dental: Dana Ruiz, Practice Manager.'),
    page(team, `${personText} ${email}`),
  ])
  assert.deepEqual([result.person, result.email], [null, null])
})
