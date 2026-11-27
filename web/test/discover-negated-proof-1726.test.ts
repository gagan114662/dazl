import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLeads } from '../lib/discover/agent.ts'
import { checkLead, isShown } from '../lib/discover/check.ts'

const company = 'Orchard Workshop'
const evidence_url = 'https://fixture.example/post'

for (const { signal, quote, shown } of [
  { signal: 'Evaluating scheduling tools', quote: 'stopped evaluating scheduling tools.', shown: false },
  { signal: 'Evaluating scheduling tools', quote: 'discontinued evaluating scheduling tools.', shown: false },
  { signal: 'Valuta strumenti di pianificazione', quote: 'non valuta strumenti di pianificazione.', shown: false },
  { signal: 'تقيّم أدوات التخطيط الرقمي', quote: 'لا تقيّم أدوات التخطيط الرقمي.', shown: false },
  { signal: 'Expansion of cold storage', quote: 'announced the expansion of cold storage.', shown: true },
  { signal: 'Evaluating scheduling tools', quote: 'is evaluating scheduling tools.', shown: true },
  { signal: 'Evaluating scheduling tools', quote: 'discusses scheduling tools.', shown: false },
  { signal: 'Evalúa herramientas de planificación', quote: 'no evalúa herramientas de planificación.', shown: false },
  { signal: 'Évalue des outils de planification', quote: 'n’évalue pas des outils de planification.', shown: false },
]) {
  test(`#1726 proof decision for “${quote}”`, async () => {
    const statement = `${company} ${quote}`
    const [lead] = parseLeads(JSON.stringify({ leads: [{ company, signal, evidence_url, evidence_quote: statement }] }), 1).leads
    assert.ok(lead)
    const judgments: string[][] = []
    const fetchPage = async () => new Response(`<p>${statement}</p>`)
    const checked = await checkLead(lead, [], fetchPage, undefined, new Date(), async (_signal, _company, statements) => {
      judgments.push(statements)
      return shown
    })
    assert.deepEqual(judgments, [[statement]])
    assert.equal(isShown(checked), shown)
  })
}


test('#1726 an unread result headline cannot establish the signal', async () => {
  const signal = 'Expansion of cold storage'
  const title = `${company} announced the expansion of cold storage`
  const [lead] = parseLeads(JSON.stringify({ leads: [{ company, signal, evidence_url, evidence_quote: title }] }), 1).leads
  assert.ok(lead)
  const checked = await checkLead(lead, [{ url: evidence_url, title, text: null, page_age: null }],
    async () => new Response(null, { status: 403 }), undefined, new Date(), async () => assert.fail('unread proof is ineligible'))
  assert.equal(checked.quote_on_page, false)
  assert.equal(checked.signal_seen, false)
  assert.equal(isShown(checked), false)
})

test('#1726 judge budget and cache are isolated per scan', async () => {
  const { runDiscovery } = await import('../lib/discover/run.ts')
  const claim = 'Opening a second warehouse'
  const fixture = (host: string, company: string) => {
    const url = `https://${host}.example/`
    const quote = `${company} is opening a second warehouse.`
    const [lead] = parseLeads(JSON.stringify({ leads: [{
      company, signal: claim, evidence_url: url, evidence_quote: quote,
    }] }), 1).leads
    assert.ok(lead)
    return { lead, seen: { url, title: company, text: quote, page_age: null } }
  }
  const a = fixture('first', 'Example Cooperative')
  const b = fixture('second', 'Another Workshop')
  const scan = async () => {
    const usage = { requests: 0, usd: 0 }
    const result = await runDiscovery({ query: claim }, { maxUsd: 0.002, wantShown: 0 }, {
      apiKey: 'synthetic-test-key', enrich: null,
      discover: async () => ({
        leads: [a.lead, a.lead, b.lead], seen: [a.seen, b.seen],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0, searches: 0, requests: 0 },
        stop: 'end_turn', note: null, model: 'claude-sonnet-5-5',
      }),
      judge: { usage, ask: async () => { usage.requests++; usage.usd += 0.001; return true } },
    })
    assert.equal(usage.requests, 1)
    assert.equal(result.usd, 0.001)
    assert.equal(result.requests, 1)
    assert.deepEqual(result.leads.map(isShown), [true, true, false])
    assert.equal(Reflect.get(result.leads[2], 'proof_check'), 'spend_cap')
  }
  await scan()
  await scan()
})

test('#1726 a readable employer alternate uses the same judge', async () => {
  const { runDiscovery } = await import('../lib/discover/run.ts')
  const source = 'https://ca.indeed.com/viewjob?jk=fixture'
  const employer = 'https://workshop.example/careers/operator'
  const company = 'Example Workshop'
  const claim = 'Hiring a machine operator'
  const quote = `${company} is hiring a machine operator`
  const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const [lead] = parseLeads(JSON.stringify({ leads: [{
    company, domain: 'workshop.example', signal: claim, signal_date: date, evidence_url: source,
    evidence_quote: quote, alternate_evidence: { url: employer, quote, date },
  }] }), 1).leads
  assert.ok(lead)
  const seen = [source, employer].map(url => ({ url, title: quote, text: null, page_age: null }))
  const usage = { requests: 0, usd: 0 }
  const result = await runDiscovery({ query: claim }, { maxUsd: 0.1, wantShown: 0 }, {
    apiKey: 'synthetic-test-key', enrich: null,
    discover: async () => ({
      leads: [lead], seen, usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, usd: 0.04, searches: 0, requests: 0 },
      stop: 'end_turn', note: null, model: 'claude-sonnet-5-5',
    }),
    fetch: async url => String(url) === employer
      ? new Response(`<p>${quote}; no prior experience required.</p><p>Posted on ${date}.</p>`)
      : new Response(null, { status: 403 }),
    judge: { usage, ask: async (_claim, _company, statements, page) => {
      assert.match(page ?? '', /^workshop\.example/)
      assert.match(statements.join(' '), /hiring a machine operator/)
      usage.requests++
      return true
    } },
  })
  assert.equal(usage.requests, 1)
  assert.deepEqual([result.leads[0].evidence_url, isShown(result.leads[0])], [employer, true])
})
