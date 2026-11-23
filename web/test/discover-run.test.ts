// The shared discovery run (lib/discover/run.ts): when a second pass happens, what gets the people pass, and the budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery } from '../lib/discover/run.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'

const lead = (company: string, o: Partial<DiscoveredLead> = {}): DiscoveredLead => ({ company, domain: null, signal: 'opening a new site', signal_date: '2026-10-14', evidence_url: `https://news.example/${company.toLowerCase().replace(/\W+/g, '-')}`, evidence_quote: `${company} said it is opening a new site`, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'medium', why: '', ...o })
const result = (leads: DiscoveredLead[], usd: number, unseen: string[] = []): DiscoverResult => ({ leads, seen: leads.filter(l => !unseen.includes(l.company)).map(l => ({ url: l.evidence_url, title: l.company, page_age: null, text: `On 14 October 2026 ${l.company} said it is opening a new site.` })), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 5, requests: 1, usd }, stop: 'end_turn', model: 'm', note: null })
const never = (() => { throw new Error('no network in this test') }) as unknown as typeof fetch

test('five shown leads on the first pass: no second pass; the people pass gets only shown leads that lack something', async () => {
  const calls: string[][] = []
  const names = ['A Co', 'B Co', 'C Co', 'D Co', 'E Co', 'Ghost Co']
  const run = await runDiscovery({ query: 'q' }, { maxUsd: 1 }, { apiKey: 'k', fetch: never,
    discover: async () => result(names.map(n => lead(n)), 0.3, ['Ghost Co']),
    enrich: async leads => { calls.push(leads.map(l => l.company)); return { leads: leads.map(l => ({ ...l, person: 'Pat Lee', title: 'Owner', person_source_url: 'https://x.example/team', email: 'pat@x.example', email_source_url: 'https://x.example/team' })), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 5, requests: 5, usd: 0.05 }, seen: [], enriched: leads.length } } })
  assert.equal(run.passes, 1)
  assert.deepEqual(calls, [['A Co', 'B Co', 'C Co', 'D Co', 'E Co']], 'the unshown lead is not worth a call')
  assert.equal(run.usd, 0.35)
  assert.equal(run.leads.find(l => l.company === 'A Co')!.person, 'Pat Lee')
  assert.equal(run.leads.find(l => l.company === 'A Co')!.email, 'pat@x.example')
  assert.equal(run.leads.find(l => l.company === 'Ghost Co')!.person, null)
})

test('fewer than five shown: a second pass for different companies, when a pass of the same size still fits the budget', async () => {
  const asked: (string[] | undefined)[] = []
  const discover = async (i: { exclude?: string[] }) => { asked.push(i.exclude); return asked.length === 1 ? result([lead('A Co'), lead('B Co')], 0.4) : result([lead('B Co'), lead('C Co')], 0.4) }
  const fits = await runDiscovery({ query: 'q' }, { maxUsd: 1 }, { apiKey: 'k', fetch: never, discover, enrich: null })
  assert.deepEqual([fits.passes, fits.usd, fits.leads.map(l => l.company)], [2, 0.8, ['A Co', 'B Co', 'C Co']], 'a company both passes return is kept once')
  assert.deepEqual(asked, [undefined, ['A Co', 'B Co']])
  asked.length = 0
  const tight = await runDiscovery({ query: 'q' }, { maxUsd: 0.6 }, { apiKey: 'k', fetch: never, discover, enrich: null })
  assert.deepEqual([tight.passes, tight.usd], [1, 0.4], 'no room for a second pass: the first stands')
})
