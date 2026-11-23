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

// Review of #1575 at a2d8a45e: the event and its qualifier were still discardable. These are the review's own four cases, unchanged, on
// the three paths a lead can take (the text Claude's reader returned, dazl's own read, an unread search result's title).
test('#1575 the event and its qualifier are never set aside or outvoted: the review\'s four cases on the reader, dazl-read and unread-title paths', async () => {
  const routine = 'Northwind Dental clinic Toronto Ontario at 14 Main Street, opening hours Monday to Friday.'
  const cases = [
    { id: 'short-hours-negative', signal: 'Opening a second clinic', quote: routine, want: false },
    { id: 'address-hours-negative', signal: 'Opening a second clinic at 14 Main Street, open Monday to Friday', quote: routine, want: false },
    { id: 'location-preface-negative', signal: 'Northwind Dental clinic Toronto Ontario, opening a second clinic.', quote: routine, want: false },
    { id: 'announcement-positive', signal: 'Opening a second clinic', quote: 'Northwind Dental is opening a second clinic in Toronto.', want: true },
  ]
  for (const c of cases) for (const path of ['reader', 'dazl', 'title'] as const) {
    const l = parseLeads(JSON.stringify({ leads: [lead({ signal: c.signal, evidence_quote: c.quote, evidence_url: 'https://northwind.example/news', signal_date: null })] }), 1).leads[0]
    const seen = [{ url: l.evidence_url, title: c.quote, text: path === 'reader' ? c.quote : null, page_age: null }]
    const fetcher = (async () => path === 'dazl' ? new Response(c.quote) : new Response('', { status: 403 })) as unknown as typeof fetch
    const out = await checkLead(l, seen, fetcher)
    assert.equal(isShown(out), c.want, `${c.id} ${path}`)
    if (!c.want) assert.ok(out.claim_lacks.includes('second'), `${c.id} ${path}: the hold names the word the proof lacks`)
  }
})

test('#1575 a claim is judged against the page\'s own sentence, read to its end: not the run\'s excerpt, and not the sentence after it', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const of = (o: Record<string, unknown>) => parseLeads(JSON.stringify({ leads: [lead({ signal_date: null, evidence_url: 'https://proof.example/page', ...o })] }), 1).leads[0]
  const routine = 'Northwind Dental clinic opening hours Monday to Friday'
  // detail appended to the claim never carries it (the first two were accepted at 0ec2bd93, the third at a2d8a45e)
  for (const signal of ['Opening a second clinic, Monday to Friday', 'Opening a second clinic; open Monday to Friday', 'Opening a second clinic at 14 Main Street, open Monday to Friday', 'Opening a second clinic (Unit 6, 14 Main Street). The site lists its opening hours, Monday to Friday.']) {
    const c = await checkLead(of({ signal, evidence_quote: routine }), [], page(`<h1>Northwind Dental</h1><p>${routine} at 14 Main Street. Call to book.</p>`))
    assert.deepEqual([signal, c.quote_on_page, isShown(c)], [signal, true, false])
  }
  // the qualifier printed in the next sentence, or in another block, is not this sentence's word
  for (const body of [`<h1>Northwind Dental</h1><p>${routine}. Second floor, 14 Main Street.</p>`, `<h1>Northwind Dental</h1><p>${routine}</p><p>Second opinions welcome</p>`]) {
    const c = await checkLead(of({ signal: 'Opening a second clinic', evidence_quote: routine }), [], page(body))
    assert.deepEqual([c.quote_on_page, c.claim_lacks, isShown(c)], [true, ['second'], false], body)
  }
  // words the run put in its excerpt that the page does not print are not evidence, even when six consecutive quoted words are on the page
  const padded = await checkLead(of({ signal: 'Opening a second clinic', evidence_quote: `${routine} and will open its second clinic` }), [], page(`<h1>Northwind Dental</h1><p>${routine}.</p>`))
  assert.deepEqual([padded.quote_on_page, padded.claim_lacks, isShown(padded)], [true, ['second'], false])
  // a stored funding lead (staging, #1571): the line names the other investors, the stored quote stops before them, and the page's own
  // sentence (copied from the public page) goes on to name them. Read to its end, that sentence states the whole line.
  // (the line's "plus" and "with" are joining words; the page says "alongside" and "with participation from")
  const quote = 'London-based LO:TECH, a capital markets firm built for round-the-clock and onchain markets, has raised $12 million in a Series A funding round led by MMC'
  const line = 'Raised $12M Series A led by MMC, with existing investors Faction and 13 Books Capital, plus Atka'
  const article = (rest: string) => `<article><h1>London-based LO:TECH lands $12M Series A led by MMC</h1><p>London-based <a href="https://lo.example/">LO:TECH</a>, a capital markets firm built for round-the-clock and onchain markets, has raised $12 million in a Series A funding round led by <a href="https://mmc.example/">MMC</a>${rest}</p></article>`
  const whole = await checkLead(of({ company: 'LO:TECH', signal: line, evidence_quote: quote }), [], page(article(',\r\nwith participation from existing investors <a href="https://faction.example/">Faction</a> and 13 Books Capital,\r\nalongside Atka.')))   // the source wraps mid-sentence, as that page's does
  assert.deepEqual([whole.proof, whole.quote_on_page, whole.claim_lacks, isShown(whole)], ['confirmed', true, [], true])
  // the same line on a page whose sentence ends at the lead investor: the other investors are not proven, and the hold says which words
  const cut = await checkLead(of({ company: 'LO:TECH', signal: line, evidence_quote: quote }), [], page(article('.')))
  assert.deepEqual([cut.quote_on_page, isShown(cut)], [true, false])
  assert.deepEqual(cut.claim_lacks, ['exist', 'investor', 'faction', '13', 'book', 'atka'])
  // and the line that says only what the sentence says is shown
  assert.equal(isShown(await checkLead(of({ company: 'LO:TECH', signal: 'Raised $12M Series A led by MMC', evidence_quote: quote }), [], page(article('.')))), true)
})

// Review of #1575 at 0db467b5: the same quoted words stood in two unrelated statements, and the words of both were pooled into one
// piece of evidence. Each place the quote stands is its own evidence. The first two cases are the review's own, unchanged, on the
// reader and dazl-read paths.
test('#1575 a claim must be stated where the quote stands: statements that only share the quoted words are never pooled', async () => {
  const q = 'Northwind Dental opening hours run Monday to Friday'
  const cases = [
    { id: 'two-unrelated-matched-statements', quote: q, parts: [`${q} for the clinic.`, `${q}; the second page has information.`], want: false },
    { id: 'actual-event-completes-quote', quote: 'Northwind Dental issued a statement today', parts: ['Northwind Dental issued a statement today announcing it is opening a second clinic.'], want: true },
    // the same two statements written as one sentence: a semicolon ends a statement too
    { id: 'one-sentence-two-statements', quote: q, parts: [`${q} for the clinic; the second page has information.`], want: false },
    // three places, none of which says it; and the words of the claim spread over places that each hold the quote
    { id: 'three-places', quote: q, parts: [`${q}.`, `${q} at our clinic.`, `${q}, second floor.`], want: false },
    // one of several places does say it: that place alone is the proof
    { id: 'one-place-states-it', quote: 'Northwind Dental said today', parts: ['Northwind Dental said today that parking is free.', 'Northwind Dental said today it is opening a second clinic.'], want: true },
    // a quote that itself runs through two statements is read as both, there and nowhere else
    { id: 'quote-spans-two-statements', quote: 'has outgrown its site; Northwind Dental is opening a second clinic', parts: ['The practice has outgrown its site; Northwind Dental is opening a second clinic.'], want: true },
  ]
  for (const c of cases) for (const path of ['reader', 'dazl'] as const) {
    const l = parseLeads(JSON.stringify({ leads: [lead({ signal: 'Opening a second clinic', evidence_quote: c.quote, evidence_url: 'https://northwind.example/news', signal_date: null })] }), 1).leads[0]
    const seen = [{ url: l.evidence_url, title: 'Northwind Dental', text: path === 'reader' ? c.parts.join('\n') : null, page_age: null }]
    const fetcher = (async () => new Response(c.parts.map(x => `<p>${x}</p>`).join(''))) as unknown as typeof fetch
    const out = await checkLead(l, seen, fetcher)
    assert.deepEqual([out.quote_on_page, isShown(out)], [true, c.want], `${c.id} ${path}: ${JSON.stringify(out.claim_lacks)}`)
    if (!c.want) assert.ok(out.claim_lacks.length > 0, `${c.id} ${path}: the hold names what the nearest place lacks`)
  }
})

// #1037 (launch blocker). Production 2026-11-23: 10 of 12 leads named a person and none showed a LinkedIn profile. The people pass
// dropped a profile it found whenever the lead already had its person, and was never sent the person's name to look for.
test('#1037: a named person with no LinkedIn profile goes to the people pass; the profile is kept only for that same person, and only a profile address', () => {
  const base = parseLeads(JSON.stringify({ leads: [lead({ linkedin_url: null, email: 'dana@northwind-dental.example', email_source_url: 'https://northwind-dental.example/contact' })] }), 1).leads[0]
  assert.deepEqual([base.person, base.linkedin_url], ['Dana Ruiz', null])
  assert.equal(needsEnrichment(base), true, 'a named person with no profile still needs the pass')
  const found = (o: Record<string, unknown>) => parseEnriched(`<json>${JSON.stringify({ domain: null, person: 'Dana Ruiz', title: 'Owner', person_source_url: 'https://www.linkedin.com/in/dana-ruiz-dds/', linkedin_url: 'https://www.linkedin.com/in/dana-ruiz-dds/', ...o })}</json>`)
  const merged = mergeEnriched(base, found({}))
  assert.deepEqual([merged.person, merged.title, merged.person_source_url, merged.linkedin_url], ['Dana Ruiz', 'Practice Owner', 'https://www.northwind-dental.example/team', 'https://www.linkedin.com/in/dana-ruiz-dds/'], 'the first pass\'s person, title and source stay; only the empty profile is filled')
  assert.equal(needsEnrichment(merged), false)
  assert.equal(mergeEnriched(base, found({ person: 'dana  RUIZ' })).linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-dds/', 'the same name, whatever its case and spacing')
  assert.equal(mergeEnriched(base, found({ person: 'Dr. Dana M. Ruiz' })).linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-dds/', 'the same first and last name with a title or middle initial')
  assert.equal(mergeEnriched(base, found({ person: 'Daniel Ruiz' })).linkedin_url, null, 'another person\'s profile is not attached to this person')
  assert.equal(mergeEnriched(base, found({ person: 'Dana Reyes' })).linkedin_url, null)
  assert.equal(found({ linkedin_url: 'https://www.linkedin.com/company/northwind-dental/' }).linkedin_url, null, 'a company page is not a person\'s profile')
  assert.equal(found({ linkedin_url: 'https://www.linkedin.com/in/' }).linkedin_url, null)
  assert.equal(found({ linkedin_url: 'https://linkedin.com.evil.example/in/dana-ruiz' }).linkedin_url, null)
  assert.equal(found({ linkedin_url: 'https://ca.linkedin.com/in/dana-ruiz-dds' }).linkedin_url, 'https://ca.linkedin.com/in/dana-ruiz-dds', 'a country address of LinkedIn is LinkedIn')
})

test('#1037: the profile must be one the run actually saw in its search results or opened; the request names the person to look for', async () => {
  const { keepSeenProfile, enrichRequest } = await import('../lib/discover/enrich.ts')
  const seen = new Map([['https://www.linkedin.com/in/dana-ruiz-dds?trk=public', { url: 'https://www.linkedin.com/in/dana-ruiz-dds?trk=public', title: 'Dana Ruiz - Northwind Dental', page_age: null, text: null }]])
  const e = parseEnriched('<json>{"person":"Dana Ruiz","title":"Owner","person_source_url":"https://northwind-dental.example/team","linkedin_url":"https://www.linkedin.com/in/dana-ruiz-dds/"}</json>')
  assert.equal(keepSeenProfile(e, seen).linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-dds/', 'seen, whatever the tracking suffix or trailing slash')
  assert.equal(keepSeenProfile({ ...e, linkedin_url: 'https://www.linkedin.com/in/dana-ruiz-1a2b3c/' }, seen).linkedin_url, null, 'an address the run never saw is dropped: it may be made up')
  assert.equal(keepSeenProfile(e, new Map()).linkedin_url, null)
  const base = parseLeads(JSON.stringify({ leads: [lead({ linkedin_url: null })] }), 1).leads[0]
  assert.match(enrichRequest(base, null), /Person already found: Dana Ruiz, Practice Owner/)
  assert.doesNotMatch(enrichRequest({ ...base, person: null, title: null }, null), /Person already found/)
})

// Review of #1596: the profile check must use what THIS lead's lookup saw, and the result must name the person.
test('#1037: a profile seen for a same-named person in another lead\'s lookup, or a result that does not name the person, is not kept', async () => {
  const { keepSeenProfile } = await import('../lib/discover/enrich.ts')
  const e = parseEnriched('<json>{"person":"Dana Ruiz","title":"Owner","person_source_url":"https://northwind-dental.example/team","linkedin_url":"https://www.linkedin.com/in/dana-ruiz-dds/"}</json>')
  const hit = (title: string | null) => new Map([['https://www.linkedin.com/in/dana-ruiz-dds', { url: 'https://www.linkedin.com/in/dana-ruiz-dds', title, page_age: null, text: null }]])
  assert.equal(keepSeenProfile(e, hit('Dana Ruiz - Practice Owner - Northwind Dental | LinkedIn')).linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-dds/')
  assert.equal(keepSeenProfile(e, hit('Dana M. Ruiz, DDS | LinkedIn')).linkedin_url, 'https://www.linkedin.com/in/dana-ruiz-dds/')
  assert.equal(keepSeenProfile(e, hit('Daniel Ruiz - Harbour Smiles | LinkedIn')).linkedin_url, null, 'the result is someone else')
  assert.equal(keepSeenProfile(e, hit(null)).linkedin_url, null, 'a result with no title cannot show whose profile it is')
})

// Staging, 2026-11-23 (96111ddd): the every-word rule showed 1 of 15 real leads although 12 had their quote on a page naming the
// company. The shapes below are those leads' shapes with invented names: a long signal line with an address or a posting age, and a
// quote that the page prints. Words cannot settle such a lead, so Claude is asked one question; the word rule stays the fast path.
test('quote on the page, words unsettled: Claude is asked whether the quoted text states the claim, and only then', async () => {
  const page = (body: string) => (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  const asked: { signal: string; company: string; statements: string[] }[] = []
  const ask = (answer: boolean) => async (signal: string, company: string, statements: string[]) => { asked.push({ signal, company, statements }); return answer }
  const own = parseLeads(JSON.stringify({ leads: [lead({ signal: 'Opening a second clinic at 1448 Lawrence Avenue East, Suite 304A, currently in the midst of construction, planned to open in February', signal_date: null,
    evidence_url: 'https://northwind-dental.example/new-location', evidence_quote: 'Our second clinic is currently under construction and is planned to open in February' })] }), 1).leads[0]
  const body = '<html><body><h1>Northwind Dental</h1><p>Our second clinic is currently under construction and is planned to open in February. Call us to book.</p></body></html>'
  const strict = await checkLead(own, [], page(body))
  assert.deepEqual([strict.proof, strict.quote_on_page, strict.signal_seen, isShown(strict)], ['confirmed', true, false, false], 'with nobody to ask, the every-word rule decides alone, as before')
  const yes = await checkLead(own, [], page(body), 12_000, new Date(), ask(true))
  assert.deepEqual([yes.signal_seen, yes.signal_by, isShown(yes)], [true, 'claude', true])
  assert.deepEqual([asked.length, asked[0].company, asked[0].statements], [1, 'Northwind Dental', ['Our second clinic is currently under construction and is planned to open in February.']], 'asked once, with the page\'s own statement that holds the quote')
  const no = await checkLead(own, [], page(body), 12_000, new Date(), ask(false))
  assert.deepEqual([no.signal_seen, no.signal_by, isShown(no)], [false, 'claude', false], 'Claude says the text does not state the claim: the user\'s review')
  const broke = await checkLead(own, [], page(body), 12_000, new Date(), async () => { throw new Error('model unavailable') })
  assert.deepEqual([broke.signal_seen, isShown(broke)], [false, false], 'an asker that fails leaves the lead as the words left it')
  // never asked: the quote is not on the page (a directory page that only names the company), or the words already settle it
  asked.length = 0
  const dir = await checkLead(own, [], page('<html><body><h1>Northwind Dental</h1><p>Reviews, opening hours and directions for Northwind Dental. Open Monday to Friday.</p></body></html>'), 12_000, new Date(), ask(true))
  assert.deepEqual([dir.proof, dir.quote_on_page, isShown(dir), asked.length], ['confirmed', false, false, 0])
  const plain = parseLeads(JSON.stringify({ leads: [lead({ signal: 'Opening a second clinic', signal_date: null, evidence_url: 'https://northwind-dental.example/new-location', evidence_quote: 'Northwind Dental is opening a second clinic' })] }), 1).leads[0]
  const fast = await checkLead(plain, [], page('<html><body><p>Northwind Dental is opening a second clinic in March.</p></body></html>'), 12_000, new Date(), ask(false))
  assert.deepEqual([fast.signal_seen, fast.signal_by, asked.length], [true, undefined, 0], 'every word present: shown without a call')
  const { saysYes } = await import('../lib/discover/entail.ts')
  assert.deepEqual(['YES', ' yes.', 'Yes, it does', 'NO', 'no', 'Not sure', 'yesterday'].map(saysYes), [true, true, true, false, false, false, false])
})

// Staging 2026-11-23 (Quest, job bdbac19a): two proof links were dead (a 404, and a job board's "Job not found" page) and labelled
// verified; one live posting printed "Posted 4d ago" and was read as having no date.
test('a proof page that is gone is not proof; a posting age the page prints is its date', async () => {
  const page = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
  const now = new Date('2026-11-23T12:00:00Z')
  const l = parseLeads(JSON.stringify({ leads: [lead({ signal: 'Hiring an Account Executive', signal_date: null, evidence_url: 'https://jobs.example/northwind/ae', evidence_quote: 'Northwind Dental is hiring an Account Executive' })] }), 1).leads[0]
  const listedResult = [{ url: l.evidence_url, title: 'Northwind Dental is hiring an Account Executive', page_age: '3 days ago', text: null }]
  const nf = await checkLead(l, listedResult, page('Not Found', 404), 12_000, now)
  assert.deepEqual([nf.proof, isShown(nf)], ['gone', false], 'the address answers 404: a search result title does not bring it back')
  const soft = await checkLead(l, [], page('<html><title>Northwind Dental</title><body><h1>Job not found</h1><p>This job is no longer available. See all open roles at Northwind Dental.</p></body></html>'), 12_000, now)
  assert.deepEqual([soft.proof, isShown(soft)], ['gone', false], 'a page that says the job is gone')
  const readerGone = await checkLead(l, [{ url: l.evidence_url, title: 'Northwind Dental', page_age: null, text: 'Northwind Dental. Job not found.' }], page('x'), 12_000, now)
  assert.equal(readerGone.proof, 'gone', 'also when Claude\'s reader returned that text')
  const live = await checkLead(l, [], page('<html><body><h1>Account Executive</h1><p>Posted 4d ago</p><p>Northwind Dental is hiring an Account Executive to join the team. The last person in this role was promoted, and that position is closed.</p>' + '<p>About the role and the company, benefits and how to apply.</p>'.repeat(40) + '</body></html>'), 12_000, now)
  assert.deepEqual([live.proof, live.date, live.date_source, isShown(live)], ['confirmed', '2026-11-19', 'page', true], 'a live posting: its printed age is its date, and a long page that mentions a closed role is not gone')
  const { relativeDay } = await import('../lib/discover/check.ts')
  assert.equal(relativeDay('Posted 2 weeks ago', now), '2026-11-09')
  assert.equal(relativeDay('Posted 3 days ago ... Posted 9 days ago', now), null, 'a list of postings with different ages gives no date')
  assert.equal(relativeDay('We posted record results. 4 days ago we met.', now), null)
})
