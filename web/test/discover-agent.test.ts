// The Claude discovery loop's own code: reading the model's answer into lead records, pricing a run, and labelling a lead
// from its proof page. No network. Invented companies and pages, except the #1575 cases at the end, which quote public proof pages.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLeads, usd } from '../lib/discover/agent.ts'
import { checkLead, companyOnPage, dayOnPage, isShown, pageAgeDay, statesSignal } from '../lib/discover/check.ts'
import { mergeEnriched, needsEnrichment, parseEnriched } from '../lib/discover/enrich.ts'

const lead = (o: Record<string, unknown> = {}) => ({ company: 'Northwind Dental', domain: 'https://www.northwind-dental.example/about', signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind-second-clinic', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://www.northwind-dental.example/team', linkedin_url: 'https://www.linkedin.com/in/dana-ruiz/', email: null, email_source_url: null, confidence: 'high', why: 'expanding', ...o })

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
  // a page nobody could read: shown when the search result's own title names the company AND speaks of the signal, dated or not
  const listed = await checkLead({ ...l, signal_date: null }, [{ url: l.evidence_url, title: 'Northwind Dental to open second clinic', page_age: null, text: null }], page('blocked', 403))
  assert.deepEqual([listed.proof, listed.signal_seen, isShown(listed)], ['listed', true, true])
  assert.equal(isShown(read), true, 'a real expansion page: the quoted words are in the text that was read')
  const unseen = await checkLead(l, [{ url: 'https://news.example/other', title: 'Northwind Dental', page_age: null, text: null }], page('blocked', 403))
  assert.deepEqual([unseen.proof, isShown(unseen)], ['unseen', false], 'a proof URL the run never saw and nobody can read is not shown')
  assert.equal((await checkLead({ ...l, evidence_url: 'http://127.0.0.1/admin' }, [], never)).proof, 'unseen', 'a private address is never fetched')
})

// Review of #1575: recency and a date-like number are labels, never support for the buying signal.
test('a recently indexed directory result nobody could read is not shown, however fresh the index date', async () => {
  const blocked = (async () => new Response('blocked', { status: 403 })) as unknown as typeof fetch
  const l = parseLeads(JSON.stringify({ leads: [lead({ signal_date: null, evidence_quote: null })] }), 1).leads[0]
  const dir = await checkLead(l, [{ url: l.evidence_url, title: 'Northwind Dental - reviews and opening hours', page_age: '3 days ago', text: null }], blocked)
  assert.deepEqual([dir.proof, dir.date_source, dir.signal_seen, isShown(dir)], ['listed', 'index', false, false], 'the index date still labels the lead; it does not admit it')
})

test('a company page that prints the year and a routine number is not shown for a signal dated that day', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const l = parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0]   // signal_date 2026-10-14, quote about the second clinic
  const plain = await checkLead(l, [], page('<h1>Northwind Dental</h1><p>Family dentistry at 14 Main Street. Open Monday to Friday.</p><footer>Copyright 2026</footer>'))
  assert.deepEqual([plain.proof, plain.date_on_page, plain.quote_on_page, plain.signal_seen, isShown(plain)], ['confirmed', true, false, false, false], 'the weak date check still labels; it does not admit')
  // a quote that IS on the page but says nothing of the signal (the company describing itself) is not support either
  const self = await checkLead({ ...l, evidence_quote: 'Family dentistry at 14 Main Street' }, [], page('<h1>Northwind Dental</h1><p>Family dentistry at 14 Main Street. Open Monday to Friday.</p>'))
  assert.deepEqual([self.quote_on_page, self.signal_seen, isShown(self)], [true, false, false])
})

test('real signal pages stay shown: the full quote, a trimmed quote, and an undated page', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const l = parseLeads(JSON.stringify({ leads: [lead()] }), 1).leads[0]
  const body = '<article><h1>Northwind Dental grows</h1><p>The practice said Northwind Dental will open its second clinic on King Street next spring, adding six chairs.</p></article>'
  assert.equal(isShown(await checkLead(l, [], page(body))), true)
  const trimmed = await checkLead({ ...l, evidence_quote: 'Northwind Dental will open its second clinic on King Street ... adding six chairs' }, [], page(body))
  assert.deepEqual([trimmed.quote_on_page, isShown(trimmed)], [true, true], 'six consecutive quoted words on the page')
  const undated = await checkLead({ ...l, signal_date: null }, [], page(body))
  assert.deepEqual([undated.date, isShown(undated)], [null, true], 'no date is a missing label, not a missing proof')
})

test('second pass: only empty fields are filled, a person needs the page that names them, and the first pass is never overwritten', () => {
  const base = parseLeads(JSON.stringify({ leads: [lead({ person: null, title: null, person_source_url: null, linkedin_url: null, domain: null })] }), 1).leads[0]
  assert.equal(needsEnrichment(base), true)
  const found = parseEnriched('<json>{"domain":"https://www.northwind-dental.example/","person":"Dana Ruiz","title":"Owner","person_source_url":"https://northwind-dental.example/team","linkedin_url":"https://www.linkedin.com/in/dana-ruiz/"}</json>')
  const merged = mergeEnriched(base, found)
  assert.deepEqual([merged.domain, merged.person, merged.title, merged.person_source_url, merged.linkedin_url], ['northwind-dental.example', 'Dana Ruiz', 'Owner', 'https://northwind-dental.example/team', 'https://www.linkedin.com/in/dana-ruiz/'])
  assert.deepEqual([merged.signal, merged.signal_date, merged.evidence_url], [base.signal, base.signal_date, base.evidence_url], 'the signal, its date and its proof are untouched')
  assert.equal(parseEnriched('{"person":"Dana Ruiz","title":"Owner","person_source_url":null,"domain":"northwind-dental.example"}').person, null, 'a name with no page that names them is not kept')
  const kept = mergeEnriched(parseLeads(JSON.stringify({ leads: [lead({ domain: null })] }), 1).leads[0], parseEnriched('{"domain":"other.example","person":"Someone Else","title":"CEO","person_source_url":"https://other.example/team"}'))
  assert.deepEqual([kept.person, kept.domain], ['Dana Ruiz', 'other.example'], 'the person the first pass found stays; only the empty website is filled')
  assert.equal(needsEnrichment(kept), true, 'still no published email')
  assert.equal(needsEnrichment({ ...kept, email: 'office@other.example', email_source_url: 'https://other.example/contact' }), false)
  assert.deepEqual(parseEnriched('no idea'), { domain: null, person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null })
  const mail = parseEnriched('{"email":"Office@Northwind-Dental.example","email_source_url":"https://northwind-dental.example/contact"}')
  assert.deepEqual([mail.email, mail.email_source_url], ['office@northwind-dental.example', 'https://northwind-dental.example/contact'])
  assert.equal(parseEnriched('{"email":"office@northwind-dental.example"}').email, null, 'an address with no page that prints it is not kept')
})

test('a proof page that prints no date takes the day the search index dates it, and says so', async () => {
  const now = new Date('2026-11-22T12:00:00Z')
  assert.equal(pageAgeDay('69 days ago', now), '2026-09-14')
  assert.equal(pageAgeDay('3 hours ago', now), '2026-11-22')
  assert.equal(pageAgeDay('October 14, 2026', now), '2026-10-14')
  assert.equal(pageAgeDay('2 weeks ago', now), '2026-11-08')
  assert.equal(pageAgeDay('soon', now), null)
  assert.equal(pageAgeDay('January 1, 2031', now), null, 'a day in the future is not a date for something that happened')
  const never = (() => { throw new Error('must not be fetched') }) as unknown as typeof fetch
  const undated = parseLeads(JSON.stringify({ leads: [lead({ signal_date: null })] }), 1).leads[0]
  const seen = [{ url: undated.evidence_url, title: 'Northwind Dental', page_age: '69 days ago', text: 'Northwind Dental will open its second clinic.' }]
  const a = await checkLead(undated, seen, never, 1000, now)
  assert.deepEqual([a.date, a.date_source, a.date_on_page], ['2026-09-14', 'index', false])
  const b = await checkLead({ ...undated, signal_date: '2026-10-14' }, seen, never, 1000, now)
  assert.deepEqual([b.date, b.date_source], ['2026-10-14', 'page'], 'a date read on the page always wins over the index')
  const c = await checkLead(undated, [{ ...seen[0], page_age: null }], never, 1000, now)
  assert.deepEqual([c.date, c.date_source], [null, null])
})

test('the saved buyer profile, with its locations, goes to the engine beside the request (#1571)', async () => {
  const { profileLines } = await import('../lib/discover/agent.ts')
  assert.deepEqual(profileLines(null), [])
  assert.deepEqual(profileLines({ summary: '', who: [], where: [] }), [])
  const lines = profileLines({ summary: 'Fintech startups', who: ['Founder'], industries: ['Fintech'], where: ['London'], exclude: ['banks'] })
  assert.equal(lines[0], "The seller's saved buyer profile:")
  assert.ok(lines.some(l => l.startsWith('Locations') && l.endsWith(': London')))
  assert.ok(lines.includes('Buyer roles: Founder') && lines.includes('Leave out: banks'))
})

test('an index day older than a year is not shown as the date of the signal (#1571)', async () => {
  const { checkLead } = await import('../lib/discover/check.ts')
  const lead = { company: 'Northwind Dental', domain: null, signal: 'Opening a second clinic', signal_date: null, evidence_url: 'https://northwind-dental.example/news', evidence_quote: '', person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'medium', why: '' }
  const now = new Date('2026-11-22T00:00:00Z')
  const page = (page_age: string) => [{ url: lead.evidence_url, title: 'Northwind Dental', page_age, text: 'Northwind Dental will open a second clinic.' }]
  const old = await checkLead(lead as never, page('May 11, 2022') as never, undefined as never, 1000, now)
  assert.deepEqual([old.proof, old.date, old.date_source], ['confirmed', null, null])
  const recent = await checkLead(lead as never, page('November 10, 2026') as never, undefined as never, 1000, now)
  assert.deepEqual([recent.date, recent.date_source], ['2026-11-10', 'index'])
})

// Second review of #1575: overlapping words are not the claim. Signal: "Opening a second clinic".
test('routine directory text that shares words with the signal is not shown; the real second-clinic announcement is', async () => {
  const page = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
  const l = parseLeads(JSON.stringify({ leads: [lead({ signal_date: null })] }), 1).leads[0]
  // the quoted words ARE on the page and share "opening" and "clinic" with the signal; nothing says a second clinic is opening
  const routine = 'Northwind Dental clinic opening hours Monday to Friday'
  const hours = await checkLead({ ...l, evidence_quote: routine }, [], page(`<h1>Northwind Dental</h1><p>${routine}. Call to book.</p>`))
  assert.deepEqual([hours.proof, hours.quote_on_page, hours.signal_seen, isShown(hours)], ['confirmed', true, false, false])
  // the same kind of title on a result nobody could read
  const title = await checkLead({ ...l, evidence_quote: null }, [{ url: l.evidence_url, title: 'Northwind Dental clinic reviews and opening hours', page_age: '3 days ago', text: null }], page('blocked', 403))
  assert.deepEqual([title.proof, title.signal_seen, isShown(title)], ['listed', false, false])
  // the real announcement, read and unread
  const real = await checkLead(l, [], page('<p>Northwind Dental will open its second clinic on King Street next spring.</p>'))
  assert.deepEqual([real.proof, real.signal_seen, isShown(real)], ['confirmed', true, true])
  const realTitle = await checkLead({ ...l, evidence_quote: null }, [{ url: l.evidence_url, title: 'Northwind Dental opens second clinic downtown', page_age: null, text: null }], page('blocked', 403))
  assert.deepEqual([realTitle.proof, realTitle.signal_seen, isShown(realTitle)], ['listed', true, true])
})

// #1575, same-cohort repair. The strict rule above stays as it is. These cases are leads whose proof DOES state the claim and which the
// rule still refused, because the claim's words were lost before they were compared: an amount written two ways, one verb in two
// forms, a page stored with HTML entities. The page wording is copied from public proof pages named on #1571 (a funding news item, a
// second funding item, a clinic's own announcement). The signal lines are written for these tests: the captured ones are only in the
// staging database.
test('#1575 an amount is one word however it is written: "$12 million" on the page proves a "$12M" round, and only that amount', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const said = 'has raised $12 million in a Series A funding round led by MMC'
  const l = parseLeads(JSON.stringify({ leads: [lead({ company: 'LO:TECH', signal: 'Raised $12M Series A', signal_date: '2026-11-02', evidence_url: 'https://news.example/lotech-series-a', evidence_quote: said })] }), 1).leads[0]
  const body = (sentence: string) => `<article><h1>London-based LO:TECH lands $12M Series A led by MMC</h1><p>London-based <a href="https://lo.example/">LO:TECH</a>, a capital markets firm built for round-the-clock and onchain markets, ${sentence}, with participation from existing investors.</p></article>`
  const real = await checkLead(l, [], page(body(said)))
  assert.deepEqual([real.proof, real.quote_on_page, real.signal_seen, isShown(real)], ['confirmed', true, true, true])
  // controls: another amount is not this round, and a number that is not an amount is not one either
  const other = 'has raised $120 million in a Series A funding round led by MMC'
  assert.equal(isShown(await checkLead({ ...l, evidence_quote: other }, [], page(body(other)))), false, '$120 million is not $12M')
  const months = 'has raised its Series A target over the last 12 months'
  assert.equal(isShown(await checkLead({ ...l, evidence_quote: months }, [], page(body(months)))), false, '12 months is not $12M')
})

test('#1575 one verb is one word in every form ("to hire" and "hiring", "raise" and "raised"); the routine controls still fail', () => {
  assert.equal(statesSignal('Hiring 40 engineers', 'Acme Robotics', 'Acme Robotics plans to hire 40 engineers this year'), true)
  assert.equal(statesSignal('Seed raise of $5M', 'Seva Money', 'London-based fintech Seva Money raised $5 million in a seed round co-led by Blockwall and Revent'), true)
  assert.equal(statesSignal('Opened a second office', 'Dental Care Group', 'We’re thrilled to announce that we’ve opened a second office – located just across the street'), true)
  // controls: the same words about something else, and the review's routine text
  assert.equal(statesSignal('Hiring 40 engineers', 'Acme Robotics', 'Acme Robotics engineers are available for hire'), false, 'no 40')
  assert.equal(statesSignal('Seed raise of $5M', 'Seva Money', 'Seva Money plans to raise awareness of seed-stage fraud'), false, 'no amount')
  assert.equal(statesSignal('Opening a second clinic', 'Northwind Dental', 'Northwind Dental clinic opening hours Monday to Friday'), false)
  assert.equal(statesSignal('Opening a second clinic', 'Northwind Dental', 'Northwind Dental clinic reviews and opening hours'), false)
})

test('#1575 a page stored with HTML entities is read as the text a person sees: the quote and an accented company name are found', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  // the apostrophe is stored as &#x27; on the public page this line is copied from
  const stored = '<p>Blockwall and Revent co-led the round. Seva&#x27;s remittance service is live in India and Mexico.</p><p>London-based fintech Seva Money raised $5 million in a seed round.</p>'
  const short = parseLeads(JSON.stringify({ leads: [lead({ company: 'Seva Money', signal: 'Remittance service live in India and Mexico', signal_date: null, evidence_url: 'https://news.example/seva-seed', evidence_quote: 'Seva’s remittance service is live' })] }), 1).leads[0]
  assert.equal((await checkLead(short, [], page(stored))).quote_on_page, true, 'a five-word quote across the apostrophe')
  const accented = parseLeads(JSON.stringify({ leads: [lead({ company: 'Café Río Group', signal: 'Opening a second clinic', evidence_url: 'https://news.example/cafe-rio', evidence_quote: 'will open its second clinic in March' })] }), 1).leads[0]
  const es = await checkLead(accented, [], page('<p>Caf&eacute; R&iacute;o Group will open its second clinic in March &ndash; the first opened in 2019.</p>'))
  assert.deepEqual([es.proof, es.quote_on_page, isShown(es)], ['confirmed', true, true])
  // control: decoding never turns escaped markup into a tag, and an unknown entity is left as written
  const esc = await checkLead(accented, [], page('<p>Caf&eacute; R&iacute;o Group</p><p>&lt;p&gt;will open its second clinic in March&lt;/p&gt; &bogus;</p>'))
  assert.deepEqual([esc.proof, esc.quote_on_page], ['confirmed', true])
})

// #1575 replay over the 16 discovery leads stored on staging (the four test searches on #1571): 13 failed the rule with their proof in
// hand, each because the signal line says more than one quoted sentence can: an address, the other investors, the run's own comment.
// The signal lines and quotes below are the stored ones, word for word; the pages are public.
test('#1575 the claim is the signal line\'s first statement: stored leads whose quote states it are shown, detail and comment are not asked of the quote', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const stored = (company: string, signal: string, quote: string) => parseLeads(JSON.stringify({ leads: [lead({ company, signal, signal_date: null, evidence_url: 'https://proof.example/page', evidence_quote: quote })] }), 1).leads[0]
  const cases: [string, string, string][] = [
    ['LO:TECH', 'Raised $12M Series A led by MMC, with existing investors Faction and 13 Books Capital, plus Atka', 'London-based LO:TECH, a capital markets firm built for round-the-clock and onchain markets, has raised $12 million in a Series A funding round led by MMC'],
    ['Seva Money', 'Raised $5M seed round co-led by Blockwall and Revent, with Seedcamp, Stride.VC and Ada Ventures also taking part', 'London-based fintech Seva Money raised $5 million in a seed round co-led by Blockwall and Revent'],
    ['Dental Care Group', 'Opened a second office at 717 Coxwell Avenue, across the street from its existing clinic at 700 Coxwell Ave in Toronto.', 'We\'re thrilled to announce that we\'ve opened a second office – located just across the street!– at 717 Coxwell Avenue'],
    ['Toronto Smile Centre', 'Joined Passion Dental Group\'s Canadian network through a new partnership. Practices that join a group like this are often renovated or rebranded.', 'Passion Dental Group expanded its Canadian network through two new partnerships: Toronto Smile Centre, Toronto, Ontario, led by Dr. Priyanka Choudhary'],
  ]
  for (const [company, signal, quote] of cases) {
    const l = stored(company, signal, quote)
    const c = await checkLead(l, [], page(`<article><h1>${company}</h1><p>${quote}, the announcement said.</p></article>`))
    assert.deepEqual([company, c.proof, c.quote_on_page, c.signal_seen, isShown(c)], [company, 'confirmed', true, true, true])
  }
  // controls: detail and comment never stand in for the claim. The routine line is quoted and on the page; the first statement is not in it.
  const routine = 'Northwind Dental clinic opening hours Monday to Friday'
  // The last two were stated by this routine text under the whole-line rule, at 0ec2bd93: their detail words matched it.
  for (const signal of ['Opening a second clinic (Unit 6, 14 Main Street). The site lists its opening hours, Monday to Friday.', 'Opening a second clinic; clinics that open a second site often need a fit-out.', 'Opening a second clinic, Monday to Friday', 'Opening a second clinic; open Monday to Friday']) {
    const c = await checkLead(stored('Northwind Dental', signal, routine), [], page(`<h1>Northwind Dental</h1><p>${routine}. Call to book.</p>`))
    assert.deepEqual([signal, c.quote_on_page, c.signal_seen, isShown(c)], [signal, true, false, false])
  }
  // a first statement too short to be a claim is extended with what follows, so a place alone is never the claim
  assert.equal(statesSignal('In Toronto, opening a second clinic', 'Northwind Dental', 'Northwind Dental Toronto'), false)
  assert.equal(statesSignal('In Toronto, opening a second clinic', 'Northwind Dental', 'Northwind Dental will open its second clinic in Toronto'), true)
})
