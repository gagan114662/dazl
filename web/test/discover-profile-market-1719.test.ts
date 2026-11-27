import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileMarketLines } from '../lib/discover/profile-market.ts'
import { resolveSearchMarket, type SearchMarket } from '../lib/scan/search-market.ts'
import { discoverLeads } from '../lib/discover/agent.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

for (const [country, language] of [['DE', 'de'], ['BR', 'pt'], ['JP', 'ja'], ['CA', 'fr']]) {
  test(`#1719: country ${country} and language ${language} carry when no place is saved`, () => {
    const [market, sourceLanguage] = profileMarketLines({ where: [], country, language })
    assert.match(market, new RegExp(`\\b${country}\\b`))
    assert.match(market, /only if the request names no place/)
    assert.match(sourceLanguage, new RegExp(`\\b${language}\\b`))
    assert.match(sourceLanguage, /only if the request leaves the language open/)
  })
}

test('#1719: a populated place keeps the existing location path', () => {
  assert.deepEqual(profileMarketLines({ where: ['Oslo'], country: 'NO', language: 'no' }), [])
})

test('#1719: market fields are independent and no defaults are invented', () => {
  assert.deepEqual(profileMarketLines(), [])
  assert.deepEqual(profileMarketLines({ country: 'MX' }), ['Saved country (only if the request names no place): MX'])
  assert.deepEqual(profileMarketLines({ language: 'ar' }), ['Saved source language (only if the request leaves the language open): ar'])
  assert.deepEqual(profileMarketLines({ country: 'not a country', language: 'unknown' }), [])
})

async function discoveryPrompt(query: string, profile: { summary: string; country: string; language: string; where?: string[] }, market?: SearchMarket) {
  const requests: { messages: { content: string }[] }[] = []
  await discoverLeads({ query, profile, profileCarried: true, market }, {
    apiKey: 'synthetic-fixture',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return sseResponse(sseEvents({
        id: 'msg_profile_market',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: '<json>{"leads":[],"note":null}</json>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 0 } },
      }))
    },
  })
  assert.equal(requests.length, 1)
  return requests[0].messages[0].content
}

test('#1719: Discovery receives saved country and language when where is absent', async () => {
  const query = 'Find manufacturers purchasing warehouse equipment'
  const prompt = await discoveryPrompt(query, { summary: 'Industrial buyers', country: 'JP', language: 'ja' })
  assert.ok(prompt.includes(query))
  assert.match(prompt, /Saved country \(only if the request names no place\): JP/)
  assert.match(prompt, /Saved source language \(only if the request leaves the language open\): ja/)
})

test('#1719: Discovery keeps a populated saved place without the market fallback', async () => {
  const prompt = await discoveryPrompt('Find independent retailers', {
    summary: 'Retail buyers', where: ['Oslo'], country: 'NO', language: 'no',
  })
  assert.match(prompt, /Usual locations .*Oslo/)
  assert.doesNotMatch(prompt, /Saved country|Saved source language/)
})

test('#1719: a resolved France query emits one market hint over saved CA/en', async () => {
  const query = 'Find independent builders in France'
  const profile = { summary: 'Builders', country: 'CA', language: 'en' }
  const market = resolveSearchMarket(query, profile, { country: 'DE', language: 'de' })
  assert.deepEqual(market, { country: 'FR', language: null })
  const prompt = await discoveryPrompt(query, profile, market)
  assert.equal(prompt.match(/Search market country FR/g)?.length, 1)
  assert.doesNotMatch(prompt, /Saved country|Saved source language|language en/)
  assert.match(prompt, /Who they sell to: Builders/)
})
