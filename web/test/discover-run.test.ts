// The shared discovery run (lib/discover/run.ts): when a second pass happens, what gets the people pass, and the budget.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runDiscovery } from '../lib/discover/run.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'

const lead = (company: string, o: Partial<DiscoveredLead> = {}): DiscoveredLead => ({ company, domain: null, signal: 'opening a new site', signal_date: '2026-10-14', evidence_url: `https://news.example/${company.toLowerCase().replace(/\W+/g, '-')}`, evidence_quote: `${company} said it is opening a new site`, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'medium', why: '', ...o })
const result = (leads: DiscoveredLead[], usd: number, unseen: string[] = []): DiscoverResult => ({ leads, seen: leads.filter(l => !unseen.includes(l.company)).map(l => ({ url: l.evidence_url, title: l.company, page_age: null, text: `On 14 October 2026 ${l.company} said it is opening a new site.` })), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 5, requests: 1, usd }, stop: 'end_turn', model: 'm', note: null })
const never = (() => { throw new Error('no network in this test') }) as unknown as typeof fetch

const proofJudge: typeof fetch = async (input, init) => {
  assert.equal(String(input), 'https://api.anthropic.com/v1/messages')
  assert.equal(JSON.parse(String(init?.body)).model, 'claude-haiku-5-5')
  return Response.json({ model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'YES' }],
    usage: { input_tokens: 0, output_tokens: 0 } })
}

test('five shown leads on the first pass: no second pass; the people pass gets the shown leads that lack something, then the one in review', async () => {
  const calls: string[][] = []
  const names = ['A Co', 'B Co', 'C Co', 'D Co', 'E Co', 'Ghost Co']
  const run = await runDiscovery({ query: 'q' }, { maxUsd: 1 }, { apiKey: 'k', fetch: proofJudge,
    discover: async () => result(names.map(n => lead(n)), 0.3, ['Ghost Co']),
    enrich: async leads => { calls.push(leads.map(l => l.company)); return { leads: leads.map(l => ({ ...l, person: 'Pat Lee', title: 'Owner', person_source_url: 'https://x.example/team', email: 'pat@x.example', email_source_url: 'https://x.example/team' })), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 5, requests: 5, usd: 0.05 }, seen: [{ url: 'https://x.example/team', title: 'Team', page_age: null, text: 'Pat Lee: pat@x.example' }], enriched: leads.length } } })
  assert.equal(run.passes, 1)
  assert.deepEqual(calls, [['A Co', 'B Co', 'C Co', 'D Co', 'E Co', 'Ghost Co']], 'shown leads first, then the lead that waits for review')
  assert.equal(run.usd, 0.35)
  assert.equal(run.leads.find(l => l.company === 'A Co')!.person, 'Pat Lee')
  assert.equal(run.leads.find(l => l.company === 'A Co')!.email, 'pat@x.example')
  assert.equal(run.leads.find(l => l.company === 'Ghost Co')!.person, 'Pat Lee', 'a lead in review gets its person too (owner, 2026-11-24)')
})

test('fewer than five shown: a second pass for different companies, when a pass of the same size still fits the budget', async () => {
  const asked: (string[] | undefined)[] = []
  const discover = async (i: { exclude?: string[] }) => { asked.push(i.exclude); return asked.length === 1 ? result([lead('A Co'), lead('B Co')], 0.4) : result([lead('B Co'), lead('C Co')], 0.4) }
  const fits = await runDiscovery({ query: 'q' }, { maxUsd: 1 }, { apiKey: 'k', fetch: proofJudge, discover, enrich: null })
  assert.deepEqual([fits.passes, fits.usd, fits.leads.map(l => l.company)], [2, 0.8, ['A Co', 'B Co', 'C Co']], 'a company both passes return is kept once')
  assert.deepEqual(asked, [undefined, ['A Co', 'B Co']])
  asked.length = 0
  const tight = await runDiscovery({ query: 'q' }, { maxUsd: 0.6 }, { apiKey: 'k', fetch: proofJudge, discover, enrich: null })
  assert.deepEqual([tight.passes, tight.usd], [1, 0.4], 'no room for a second pass: the first stands')
})

// Review of #1596: a profile address from the FIRST pass went to the card unchecked. It is held to the same rule as the people pass:
// the run must have seen that address, in a result or page whose title carries the person's name; otherwise it is dropped and the
// people pass looks for the profile. A profile with no named person is never kept for whoever is found later.
test('#1037: a first-pass LinkedIn profile is kept only when the run saw it for that person', async () => {
  const withProfile = (company: string, slug: string) => lead(company, { person: 'Dana Ruiz', title: 'Owner', person_source_url: 'https://x.example/team', linkedin_url: `https://www.linkedin.com/in/${slug}/` })
  const first: DiscoverResult = result([withProfile('A Co', 'dana-ruiz-a'), withProfile('B Co', 'dana-ruiz-made-up'), lead('C Co', { linkedin_url: 'https://www.linkedin.com/in/somebody/' })], 0.3)
  first.seen.push({ url: 'https://www.linkedin.com/in/dana-ruiz-a', title: 'Dana Ruiz - Owner - A Co | LinkedIn', page_age: null, text: null })
  first.seen.push({ url: 'https://www.linkedin.com/in/somebody', title: 'Somebody Else | LinkedIn', page_age: null, text: null })
  const sent: (string | null)[][] = []
  const run = await runDiscovery({ query: 'q' }, { maxUsd: 1, wantShown: 1 }, { apiKey: 'k', fetch: proofJudge, discover: async () => first,
    enrich: async leads => { sent.push(leads.map(l => l.linkedin_url)); return { leads: leads.map(l => l.company === 'C Co' ? { ...l, person: 'Pat Lee', title: 'Owner', person_source_url: 'https://c.example/team' } : l), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 1, usd: 0.01 }, seen: [], enriched: 1 } } })
  const of = (c: string) => run.leads.find(l => l.company === c)!
  assert.equal(of('A Co').linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-a/', 'seen for this person: kept')
  assert.equal(of('B Co').linkedin_url, null, 'an address the run never saw is dropped')
  assert.deepEqual([of('C Co').person, of('C Co').linkedin_url], ['Pat Lee', null], 'a profile that came with no person is not attached to the person found later')
  assert.ok(sent[0].every(u => u === null || u === 'https://www.linkedin.com/in/dana-ruiz-a/'), 'the people pass is asked to find the dropped ones')
})

// Owner, 2026-11-24, after the free-search benchmark on staging (39 leads, 10 of them in review with no people pass): leads that wait
// for review get the people pass too, after the shown ones, and a lead whose proof page is gone gets none.
test('the people pass: shown leads keep their place ahead of leads in review, the limit is passed on, and a gone proof page gets no call', async () => {
  const sent: { companies: string[]; maxLeads: number | undefined }[] = []
  const gone = lead('Gone Co')
  const first: DiscoverResult = { ...result([lead('Review Co'), lead('A Co'), gone, lead('B Co')], 0.3, ['Review Co']) }
  first.seen = first.seen.map(p => p.url === gone.evidence_url ? { ...p, text: 'Gone Co. Job not found.' } : p)
  const run = await runDiscovery({ query: 'q' }, { maxUsd: 0.5, enrichLeads: 6 }, { apiKey: 'k', fetch: never, judge: null,
    discover: async () => first,
    enrich: async (leads, o) => { sent.push({ companies: leads.map(l => l.company), maxLeads: o.maxLeads }); return { leads: leads.map(l => ({ ...l, person: 'Pat Lee', title: 'Owner', person_source_url: 'https://x.example/team' })), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 3, usd: 0.03 }, seen: [], enriched: leads.length } } })
  assert.equal(run.passes, 1, 'no room for a second search pass at this budget')
  assert.deepEqual(sent, [{ companies: ['A Co', 'B Co', 'Review Co'], maxLeads: 4 }], 'shown first, then the lead in review; never the one whose proof is gone. US$0.20 is left of US$0.50, which pays for 4 leads at the worst case, fewer than the limit of 6')
  const by = (c: string) => run.leads.find(l => l.company === c)!
  assert.equal(by('Gone Co').proof, 'gone')
  assert.equal(by('Gone Co').person, null)
  assert.equal(by('Review Co').person, 'Pat Lee')
  assert.equal(by('A Co').person, 'Pat Lee')
})

// Review of PR #1690: a run that has spent its ceiling starts no people pass, and one with a little left takes only what that pays for.
test('the people pass never starts past the run\'s ceiling, and takes no more leads than the money left pays for', async () => {
  const sent: (number | undefined)[] = []
  const enrich = async (leads: DiscoveredLead[], o: { maxLeads?: number }) => { sent.push(o.maxLeads); return { leads, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 0, requests: 0, usd: 0 }, seen: [], enriched: 0 } }
  const five = ['A Co', 'B Co', 'C Co', 'D Co', 'E Co'].map(n => lead(n))
  // the smallest free search: US$0.24 to spend, US$0.23 already spent by the search
  await runDiscovery({ query: 'q' }, { maxUsd: 0.24, enrichLeads: 2 }, { apiKey: 'k', fetch: never, judge: null, discover: async () => result(five, 0.23), enrich })
  assert.deepEqual(sent, [], 'one cent left pays for no lead: no pass, so the run cannot settle past its reservation')
  await runDiscovery({ query: 'q' }, { maxUsd: 0.24, enrichLeads: 2 }, { apiKey: 'k', fetch: never, judge: null, discover: async () => result(five, 0.19), enrich })
  assert.deepEqual(sent, [1], 'five cents left pays for one lead')
  await runDiscovery({ query: 'q' }, { maxUsd: 1, enrichLeads: 6 }, { apiKey: 'k', fetch: never, judge: null, discover: async () => result(five, 0.3), enrich })
  assert.deepEqual(sent, [1, 6], 'with room to spare the run\'s own limit applies')
})
