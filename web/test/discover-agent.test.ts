// The Claude discovery loop's own code: reading the model's answer into lead records, pricing a run, and labelling a lead
// from its proof page. Invented companies and pages only; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLeads, usd } from '../lib/discover/agent.ts'
import { checkLead, companyOnPage, dayOnPage } from '../lib/discover/check.ts'

const lead = (o: Record<string, unknown> = {}) => ({ company: 'Northwind Dental', domain: 'https://www.northwind-dental.example/about', signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind-second-clinic', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://www.northwind-dental.example/team', linkedin_url: 'https://www.linkedin.com/in/dana-ruiz/', confidence: 'high', why: 'expanding', ...o })

test('parseLeads: reads the <json> answer, normalises the domain and keeps only records with a company, a signal and a proof URL', () => {
  const text = `Here you go.\n<json>${JSON.stringify({ leads: [lead(), lead({ company: 'No Proof Co', evidence_url: 'not a url' }), lead({ company: '', signal: 'x' }), lead({ company: 'northwind dental' })], note: 'only one fit' })}</json>`
  const r = parseLeads(text, 10)
  assert.equal(r.leads.length, 1, 'no proof URL, no company, and a repeat of the same company are dropped')
  assert.equal(r.leads[0].domain, 'northwind-dental.example')
  assert.equal(r.leads[0].signal_date, '2026-10-14')
  assert.equal(r.note, 'only one fit')
})

test('parseLeads: a made-up date shape, a non-LinkedIn "LinkedIn" link and person fields without a person are not kept', () => {
  const r = parseLeads(JSON.stringify({ leads: [lead({ signal_date: 'October 2026', linkedin_url: 'https://evil.example/in/dana', person: null, title: 'Owner', confidence: 'certain' })] }), 10)
  assert.equal(r.leads[0].signal_date, null)
  assert.equal(r.leads[0].linkedin_url, null)
  assert.equal(r.leads[0].title, null, 'a title with no named person is dropped')
  assert.equal(r.leads[0].confidence, 'medium', 'an unknown confidence word falls back to medium')
})

test('parseLeads: an unreadable answer is zero leads with a note, and the cap is honoured', () => {
  assert.deepEqual(parseLeads('sorry, nothing', 10), { leads: [], note: 'unreadable answer' })
  const many = { leads: Array.from({ length: 30 }, (_, i) => lead({ company: `Co ${i}` })) }
  assert.equal(parseLeads(JSON.stringify(many), 10).leads.length, 10)
})

test('usd: tokens at list price plus searches', () => {
  assert.equal(usd({ input_tokens: 100_000, output_tokens: 5_000, cache_read_tokens: 0, cache_write_tokens: 0, searches: 6, requests: 1 }), 0.56)
})

test('companyOnPage and dayOnPage label the proof; they tolerate case, accents and date styles', () => {
  assert.equal(companyOnPage('Northwind Dental', 'This week NORTHWIND DENTAL announced'), true)
  assert.equal(companyOnPage('Café Río Group', 'the cafe rio group opened'), true)
  assert.equal(companyOnPage('Northwind Dental', 'Southwind Dental announced'), false)
  assert.equal(dayOnPage('2026-10-14', 'Published 14 October 2026'), true)
  assert.equal(dayOnPage('2026-10-14', 'Published in 2025'), false)
  assert.equal(dayOnPage(null, 'anything 2026'), false)
})

test('checkLead: confirmed when the page names the company; a page that does not, or cannot be read, is labelled and still returned', async () => {
  const page = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
  const ok = await checkLead(parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0], page('<html><body><p>14 October 2026</p><p>Northwind Dental will open its second clinic in the spring.</p></body></html>'))
  assert.deepEqual([ok.proof, ok.quote_on_page, ok.date_on_page], ['confirmed', true, true])
  const other = await checkLead(parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0], page('<p>Unrelated story</p>'))
  assert.equal(other.proof, 'company_not_on_page')
  const gone = await checkLead(parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0], page('nope', 404))
  assert.equal(gone.proof, 'unreadable')
  const local = await checkLead({ ...ok, evidence_url: 'http://127.0.0.1/admin' }, (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch)
  assert.equal(local.proof, 'unreadable', 'a private address is never fetched')
})
