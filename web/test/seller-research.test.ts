// #379: multi-page seller research. Synthetic site (invented company); stubbed fetch and model; no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, researchLinks, researchSeller, targetingFor, MAX_PAGES } from '../lib/scan/seller-research.ts'

const pad = (s: string) => `${s} ${'Our team builds reliable software for growing businesses and supports every customer. '.repeat(3)}`
const SITE: Record<string, string> = {
  'https://acme.example/': `<html><title>Acme</title><body><h1>${pad('Acme builds tools for modern teams.')}</h1><a href="/pricing">Pricing</a><a href="/customers">Customers</a><a href="/products/booking">Booking</a><a href="/products/payroll">Payroll</a><a href="https://other.example/x">Partner</a><a href="/logo.png">img</a><a href="mailto:a@acme.example">mail</a></body></html>`,
  'https://acme.example/pricing': `<html><body>${pad('Booking starts at $49 per location per month. Payroll is priced per employee for clinics with 10 to 50 staff.')}</body></html>`,
  'https://acme.example/customers': `<html><body>${pad('Case study: Harbor Dental, a four-chair dental practice, cut no-shows with Acme Booking. Case study: Elm Street Physio runs Acme Payroll for its 22 staff.')}</body></html>`,
  'https://acme.example/products/booking': `<html><body>${pad('Acme Booking lets practice managers fill their appointment book and send reminders.')}</body></html>`,
  'https://acme.example/products/payroll': `<html><body>${pad('Acme Payroll runs payroll for clinic owners without a finance team.')}</body></html>`,
}
const fetchHtml = async (u: string) => (SITE[u] !== undefined ? { html: SITE[u], finalUrl: u } : null)
const MODEL = JSON.stringify({
  offers: [{ id: 'o1', name: 'Acme Booking' }, { id: 'o2', name: 'Acme Payroll' }],
  items: [
    { offer: 'o1', kind: 'persona', text: 'practice managers', url: 'https://acme.example/products/booking', quote: 'lets practice managers fill their appointment book', inferred: false },
    { offer: 'o1', kind: 'industry', text: 'dental practices', url: 'https://acme.example/customers', quote: 'Harbor Dental, a four-chair dental practice', inferred: false },
    { offer: 'o1', kind: 'size', text: '10,000 employees', url: 'https://acme.example/pricing', quote: 'serves enterprises of 10,000 employees', inferred: false },   // not on the page
    { offer: 'o2', kind: 'persona', text: 'clinic owners', url: 'https://acme.example/products/payroll', quote: 'payroll for clinic owners without a finance team', inferred: false },
    { offer: 'o2', kind: 'persona', text: 'CFOs of hospital groups', url: 'https://acme.example/pricing', quote: 'built for hospital group CFOs', inferred: true },        // unsupported
    { offer: 'o2', kind: 'location', text: 'Texas', url: 'https://acme.example/pricing', quote: 'available across Texas', inferred: false },                // not on the page
    { offer: 'o9', kind: 'persona', text: 'ghost offer', url: 'https://acme.example/', quote: 'Acme builds tools for modern teams', inferred: false },    // unknown offer id
  ],
})
const calls: string[] = []
const run = () => researchSeller('https://acme.example/', { fetchHtml, complete: async p => { calls.push(p); return MODEL }, now: () => 1_800_000_000 })

test('the crawl is bounded and same-site: pricing, customers and product pages are read; offsite, files and mailto are not', async () => {
  const links = researchLinks(SITE['https://acme.example/'], 'https://acme.example/')
  assert.deepEqual(links.map(l => l.kind), ['pricing', 'customers', 'product', 'product']); assert.ok(links.length <= MAX_PAGES)
  assert.ok(links.every(l => l.url.startsWith('https://acme.example/')))
  const many = `<html>${Array.from({ length: 30 }, (_, i) => `<a href="/products/p${i}">Product ${i}</a>`).join('')}</html>`
  assert.equal(researchLinks(many, 'https://acme.example/').length, MAX_PAGES)
})

test('a multiproduct site whose homepage omits the buyer yields distinct, source-backed hypotheses per offer; unsupported claims are not facts', async () => {
  const r = await run(); assert.ok(!('error' in r)); if ('error' in r) return
  assert.deepEqual(r.offers.map(o => o.id), ['acme-booking', 'acme-payroll'], 'offer identity is the normalized name, never the positional ref'); assert.deepEqual(r.offers.map(o => o.name), ['Acme Booking', 'Acme Payroll']); assert.equal(r.pages.length, 5)
  assert.ok(calls[0].includes('PAGE 5') && calls[0].includes('/pricing') && !calls[0].includes('other.example'))
  const h = (id: string) => r.hypotheses.find(x => x.id === id)!
  const booking = r.hypotheses.find(x => x.offer === 'acme-booking' && x.kind === 'persona')!, pay = r.hypotheses.find(x => x.offer === 'acme-payroll' && x.kind === 'persona' && x.text === 'clinic owners')!
  assert.deepEqual([booking.status, booking.text, booking.url, booking.fetched_at], ['sourced', 'practice managers', 'https://acme.example/products/booking', 1_800_000_000])
  assert.deepEqual([pay.status, pay.url], ['sourced', 'https://acme.example/products/payroll']); assert.notEqual(booking.text, pay.text, 'distinct personas per offer')
  assert.equal(r.hypotheses.find(x => x.text === 'CFOs of hospital groups')!.status, 'hypothesis', 'an inferred persona is a hypothesis, not a fact')
  const size = r.hypotheses.find(x => x.kind === 'size')!, loc = r.hypotheses.find(x => x.kind === 'location')!
  assert.deepEqual([size.status, size.text, size.quote, loc.status, loc.text], ['unknown', 'unknown', null, 'unknown', 'unknown'], 'headcount and location without a quote on the page are unknown')
  assert.ok(!r.hypotheses.some(x => x.text === 'ghost offer'), 'an item for an unknown offer is dropped')
  assert.equal(h('acme-booking:offer').status, 'hypothesis')
})

test('at most one question, and only when the answer changes targeting', async () => {
  const r = await run() as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(r.question, null, 'every offer has a sourced buyer: nothing to ask')
  const noBuyer = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => JSON.stringify({ offers: [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }], items: [] }) }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(noBuyer.question, 'Which of your offers is this play for?')
  const one = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => JSON.stringify({ offers: [{ id: 'o1', name: 'A' }], items: [] }) }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(one.question, 'Who buys this?')
})

test('reviewed corrections change retrieval per offer and never leak across offers; unsupported items never become targeting', async () => {
  const r = await run() as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.deepEqual(targetingFor(r, 'acme-booking'), { who: ['practice managers'], industries: ['dental practices'], exclude: [], sizes: [], where: [] })
  assert.deepEqual(targetingFor(r, 'acme-payroll').who, ['clinic owners'], 'the hospital-CFO hypothesis is not targeting until a person confirms it')
  const hyp = r.hypotheses.find(x => x.text === 'CFOs of hospital groups')!
  const bookingPersona = r.hypotheses.find(x => x.offer === 'acme-booking' && x.kind === 'persona')!
  const fixed = applyCorrections(r, [{ offer: 'acme-payroll', hypothesis: hyp.id, action: 'confirm' }, { offer: 'acme-booking', hypothesis: bookingPersona.id, action: 'edit', value: 'front-desk leads' }, { offer: 'acme-booking', hypothesis: hyp.id, action: 'reject' }])
  assert.deepEqual(targetingFor(fixed, 'acme-payroll').who.sort(), ['CFOs of hospital groups', 'clinic owners'])
  assert.deepEqual(targetingFor(fixed, 'acme-booking').who, ['front-desk leads'], 'an edit is reviewed; the reject aimed at another offer item changed nothing here')
  const rej = applyCorrections(r, [{ offer: 'acme-booking', hypothesis: bookingPersona.id, action: 'reject' }])
  assert.deepEqual(targetingFor(rej, 'acme-booking').who, []); assert.deepEqual(targetingFor(rej, 'acme-payroll').who, ['clinic owners'])
  assert.equal(fixed.question, null)
})

test('a recrawl keeps stable offer and hypothesis identity, so reviewed corrections re-apply and never contaminate across offers', async () => {
  const first = await run() as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  const bookingPersona = first.hypotheses.find(x => x.offer === 'acme-booking' && x.kind === 'persona')!
  const cfo = first.hypotheses.find(x => x.text === 'CFOs of hospital groups')!
  const reviewed = applyCorrections(first, [{ offer: 'acme-booking', hypothesis: bookingPersona.id, action: 'edit', value: 'office managers' }, { offer: 'acme-payroll', hypothesis: cfo.id, action: 'confirm' }])
  // Recrawl: same site, the model returns the same statements in a DIFFERENT order with different positional refs.
  const shuffled = JSON.stringify({ offers: [{ id: 'x9', name: 'Acme Payroll' }, { id: 'x1', name: 'Acme Booking' }], items: [
    { offer: 'x1', kind: 'persona', text: 'practice managers', url: 'https://acme.example/products/booking', quote: 'lets practice managers fill their appointment book', inferred: false },
    { offer: 'x9', kind: 'persona', text: 'CFOs of hospital groups', url: 'https://acme.example/pricing', quote: 'built for hospital group CFOs', inferred: true },
    { offer: 'x9', kind: 'persona', text: 'clinic owners', url: 'https://acme.example/products/payroll', quote: 'payroll for clinic owners without a finance team', inferred: false },
    { offer: 'x1', kind: 'industry', text: 'dental practices', url: 'https://acme.example/customers', quote: 'Harbor Dental, a four-chair dental practice', inferred: false },
  ] })
  const second = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => shuffled, now: () => 1_800_000_100, prior: reviewed }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.deepEqual(second.offers.map(o => o.id).sort(), ['acme-booking', 'acme-payroll'], 'stable ids despite swapped order and different positional refs')
  const reBooking = second.hypotheses.find(x => x.id === bookingPersona.id)!
  assert.deepEqual([reBooking.status, reBooking.text], ['reviewed', 'office managers'], 'the edit re-applies to the same content-keyed hypothesis')
  const reCfo = second.hypotheses.find(x => x.id === cfo.id)!
  assert.equal(reCfo.status, 'reviewed', 'the confirm re-applies across the recrawl')
  assert.deepEqual(targetingFor(second, 'acme-booking').who, ['office managers']); assert.deepEqual(targetingFor(second, 'acme-payroll').who.sort(), ['CFOs of hospital groups', 'clinic owners'])
})

test('an answered question stays bound to its offer across recrawls and is never re-asked', async () => {
  const noBuyer = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Booking' }, { id: 'o2', name: 'Acme Payroll' }], items: [] })
  const first = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => noBuyer }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(first.question, 'Which of your offers is this play for?')
  const answered = { ...first, question: null, answered: { question: first.question!, offer: 'acme-booking' } }
  const second = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => noBuyer, prior: answered }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(second.question, null, 'the answered question is not re-asked')
  assert.deepEqual(second.answered, { question: 'Which of your offers is this play for?', offer: 'acme-booking' }, 'the binding persists while the offer exists')
  const gone = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Payroll' }], items: [] })
  const third = await researchSeller('https://acme.example/', { fetchHtml, complete: async () => gone, prior: answered }) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.deepEqual(third.answered, null, 'the binding lapses when its offer no longer exists')
})

test('failure modes: unreachable site, unreadable pages, bad model output', async () => {
  assert.deepEqual(await researchSeller('https://nope.example/', { fetchHtml: async () => null, complete: async () => '{}' }), { error: 'unreachable' })
  assert.deepEqual(await researchSeller('https://acme.example/', { fetchHtml: async () => ({ html: '<html><body>hi</body></html>', finalUrl: 'https://acme.example/' }), complete: async () => '{}' }), { error: 'unreadable' })
  assert.deepEqual(await researchSeller('https://acme.example/', { fetchHtml, complete: async () => 'not json' }), { error: 'model_failed' })
  assert.deepEqual(await researchSeller('https://acme.example/', { fetchHtml, complete: async () => '{"offers":[],"items":[]}' }), { error: 'model_failed' })
})
