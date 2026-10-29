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

// Review fix (#342): an explicit company-bound headquarters in another listed city beats country overlap and incidental alias mentions.
import { placeAgreement as pa342 } from '../lib/scan/place-agreement.ts'
import { test as t342 } from 'node:test'
import assert342 from 'node:assert/strict'
t342('#342 city+country request: Mumbai HQ is a mismatch for Gurugram, India', () => assert342.equal(pa342('Orbitly is based in Mumbai, India.', ['Gurugram, India'], 'Orbitly'), 'mismatch'))
t342('#342 city+country request: Abu Dhabi HQ is a mismatch for Dubai, UAE', () => assert342.equal(pa342('Orbitly is based in Abu Dhabi, UAE.', ['Dubai, UAE'], 'Orbitly'), 'mismatch'))
t342('#342 incidental alias mention (conference in Gurgaon) does not erase a Mumbai HQ', () => assert342.equal(pa342('Orbitly is based in Mumbai. We attended a conference in Gurgaon.', ['Gurugram'], 'Orbitly'), 'mismatch'))
t342('#342 first-person competing HQ also wins', () => assert342.equal(pa342('Our headquarters is in Pune, India. Founder spoke at an event in Gurgaon.', ['Gurugram, India'], 'Orbitly'), 'mismatch'))
t342('#342 positive: genuine alias HQ still agrees', () => assert342.equal(pa342('Orbitly is based in Gurgaon, India.', ['Gurugram'], 'Orbitly'), 'agrees'))
t342('#342 positive: bound asked city plus a later other-city mention agrees', () => assert342.equal(pa342('Orbitly is based in Gurgaon, with a sales office in Mumbai.', ['Gurugram, India'], 'Orbitly'), 'agrees'))
t342('#342 country-only request accepts any listed city', () => assert342.equal(pa342('Orbitly is based in Mumbai, India.', ['India'], 'Orbitly'), 'agrees'))
t342('#342 unbound other-city mention is not a conflict', () => assert342.equal(pa342('Orbitly, Gurugram, India. Our customer Acme is based in Mumbai.', ['Gurugram, India'], 'Orbitly'), 'agrees'))

// Review fix 2 (#342): the country token must not stand in for the city. Normal headquarters / appositive wording, not one word per example.
for (const [name, text] of [['headquartered', 'Orbitly is headquartered in Mumbai, India.'], ['hyphen adjective', 'Orbitly is a Mumbai-based startup in India.'], ['appositive', 'Orbitly, a Mumbai startup, raised a seed round in India.']] as const)
  t342(`#342 city+country request: ${name} wording in another city is a mismatch`, () => assert342.equal(pa342(text, ['Gurugram, India'], 'Orbitly'), 'mismatch'))
t342('#342 UAE: Abu Dhabi appositive does not agree with Dubai via the UAE token', () => assert342.equal(pa342('Orbitly, an Abu Dhabi startup, expanded across the UAE.', ['Dubai, UAE'], 'Orbitly'), 'mismatch'))
t342('#342 country-only request still accepts a headquartered city', () => assert342.equal(pa342('Orbitly is headquartered in Mumbai, India.', ['India'], 'Orbitly'), 'agrees'))
t342('#342 requested city + country wording agrees', () => assert342.equal(pa342('Orbitly is a Gurgaon-based startup in India.', ['Gurugram, India'], 'Orbitly'), 'agrees'))
t342('#342 company office in the requested city beside another HQ city still agrees', () => assert342.equal(pa342('Orbitly, a Mumbai startup, opened an office in Gurugram, India.', ['Gurugram, India'], 'Orbitly'), 'agrees'))
