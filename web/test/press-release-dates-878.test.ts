// #878 / #1107 (mission root cause 2): a lead whose source is a dated press release or a job posting was held as "outside_window_undated" although its page carried the
// day. Real data: the leads of the 2026-11-13 staging matrix run (Chicago law firms' press releases, a Toronto clinic's LinkedIn posting), read from the live pages on
// 2026-11-14. test/fixtures/real-press-pages-878.json keeps, per page, its title, its own publication metadata, the lead's stored signal and quote, and the schema.org nodes
// (trimmed to what the rule reads). Before: 0 of those 4 were dated; after: 4 of 4, each with its proof; the negatives are built from the SAME real nodes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { finishUndatedLeads, resolveStructuredDate, structuredProof } from '../lib/scan/structured-date.ts'
import { verifyLeads } from '../lib/scan/runner.ts'
import { splitByWindow } from '../lib/scan/window.ts'
import { isEventDateProof } from '../lib/scan/scoreboard.ts'
import { isAnnouncementDay } from '../lib/scan/announcement.ts'
import { cardDate } from '../lib/scan/lead-card.ts'
import { eventDateCopy } from '../lib/scan/date-copy.ts'

type Real = { company: string; url: string; signal: string; quote: string; title: string; published: string | null; structured: string[] }
const pages = (JSON.parse(readFileSync(new URL('./fixtures/real-press-pages-878.json', import.meta.url), 'utf8')) as { pages: Real[] }).pages
const real = (c: string): Real => pages.find(p => p.company === c)!
const resolve = (p: Real, o: Partial<Real> = {}) => { const q = { ...p, ...o }; return resolveStructuredDate(q.structured, q.company, `${q.signal} ${q.quote}`, [], { title: q.title, quote: q.quote, published: q.published }) }
const NOW = new Date('2026-11-13T18:00:00Z')

test('#878 the real press releases of Armstrong Teasdale, McGuireWoods and Benesch are dated by their own NewsArticle publication day; the Toronto clinic by its JobPosting day', () => {
  assert.deepEqual(resolve(real('Armstrong Teasdale')), { date: '2026-09-30', kind: 'NewsArticle' })
  assert.deepEqual(resolve(real('McGuireWoods')), { date: '2026-09-08', kind: 'NewsArticle' })
  assert.deepEqual(resolve(real('Benesch')), { date: '2026-09-10', kind: 'NewsArticle' })
  // a clinic listed on LinkedIn under its parent group ("123Dentist"): the posting's title names "Queen Street Dental" and its own text names "Queen Street Dental Centre"
  assert.deepEqual(resolve(real('Queen Street Dental Centre')), { date: '2026-11-06', kind: 'JobPosting' })
})

test('#878 what is NOT dated, on real pages: a press release whose event is still ahead (Milbank: "upon its opening"), a roundup blog, a careers page with no dated node', () => {
  assert.equal(resolve(real('Milbank LLP')), null, 'the office is not open yet: the story\'s day is not the opening\'s day')
  assert.equal(resolve(real('Nousu Collective')), null)
  assert.equal(resolve(real('Roof Royale')), null)
})

test('#878 each day carries its proof and says where it came from; a JobPosting day proves a hiring claim only', () => {
  assert.deepEqual(structuredProof({ date: '2026-09-30', kind: 'NewsArticle' })?.proof, 'page_bound')
  assert.match(structuredProof({ date: '2026-09-30', kind: 'NewsArticle' })!.note, /announcement's own publication day.*the day it took effect may differ/)
  assert.deepEqual(structuredProof({ date: '2026-11-06', kind: 'JobPosting' })?.proof, 'ats_structured')
  assert.equal(structuredProof({ date: '2026-11-06', kind: 'Event' }), null, 'an Event startDate keeps the behaviour it always had: a date, no proof')
  for (const p of ['page_bound', 'ats_structured']) assert.ok(isEventDateProof(p))
})

test('#878 negatives built from the real Armstrong Teasdale page: each rule that keeps a wrong day out', () => {
  const a = real('Armstrong Teasdale')
  assert.ok(resolve(a), 'the control')
  assert.equal(resolve({ ...a, company: 'Foley & Lardner' } as Real), null, 'the headline names another company')
  assert.equal(resolve(a, { quote: 'Armstrong Teasdale will add a partner in Chicago and plans to open a second office there.' }), null, 'a plan, not a done event')
  // the quote dates its own event, so the story's publication day is not read (a case study, a retrospective): any year, a month with a day, a relative past
  for (const quote of ['Armstrong Teasdale expanded in Chicago in 2019 with a new partner.', 'In March 2025 Armstrong Teasdale expanded in Chicago with a new partner.', 'Armstrong Teasdale expanded in Chicago on March 3 with a new partner.',
    'Armstrong Teasdale expanded in Chicago last year with a new partner.', 'Armstrong Teasdale expanded in Chicago three years ago with a new partner.', 'Armstrong Teasdale previously expanded in Chicago with a new partner.']) {
    assert.equal(resolve(a, { quote }), null, quote)
  }
  assert.equal(resolve(a, { title: 'Armstrong Teasdale Case Study: the Chicago expansion', quote: 'In March 2025 Armstrong Teasdale opened its Chicago office.' }), null)
  assert.equal(resolve(a, { title: 'Top 10 Chicago law firms expanding in 2026' }), null, 'a roundup title')
  assert.equal(resolve(a, { published: '2026-10-15' }), null, "the page's own metadata names another day")
  assert.equal(resolve(a, { structured: a.structured.map(b => b.replace('"datePublished"', '"dateModified"')) }), null, 'a modification stamp is never read')
  assert.equal(resolve(a, { structured: a.structured.map(b => b.replace('"NewsArticle"', '"BlogPosting"')) }), null, 'a blog is not a press release')
  // two different publication days: a list of items, none is this lead's (the page's own metadata names none of them, as on a list page)
  assert.equal(resolve(a, { published: null, structured: [...a.structured, a.structured[0].replace(/2026-09-30/g, '2026-08-01')] }), null)
  // when the page's own metadata names exactly one of them, that story is the page's
  assert.deepEqual(resolve(a, { structured: [...a.structured, a.structured[0].replace(/2026-09-30/g, '2026-08-01')] }), { date: '2026-09-30', kind: 'NewsArticle' })
  // a hiring claim is not dated by a news story
  assert.equal(resolve(a, { signal: 'is hiring a corporate associate', quote: 'Armstrong Teasdale is hiring a corporate associate in Chicago' }), null)
})

test('#878 through the scan steps (verifyLeads -> finishUndatedLeads -> the 90-day window): the four real leads are ready in the window, with their proof', async () => {
  const outcome: string[] = []
  for (const c of ['Armstrong Teasdale', 'McGuireWoods', 'Benesch', 'Queen Street Dental Centre']) {
    const r = real(c)
    const page = { text: `${r.title} ${r.quote}`, title: r.title, retrievedAt: 1, published: r.published, structured: r.structured }
    const cand = { name: '', company: c, contact: null, signal: r.signal, source_url: r.url, score: 70, excerpt: r.quote, event_date: null }
    const out = await verifyLeads([cand], async () => page, NOW)
    assert.equal(out.leads.length, 1, `${c} verified`)
    await finishUndatedLeads(out.leads, async () => page, 6, [])
    const l = out.leads[0] as { event_date: string | null; event_date_proof?: string | null; event_date_proof_note?: string | null; timing_note?: string | null }
    assert.ok(l.event_date, `${c} is dated`)
    assert.ok(isEventDateProof(l.event_date_proof), `${c} carries a proof`)
    assert.match(l.event_date_proof_note ?? '', /./)
    assert.equal(splitByWindow(out.leads, 90, NOW).inside.length, 1, `${c} is inside the 90-day window`)
    // the same lead found a year later is stale, never ready
    assert.equal(splitByWindow(out.leads, 90, new Date('2027-09-01T00:00:00Z')).inside.length, 0)
    outcome.push(`${c} ${l.event_date} ${l.event_date_proof}`)
  }
  assert.deepEqual(outcome, ['Armstrong Teasdale 2026-09-30 page_bound', 'McGuireWoods 2026-09-08 page_bound', 'Benesch 2026-09-10 page_bound', 'Queen Street Dental Centre 2026-11-06 ats_structured'])
})

test('#878 an announcement day is worded as one wherever the day is shown: "announced", never "event day verified"', () => {
  const note = structuredProof({ date: '2026-09-30', kind: 'NewsArticle' })!.note
  assert.ok(isAnnouncementDay(note))
  assert.ok(!isAnnouncementDay(structuredProof({ date: '2026-11-06', kind: 'JobPosting' })!.note))
  assert.ok(!isAnnouncementDay("the sentence names this company and the day"))
  assert.ok(!isAnnouncementDay(null))
  assert.equal(cardDate('2026-09-30', null, { dayVerified: true, announced: true }), "announced 30 Sep 2026 (the cited source's own publication day; the day it took effect may differ)")
  assert.match(cardDate('2026-09-30', null, { dayVerified: true, announced: true, windowMissed: true }), /outside the requested window/)
  assert.equal(cardDate('2026-09-30', null, { dayVerified: true }), 'event date 30 Sep 2026 (verified on the cited source)', 'a day the page states for the event reads as before')
  assert.match(eventDateCopy('2026-09-30', 'unverified', 'proof_backed', { announced: true }), /announced that day on the cited source; the day it took effect may differ - current need unconfirmed/)
  assert.match(eventDateCopy('2026-09-30', 'unverified', 'proof_backed'), /event day verified on the cited source/)
})
