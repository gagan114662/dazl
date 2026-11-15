// Research engine orchestration (MISSION v2 part A): stage order, the between-stage rules (literal quote pre-check, window, one event per company,
// company budget) and the funnel, with every stage stubbed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runResearch, pickEvents, quoteOnPage, researchReady, researchEngineOn, companyKey } from '../lib/research/engine.ts'
import type { ResearchCase, ResearchEvent, Candidate, CompanyResearch, Verification } from '../lib/research/types.ts'

const C: ResearchCase = { tenant: 't', jobId: 'j', query: 'q', offer: 'o', where: 'Chicago, Illinois', category: 'law firms', windowDays: 90, today: '2026-11-15' }
const ev = (company: string, o: Partial<ResearchEvent> = {}): ResearchEvent => ({ company, website: null, pageIsCompanySite: false, triggerId: 't1', whatHappened: 'opened an office',
  whyNow: 'x', quote: `${company} has moved into a new downtown office`, eventDate: '2026-10-02', dateQuote: 'October 2, 2026', locationQuote: null, people: [], sourceUrl: `https://n.test/${company}`, indexDate: null, foundBy: 'q', ...o })
const page = (e: ResearchEvent) => `News. ${e.quote}. More text.`

test('the literal quote pre-check folds whitespace, case and curly quotes only', () => {
  assert.ok(quoteOnPage('Zayed Law  has moved', 'x zayed law has moved y'))
  assert.ok(quoteOnPage('the firm’s new office opened', "The firm's new office opened today"))
  assert.equal(quoteOnPage('Zayed Law has moved', 'Zayed Law moved'), false)
  assert.equal(quoteOnPage('short', 'short'), false, 'a quote too short to prove anything')
})

test('pickEvents: quote off the page, outside the window and the second event of a company are dropped; page-dated first', () => {
  const a = ev('Zayed Law'), b = ev('Zayed Law LLC', { eventDate: null, indexDate: '2026-10-01', people: [{ name: 'A', title: 'Founder', quote: 'A, Founder' }] })
  const old = ev('Old Firm', { eventDate: '2026-01-01' }), fut = ev('Future Firm', { eventDate: '2026-12-01' }), off = ev('Off Page')
  const undated = ev('Undated Firm', { eventDate: null })
  const r = pickEvents(C, [{ ev: b, pageText: page(b) }, { ev: a, pageText: page(a) }, { ev: old, pageText: page(old) }, { ev: fut, pageText: page(fut) }, { ev: off, pageText: 'nothing' }, { ev: undated, pageText: page(undated) }])
  assert.deepEqual(r.kept.map(e => e.company), ['Zayed Law', 'Undated Firm'])
  assert.deepEqual(r.dropped, { outside_window: 2, quote_not_on_page: 1, same_company: 1 })
  assert.equal(companyKey('Zayed Law LLC'), companyKey('Zayed Law'))
})

test('runResearch: stages in order, only trigger-verified leads returned, the company budget and the funnel', async () => {
  const order: string[] = []
  const cands: Candidate[] = ['a', 'b', 'c'].map(x => ({ url: `https://n.test/${x}`, title: x, snippet: '', date: null, triggerId: 't1', query: 'q', via: 'tinyfish' }))
  const v = (ok: boolean, ready: boolean): Verification => ({ triggerLiteral: ok, triggerP: 1, triggerOk: ok, date: '2026-10-02', dateTier: 'page', dateInWindow: true, personOk: ready, personP: 1, personTier: 'page', personUrl: null, placeP: 1, categoryP: 1, placeCategoryOk: true, ready, why: [] })
  const research = (person: boolean): CompanyResearch => ({ site: null, sources: [], person: person ? { name: 'P', title: 'CEO', sourceId: 'S1', quote: 'P, CEO', profileUrl: null, from: 'research' } : null, location: null, whatTheyDo: null, emails: [] })
  const s = {
    plan: async () => { order.push('plan'); return { persona: '', decisionMakerTitles: [], triggers: [{ id: 't1', name: 'n', why: '', footprint: '', queries: ['q q'] }], askingQueries: [], source: 'model' as const } },
    hunt: async () => { order.push('hunt'); return { candidates: cands, queries: 1, failed: {}, stopped: null, funnel: { stage: 'hunt' as const, in: 1, out: 3, dropped: {} } } },
    filter: async (_c: unknown, _p: unknown, all: Candidate[]) => { order.push('filter'); return { all: all.map((x, i) => i === 2 ? { ...x, dropped: 'filter' } : x), keep: all.slice(0, 2) } },
    read: async (_c: unknown, _p: unknown, x: Candidate) => { order.push('read'); const e = [ev(`Acme${x.title}`), ev(`Beta${x.title}`)]; return { events: e, pageText: e.map(page).join(' ') } },
    gate: async (_c: unknown, es: ResearchEvent[]) => { order.push('gate'); return es.filter(e => e.company !== 'Betab') },
    research: async (_c: unknown, _p: unknown, e: ResearchEvent) => research(e.company !== 'Betaa'),
    verify: async (_c: unknown, e: ResearchEvent) => v(e.company !== 'Acmeb', e.company === 'Acmea'),
  }
  assert.ok(researchReady(s)); assert.equal(researchReady({ plan: s.plan, hunt: s.hunt }), false)
  const r = await runResearch(C, s, { maxCompanies: 3 })
  assert.deepEqual(order.slice(0, 3), ['plan', 'hunt', 'filter']); assert.equal(order.at(-1), 'gate')
  assert.deepEqual(r.leads.map(l => [l.event.company, l.verification.ready]), [['Acmea', true], ['Betaa', false]])
  const st = Object.fromEntries(r.funnel.stages.map(x => [x.stage, [x.in, x.out]]))
  assert.deepEqual(st, { understand: [1, 1], hunt: [1, 3], filter: [3, 2], read: [2, 4], gate: [4, 3], research: [3, 2], verify: [3, 1] })
  assert.deepEqual(r.funnel.stages.find(x => x.stage === 'filter')!.dropped, { filter: 1 })
  assert.equal(researchEngineOn({ LEAD_ENGINE: 'research' }), true); assert.equal(researchEngineOn({}), false)
})
