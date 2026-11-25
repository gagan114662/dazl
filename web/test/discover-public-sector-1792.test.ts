import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import type { DiscoverResult } from '../lib/discover/agent.ts'

const reason = 'Municipal government body'
const normalOffer = 'Accounting software for private companies'
const governmentOffer = 'Accounting software for local governments'
const calls: unknown[] = []
const stubUrl = 'test:public-sector-1792'

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../non-buyer.ts' && context.parentURL?.endsWith('/lib/discover/run.ts')) {
      return { url: stubUrl, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url !== stubUrl) return next(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `export function isPublicSectorBody(input) {
        globalThis.__publicSector1792Calls.push(input)
        return { nonBuyer: input.offer !== ${JSON.stringify(governmentOffer)}, reason: ${JSON.stringify(reason)} }
      }`,
    }
  },
})

const globals = globalThis as typeof globalThis & { __publicSector1792Calls?: unknown[] }
globals.__publicSector1792Calls = calls
const { runDiscovery } = await import('../lib/discover/run.ts')
hooks.deregister()

const company = 'Town of Oakville'
const domain = 'oakville.ca'
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
  assert.deepEqual(calls.at(-1), { company, domain, offer: normalOffer })
})

test('keeps the Town of Oakville when the offer targets government', async () => {
  const outcome = await run(governmentOffer)
  assert.deepEqual(outcome.leads.map(lead => [lead.company, lead.proof, lead.signal_seen]), [[company, 'confirmed', true]])
  assert.equal(outcome.note, result.note)
  assert.deepEqual(calls.at(-1), { company, domain, offer: governmentOffer })
})
