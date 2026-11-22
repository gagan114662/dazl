// The Claude discovery loop's own code: reading the model's answer into lead records, pricing a run, and labelling a lead
// from its proof page. Invented companies and pages only; no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLeads, usd } from '../lib/discover/agent.ts'
import { checkLead, companyOnPage, dayOnPage, isShown } from '../lib/discover/check.ts'

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

test('checkLead: the text Claude read decides first, then the read by dazl, then the search results; a URL the run never saw is unseen', async () => {
  const page = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
  const never = (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch
  const l = parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0]
  const read = await checkLead(l, [{ url: 'https://www.news.example/northwind-second-clinic/', title: 't', page_age: 'October 14, 2026', text: 'On 14 October 2026 Northwind Dental will open its second clinic.' }], never)
  assert.deepEqual([read.proof, read.proof_read_by, read.quote_on_page, read.date_on_page, read.page_age], ['confirmed', 'reader', true, true, 'October 14, 2026'], 'www. and a trailing slash are the same page')
  const ours = await checkLead(l, [], page('<html><body><p>14 October 2026</p><p>Northwind Dental will open its second clinic in the spring.</p></body></html>'))
  assert.deepEqual([ours.proof, ours.proof_read_by], ['confirmed', 'dazl'])
  assert.equal((await checkLead(l, [], page('<p>Unrelated story</p>'))).proof, 'company_not_on_page')
  const listed = await checkLead(l, [{ url: l.evidence_url, title: 'Northwind Dental to open second clinic', page_age: null, text: null }], page('blocked', 403))
  assert.deepEqual([listed.proof, isShown(listed)], ['listed', true])
  const unseen = await checkLead(l, [{ url: 'https://news.example/other', title: 'Northwind Dental', page_age: null, text: null }], page('blocked', 403))
  assert.deepEqual([unseen.proof, isShown(unseen)], ['unseen', false], 'a proof URL the run never saw and nobody can read is not shown')
  assert.equal((await checkLead({ ...l, evidence_url: 'http://127.0.0.1/admin' }, [], never)).proof, 'unseen', 'a private address is never fetched')
})
