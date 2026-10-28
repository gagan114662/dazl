// A page that names a DIFFERENT city of India / the UAE / the Gulf than the one asked for is a place conflict, not "unconfirmed". Pure; invented businesses.
import test from 'node:test'
import assert from 'node:assert/strict'
import { placeAgreement } from '../lib/scan/place-agreement.ts'

const v = (where: string, text: string) => placeAgreement(text, [where], text.split(',')[0])
test('Gurugram: the asked city agrees; every other listed city (Delhi, Mumbai, Bengaluru, Dubai, Doha...) is a mismatch', () => {
  assert.equal(v('Gurugram, India', 'Sky Realty, a commercial broker in Gurugram, Haryana, leased space in Cyber City'), 'agrees')
  assert.equal(v('Gurugram, India', 'Sky Realty, a commercial broker in Gurgaon, leased space'), 'agrees')
  for (const c of ['Mumbai, Maharashtra', 'Delhi', 'New Delhi', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Dubai', 'Abu Dhabi', 'Doha, Qatar', 'Riyadh']) assert.equal(v('Gurugram, India', `Sky Realty, a commercial broker in ${c}, leased space`), 'mismatch', c)
  assert.equal(v('Gurugram, India', 'Sky Realty has offices in Mumbai and Gurugram'), 'agrees', 'naming the asked city beside another still agrees')
  assert.notEqual(v('Gurugram, India', 'Sky Realty, a Delhi NCR commercial broker, leased space'), 'mismatch', 'Delhi NCR is the region around the asked city')
})
test('Delhi / Bengaluru / Mumbai: alternate names are the same place', () => {
  assert.equal(v('Delhi, India', 'Sky Realty, a broker in New Delhi, leased space'), 'agrees')
  assert.notEqual(v('Bengaluru, India', 'Sky Realty, a broker in Bangalore, leased space'), 'mismatch'); assert.equal(v('Bengaluru, India', 'Sky Realty, a broker in Chennai, leased space'), 'mismatch')
  assert.notEqual(v('Mumbai, India', 'Sky Realty, a broker in Bombay, leased space'), 'mismatch'); assert.equal(v('Mumbai, India', 'Sky Realty, a broker in Pune, leased space'), 'mismatch')
})
test('Dubai: Abu Dhabi, Sharjah and Doha-as-another-country are mismatches; Dubai agrees', () => {
  assert.equal(v('Dubai, UAE', 'Gulf Freight opened a warehouse in Jebel Ali, Dubai'), 'agrees')
  for (const c of ['Abu Dhabi', 'Sharjah', 'Doha, Qatar', 'Riyadh, Saudi Arabia', 'Mumbai']) assert.equal(v('Dubai, UAE', `Gulf Freight opened a warehouse in ${c}`), 'mismatch', c)
  assert.equal(v('Abu Dhabi, UAE', 'Gulf Freight opened a warehouse in Dubai'), 'mismatch')
})
test('NOT widened: a country-level ask accepts any of its cities; a request elsewhere is untouched; a page naming no city is still unconfirmed', () => {
  assert.notEqual(v('India', 'Sky Realty, a broker in Mumbai, leased space'), 'mismatch'); assert.notEqual(v('UAE', 'Gulf Freight opened a warehouse in Sharjah'), 'mismatch')
  assert.notEqual(v('Toronto, Canada', 'Maple Marketing, a Mumbai agency, serves Toronto clients'), 'mismatch', 'Toronto named: agrees'); assert.equal(v('Toronto, Canada', 'Maple Marketing opened an office in Toronto'), 'agrees')
  assert.equal(v('Gurugram, India', 'Sky Realty leased 50,000 sq ft of office space this month'), 'unconfirmed')
  assert.equal(v('London, UK', 'Sky Realty, a Mumbai broker, opened an office in London'), 'agrees')
})
