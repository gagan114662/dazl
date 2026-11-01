// #379: multi-page seller research. Synthetic site (invented company); stubbed fetch and model; no network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCorrections, applyReviewedDraft, buildResearch, fromStored, jsonOnly, researchLinks, targetingFor, toStored, MAX_PAGES, type FetchedPage, type PageKind, type SellerResearch } from '../lib/scan/seller-research.ts'
import { extractSiteText } from '../lib/scan/icp-from-site.ts'

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
// The crawl harness the deleted researchSeller wrapper used to provide: the same pure steps (researchLinks +
// extractSiteText + the 80-char and page-text caps) feeding buildResearch directly. The production crawl lives in
// icpFromWebsite with its own tests; the behavioral contract under test here is buildResearch's.
const crawl = async (complete: (p: string) => Promise<string>, prior?: SellerResearch | null, now: () => number = () => 1_800_000_000) => {
  const home = await fetchHtml('https://acme.example/'); if (!home) return { error: 'unreachable' as const }
  const pages: FetchedPage[] = []
  const read = (h: { html: string; finalUrl: string }, kind: PageKind) => { const { title, text } = extractSiteText(h.html); if (text.length >= 80) pages.push({ url: h.finalUrl, kind, title, text: text.slice(0, 3500), fetched_at: now() }) }
  read(home, 'home')
  for (const l of researchLinks(home.html, home.finalUrl)) { const p = await fetchHtml(l.url); if (p) read(p, l.kind) }
  if (pages.length === 0) return { error: 'unreadable' as const }
  const prompt = pages.map((p, i) => `PAGE ${i + 1} ${p.url}`).join('\n')
  return buildResearch(jsonOnly(await complete(prompt)), pages, 'acme.example', prior)
}
const run = () => crawl(async p => { calls.push(p); return MODEL })

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
  const noBuyer = await crawl(async () => JSON.stringify({ offers: [{ id: 'o1', name: 'A' }, { id: 'o2', name: 'B' }], items: [] })) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(noBuyer.question, 'Which of your offers is this play for?')
  const one = await crawl(async () => JSON.stringify({ offers: [{ id: 'o1', name: 'A' }], items: [] })) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
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
  const second = await crawl(async () => shuffled, reviewed, () => 1_800_000_100) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.deepEqual(second.offers.map(o => o.id).sort(), ['acme-booking', 'acme-payroll'], 'stable ids despite swapped order and different positional refs')
  const reBooking = second.hypotheses.find(x => x.id === bookingPersona.id)!
  assert.deepEqual([reBooking.status, reBooking.text], ['reviewed', 'office managers'], 'the edit re-applies to the same content-keyed hypothesis')
  const reCfo = second.hypotheses.find(x => x.id === cfo.id)!
  assert.equal(reCfo.status, 'reviewed', 'the confirm re-applies across the recrawl')
  assert.deepEqual(targetingFor(second, 'acme-booking').who, ['office managers']); assert.deepEqual(targetingFor(second, 'acme-payroll').who.sort(), ['CFOs of hospital groups', 'clinic owners'])
})

test('an answered question stays bound to its offer across recrawls and is never re-asked', async () => {
  const noBuyer = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Booking' }, { id: 'o2', name: 'Acme Payroll' }], items: [] })
  const first = await crawl(async () => noBuyer) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(first.question, 'Which of your offers is this play for?')
  const answered = { ...first, question: null, answered: { question: first.question!, offer: 'acme-booking' } }
  const second = await crawl(async () => noBuyer, answered) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(second.question, null, 'the answered question is not re-asked')
  assert.deepEqual(second.answered, { question: 'Which of your offers is this play for?', offer: 'acme-booking' }, 'the binding persists while the offer exists')
  const gone = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Payroll' }], items: [] })
  const third = await crawl(async () => gone, answered) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.deepEqual(third.answered, null, 'the binding lapses when its offer no longer exists')
})

test("a typed 'Who buys this?' answer persists its WORDS across recrawls as a reviewed persona on the answering offer", async () => {
  const oneOffer = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Booking' }], items: [] })
  const first = await crawl(async () => oneOffer) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(first.question, 'Who buys this?')
  const answered = { ...first, question: null, answered: { question: 'Who buys this?', offer: 'acme-booking', text: 'office managers' } }
  const second = await crawl(async () => oneOffer, answered) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(second.question, null, 'the answered question is not re-asked')
  assert.deepEqual(second.answered, { question: 'Who buys this?', offer: 'acme-booking', text: 'office managers' }, 'the typed words carry with the binding')
  const words = second.hypotheses.find(h => h.kind === 'persona' && h.text === 'office managers')
  assert.ok(words, "the person's words surface as a persona hypothesis, not only a suppression flag")
  assert.equal(words!.offer, 'acme-booking')
  assert.equal(words!.status, 'reviewed', 'the person\'s own answer is reviewed targeting')
  assert.equal(words!.url, null); assert.equal(words!.quote, null)
  // Kept in the draft it stays reviewed; deleted from the draft it is an explicit rejection that persists.
  const base = { summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  const kept = applyReviewedDraft({ ...base, who: ['office managers'], research: toStored(second) }, 'Acme Booking')
  assert.equal(fromStored(kept.research!).hypotheses.find(h => h.text === 'office managers')!.status, 'reviewed')
  const dropped = applyReviewedDraft({ ...base, research: toStored(second) }, 'Acme Booking')
  assert.equal(fromStored(dropped.research!).hypotheses.find(h => h.text === 'office managers')!.status, 'rejected')
  // The binding lapses when its offer no longer exists: words are not injected and the question is asked again.
  const other = JSON.stringify({ offers: [{ id: 'o1', name: 'Acme Payroll' }], items: [] })
  const third = await crawl(async () => other, answered) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(third.answered, null)
  assert.ok(!third.hypotheses.some(h => h.text === 'office managers'))
  // A different site never inherits the answer.
  const far = buildResearch(JSON.parse(oneOffer), [], 'other.example', answered) as Exclude<Awaited<ReturnType<typeof run>>, { error: string }>
  assert.equal(far.answered, null, 'site identity guards the carried answer')
  assert.ok(!far.hypotheses.some(h => h.text === 'office managers'))
})

test('failure modes: bad model output and empty offers are model_failed (fetch errors are covered by icpFromWebsite tests)', async () => {
  assert.deepEqual(await crawl(async () => 'not json'), { error: 'model_failed' })
  assert.deepEqual(await crawl(async () => '{"offers":[],"items":[]}'), { error: 'model_failed' })
})
