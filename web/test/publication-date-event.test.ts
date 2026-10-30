// #460: an event day counts only when the FETCHED page ties it to THIS company and THIS event. A publication / update stamp (metadata or a visible
// "Published/Posted/Updated <day>" line), another company's announcement or an unrelated conference on the same day, a page with no date at all, and the model's own
// date are all undated research. Valid event-dated pages and genuine structured job-board dates keep working. Synthetic pages only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'
import { eventDateBound } from '../lib/scan/event-date-binding.ts'
import type { Page } from '../lib/scan/fetch-page.ts'

const NOW = new Date('2026-10-20T12:00:00Z')
const filler = ' The agency builds brand campaigns for Toronto restaurants and retailers across Ontario.'.repeat(4)
const QUOTE = 'Aurora Agency opened a new office on King Street West in Toronto, ON'
const lead = (event_date: string | null, o: Partial<LeadDraft> = {}): LeadDraft => ({ name: '', company: 'Aurora Agency', contact: null, signal: 'Opened a new office', source_url: 'https://news.example/aurora', score: 70, excerpt: QUOTE, event_date, ...o })
const page = (text: string, published: string | null = null): Page => ({ title: 'Aurora Agency', text, retrievedAt: NOW.getTime(), published })
const run = async (c: LeadDraft, p: Page, dates?: ReadonlyMap<string, string>) => { const o = await verifyLeads([c], async () => p, NOW, undefined, null, undefined, undefined, [], dates); return { lead: o.leads[0], review: o.review[0] } }
const undated = (l: { event_date: string | null; date_status?: string | null }) => { assert.equal(l.event_date, null); assert.equal(l.date_status, 'undated') }

test('negative 1: the fetched page has no date at all, so the model\'s date does not survive', async () => {
  const { lead: l } = await run(lead('2026-10-15'), page(`${QUOTE}.${filler}`))
  assert.ok(l, 'still source-checked'); undated(l)
  assert.match(l.timing_note ?? '', /not tied to this company and event/)
})

test('negative 2: published-only date for Aurora, plus an unrelated company\'s event on that day', async () => {
  const p = page(`Published 2026-10-15. ${QUOTE}. On October 15, 2026, Zenith Corp opened a new office in Ottawa.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), p)).lead)
})

test('negative 3: published-only date for Aurora, plus an unrelated conference on that day', async () => {
  const p = page(`Published 2026-10-15. ${QUOTE}. The Toronto Marketing Conference runs on October 15, 2026 at the convention centre.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), p)).lead)
  // even when the conference sentence names Aurora (as an attendee), it is a different event than the quote's
  const attends = page(`Published 2026-10-15. ${QUOTE}. Aurora Agency will attend the Toronto Marketing Conference on October 15, 2026.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), attends)).lead)
})

test('a publication / update stamp never dates the event: metadata, and every visible form', async () => {
  const meta = page(`${QUOTE}. Archive profile from our directory.${filler}`, '2026-10-15')
  undated((await run(lead('2026-10-15'), meta)).lead); assert.equal((await run(lead('2026-10-15'), meta)).lead.published_at, '2026-10-15')
  for (const stamp of ['Published 2026-10-15', 'Posted October 15, 2026', 'Updated Oct 15, 2026', 'Published 15 October 2026']) {
    const { lead: l } = await run(lead('2026-10-15'), page(`${stamp}. ${QUOTE}.${filler}`))
    undated(l)
    if (!/^Updated/.test(stamp)) assert.equal(l.published_at, '2026-10-15', `${stamp}: kept as a label`)
  }
})

test('valid event-dated pages keep their date: the same sentence as the quote, or a sentence naming the company and the same event', async () => {
  const same = page(`On October 15, 2026, ${QUOTE}.${filler}`, '2026-10-15')
  assert.equal((await run(lead('2026-10-15'), same)).lead.event_date, '2026-10-15')
  const also = page(`Published 2026-10-15. On October 15, 2026, ${QUOTE}.${filler}`)
  assert.equal((await run(lead('2026-10-15'), also)).lead.event_date, '2026-10-15')
  const neighbour = page(`${QUOTE}. Aurora Agency opened its new office to clients on 2026-10-09.${filler}`)
  assert.equal((await run(lead('2026-10-09'), neighbour)).lead.event_date, '2026-10-09')
})

test('structured job-board provenance: a collected posting date for exactly this URL is kept; a board-looking hostname alone is not', async () => {
  const job = lead('2026-10-12', { source_url: 'https://boards.greenhouse.io/aurora/jobs/1', excerpt: 'Aurora Agency is hiring an Account Executive in Toronto, ON' })
  const p = page(`Aurora Agency is hiring an Account Executive in Toronto, ON.${filler}`)
  assert.equal((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/1', '2026-10-12']]))).lead.event_date, '2026-10-12')
  undated((await run(job, p)).lead)                                                                         // ATS hostname, no collected date
  undated((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/2', '2026-10-12']]))).lead) // another posting's date
  undated((await run(job, p, new Map([['https://boards.greenhouse.io/aurora/jobs/1', '2026-09-01']]))).lead) // a different day than the claim
})

test('an old year in the quote is still held as stale; a bound date is judged by the window as before', async () => {
  const old = { ...lead('2026-10-15'), excerpt: `${QUOTE} in 2019` }
  const r = await run(old, page(`On October 15, 2026, ${QUOTE} in 2019.${filler}`, '2026-10-15'))
  assert.equal(r.lead, undefined); assert.equal(r.review.review_reason, 'event_date_stale')
})

test('eventDateBound: day found, sentence-bound to company + event; stamps, other companies and other events do not bind', () => {
  const b = (text: string) => eventDateBound('2026-10-15', text, QUOTE, 'Aurora Agency')
  assert.equal(b(`On 15 October 2026, ${QUOTE}.`).bound, true)
  assert.equal(b(`${QUOTE}.`).why, 'the fetched page never states that day')
  assert.equal(b(`Posted 15 October 2026. ${QUOTE}.`).why, 'the day appears only as a publication / update stamp')
  assert.equal(b(`${QUOTE}. Zenith Corp opened a new office on 2026-10-15.`).bound, false)
  assert.equal(b(`${QUOTE}. Aurora Agency sponsors a gala on 2026-10-15.`).bound, false, 'same company, different event')
  assert.equal(b(`2026-10-15. ${QUOTE}.`).bound, false, 'a bare date line before the quote is not a statement about it')
  assert.equal(eventDateBound(null, 'x', QUOTE, 'Aurora Agency').bound, false)
})

// ---- #460 review holds (Instinct, 7463ef2) ----
import { HeldText } from '../lib/scan/held-text.ts'
import { eventYears } from '../lib/scan/date-in-text.ts'
import { resolveTiming } from '../lib/scan/page-timing.ts'

test('hold 1: a day in ANOTHER clause about another company does not date this event; a genuinely dated Aurora clause still does', async () => {
  const mixed = 'Aurora Agency opened a new office on King Street West in Toronto, ON, while UnrelatedCo launched a tool on 2026-10-15.'
  // the helper, with the whole sentence as the quote (the case reviewed) and with Aurora's clause as the quote
  for (const quote of [mixed.replace(/\.$/, ''), QUOTE]) assert.equal(eventDateBound('2026-10-15', `${mixed}${filler}`, quote, 'Aurora Agency').bound, false, quote)
  for (const join of ['; ', ', and ', ' but ', ' whereas ', ', after ', ' before ', ' following ', ' until ']) assert.equal(eventDateBound('2026-10-15', `${QUOTE}${join}UnrelatedCo launched a tool on 2026-10-15.`, QUOTE, 'Aurora Agency').bound, false, join)
  // the real verifier
  undated((await run(lead('2026-10-15', { excerpt: mixed.replace(/\.$/, '') }), page(`${mixed}${filler}`))).lead)
  // genuinely dated Aurora events still bind, in the same clause, before or after
  const dated = [`${QUOTE} on 2026-10-15, while UnrelatedCo launched a tool.`, `On October 15, 2026, ${QUOTE}, while UnrelatedCo launched a tool.`, `${QUOTE} on 15 October 2026.`]
  for (const t of dated) assert.equal(eventDateBound('2026-10-15', `${t}${filler}`, QUOTE, 'Aurora Agency').bound, true, t)
  // non-Latin names bind by the name itself (no a-z words to match): Hindi, Arabic, Japanese
  for (const [co, q] of [['शर्मा कोचिंग सेंटर', 'शर्मा कोचिंग सेंटर ने इस महीने दिल्ली में अपनी नई शाखा खोली है'], ['شركة الخليج للشحن', 'شركة الخليج للشحن افتتحت مستودعا جديدا في دبي'], ['さくら歯科クリニック', 'さくら歯科クリニックは東京の渋谷に新しい医院を開業しました']]) {
    assert.equal(eventDateBound('2026-10-15', `2026-10-15: ${q}. ${filler}`, q, co).bound, true, co)
    assert.equal(eventDateBound('2026-10-15', `${q}; UnrelatedCo launched a tool on 2026-10-15.`, q, co).bound, false, `${co}: another clause`)
  }
  // a Latin name binds by its words, never as a substring of another name or word ("Nova" is not "Novartis")
  assert.equal(eventDateBound('2026-10-15', 'Nova opened a new office in Berlin; Novartis launched a tool on October 15, 2026.', 'Nova opened a new office in Berlin', 'Nova').bound, false)
  assert.equal(eventDateBound('2026-10-15', 'Nova opened a new office in Berlin on October 15, 2026.', 'Nova opened a new office in Berlin', 'Nova').bound, true)
  // ", as the firm said on <day>" is the company's own statement: still bound
  assert.equal(eventDateBound('2026-10-15', `${QUOTE}, as Aurora Agency said on October 15, 2026.`, QUOTE, 'Aurora Agency').bound, true)
  // no other subject between Aurora and the day: the continuation of its own statement still dates it
  assert.equal(eventDateBound('2026-10-15', `${QUOTE}, and on 2026-10-15 the ribbon was cut.`, QUOTE, 'Aurora Agency').bound, true)
  const ok = (await run(lead('2026-10-15'), page(`${dated[0]}${filler}`))).lead
  assert.deepEqual([ok.event_date, ok.date_status], ['2026-10-15', 'unverified'])
})

test('hold 2: the blocked-source fallback binds the date on the HELD copy before promotion', async () => {
  const url = 'https://news.example/aurora'
  const blocked = async () => ({ fail: 'blocked' as const })
  const heldBody = (body: string) => ({ text: HeldText.seal('job1:1', [url], [{ url, title: 'Aurora Agency', text: body }]), attempt: 'job1:1' })
  // the held copy names no date: the model's Oct 15 does not survive promotion
  const noDate = await verifyLeads([lead('2026-10-15')], blocked, NOW, undefined, null, heldBody(`${QUOTE}.${filler}`))
  assert.equal(noDate.leads.length, 1); assert.equal(noDate.leads[0].evidence_origin, 'tinyfish_copy')
  undated(noDate.leads[0]); assert.match(noDate.leads[0].timing_note ?? '', /not tied to this company and event by the held copy/)
  // another clause's day on the held copy does not either
  undated((await verifyLeads([lead('2026-10-15')], blocked, NOW, undefined, null, heldBody(`${QUOTE}, while UnrelatedCo launched a tool on 2026-10-15.${filler}`))).leads[0])
  // a claimed day the date rules reject stays held (never laundered to undated), and so does a quote naming an old year
  for (const [ev, ex] of [['2020-01-05', QUOTE], ['2026-10-15', `${QUOTE} in 2019`]] as const) {
    const r = await verifyLeads([lead(ev, { excerpt: ex })], blocked, NOW, undefined, null, heldBody(`${ex}.${filler}`))
    assert.equal(r.leads.length, 0, `${ev} / ${ex}`); assert.equal(r.review[0]?.review_reason, 'blocked_by_site')
  }
  // control: the held copy dates Aurora's opening itself
  const dated = await verifyLeads([lead('2026-10-15')], blocked, NOW, undefined, null, heldBody(`${QUOTE} on 2026-10-15.${filler}`))
  assert.deepEqual([dated.leads[0].event_date, dated.leads[0].evidence_origin], ['2026-10-15', 'tinyfish_copy'])
})

test('hold 3: company background years ("founded in 2020") never make a fresh, explicitly dated event stale', async () => {
  const quote = 'Aurora Agency, founded in 2020 and incorporated in 2021, opened a new office on King Street West in Toronto, ON on 2026-10-15'
  assert.equal(eventDateBound('2026-10-15', `${quote}.${filler}`, quote, 'Aurora Agency').bound, true)
  const r = await run(lead('2026-10-15', { excerpt: quote }), page(`${quote}.${filler}`))
  assert.ok(r.lead, JSON.stringify(r.review)); assert.equal(r.lead.event_date, '2026-10-15')
  // undated path too: a background year is not "the quote names an old year"
  assert.equal(resolveTiming(`${quote}.`, quote.replace(' on 2026-10-15', ''), null, 2026).olderYear, null)
  // controls: the EVENT's own old year is still stale, in both checks
  const old = 'Aurora Agency opened a new office on King Street West in Toronto, ON in 2019'
  assert.match(eventDateBound('2026-10-15', `${old} on 2026-10-15.`, old, 'Aurora Agency').why, /names 2019/)
  assert.equal(resolveTiming(`${old}.`, old, null, 2026).olderYear, 2019)
  assert.deepEqual(eventYears('founded in 2020, incorporated in 2018, in business since 2015, operating since 2014; opened in 2019 and moved 2024'), [2019, 2024])
  // event verbs are not background: their year is the event's, and an old one is still stale
  for (const ev of ['Aurora Agency and Beta formed a joint venture formed in 2019', 'Aurora Agency announced its Austin office established in 2019', 'Aurora Agency has had an office on King Street West since 2019']) {
    assert.equal(resolveTiming(`Published 2026-10-15. ${ev}.`, ev, null, 2026).olderYear, 2019, ev)
    assert.match(eventDateBound('2026-10-15', `${ev} on 2026-10-15.`, ev, 'Aurora Agency').why, /names 2019/, ev)
  }
})

// ---- council round 1 (findings on bc1f7bfe) ----
test('council: a claimed day the date rules reject is never laundered to undated on a FETCHED page either', async () => {
  for (const [d, why] of [['2019-10-15', 'event_date_stale'], ['2027-06-01', 'event_date_future_date'], ['2026-02-30', 'event_date_bad_date']] as const) {
    const r = await run(lead(d), page(`${QUOTE}.${filler}`))
    assert.equal(r.lead, undefined, d); assert.equal(r.review?.review_reason, why, d)
  }
})

test('council: other-clause days stay unbound for more joins and scripts; genuine dated clauses still bind', () => {
  const b = (text: string, quote = QUOTE, co = 'Aurora Agency') => eventDateBound('2026-10-15', text, quote, co).bound
  for (const t of [`${QUOTE} and UnrelatedCo launched a tool on October 15, 2026.`, `${QUOTE} - UnrelatedCo launched a tool on October 15, 2026.`, `${QUOTE} (UnrelatedCo launched a tool on October 15, 2026).`, `${QUOTE}, months after UnrelatedCo launched a tool on October 15, 2026.`]) assert.equal(b(t), false, t)
  // Japanese / Hindi: the native clause and sentence marks split too
  assert.equal(b('オーロラ株式会社は東京で新しいオフィスを開設し、別会社は2026-10-15に製品を発表しました。', 'オーロラ株式会社は東京で新しいオフィスを開設し', 'オーロラ株式会社'), false)
  assert.equal(b('शर्मा कोचिंग सेंटर ने नई शाखा खोली। दूसरी कंपनी ने 2026-10-15 को उत्पाद लॉन्च किया।', 'शर्मा कोचिंग सेंटर ने नई शाखा खोली', 'शर्मा कोचिंग सेंटर'), false)
  // the company's own name is never split, a parenthesis after the name does not cut the clause, and "announced on <day>" is not a stamp
  assert.equal(b('Smith and Sons opened a new office on King Street West on October 15, 2026.', 'Smith and Sons opened a new office on King Street West', 'Smith and Sons'), true)
  assert.equal(b('Better But Cheaper opened a new store in Toronto on October 15, 2026.', 'Better But Cheaper opened a new store in Toronto', 'Better But Cheaper'), true)
  assert.equal(b(`Aurora Agency (Toronto) opened a new office on King Street West on October 15, 2026.`, 'Aurora Agency (Toronto) opened a new office on King Street West'), true)
  assert.equal(b(`Aurora Agency announced on October 15, 2026 that it opened a new office on King Street West in Toronto, ON.`, 'Aurora Agency announced on October 15, 2026 that it opened a new office on King Street West in Toronto, ON'), true)
  // another sentence about a DIFFERENT event of the same company does not date this one
  assert.equal(b(`${QUOTE}. Aurora Agency closed its office on King Street West in Toronto on October 15, 2026.`), false)
  assert.equal(b(`${QUOTE}. Aurora Agency opened the King Street West office in Toronto on October 15, 2026.`), true)
  // relative clauses about another company split; one about this company does not
  for (const rel of ['which', 'who']) assert.equal(b(`Aurora Agency opened a new office in Berlin with UnrelatedCo, ${rel} launched a tool on October 15, 2026.`, 'Aurora Agency opened a new office in Berlin'), false, rel)
  assert.equal(b('Aurora Agency, which opened a new office on King Street West on October 15, 2026, is hiring.', 'Aurora Agency, which opened a new office on King Street West'), true)
  // " and " splits only before another subject's verb: place and partner lists stay whole
  assert.equal(b('Aurora Agency opened new offices in Toronto and Vancouver on October 15, 2026.', 'Aurora Agency opened new offices in Toronto and Vancouver'), true)
  // a dateline opening the sentence is a stamp, like Posted / Published
  assert.equal(b('Announced on October 15, 2026: Aurora Agency opened a new office on King Street West.', 'Aurora Agency opened a new office on King Street West'), false)
  // a cut quote's ellipsis does not hide it
  assert.equal(b(`${QUOTE} on October 15, 2026.`, `...${QUOTE}`), true)
})

test('council: a held copy with a future or malformed claimed day stays held too', async () => {
  const url = 'https://news.example/aurora'
  const blocked = async () => ({ fail: 'blocked' as const })
  for (const d of ['2027-06-01', '2026-02-30']) {
    const r = await verifyLeads([lead(d)], blocked, NOW, undefined, null, { text: HeldText.seal('job1:1', [url], [{ url, title: 'Aurora Agency', text: `${QUOTE}.${filler}` }]), attempt: 'job1:1' })
    assert.equal(r.leads.length, 0, d); assert.equal(r.review[0]?.review_reason, 'blocked_by_site', d)
  }
})

// ---- council round 2: no other subject between the company and its day (Latin script) ----
test('council r2: another subject in between unbinds; datelines, place lists, parentheses and asides without one still bind', () => {
  const Q = 'Aurora Agency opened a new office in Austin'
  const b = (text: string, quote = Q) => eventDateBound('2026-10-15', text, quote, 'Aurora Agency').bound
  for (const t of [`${Q}, as UnrelatedCo launched a tool on October 15, 2026.`, `${Q}, so UnrelatedCo launched a tool on October 15, 2026.`, `${Q}: UnrelatedCo launched a tool on October 15, 2026.`, `${Q}, UnrelatedCo launched a tool on October 15, 2026.`,
    `${Q} and rival firm UnrelatedCo launched a tool on October 15, 2026.`, `${Q} and the CEO of UnrelatedCo launched a tool on October 15, 2026.`, `${Q} with UnrelatedCo, which launched a tool on October 15, 2026.`]) assert.equal(b(t), false, t)
  for (const t of ['TORONTO, Oct. 15, 2026 — Aurora Agency opened a new office in Austin.', 'AUSTIN, Texas, October 15, 2026 - Aurora Agency opened a new office in Austin.', 'TORONTO (October 15, 2026) - Aurora Agency opened a new office in Austin.',
    'Aurora Agency opened a new office in Austin (October 15, 2026).', 'Aurora Agency opened new offices in Austin and Vancouver on October 15, 2026.', 'Aurora Agency, after months of planning, opened a new office in Austin on October 15, 2026.',
    'Aurora Agency opened a pop-up office in Austin that runs until October 15, 2026.', 'Aurora Agency, as the firm said on October 15, 2026, opened a new office in Austin.']) assert.equal(b(t), true, t)
  // the predicate of the quote skips adverbs: "today announced" finds "announced"
  assert.equal(eventDateBound('2026-10-15', 'Aurora Agency today announced its expansion to Austin. Aurora Agency announced the Austin expansion office on October 15, 2026.', 'Aurora Agency today announced its expansion to Austin', 'Aurora Agency').bound, true)
})

test('council r3: a connective starts another statement whatever case its subject is in; the quote\'s own capitals and suffixes stay the company\'s', () => {
  const Q = 'Aurora Agency opened a new office in Austin'
  const b = (text: string, quote = Q) => eventDateBound('2026-10-15', text, quote, 'Aurora Agency').bound
  for (const t of [
    `${Q}, while the city launched a grant program on 2026-10-15.`, `${Q}, while its former parent launched a tool on 2026-10-15.`, `${Q}, but eBay launched a tool on 2026-10-15.`,
    `${Q} but its former landlord sold the building on 2026-10-15.`, `${Q}, and a local bakery next door opened on 2026-10-15.`, `${Q}, months before the city held a festival on 2026-10-15.`,
    'UnrelatedCo launched a tool on 2026-10-15, while Aurora Agency opened a new office in Austin.', 'UnrelatedCo left Austin on 2026-10-15 before Aurora Agency opened a new office in Austin.',
    `${Q} next to UnrelatedCo, which launched a tool on 2026-10-15.`, 'Aurora Agency opened a new office in Austin, Zenith Corp opened one in Toronto on 2026-10-15.',
    `${Q}, and the city will launch a grant on 2026-10-15.`, `${Q} and the city opens a park on 2026-10-15.`,
    'UnrelatedCo launched a tool on 2026-10-15, as Aurora Agency opened a new office in Austin.', 'The city launched a grant on 2026-10-15 as Aurora Agency opened a new office in Austin.',
  ]) assert.equal(b(t), false, t)
  // the whole sentence as the quote does not make the other company's name the company's own
  for (const t of ['Aurora Agency opened a new office in Berlin as UnrelatedCo launched a tool on 2026-10-15', 'Aurora Agency opened a new office in Berlin when UnrelatedCo launched a tool on 2026-10-15',
    'Aurora Agency opened a new office in Berlin, with UnrelatedCo launching a tool on 2026-10-15', 'Aurora Agency opened a new office in Berlin, UnrelatedCo launched a tool on 2026-10-15',
    'Aurora Agency opened a new office in Berlin: UnrelatedCo launched a tool on 2026-10-15', 'Aurora Agency opened a new office in Berlin and Zenith Corp launches a tool on 2026-10-15',
    "Aurora Agency opened a new office in Berlin after UnrelatedCo's launch on 2026-10-15", 'Aurora Agency opened a new office in Berlin alongside UnrelatedCo, launching a tool on 2026-10-15']) assert.equal(b(`${t}.`, t), false, t)
  for (const t of [`${Q}, and a local bakery opens on 2026-10-15.`, `${Q}, as its rival launched a tool on 2026-10-15.`, `${Q}, when its rival launched a tool on 2026-10-15.`, `${Q}, so the city held a festival on 2026-10-15.`]) assert.equal(b(t), false, t)
  assert.equal(b(`${Q} as part of its expansion on 2026-10-15.`), true)
  assert.equal(b(`${Q} as planned on 2026-10-15.`), true)
  for (const t of [`${Q}, Zenith held a gala on 2026-10-15.`, `${Q}, UnrelatedCo's new tool launched on 2026-10-15.`, `${Q}, UnrelatedCo CEO Jane Doe said on 2026-10-15.`, `${Q}, and the mayor spoke on 2026-10-15.`]) assert.equal(b(t), false, t)
  assert.equal(b('Aurora Agency opened a new office in Austin, Texas on 2026-10-15.', 'Aurora Agency opened a new office in Austin, Texas'), true)
  const own = 'Aurora Agency signed a lease and officially opened its Toronto office on 2026-10-15'
  assert.equal(b(`${own}.`, own), true)   // the company's own compound predicate
  for (const t of [`${Q} on 2026-10-15 after months of planning.`, `${Q} on 2026-10-15, and hired ten designers.`, `${Q} after it signed a lease on 2026-10-15.`]) assert.equal(b(t), true, t)
  assert.equal(b('Aurora Agency sold its old office to UnrelatedCo, which launched a tool on 2026-10-15.', 'Aurora Agency sold its old office to UnrelatedCo'), false)
  assert.equal(b('Aurora Agency hired a director from Zenith, who launched a tool on 2026-10-15.', 'Aurora Agency hired a director from Zenith'), false)
  // positives: the quote's own capitals, the company's own suffix and "which", and the same statement continued
  assert.equal(b('Aurora Agency opened its Toronto office on 2026-10-15.', 'Aurora Agency opened its Toronto office'), true)
  assert.equal(b('Aurora Agency CEO Jane Smith opened a new office in Berlin on 2026-10-15.', 'Aurora Agency CEO Jane Smith opened a new office in Berlin'), true)
  assert.equal(b('Aurora Agency Inc. opened a new office in Austin on 2026-10-15.', 'Aurora Agency Inc. opened a new office in Austin'), true)
  assert.equal(b('Aurora Agency, which opened a new office in Austin on 2026-10-15, is hiring.', 'Aurora Agency, which opened a new office in Austin'), true)
  assert.equal(b(`${Q}, and on 2026-10-15 the ribbon was cut.`), true)
  assert.equal(b('TORONTO, Oct. 15, 2026 /PRNewswire/ — Aurora Agency today opened a new office in Austin.', 'Aurora Agency today opened a new office in Austin'), true)
})

test('takeover: a name inside another subject\'s modifier does not own that subject\'s event day', async () => {
 const wrong = [
  'UnrelatedCo, which partners with Aurora Agency, opened a new office on King Street West in Toronto, ON on 2026-10-15',
  'UnrelatedCo, whose partner Aurora Agency is growing, opened a new office in Toronto on 2026-10-15',
  'UnrelatedCo hired Aurora Agency and opened a new office in Toronto on 2026-10-15',
  'UnrelatedCo, a partner of Aurora Agency, opened a new office on King Street West in Toronto, ON on 2026-10-15',
  'UnrelatedCo (Aurora Agency partner) opened a new office on King Street West in Toronto, ON on 2026-10-15',
  'UnrelatedCo worked alongside Aurora Agency and opened a new office on King Street West in Toronto, ON on 2026-10-15',
  'UnrelatedCo opened a new office for Aurora Agency in Toronto on 2026-10-15',
  "Aurora Agency's partner opened a new office in Toronto on 2026-10-15",
 ]
 for (const quote of wrong) {
  assert.equal(eventDateBound('2026-10-15',`${quote}.${filler}`,quote,'Aurora Agency').bound,false,quote)
  const verified=await run(lead('2026-10-15',{excerpt:quote}),page(`${quote}.${filler}`))
  assert.ok(verified.lead,JSON.stringify(verified.review)); undated(verified.lead)
  const url='https://news.example/aurora'
  const held=await verifyLeads([lead('2026-10-15',{excerpt:quote})],async()=>({fail:'blocked' as const}),NOW,undefined,null,{text:HeldText.seal('subject:1',[url],[{url,title:'Aurora Agency',text:`${quote}.${filler}`}]),attempt:'subject:1'})
  assert.equal(held.leads.length,1); undated(held.leads[0])
 }
 for (const quote of [
  'Aurora Agency (Toronto) opened a new office in Toronto on 2026-10-15',
  'On 2026-10-15, Aurora Agency opened a new office in Toronto',
 ]) assert.equal(eventDateBound('2026-10-15',quote,quote,'Aurora Agency').bound,true,quote)
})


test('takeover: a reporting company does not acquire its client or ambiguous firm event date', async () => {
 for (const reporting of ['announced its client','said the company','reported its partner','confirmed that the firm']) {
  const quote='Aurora Agency opened a new office in Toronto'
  const text=`${quote}. Aurora Agency ${reporting} opened a new office in Toronto on 2026-10-15.${filler}`
  assert.equal(eventDateBound('2026-10-15',text,quote,'Aurora Agency').bound,false,reporting)
  undated((await run(lead('2026-10-15',{excerpt:quote}),page(text))).lead)
 }
})
