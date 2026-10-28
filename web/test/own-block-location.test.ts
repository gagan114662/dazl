// Location is judged on the candidate's OWN block of a page, and contacts attach only on domain or location agreement. Stubbed, invented data, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownBlock, ownPlaceAgreement } from '../lib/scan/own-block.ts'
import { contactAgreement } from '../lib/scan/contact-agreement.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const LONDON = ['London']
const ROUNDUP = (extra = '') => ({
  title: 'Seed round-up: who raised this week',
  text: `Posted ${day(5)}. Brightloop raised a $3M seed round to build sales tooling for London retailers. Our office is at 12 Hoxton Square, London N1 6NU. Acme Dental raised a $2M seed round for its Manchester, England clinics. Visit us at 4 King Street, Manchester M2 4LQ. ${extra} ${'Founders shared what is next. '.repeat(8)}`,
  retrievedAt: 1,
})
const cand = (company: string, excerpt: string) => ({ name: '', company, contact: null, signal: 'seed round', source_url: 'https://news.example/roundup', score: 70, excerpt, event_date: day(5) })
const run = (c: ReturnType<typeof cand>, page = ROUNDUP()) => verifyLeads([c], async () => page, new Date(), undefined, null, undefined, undefined, LONDON)

test('own block: only the sentences naming the company (and the own-address sentence that continues them)', () => {
  const p = ROUNDUP()
  const b = ownBlock(p.text, 'Brightloop', p.title)!
  assert.match(b, /Hoxton Square/); assert.doesNotMatch(b, /Manchester/)
  assert.equal(ownBlock(p.text, 'Zenith Labs', p.title), null, 'a company the page never names has no block')
  assert.equal(ownBlock(p.text, 'Brightloop', 'Brightloop raises seed'), p.text, 'a page titled with the company is about that company alone')
})

test('multi-company page: each candidate is judged on its own place, not the neighbour\'s', async () => {
  const bright = await run(cand('Brightloop', 'Brightloop raised a $3M seed round to build sales tooling for London retailers'))
  assert.equal(bright.leads.length, 1, 'the Manchester neighbour on the same page does not hold the London company')
  const acme = await run(cand('Acme Dental', 'Acme Dental raised a $2M seed round for its Manchester, England clinics'))
  assert.equal(acme.leads.length, 0); assert.equal(acme.review[0].review_reason, 'location_mismatch', 'a real mismatch of its OWN block stays held with the reason')
})

test('multi-company page: a company whose own sentence names no place is unconfirmed, never mismatched by a neighbour\'s city', () => {
  const page = { title: 'Seed round-up', text: 'Northwind raised a $1M seed round. Acme Dental is based in Manchester, England. Bristol Labs raised a seed round in Bristol, England.', retrievedAt: 1 }
  assert.equal(ownPlaceAgreement(page, LONDON, 'Northwind'), 'unconfirmed')
  assert.equal(ownPlaceAgreement(page, LONDON, 'Acme Dental'), 'mismatch')
  assert.equal(ownPlaceAgreement(page, [], 'Acme Dental'), 'no_geography')
})

test('contact: a same-name practice in another city is refused; a matching domain or place attaches', () => {
  const lead = { company_domain: 'dentblanche.com', where: ['New York City'] }
  const wrong = contactAgreement({ company_domain: null, where: ['New York City'] }, { place: 'Pico Rivera, CA' })
  assert.equal(wrong.ok, false); assert.match((wrong as { reason: string }).reason, /location mismatch Pico Rivera, CA vs New York, NY/)
  assert.deepEqual(contactAgreement(lead, { domain: 'www.dentblanche.com', place: 'Pico Rivera, CA' }), { ok: true, via: 'domain' }, 'the agreeing domain is the identity')
  const other = contactAgreement(lead, { domain: 'dentblanche-ca.com', place: 'New York, NY' })
  assert.equal(other.ok, false); assert.match((other as { reason: string }).reason, /domain mismatch/)
  assert.deepEqual(contactAgreement({ company_domain: null, where: ['New York City'] }, { place: 'Brooklyn, NY' }), { ok: true, via: 'location' })
  const none = contactAgreement({ company_domain: null, where: ['New York City'] }, {})
  assert.equal(none.ok, false); assert.match((none as { reason: string }).reason, /no domain or location/)
})

test('Instinct audit controls: another company\'s city on the same page never decides this company; wrong-city same-name and third-party addresses still hold', () => {
  const pg = (text: string, title = 'Startup funding round-up') => ({ title, text, retrievedAt: 1 })
  assert.equal(ownPlaceAgreement(pg('Obsero is based in London, UK. Other company: Revnu is based in Manchester, UK.'), ['London', 'UK'], 'Obsero'), 'agrees')
  assert.equal(ownPlaceAgreement(pg('Obsero is based in London, UK. Other company: Revnu is based in Manchester, UK.'), ['London', 'UK'], 'Revnu'), 'mismatch', 'the neighbour is judged on ITS block and is held')
  const aggregate = 'Opply, the London-based marketplace, closed an undisclosed round. Our office is at 1 Canal Way, London E2 7DJ. Fieldwork raised a seed round at its Macclesfield, UK base.'
  assert.equal(ownPlaceAgreement(pg(aggregate), ['London', 'UK'], 'Opply'), 'agrees', 'Macclesfield belongs to Fieldwork')
  // wrong-city same-name: the company\'s OWN block names another place -> still held
  assert.equal(ownPlaceAgreement(pg('Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660. Other clinic: Smile Studio, 57 W 57th St, New York, NY 10019.'), ['New York City'], 'Dent Blanche'), 'mismatch')
  assert.equal(ownPlaceAgreement(pg('Smile Studio, 57 W 57th St, New York, NY 10019. Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660.'), ['New York City'], 'Smile Studio'), 'agrees')
  // third-party address inside the company's own sentence is not its address
  assert.notEqual(ownPlaceAgreement(pg('Brightloop uses a supplier whose address is London EC1V 9HX. Brightloop is headquartered in Leeds, UK.'), ['London'], 'Brightloop'), 'agrees')
})

test('Pico Rivera regression: a same-name Dent Blanche practice in Pico Rivera, CA is not attached to the New York lead, on a mixed page or a contact record', async () => {
  const NYC = ['New York City']
  const page = { title: 'Dental practices expanding', text: `Posted ${day(5)}. Dent Blanche is opening a second location on West 57th Street. Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660 offers family dentistry. Smile Studio, 57 W 57th St, New York, NY 10019 also welcomes patients. ${'The practice welcomes families. '.repeat(8)}`, retrievedAt: 1 }
  const c = { name: '', company: 'Dent Blanche', contact: null, signal: 'second location', source_url: 'https://news.example/db', score: 70, excerpt: 'Dent Blanche is opening a second location on West 57th Street', event_date: day(5) }
  const r = await verifyLeads([c], async () => page, new Date(), undefined, null, undefined, undefined, NYC)
  assert.equal(r.leads.length, 0, 'the page also places a same-name Dent Blanche in Pico Rivera, and no New York address is bound to it: held, not attached'); assert.equal(r.review[0].review_reason, 'location_mismatch')
  const pico = await verifyLeads([{ ...c, excerpt: 'Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660 offers family dentistry' }], async () => page, new Date(), undefined, null, undefined, undefined, NYC)
  assert.equal(pico.leads.length, 0); assert.equal(pico.review[0].review_reason, 'location_mismatch')
  const contact = contactAgreement({ company_domain: null, where: NYC }, { place: 'Pico Rivera, CA' })
  assert.equal(contact.ok, false); assert.match((contact as { reason: string }).reason, /location mismatch Pico Rivera, CA vs New York, NY/)
})
