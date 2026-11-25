import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'
import type { DiscoverResult } from '../lib/discover/agent.ts'

const reason = 'Municipal government body'
const normalOffer = 'Accounting software for private companies'
const governmentOffer = 'Accounting software for local governments'
const company = 'Town of Oakville'
const domain = 'oakville.ca'
const stub = `
  export function isPublicSectorBody(input) {
    if (input.company !== ${JSON.stringify(company)} || input.domain !== ${JSON.stringify(domain)}) {
      throw new Error('Incorrect classifier input')
    }
    return { nonBuyer: input.offer !== ${JSON.stringify(governmentOffer)}, reason: ${JSON.stringify(reason)} }
  }
`
const loader = `
  export function resolve(specifier, context, next) {
    if (specifier === '../non-buyer.ts' && context.parentURL?.endsWith('/lib/discover/run.ts')) {
      return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(stub))}, shortCircuit: true }
    }
    return next(specifier, context)
  }
`
register('data:text/javascript,' + encodeURIComponent(loader))
const { runDiscovery } = await import('../lib/discover/run.ts')

const url = 'https://www.oakville.ca/news/finance-system'
const quote = 'Town of Oakville is replacing its finance system.'
const result: DiscoverResult = {
  leads: [{
    company, domain, signal: 'Replacing its finance system', signal_date: null,
    evidence_url: url, evidence_quote: quote, person: null, title: null,
    person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: 'Finance system replacement',
  }],
  usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.01 },
  stop: 'end_turn', model: 'test', note: 'Existing discovery note',
  seen: [{ url, title: company, text: quote, page_age: null }],
}

const run = (offer: string) => runDiscovery({ query: 'Organizations replacing finance systems', offer }, { maxUsd: 0.1, wantShown: 1 }, {
  apiKey: 'unused', discover: async () => result, enrich: null, judge: null,
  fetch: async () => { throw new Error('Unexpected fetch') },
})

test('drops the Town of Oakville from the kept leads for a normal offer and reports why', async () => {
  const outcome = await run(normalOffer)
  assert.deepEqual(outcome.leads, [])
  assert.deepEqual(outcome.pages, [])
  assert.equal(outcome.note, `Existing discovery note Public-sector leads excluded: ${reason}.`)
})

test('keeps the Town of Oakville when the offer targets government', async () => {
  const outcome = await run(governmentOffer)
  assert.deepEqual(outcome.leads.map(lead => [lead.company, lead.proof, lead.signal_seen]), [[company, 'confirmed', true]])
  assert.equal(outcome.note, result.note)
})
