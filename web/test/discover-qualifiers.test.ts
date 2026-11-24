// What a request asks for beyond the event (a role, a first hire, a funding stage, a time window) is checked against the lead's
// proof page (lib/discover/qualifiers.ts, lib/discover/check.ts qualify). Refs #1037, #1400.
// Production, 2026-11-24: the search "SaaS startups hiring their first salesperson" listed six leads as confirmed and a second
// reader found one that met the request. The request text below is that search's; every company and page is invented. No network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkLead, isShown, type AskQualifiers, type RequestCheck } from '../lib/discover/check.ts'
import { requestQualifiers } from '../lib/discover/qualifiers.ts'
import { signalJudge, yesNoList } from '../lib/discover/entail.ts'
import type { DiscoveredLead, SeenPage } from '../lib/discover/agent.ts'

const NOW = new Date('2026-11-24T12:00:00Z')
const FIRST_SALES = 'SaaS startups hiring their first salesperson'
const URL_AE = 'https://brightloop.example/careers/account-executive'
const lead = (o: Partial<DiscoveredLead> = {}): DiscoveredLead => ({ company: 'Brightloop', domain: 'brightloop.example', signal: 'Hiring an Account Executive', signal_date: null, evidence_url: URL_AE, evidence_quote: 'Brightloop is hiring an Account Executive', person: null, title: null, person_source_url: null, linkedin_url: null, email: null, email_source_url: null, confidence: 'medium', why: '', ...o })
const page = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
const blocked = page('no', 403)
// An asker that records what it was asked and answers each requirement with the same word.
const asker = (answer: boolean | 'throws') => {
  const calls: { company: string; requirements: string[]; statements: string[] }[] = []
  const ask: AskQualifiers = async (company, requirements, statements) => {
    calls.push({ company, requirements, statements })
    if (answer === 'throws') throw new Error('model unavailable')
    return requirements.map(() => answer)
  }
  return { ask, calls }
}
const check = (l: DiscoveredLead, body: string, query: string, ask?: AskQualifiers, seen: SeenPage[] = []) => {
  const request: RequestCheck = { q: requestQualifiers(query), ask }
  return checkLead(l, seen, page(body), 12_000, NOW, undefined, request)
}
const TEAM = '<h1>Account Executive</h1><p>Brightloop is hiring an Account Executive to join our 12-person sales team.</p>'
const teamLead = lead({ evidence_quote: 'Brightloop is hiring an Account Executive to join our 12-person sales team' })

test('what a request asks for is read from the person\'s own words, and only what a page can be held to', () => {
  const first = requestQualifiers(FIRST_SALES)
  assert.deepEqual([first.roles.map(r => r.normalized), first.first, first.stage, first.windowDays], [['salesperson'], true, null, null])
  const both = requestQualifiers('B2B SaaS founders in the US and Canada hiring their first SDR or salesperson')
  assert.deepEqual([both.roles.map(r => r.normalized), both.first], [['sdr', 'salesperson'], true])
  assert.equal(requestQualifiers('first-time founders hiring an SDR').first, false, 'the founders are first-time, not the hire')
  assert.equal(requestQualifiers('startups that just made their first sales hire').first, true)
  const funded = requestQualifiers('Series A SaaS companies hiring SDRs in the last 30 days')
  assert.deepEqual([funded.roles.map(r => r.normalized), funded.first, funded.stage, funded.windowDays], [['sdr'], false, 'series a', 30])
  assert.equal(requestQualifiers('seed-stage startups hiring SDRs').stage, 'seed')
  // not one stage a page can be held to: a plant, two stages, a range
  assert.equal(requestQualifiers('garden centres buying seed in spring').stage, null)
  assert.equal(requestQualifiers('seed or Series A startups hiring SDRs').stage, null)
  assert.equal(requestQualifiers('Series A or later companies hiring SDRs').stage, null)
  // words after "hiring" that are not a title ask for no role
  assert.deepEqual(requestQualifiers('companies hiring right now').roles, [])
  assert.deepEqual(requestQualifiers('startups hiring aggressively after a raise').roles, [])
  assert.deepEqual(requestQualifiers('dental clinics hiring a front desk receptionist').roles.map(r => r.normalized), ['front desk receptionist'])
  const none = requestQualifiers('dental clinics expanding')
  assert.deepEqual([none.roles, none.first, none.stage, none.windowDays], [[], false, null, null])
})

test('a posting that joins an existing sales team is not confirmed for a first-salesperson request; the review names the first hire', async () => {
  const before = await checkLead(teamLead, [], page(TEAM), 12_000, NOW)
  assert.deepEqual([before.proof, before.signal_seen, before.request_lacks, isShown(before)], ['confirmed', true, [], true], 'with no request given the lead is checked as before')
  // no asker (a test, the replay script): the words decide alone
  const alone = await check(teamLead, TEAM, FIRST_SALES)
  assert.deepEqual([alone.proof, alone.signal_seen, alone.request_lacks, isShown(alone)], ['confirmed', true, ['first'], false])
  // an asker that says NO: asked once, about the first hire only (the role is settled by words)
  const no = asker(false)
  const refused = await check(teamLead, TEAM, FIRST_SALES, no.ask)
  assert.deepEqual([refused.request_lacks, isShown(refused), no.calls.length], [['first'], false, 1])
  assert.equal(no.calls[0].company, 'Brightloop')
  assert.equal(no.calls[0].requirements.length, 1)
  assert.match(no.calls[0].requirements[0], /FIRST hire/)
  assert.ok(no.calls[0].statements.includes('Brightloop is hiring an Account Executive to join our 12-person sales team.'), 'the page\'s own statement that holds the quote is sent')
  // an asker that says YES settles it
  const yes = asker(true)
  const cleared = await check(teamLead, TEAM, FIRST_SALES, yes.ask)
  assert.deepEqual([cleared.request_lacks, isShown(cleared), yes.calls.length], [[], true, 1])
})

test('a page that says first or founding of a selling role is confirmed by its words, with no call', async () => {
  const a = asker(false)
  const said = await check(lead({ evidence_quote: 'Brightloop is hiring its first Account Executive' }), '<p>Brightloop is hiring its first Account Executive.</p>', FIRST_SALES, a.ask)
  assert.deepEqual([said.request_lacks, isShown(said), a.calls.length], [[], true, 0])
  // the job title says it and the quoted sentence does not
  const heading = await check(lead({ evidence_quote: 'Brightloop is hiring an Account Executive to build our outbound motion' }), '<h1>Founding Account Executive</h1><p>Brightloop is hiring an Account Executive to build our outbound motion.</p>', FIRST_SALES, a.ask)
  assert.deepEqual([heading.request_lacks, isShown(heading), a.calls.length], [[], true, 0])
  const hire = await check(lead({ evidence_quote: 'Brightloop is hiring an Account Executive' }), '<p>Brightloop is hiring an Account Executive. This is our first sales hire.</p>', FIRST_SALES, a.ask)
  assert.deepEqual([hire.request_lacks, isShown(hire), a.calls.length], [[], true, 0])
})

test('"first" beside something that is not the hire settles nothing by words: the question is asked', async () => {
  const bodies = [
    '<p>Brightloop is hiring an Account Executive.</p><p>In your first 90 days you will own the sales pipeline.</p>',
    '<p>Brightloop is hiring an Account Executive.</p><p>You will run every first sales call yourself.</p>',
    '<p>Brightloop is hiring an Account Executive.</p><p>We have a customer-first sales team.</p>',
    '<p>Brightloop is hiring an Account Executive.</p><p>This is our first engineering hire outside the founders.</p>',
    '<p>Brightloop is hiring an Account Executive.</p><p>This is not our first sales hire.</p>',
  ]
  for (const body of bodies) {
    const a = asker(false)
    const out = await check(lead(), body, FIRST_SALES, a.ask)
    assert.deepEqual([out.request_lacks, isShown(out), a.calls.length], [['first'], false, 1], body)
  }
})

test('a posting for another kind of role is not confirmed for a sales request; one call covers the role and the first hire', async () => {
  const eng = lead({ signal: 'Hiring a Senior Backend Engineer', evidence_url: 'https://brightloop.example/careers/backend', evidence_quote: 'Brightloop is hiring a Senior Backend Engineer' })
  const body = '<p>Brightloop is hiring a Senior Backend Engineer.</p>'
  const plain = await checkLead(eng, [], page(body), 12_000, NOW)
  assert.equal(isShown(plain), true, 'the signal line itself is on the page')
  const a = asker(false)
  const out = await check(eng, body, FIRST_SALES, a.ask)
  assert.deepEqual([out.request_lacks, isShown(out), a.calls.length], [['role', 'first'], false, 1])
  assert.equal(a.calls[0].requirements.length, 2, 'both open requirements go in the one call')
  assert.match(a.calls[0].requirements[0], /salesperson/)
  const alone = await check(eng, body, FIRST_SALES)
  assert.deepEqual([alone.request_lacks, isShown(alone)], [['role', 'first'], false])
})

test('a funding stage the request names must be stated on the proof page; it is never asked', async () => {
  const query = 'Series A SaaS companies hiring SDRs'
  const sdr = lead({ signal: 'Hiring SDRs', evidence_url: 'https://brightloop.example/careers/sdr', evidence_quote: 'Brightloop is hiring SDRs to build its outbound team' })
  const hiring = '<p>Brightloop is hiring SDRs to build its outbound team.</p>'
  const a = asker(true)
  const stated = await check(sdr, `<p>Brightloop raised a $12M Series A in September.</p>${hiring}`, query, a.ask)
  assert.deepEqual([stated.request_lacks, isShown(stated)], [[], true])
  const silent = await check(sdr, hiring, query, a.ask)
  assert.deepEqual([silent.request_lacks, isShown(silent)], [['stage'], false])
  const other = await check(sdr, `<p>Brightloop raised a $30M Series B in September.</p>${hiring}`, query, a.ask)
  assert.deepEqual([other.request_lacks, isShown(other)], [['stage'], false])
  assert.equal(a.calls.length, 0)
})

test('a time window the request names: only a date of the page\'s own inside it confirms the lead; it is never asked', async () => {
  const query = 'SaaS companies hiring SDRs in the last 30 days'
  const sdr = (o: Partial<DiscoveredLead> = {}) => lead({ signal: 'Hiring SDRs', evidence_url: 'https://brightloop.example/careers/sdr', evidence_quote: 'Brightloop is hiring SDRs to build its outbound team', ...o })
  const hiring = '<p>Brightloop is hiring SDRs to build its outbound team.</p>'
  const a = asker(true)
  const fresh = await check(sdr({ signal_date: '2026-11-14' }), `<p>Posted 14 November 2026.</p>${hiring}`, query, a.ask)
  assert.deepEqual([fresh.date, fresh.date_source, fresh.request_lacks, isShown(fresh)], ['2026-11-14', 'page', [], true], '10 days old')
  const printed = await check(sdr(), `<p>Posted 4d ago</p>${hiring}`, query, a.ask)
  assert.deepEqual([printed.date, printed.date_source, printed.request_lacks, isShown(printed)], ['2026-11-20', 'page', [], true], 'the age the page prints is the page\'s own date')
  const old = await check(sdr({ signal_date: '2026-05-08' }), `<p>Posted 8 May 2026.</p>${hiring}`, query, a.ask)
  assert.deepEqual([old.request_lacks, isShown(old)], [['window'], false], '200 days old')
  const undated = await check(sdr(), hiring, query, a.ask)
  assert.deepEqual([undated.date, undated.request_lacks, isShown(undated)], [null, ['window'], false])
  // dated only by the search index: the page was read by the run's reader and prints no date
  const request: RequestCheck = { q: requestQualifiers(query), ask: a.ask }
  const seen: SeenPage[] = [{ url: 'https://brightloop.example/careers/sdr', title: 'Careers', page_age: '3 days ago', text: 'Brightloop is hiring SDRs to build its outbound team.' }]
  const indexed = await checkLead(sdr(), seen, blocked, 12_000, NOW, undefined, request)
  assert.deepEqual([indexed.date, indexed.date_source, indexed.request_lacks, isShown(indexed)], ['2026-11-21', 'index', ['window'], false])
  // a day the engine gave that the page does not print is not the page's own date
  const claimed = await check(sdr({ signal_date: '2026-11-14' }), hiring, query, a.ask)
  assert.deepEqual([claimed.date_on_page, claimed.request_lacks, isShown(claimed)], [false, ['window'], false])
  assert.equal(a.calls.length, 0)
})

test('a request with no qualifier, and a lead that is not shown anyway, are checked exactly as before and cost no call', async () => {
  const a = asker(false)
  const none = await check(teamLead, TEAM, 'dental clinics expanding', a.ask)
  assert.deepEqual([none.request_lacks, isShown(none)], [[], true])
  // the quote is not on the page
  const noQuote = await check(lead({ evidence_quote: 'We are looking for our first sales hire to own the pipeline' }), '<h1>Brightloop</h1><p>Careers at Brightloop. See our open roles.</p>', FIRST_SALES, a.ask)
  assert.deepEqual([noQuote.proof, noQuote.quote_on_page, noQuote.request_lacks, isShown(noQuote)], ['confirmed', false, [], false])
  // the page does not name the company
  const elsewhere = await check(teamLead, '<p>Another company is hiring an Account Executive to join our 12-person sales team.</p>', FIRST_SALES, a.ask)
  assert.deepEqual([elsewhere.proof, elsewhere.request_lacks, isShown(elsewhere)], ['company_not_on_page', [], false])
  // the page is gone
  const request: RequestCheck = { q: requestQualifiers(FIRST_SALES), ask: a.ask }
  const gone = await checkLead(teamLead, [], page('Not Found', 404), 12_000, NOW, undefined, request)
  assert.deepEqual([gone.proof, gone.request_lacks, isShown(gone)], ['gone', [], false])
  assert.equal(a.calls.length, 0)
})

test('a page nobody could read: the search result\'s title is held to the request by words alone, with no call', async () => {
  const a = asker(true)
  const request: RequestCheck = { q: requestQualifiers(FIRST_SALES), ask: a.ask }
  const result = (title: string): SeenPage[] => [{ url: URL_AE, title, page_age: null, text: null }]
  const says = await checkLead(lead(), result('Brightloop is hiring its first Account Executive'), blocked, 12_000, NOW, undefined, request)
  assert.deepEqual([says.proof, says.request_lacks, isShown(says)], ['listed', [], true])
  const silent = await checkLead(lead(), result('Brightloop is hiring an Account Executive'), blocked, 12_000, NOW, undefined, request)
  assert.deepEqual([silent.proof, silent.signal_seen, silent.request_lacks, isShown(silent)], ['listed', true, ['first'], false])
  assert.equal(a.calls.length, 0)
})

test('an asker that fails, or a reply that cannot be read, leaves the lead in review with the open qualifier named', async () => {
  const broke = asker('throws')
  const out = await check(teamLead, TEAM, FIRST_SALES, broke.ask)
  assert.deepEqual([out.company, out.request_lacks, isShown(out), broke.calls.length], ['Brightloop', ['first'], false, 1])
  // the real asker, with the model's reply replaced: one line of YES / NO words, one per requirement
  const reply = (text: string) => (async () => new Response(JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 4000, output_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  const judge = signalJudge({ apiKey: 'test-key', fetch: reply('YES NO') })
  assert.deepEqual(await judge.askQualifiers!('Brightloop', ['the role', 'the first hire'], ['Brightloop is hiring an Account Executive.']), [true, false])
  assert.deepEqual(judge.usage, { requests: 1, usd: 0.0004 }, 'the call is counted and priced on the judge the run totals')
  assert.deepEqual(await judge.askQualifiers!('Brightloop', ['the role'], []), [false], 'no text: no call, and nothing is supported')
  assert.equal(judge.usage.requests, 1)
  const unreadable = signalJudge({ apiKey: 'test-key', fetch: reply('It may be, the page is not clear.') })
  const held = await check(teamLead, TEAM, FIRST_SALES, unreadable.askQualifiers)
  assert.deepEqual([held.request_lacks, isShown(held), unreadable.usage.requests], [['first'], false, 1])
  assert.deepEqual(yesNoList('YES NO', 2), [true, false])
  assert.deepEqual(yesNoList('1. YES\n2. no', 2), [true, false])
  assert.deepEqual(yesNoList('Yes.', 1), [true])
  assert.deepEqual(yesNoList('YES', 2), [false, false], 'one answer for two requirements is no answer')
  assert.deepEqual(yesNoList('', 1), [false])
})
