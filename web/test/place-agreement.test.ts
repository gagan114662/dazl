// Location agreement before a company gets evidence or contacts. Pure functions and stubbed verifier runs; pages are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventPlaceOk, geoTerms, namesPlace, otherState as otherUsState, placeAgreement } from '../lib/scan/place-agreement.ts'
import { verifyLeads } from '../lib/scan/runner.ts'

test('terms: NYC expands to its boroughs, London to the UK names; no geography means no demand', () => {
  assert.ok(geoTerms(['New York City']).includes('brooklyn') && geoTerms(['New York City']).includes('nyc'))
  assert.deepEqual(geoTerms(['London', 'UK']), ['london', 'greater london'], 'the country beside a city is context, not a match')
  assert.deepEqual(geoTerms([]), []); assert.equal(placeAgreement('anything at all', []), 'no_geography')
})
test('agreement: a text naming the place agrees; another US state is a mismatch; a text naming no place is unconfirmed', () => {
  const W = ['New York City']
  assert.equal(placeAgreement('Dent Blanche - 57 W 57th St, New York, NY 10019', W, 'Dent Blanche'), 'agrees')
  assert.equal(placeAgreement('Our new Brooklyn office opens soon', W), 'agrees')
  assert.equal(placeAgreement('Dent Blanche Dental, 8500 Whittier Blvd, Pico Rivera, CA 90660', W), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche is a modern dental practice', W), 'unconfirmed')
  assert.equal(placeAgreement('Dent Blanche, Pico Rivera, California', ['California']), 'agrees', 'the requested state is never a mismatch')
  assert.equal(otherUsState('Springfield, IL', geoTerms(['Ohio'])), 'illinois'); assert.equal(namesPlace('London, UK', geoTerms(['London'])), true)
  assert.equal(namesPlace('Londonderry', geoTerms(['London'])), false, 'whole words only')
})
const Q = 'Dent Blanche is opening a second location on West 57th Street'
const dayStr = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const cand = { name: '', company: 'Dent Blanche', contact: null, signal: 'second location', source_url: 'https://news.example/db', score: 70, excerpt: Q, event_date: dayStr(10) }
const page = (extra: string) => async () => ({ text: `Posted ${dayStr(10)}. ${Q}. ${extra} ${'The practice welcomes families. '.repeat(10)}`, title: 'Dent Blanche expands', retrievedAt: 1 })
test('verifier: a same-name practice in another state is NOT attached (location_mismatch); a page with no place is not rejected; the right place verifies; no geography changes nothing', async () => {
  const W = ['New York City']
  const wrong = await verifyLeads([cand], page('Visit us at 8500 Whittier Blvd, Pico Rivera, CA 90660.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
  const none = await verifyLeads([cand], page(''), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(none.leads.length, 1, 'a page naming no place is not rejected by the evidence gate (contacts are stricter)')
  const right = await verifyLeads([cand], page('Visit us at 57 W 57th St, New York, NY 10019.'), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(right.leads.length, 1)
  const global = await verifyLeads([cand], page(''))
  assert.equal(global.leads.length, 1, 'a request with no place makes no demand')
})

test('city-level geography: "New York, NY" / "New York City" rejects Rome, NY and other New York towns; boroughs and the city line agree; a state-level request is not city-scoped', () => {
  for (const W of [['New York, NY'], ['New York City'], ['NYC']]) {
    assert.equal(placeAgreement('Dent Blanche, 8500 Main St, Rome, NY 13440', W), 'mismatch', W.join())
    assert.equal(placeAgreement('Visit us in Albany, New York', W), 'mismatch')
    assert.equal(placeAgreement('Smile Studio, 57 W 57th St, New York, NY 10019', W, 'Smile Studio'), 'agrees')
    assert.equal(placeAgreement('Our Brooklyn, NY office', W), 'agrees')
    assert.equal(placeAgreement('Offices in Rome, NY and Manhattan', W), 'mismatch', 'another New York town is named and no NYC address binds the company to the city')
  }
  assert.equal(placeAgreement('Dent Blanche, Rome, NY 13440', ['New York']), 'unconfirmed', 'bare "New York" is the state: not city-scoped, not a conflict')
  assert.equal(placeAgreement('Dent Blanche, Rome, New York', ['New York']), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, London, Ontario, Canada', ['London', 'UK']), 'mismatch')
  assert.equal(placeAgreement('Acme Ltd, London, UK', ['London', 'UK']), 'agrees')
})
test('verifier: a Rome, NY page is not attached to a New York City request', async () => {
  const wrong = await verifyLeads([cand], page('Visit us at 8500 Main St, Rome, NY 13440.'), new Date(), undefined, null, undefined, undefined, ['New York, NY'])
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
})

// Instinct's wrong-city reproductions for #230 (each its own test).
const LON = ['London', 'UK']
test('wrong city: "Manchester, England" is not London', () => { assert.equal(placeAgreement('Acme Ltd, 5 Deansgate, Manchester, England', LON), 'mismatch'); assert.equal(placeAgreement('Acme Ltd, 5 Deansgate, Manchester, England', ['London UK']), 'mismatch') })
test('wrong city: London, Ontario plus an unrelated "United Kingdom news" mention is not London, UK', () => {
  assert.equal(placeAgreement('Acme Dental, 12 Dundas St, London, Ontario, Canada. Latest United Kingdom news: ...', LON), 'mismatch')
  assert.equal(placeAgreement('Acme Dental, London, ON N6A 1A1. United Kingdom', LON), 'mismatch')
})
test('wrong city: an Albany, NY company page with an incidental NYC mention is not New York City', () => {
  for (const W of [['New York City'], ['New York, NY'], ['NYC']]) {
    assert.equal(placeAgreement('Acme Dental, 12 State St, Albany, NY 12207. We also serve clients from NYC.', W), 'mismatch', W.join())
    assert.equal(placeAgreement('Acme Dental, Rome, NY. Our founder grew up in Brooklyn.', W), 'mismatch', W.join())
  }
})
test('wrong city: a footer / other-office / country mention does not bind the company to London', () => {
  assert.equal(placeAgreement('Headquarters: 10 Wellington St, Leeds, UK. Satellite desk in London.', LON), 'mismatch')
  assert.equal(placeAgreement('Acme is a United Kingdom company, offices in Glasgow, Scotland', LON), 'mismatch')
  assert.equal(placeAgreement('Acme is a United Kingdom company', LON), 'unconfirmed', 'the country alone never agrees')
})
test('right city still agrees: London postcode / "London, UK" address and a New York, NY ZIP address, even beside another office', () => {
  assert.equal(placeAgreement('Acme Ltd, 1 Old Street, London EC1V 9HX', LON, 'Acme Ltd'), 'agrees'); assert.equal(placeAgreement('Acme Ltd, London, UK', LON), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, 1 Old Street, London EC1V 9HX. Second office: Leeds, UK', LON, 'Acme Ltd'), 'agrees')
  assert.equal(placeAgreement('Smile Studio, 57 W 57th St, New York, NY 10019. Second office in Albany, NY', ['New York City'], 'Smile Studio'), 'agrees', 'the company\'s own NYC address binds it')
})

test('Instinct c3c505e cases: the company is bound to the city by its own text, not by an unrelated mention elsewhere', () => {
  const LON = ['London, UK']
  assert.notEqual(placeAgreement('Dent Blanche, East London, South Africa. Dental practice owner.', LON), 'agrees')
  assert.equal(placeAgreement('Dent Blanche, East London, South Africa. Dental practice owner.', LON), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. News from London, UK.', LON), 'mismatch')
  assert.equal(placeAgreement('Dental Studio based in Albany, NY. News: New York, NY 10001.', ['NYC']), 'mismatch')
  // controls: a real street / postcode address of the company still binds it, even beside another office
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Our UK office: 1 Old Street, London EC1V 9HX.', LON), 'agrees')
  assert.equal(placeAgreement('Dental Studio, Albany, NY. Our flagship: 57 W 57th St, New York, NY 10019.', ['NYC'], 'Dental Studio'), 'agrees')
  assert.equal(placeAgreement('Acme Ltd, London, UK', LON), 'agrees')
})

test('Instinct 5098eba cases: an address in a sentence about a third party (conference venue, news about another business) does not bind the company', () => {
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Unrelated conference venue: London EC1V 9HX.', ['London UK']), 'mismatch')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. News: another business opens at 57 W 57th St, New York, NY 10019.', ['NYC']), 'mismatch')
  // controls: the company's own office sentence still binds, even when a venue/news sentence sits beside it
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Unrelated conference venue: London EC1V 9HX. Our UK office: 1 Old Street, London EC1V 9HX.', ['London UK']), 'agrees')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. News: another business opens at 9 Pine St, New York, NY 10005. Visit us at 57 W 57th St, New York, NY 10019.', ['NYC']), 'agrees')
})

test('Instinct 3d6890d cases: another party\u2019s address (supplier, their lawyer) never binds the company; own-company addresses still do', () => {
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Supplier address: London EC1V 9HX.', ['London UK']), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Supplier address: London EC1V 9HX.', ['London UK'], 'Dent Blanche'), 'mismatch')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. Their lawyer works at 57 W 57th St, New York, NY 10019.', ['New York, NY']), 'mismatch')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. Their lawyer works at 57 W 57th St, New York, NY 10019.', ['New York, NY'], 'Dental Studio'), 'mismatch')
  // the company\u2019s name in a sentence about someone else still does not bind a third party\u2019s address
  assert.equal(placeAgreement('Dental Studio in Albany, NY. Dental Studio\u2019s lawyer works at 57 W 57th St, New York, NY 10019.', ['New York, NY'], 'Dental Studio'), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Our accountant is at 1 Old Street, London EC1V 9HX.', ['London UK'], 'Dent Blanche'), 'mismatch')
  // positives: own office phrasing, with or without the company name
  assert.equal(placeAgreement('Dent Blanche in London, Ontario. Supplier address: London EC1V 9HX. Our UK office: 1 Old Street, London EC1V 9HX.', ['London UK']), 'agrees')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. Their lawyer works at 57 W 57th St, New York, NY 10019. Dental Studio, 9 Pine St, New York, NY 10005.', ['New York, NY'], 'Dental Studio'), 'agrees')
  assert.equal(placeAgreement('Dental Studio in Albany, NY. Visit us at 57 W 57th St, New York, NY 10019.', ['New York, NY']), 'agrees')
  assert.equal(placeAgreement('Dental Studio, Albany, NY. Dental Studio is located at 57 W 57th St, New York, NY 10019.', ['NYC'], 'Dental Studio'), 'agrees')
})

test('through the real verifier: another party’s address on the page (supplier / their lawyer) does not make the company local; its own office does', async () => {
  const W = ['New York, NY']
  const albany = 'Dent Blanche is based in Albany, NY.'
  const wrong = await verifyLeads([cand], page(`${albany} Their lawyer works at 57 W 57th St, New York, NY 10019.`), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(wrong.leads.length, 0); assert.equal(wrong.review[0].review_reason, 'location_mismatch')
  const ownOffice = await verifyLeads([cand], page(`${albany} Visit us at 57 W 57th St, New York, NY 10019.`), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(ownOffice.leads.length, 1, 'the company’s own New York office binds it')
  const named = await verifyLeads([cand], page(`${albany} Dent Blanche, 57 W 57th St, New York, NY 10019.`), new Date(), undefined, null, undefined, undefined, W)
  assert.equal(named.leads.length, 1, 'an address directly after the company name binds it')
  const LON = ['London UK']
  const q2 = { ...cand, excerpt: 'Dent Blanche is opening a second location on Oxford Street', signal: 'second location' }
  const pg2 = (extra: string) => async () => ({ text: `Posted ${dayStr(10)}. ${q2.excerpt}. ${extra} ${'The practice welcomes families. '.repeat(10)}`, title: 'Dent Blanche expands', retrievedAt: 1 })
  const sup = await verifyLeads([q2], pg2('Dent Blanche is in London, Ontario. Supplier address: London EC1V 9HX.'), new Date(), undefined, null, undefined, undefined, LON)
  assert.equal(sup.leads.length, 0); assert.equal(sup.review[0].review_reason, 'location_mismatch')
  const own = await verifyLeads([q2], pg2('Dent Blanche is in London, Ontario. Our UK office: 1 Old Street, London EC1V 9HX.'), new Date(), undefined, null, undefined, undefined, LON)
  assert.equal(own.leads.length, 1)
})

// Any other city, any country (#440: a Paris startup verified for a London request). A page that names only a different place is a
// mismatch; "unconfirmed" is kept for a page that names no place at all; a page naming the requested city is unchanged.
test('another city in any country is a mismatch, not unconfirmed', () => {
  assert.equal(placeAgreement('Lumen Ledger, a Paris B2B SaaS startup, raised a seed round. The team works from its office in Paris, France.', LON, 'Lumen Ledger'), 'mismatch')
  assert.equal(placeAgreement('Acme, a Berlin startup, raised a seed round.', LON, 'Acme'), 'mismatch')
  assert.equal(placeAgreement('Acme opened its office in Toronto, ON this month.', LON, 'Acme'), 'mismatch')
  assert.equal(placeAgreement('Acme opened in Austin, Texas.', LON, 'Acme'), 'mismatch', 'a bare first-name city is not listed, but "City, State" is still a place')
  assert.equal(placeAgreement('Acme, a startup in Lyon, raised a seed round.', ['Paris, France'], 'Acme'), 'mismatch', 'another city of the same country, for a city request')
  assert.equal(placeAgreement('Acme opened its first office in Manchester this month.', LON, 'Acme'), 'mismatch', 'a bare UK city with no London at all')
})
test('control: the requested city named in another country (or state) is a mismatch', () => {
  assert.equal(placeAgreement('Acme, a startup in Paris, Texas, raised a seed round.', ['Paris, France'], 'Acme'), 'mismatch')
  assert.equal(placeAgreement('Acme moved to Springfield, Illinois.', ['Springfield, Missouri'], 'Acme'), 'mismatch')
  assert.equal(placeAgreement('Acme opened in London, Ontario.', LON, 'Acme'), 'mismatch')
  // ...but not when the page also places it in the requested country
  assert.equal(placeAgreement('Acme, a Paris, France startup, is not to be confused with Paris, Texas.', ['Paris, France'], 'Acme'), 'agrees')
})
test('control: a page that names no place stays unconfirmed', () => {
  for (const t of ['Acme raised a seed round this month.', 'Acme is a United Kingdom company', 'Nice work from the Acme team: reading the room, they hired three people.', 'Acme is a modern dental practice'])
    assert.equal(placeAgreement(t, LON, 'Acme'), 'unconfirmed', t)
  assert.equal(placeAgreement('Acme raised a seed round this month.', ['Paris, France'], 'Acme'), 'unconfirmed')
})
test('control: a page naming the requested city still agrees, even beside another city', () => {
  assert.equal(placeAgreement('Acme, a London startup, raised a seed round.', LON, 'Acme'), 'agrees')
  assert.equal(placeAgreement('Acme, a London startup, plans to open in Paris, France next year.', LON, 'Acme'), 'agrees', 'an incidental foreign city does not override the named London')
  assert.equal(placeAgreement('Acme, a Paris startup, raised a seed round.', ['Paris, France'], 'Acme'), 'agrees')
  assert.equal(placeAgreement('Acme opened at 100 King Street West, Toronto, ON this month', ['Toronto, Canada'], 'Acme'), 'agrees')
})
test('a country or state request only rejects places outside it; US namesakes keep bare foreign names ambiguous', () => {
  assert.notEqual(placeAgreement('Acme, a Berlin startup, raised a seed round.', ['Germany'], 'Acme'), 'mismatch', 'Berlin is in Germany')
  assert.equal(placeAgreement('Acme, a Paris startup, raised a seed round.', ['Germany'], 'Acme'), 'mismatch')
  assert.equal(placeAgreement('Dent Blanche, Rome, NY 13440', ['New York']), 'unconfirmed', 'a town in the requested state')
  assert.equal(placeAgreement('Acme opened in Rome this spring.', ['New York'], 'Acme'), 'unconfirmed', 'Rome, NY exists: a bare foreign name is not clearly elsewhere for a US request')
  assert.equal(placeAgreement('Acme opened in Rome, Italy this spring.', ['New York'], 'Acme'), 'mismatch')
})
test('verifier: a Paris page for a London request is held as location_mismatch, a London page still verifies', async () => {
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const page = (text: string) => async () => ({ text: `${ago(5)}. ${text} ${'More about the company and its customers. '.repeat(15)}`, title: 'Seed round', retrievedAt: Math.floor(Date.now() / 1000) })
  const cand = (company: string, excerpt: string) => ({ name: '', company, contact: null, signal: 'raised a seed round', source_url: 'https://news.example/a', score: 70, excerpt, event_date: ago(5) })
  const paris = await verifyLeads([cand('Lumen Ledger', 'Lumen Ledger, a Paris B2B SaaS startup, raised a seed round this month')], page('Lumen Ledger, a Paris B2B SaaS startup, raised a seed round this month.'), new Date(), undefined, null, undefined, undefined, LON)
  assert.equal(paris.leads.length, 0); assert.equal(paris.review[0].review_reason, 'location_mismatch')
  const london = await verifyLeads([cand('Querix', 'Querix, a London B2B SaaS startup, raised a seed round this month')], page('Querix, a London B2B SaaS startup, raised a seed round this month.'), new Date(), undefined, null, undefined, undefined, LON)
  assert.equal(london.leads.length, 1)
})

// Review of #446: explicit location binding must survive capitalisation, and a company bound to another place outranks an
// incidental mention of the requested city. Company and pages are invented.
const SC = 'Synthetic Co'
test('control: the original Paris case in lower, upper and mixed case is a mismatch, and eventPlaceOk refuses it', () => {
  for (const t of ['Synthetic Co is based in Paris, France and raised seed funding.', 'synthetic co is based in paris, france and raised seed funding.',
    'SYNTHETIC CO IS BASED IN PARIS, FRANCE AND RAISED SEED FUNDING.', 'Synthetic Co is based in PARIS, FRANCE and raised seed funding.', 'Synthetic Co is based in paris, France and raised seed funding.']) {
    assert.equal(placeAgreement(t, ['London, UK'], SC), 'mismatch', t)
    assert.equal(eventPlaceOk(t, ['London, UK'], SC), false, t)
  }
})
test('control: a company bound to another place is a mismatch even when the page mentions the requested city incidentally', () => {
  for (const t of ['Synthetic Co is based in Paris, France. Market news: London startups raised more this year.',
    'Synthetic Co is headquartered in Berlin, Germany. We also serve clients in London.',
    'Our office is in Toronto, ON. Footer: events in London, Paris and New York.',
    'synthetic co is based in paris, france. market news: london startups raised more this year.'])
    assert.equal(placeAgreement(t, ['London, UK'], SC), 'mismatch', t)
})
test('control: a genuine company address in the requested city still agrees, whatever the case and other mentions', () => {
  for (const t of ['Synthetic Co is based in London, UK and raised seed funding.', 'synthetic co is based in london and raised seed funding.',
    'Synthetic Co is based in London, with a sales office in Paris, France.', 'Synthetic Co is based in London. Synthetic Co is also based in Paris, France.',
    'Synthetic Co is in London, Ontario too. Our UK office: 1 Old Street, London EC1V 9HX.'])
    assert.equal(placeAgreement(t, ['London, UK'], SC), 'agrees', t)
})
test('control: ambiguous lower-case words and abbreviations are not places', () => {
  for (const t of ['Reach out to us, in confidence, and we reply the same day.', 'We sell to nice people, or at least we try.', 'Thanks, me and the team look forward to it.',
    'synthetic co is reading the room and growing on, in and around its niche.', 'The cologne line, eau de cologne, sold out.'])
    assert.equal(placeAgreement(t, ['London, UK'], SC), 'unconfirmed', t)
})
test('control: same-name city in a different region, any case', () => {
  assert.equal(placeAgreement('synthetic co is based in paris, texas and raised seed funding.', ['Paris, France'], SC), 'mismatch')
  assert.equal(placeAgreement('SYNTHETIC CO OPENED IN LONDON, ONTARIO.', ['London, UK'], SC), 'mismatch')
  assert.equal(placeAgreement('Synthetic Co moved to springfield, illinois.', ['Springfield, Missouri'], SC), 'mismatch')
  assert.equal(placeAgreement('Synthetic Co moved to Springfield, Missouri.', ['Springfield, Missouri'], SC), 'agrees')
})
test('verifier (runner path): lower-case, upper-case and incidental-London Paris pages are held as location_mismatch; a London page verifies', async () => {
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const run = async (company: string, quote: string, rest = '') => {
    const page = async () => ({ text: `${ago(5)}. ${quote}. ${rest} ${'More about the company and its customers. '.repeat(15)}`, title: 'Seed round', retrievedAt: Math.floor(Date.now() / 1000) })
    return verifyLeads([{ name: '', company, contact: null, signal: 'raised a seed round', source_url: 'https://news.example/a', score: 70, excerpt: quote, event_date: ago(5) }], page, new Date(), undefined, null, undefined, undefined, ['London, UK'])
  }
  for (const [quote, rest] of [['synthetic co is based in paris, france and raised a seed round this month', ''], ['SYNTHETIC CO IS BASED IN PARIS, FRANCE AND RAISED A SEED ROUND THIS MONTH', ''],
    ['Synthetic Co is based in Paris, France and raised a seed round this month', 'Market news: London startups raised more this year.']]) {
    const o = await run(SC, quote, rest)
    assert.equal(o.leads.length, 0, quote); assert.equal(o.review[0]?.review_reason, 'location_mismatch', quote)
  }
  const ok = await run(SC, 'Synthetic Co is based in London and raised a seed round this month', 'It also has a sales office in Paris, France.')
  assert.equal(ok.leads.length, 1)
})

// Review of #446 (950352bf): a mention of the requested region elsewhere on the page must not cancel the company's own address
// in a same-name city in another region; only the requested-region mention bound to the company does.
test('control: a company bound to a same-name city elsewhere stays a mismatch despite an unrelated requested-region mention', () => {
  const P = ['Paris, France']
  assert.equal(placeAgreement('Synthetic Co is based in Paris, Texas. Market news: Paris, France startups raised funds.', P, SC), 'mismatch')
  assert.equal(placeAgreement('synthetic co is based in paris, texas. market news: paris, france startups raised funds.', P, SC), 'mismatch')
  assert.equal(placeAgreement('Synthetic Co is based in Paris, Texas. Our office is in Paris, France.', P, SC), 'agrees')   // requested region bound to the company too
  assert.equal(placeAgreement('Synthetic Co is based in Paris, France. Unrelated: Paris, Texas hosts a rodeo.', P, SC), 'agrees')
  assert.equal(placeAgreement('Synthetic Co is based in London, Ontario. Market news: London, UK startups raised funds.', ['London, UK'], SC), 'mismatch')
})
test('verifier (runner path): Paris, Texas company with Paris, France market news is held; with a bound Paris, France office it verifies', async () => {
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const run = (quote: string, rest: string) => verifyLeads([{ name: '', company: SC, contact: null, signal: 'raised a seed round', source_url: 'https://news.example/p', score: 70, excerpt: quote, event_date: ago(5) }],
    async () => ({ text: `${ago(5)}. ${quote}. ${rest} ${'More about the company and its customers. '.repeat(15)}`, title: 'Seed round', retrievedAt: Math.floor(Date.now() / 1000) }), new Date(), undefined, null, undefined, undefined, ['Paris, France'])
  const held = await run('Synthetic Co is based in Paris, Texas and raised a seed round this month', 'Market news: Paris, France startups raised funds.')
  assert.equal(held.leads.length, 0); assert.equal(held.review[0]?.review_reason, 'location_mismatch')
  const ok = await run('Synthetic Co is based in Paris, Texas and raised a seed round this month', 'Our office is in Paris, France.')
  assert.equal(ok.leads.length, 1)
})
