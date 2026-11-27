import assert from 'node:assert/strict'
import test from 'node:test'
import { checkLead } from '../lib/discover/check.ts'
import type { DiscoveredLead } from '../lib/discover/agent.ts'

const day = '2026-11-20'
const now = new Date('2026-11-26T12:00:00Z')

async function checked(company: string, signal: string, html: string, signalDate: string | null = day) {
  const lead: DiscoveredLead = {
    company, signal, signal_date: signalDate, evidence_quote: signal,
    evidence_url: 'https://news.example/announcement', domain: null, person: null, title: null,
    person_source_url: null, linkedin_url: null, email: null, email_source_url: null,
    confidence: 'high', why: '',
  }
  const result = await checkLead(lead, [], async () => new Response(html), 100, now)
  assert.equal(result.proof, 'confirmed')
  assert.equal(result.signal_seen, true)
  return [result.date, result.date_source, result.date_on_page]
}

test('#1910: an archive sidebar date does not bind to an undated expansion announcement', async () => {
  const company = 'Northwind Dental'
  const signal = 'Northwind Dental announced a second clinic.'
  assert.deepEqual(await checked(company, signal, `<main><p>${signal}</p></main><aside>Archive issue: 20 November 2026</aside>`), [null, null, false])
})

test('#1910: a date in the announcement clause binds to the expansion', async () => {
  const company = 'Maple Freight'
  const signal = 'Maple Freight announced a second depot.'
  assert.deepEqual(await checked(company, signal, `<p>On 20 November 2026, ${signal}</p>`), [day, 'page', true])
})

test('#1910: a date in a French announcement clause also binds', async () => {
  const company = 'Atelier Lumière'
  const signal = 'Atelier Lumière annonce une deuxième usine.'
  assert.deepEqual(await checked(company, signal, `<p>Le 2026-11-20, ${signal}</p>`), [day, 'page', true])
})

test('#1910: the explicit posting date still binds for a hiring lead', async () => {
  const company = 'Harbor Bakery'
  const signal = 'Harbor Bakery is hiring a pastry chef.'
  assert.deepEqual(await checked(company, signal, `<p>Posted: 20 November 2026</p><p>${signal}</p>`, null), [day, 'page', true])
})

test('#1910: an archive publication age cannot date an undated expansion', async () => {
  const company = 'Northwind Dental'
  const signal = 'Northwind Dental announced a second clinic.'
  assert.deepEqual(await checked(company, signal, `<main><p>${signal}</p></main><aside>Archive issue: 20 November 2026. Published 6 days ago</aside>`), [null, null, false])
})

test('#1910: a relative day in the announcement binds to the event', async () => {
  const company = 'Maple Freight'
  const signal = 'Maple Freight announced a second depot.'
  assert.deepEqual(await checked(company, signal, `<p>6 days ago, ${signal}</p>`, null), [day, 'page', false])
})

test('#1910: a relative day in a French announcement binds to the event', async () => {
  const company = 'Atelier Lumière'
  const signal = 'Atelier Lumière annonce une deuxième usine.'
  assert.deepEqual(await checked(company, signal, `<p>Il y a 6 jours, ${signal}</p>`, null), [day, 'page', false])
})

test('#1910: a hiring posting still keeps its relative posting day', async () => {
  const company = 'Harbor Bakery'
  const signal = 'Harbor Bakery is hiring a pastry chef.'
  assert.deepEqual(await checked(company, signal, `<p>Posted: 6 days ago</p><p>${signal}</p>`, null), [day, 'page', false])
})
