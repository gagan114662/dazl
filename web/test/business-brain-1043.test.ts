// #1043: "Your business" sections and suggested plays, built only from what is stored, with honest provenance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { businessSections, businessPlays, profilePayload, COMPLAINT_COMPETITORS, type BrainProfile, type ProfileForm } from '../lib/business-brain.ts'
import type { Icp } from '../lib/scan/icp.ts'

const icp = (o: Partial<Icp> = {}): Icp => ({ summary: 'Independent dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: ['1-50 employees'], where: ['Ohio'], signals: ['opened a new location', 'hiring a front desk coordinator'], exclude: ['dental chains'], ...o })
const research = { v: 1 as const, site: 'https://brightsmile.example', offers: [{ i: 'o1', n: 'Online booking' }], q: null, ans: null, hyps: [
  { i: 'h1', o: 'o1', k: 'persona' as const, t: 'Office manager', s: 'sourced' as const, u: 'https://brightsmile.example/for-practices', q: 'built for office managers', at: 1 },
  { i: 'h2', o: 'o1', k: 'persona' as const, t: 'Dentist', s: 'hypothesis' as const, u: 'https://brightsmile.example/', q: null, at: 1 },        // not source-backed
  { i: 'h3', o: 'o1', k: 'pain' as const, t: 'Missed calls', s: 'rejected' as const, u: 'https://brightsmile.example/x', q: 'missed calls', at: 1 }, // rejected
  { i: 'h4', o: 'o1', k: 'offer' as const, t: 'Online booking', s: 'reviewed' as const, u: 'https://brightsmile.example/booking', q: 'book online', at: 1 },
] }
const profile: BrainProfile = { business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: 'https://brightsmile.example', buyer: icp({ research }) }
const byId = (s: ReturnType<typeof businessSections>) => Object.fromEntries(s.map(x => [x.id, x]))

test('#1043: every section, built only from the saved profile, Memory and Competitors', () => {
  const s = byId(businessSections(profile, { tone: 'Plain and friendly', objections: [{ q: 'We already have a phone system', a: 'It works alongside it' }], exclusions: ['corporate chains'] }, ['Zocdoc']))
  assert.deepEqual(Object.keys(s), ['company', 'customer', 'roles', 'signals', 'competitors', 'objections', 'voice'])
  assert.deepEqual(s.company.items.map(i => [i.label, i.text]), [['Company', 'Bright Smile'], ['What you sell', 'Online booking for dental practices'], ['Website', 'https://brightsmile.example'], ['Offer', 'Online booking']])
  assert.deepEqual(s.roles.items.map(i => [i.text, i.source.kind]), [['Practice owner', 'profile'], ['Office manager', 'site']])
  assert.deepEqual(s.competitors.items.map(i => i.text), ['Zocdoc'])
  assert.deepEqual(s.objections.items.map(i => [i.label, i.text]), [['We already have a phone system', 'It works alongside it']])
  assert.deepEqual(s.voice.items.map(i => i.text), ['Plain and friendly'])
  assert.ok(s.customer.items.some(i => i.label === 'Skip' && i.text === 'corporate chains' && i.source.kind === 'memory'))
})

test('#1043: "from your site" only for a source-backed item with its page; a hypothesis or a rejected item is never shown as from the site', () => {
  const all = businessSections(profile, null, null).flatMap(x => x.items)
  const site = all.filter(i => i.source.kind === 'site')
  assert.deepEqual(site.map(i => [i.text, (i.source as { url: string }).url]), [['Online booking', 'https://brightsmile.example/booking'], ['Office manager', 'https://brightsmile.example/for-practices']])
  assert.equal(all.find(i => i.label === 'Website')?.source.kind, 'profile', 'the website the user saved is not a page dazl read')
  assert.ok(!all.some(i => i.text === 'Dentist'), 'an unsourced hypothesis is not shown as known')
  assert.ok(!all.some(i => i.text === 'Missed calls'), 'a rejected item is not shown')
  // flat profile fields keep no per-item source: they say "your profile", never "from your site"
  assert.ok(all.filter(i => i.label === 'Industry' || i.label === 'Signal').every(i => i.source.kind === 'profile'))
})

test('#1043: nothing stored -> every section is empty (the page says "dazl did not find this"), nothing invented, no plays', () => {
  const s = businessSections(null, null, null)
  assert.equal(s.length, 7); assert.ok(s.every(x => x.items.length === 0))
  assert.deepEqual(businessPlays(null, null), [])
  assert.deepEqual(businessPlays({ buyer: icp({ who: [], industries: [], signals: [] }) }, []), [], 'no buyer and no signal: no play')
})

test('#1043: plays come only from what is saved and only with signals search can find (a hiring play only from a hiring signal, never from a buyer role)', () => {
  const plays = businessPlays(profile, ['Zocdoc'])
  assert.deepEqual(plays.map(p => p.query), [
    'Practice owner in Ohio - opened a new location',
    'Practice owner at companies in Ohio hiring front desk coordinator',
    'Practice owner in Ohio looking for an alternative to Zocdoc',
  ], 'the hiring signal becomes one hiring play, not also a second signal play saying the same')
  // a hiring signal listed FIRST is still only the hiring play
  const first = businessPlays({ buyer: icp({ signals: ['hiring a front desk coordinator', 'opened a new location'] }) }, [])
  assert.deepEqual(first.map(p => p.query), ['Practice owner in Ohio - opened a new location', 'Practice owner at companies in Ohio hiring front desk coordinator'])
  assert.ok(plays.length >= 1 && plays.length <= 5)
  const noHiring = businessPlays({ buyer: icp({ signals: ['opened a new location'] }) }, [])
  assert.ok(!noHiring.some(p => /hiring/.test(p.query)), 'no hiring signal saved: no hiring play (a buyer role is not a role being hired)')
  assert.ok(businessPlays({ buyer: icp() }, ['A', 'B', 'C', 'D']).length <= 5)
})

const form = (o: Partial<ProfileForm> = {}): ProfileForm => ({ business_name: 'Bright Smile', sells: 'Online booking', website: 'https://brightsmile.example', summary: '', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [], ...o })

test('#1043 profile save: the stored buyer keeps research/window/country/lookalike; a new user saves company fields without a buyer; buyer details need a summary', () => {
  const stored: BrainProfile = { buyer: icp({ research, window_days: 90, country: 'US' }) }
  const a = profilePayload(stored, form({ summary: 'Dental practices', who: ['Practice owner', 'Office manager'] }))
  assert.ok('body' in a)
  const buyer = (a as { body: { buyer: Icp } }).body.buyer
  assert.deepEqual(buyer.who, ['Practice owner', 'Office manager']); assert.deepEqual(buyer.research, research); assert.equal(buyer.window_days, 90); assert.equal(buyer.country, 'US')
  // a new user (no stored buyer) saving only the company fields: no buyer is sent (the route would refuse one without a summary)
  const b = profilePayload(null, form())
  assert.ok('body' in b); assert.equal('buyer' in (b as { body: object }).body, false)
  assert.deepEqual((b as { body: object }).body, { business_name: 'Bright Smile', sells: 'Online booking', website: 'https://brightsmile.example' })
  // buyer details without "who you sell to": an error to fix, never a silent drop
  assert.ok('error' in profilePayload(null, form({ who: ['Practice owner'] })))
  assert.ok('error' in profilePayload(stored, form({ summary: '' })), 'clearing the summary of a stored buyer is refused, not saved as nothing')
  // a blank website is sent (it clears the stored one)
  assert.equal((profilePayload(null, form({ website: '  ' })) as { body: { website: string } }).body.website, '')
})

test('#1043 council: "from your site" needs the quote found on the page and research about the CURRENT website', () => {
  const noQuote = { ...research, hyps: [{ i: 'h9', o: 'o1', k: 'persona' as const, t: 'Receptionist', s: 'reviewed' as const, u: 'https://brightsmile.example/team', q: null, at: 1 }] }
  const a = businessSections({ ...profile, buyer: icp({ research: noQuote }) }, null, null).flatMap(x => x.items)
  assert.ok(!a.some(i => i.source.kind === 'site'), 'a reviewed item with a page but no quote is not shown as from the site')
  // the website changed after the read: the old site's items are not "your site" any more
  const moved = businessSections({ ...profile, website: 'https://newsite.example' }, null, null).flatMap(x => x.items)
  assert.ok(!moved.some(i => i.source.kind === 'site'))
  assert.ok(!moved.some(i => i.text === 'Office manager'), 'research about another site is not shown as known')
})

test('#1043 council r2: a signal mentioning hiring with no role to hire still makes a plain play (the compiler reads it as hiring)', () => {
  assert.deepEqual(businessPlays({ buyer: icp({ signals: ['Expanding team, hiring'] }) }, []).map(p => p.query), ['Practice owner in Ohio - Expanding team, hiring'])
})

test('#1043 xhawk: a saved signal the targeting compiler cannot enforce is not offered as a play; one competitor play names all competitors', () => {
  const q = (signals: string[]) => businessPlays({ buyer: icp({ signals }) }, []).map(p => p.query)
  assert.deepEqual(q(['attended a trade show']), [], 'no positive condition: no play')
  assert.deepEqual(q(['attended a trade show', 'opened a new location']), ['Practice owner in Ohio - opened a new location'], 'the enforceable one is offered')
  const c = businessPlays({ buyer: icp({ signals: [] }) }, ['Zocdoc', 'Dentrix']).map(p => p.query)
  assert.deepEqual(c, ['Practice owner in Ohio looking for an alternative to Zocdoc or Dentrix'], 'one play covering every competitor the scan reads')
})

test('#1043 xhawk follow-up: the signal alone must be enforceable (a buyer role never supplies it); the competitor play names every competitor the scan reads', async () => {
  const q = (who: string[], signals: string[]) => businessPlays({ buyer: icp({ who, signals }) }, []).map(p => p.query)
  assert.deepEqual(q(['Hiring manager'], ['attended a trade show']), [], 'the buyer text "Hiring manager" does not make the signal enforceable')
  assert.deepEqual(q(['Hiring manager'], ['opened a new location']), ['Hiring manager in Ohio - opened a new location'])
  const { MAX_COMPETITORS } = await import('../lib/signals/competitor-reddit.ts')
  assert.equal(COMPLAINT_COMPETITORS, MAX_COMPETITORS, 'the play covers exactly what the complaint collector reads')
  const three = businessPlays({ buyer: icp({ signals: [] }) }, ['Zocdoc', 'Dentrix', 'Weave']).map(p => p.query)
  assert.deepEqual(three, ['Practice owner in Ohio looking for an alternative to Zocdoc, Dentrix or Weave'])
  const six = businessPlays({ buyer: icp({ signals: [] }) }, ['A1', 'B2', 'C3', 'D4', 'E5', 'F6']).map(p => p.query)
  assert.deepEqual(six, ['Practice owner in Ohio looking for an alternative to A1, B2, C3, D4 or E5'], 'the sixth is not read by the scan either')
})

test('#1043 council: a signal that compiles only to a negated condition makes no play (plain or hiring); a competitor play that would be cut is not offered', () => {
  const q = (signals: string[], comps: string[] = []) => businessPlays({ buyer: icp({ signals }) }, comps).map(p => p.query)
  assert.deepEqual(q(['not hiring']), [], '"not hiring" is a negated condition only')
  assert.deepEqual(q(['not hiring a receptionist']), [], 'never "companies hiring receptionist" from a signal that says not hiring')
  assert.deepEqual(q(['hiring a receptionist']), ['Practice owner at companies in Ohio hiring receptionist'])
  const long = ['A', 'B', 'C', 'D', 'E'].map(c => c.repeat(60))
  assert.deepEqual(q([], long), [], 'five 60-character names do not fit: no play that leaves one out')
})

test('#1043 council r2: a hiring play only from a positive hiring condition, never from a negated or stopped one; the 300-character edge', () => {
  const q = (signals: string[], comps: string[] = []) => businessPlays({ buyer: icp({ signals }) }, comps).map(p => p.query)
  // a signal with a negation makes no plain play (fail closed, documented cost), and never "companies hiring receptionist"
  assert.deepEqual(q(['recently raised funding, not hiring a receptionist']), [])
  // hiring that stopped makes no play at all (neither a hiring play nor a plain one), with or without a role
  for (const s of ['stopped hiring SDRs', "isn't hiring a receptionist", 'no longer hiring SDRs', 'paused hiring SDRs', 'cancelled hiring SDRs', 'deferred hiring SDRs',
    'hiring freeze', 'hiring frozen', 'stopped hiring', 'paused hiring', "isn't hiring", 'not hiring']) assert.deepEqual(q([s]), [], s)
  // ...while real hiring that merely mentions a negation still makes its play
  for (const [s, role] of [['not only hiring SDRs', 'SDRs'], ['not just hiring engineers', 'engineers'], ['never stopped hiring SDRs', 'SDRs'], ['currently hiring SDRs', 'SDRs'], ['is actively hiring SDRs', 'SDRs']])
    assert.deepEqual(q([s]), [`Practice owner at companies in Ohio hiring ${role}`], s)
  assert.deepEqual(q(['hiring their first sales rep']), ['Practice owner at companies in Ohio hiring sales rep'])
  assert.deepEqual(q(['hiring SDRs and AEs']), ['Practice owner at companies in Ohio hiring SDRs'], 'the role the compiler enforces')
  assert.deepEqual(q(['hiring the']), [], 'no role, no hiring play')
  // exactly 300 characters: offered with every name; 301: not offered
  const prefix = 'Practice owner in Ohio looking for an alternative to ', four = ['A', 'B', 'C', 'D'].map(c => c.repeat(50))
  const fifth = (n: number) => 'E'.repeat(n - (prefix + four.join(', ') + ' or ').length)
  const at = (n: number) => q([], [...four, fifth(n)])
  assert.equal(at(300).length, 1); assert.equal(at(300)[0].length, 300); assert.ok(at(300)[0].endsWith('E'))
  assert.deepEqual(at(301), [])
})

// Hermes review at 2ac10107: real prod saved signals (read-only, 2026-11-13) and their negated forms
test('#1043 Hermes: a negated hiring signal in real prod wording never makes a hiring play; a signal the compiler reads the wrong way round makes no play', () => {
  const q = (signals: string[], who = ['Practice owner']) => businessPlays({ buyer: icp({ who, where: [], signals }) }, []).map(p => p.query)
  // "without" / "no ... of" are caught only by the compiled plan's negation (not by the stop-word list)
  for (const s of ['without hiring front-desk staff', 'without hiring an office manager', 'no hiring of recruiters', 'without hiring a receptionist']) assert.deepEqual(q([s]), [], s)
  // the real signal "Business rejecting venture capital funding" compiles to a POSITIVE funding condition: no play (it would find funded companies)
  assert.deepEqual(q(['Business rejecting venture capital funding'], ['Small team leaders']), [])
  assert.deepEqual(q(['Company switching away from ad-supported or data-selling tools']), [])
  // the real positive signals keep their plays
  assert.deepEqual(q(['Opened a new location', 'hiring front-desk staff', 'hiring an office manager']),
    ['Practice owner - Opened a new location', 'Practice owner at companies hiring front-desk staff', 'Practice owner at companies hiring office manager'])
  assert.deepEqual(q(['Opened a new office', 'hiring recruiters'], ['Agency owner']), ['Agency owner - Opened a new office', 'Agency owner at companies hiring recruiters'])
})

test('#1043 review: no play from any negated wording the compiler may read the wrong way round; the fail-closed cost is pinned', () => {
  const q = (signals: string[]) => businessPlays({ buyer: icp({ who: ['Practice owner'], where: [], signals }) }, []).map(p => p.query)
  for (const s of ["didn't raise funding", 'failed to raise funding', 'nobody raised funding', 'nobody hiring', 'zero hiring', 'lack of hiring',
    'hiring but not SDRs', 'lacking a CMO, raised funding', 'downsizing, raised funding', "hasn't hired SDRs", 'failed to hire SDRs', 'nobody hiring SDRs'])
    assert.deepEqual(q([s]), [], s)
  // accepted cost: a mixed signal that is really positive makes no play rather than risk the opposite one
  for (const s of ['hiring freeze lifted, now hiring SDRs', 'not yet profitable']) assert.deepEqual(q([s]), [], `fail closed: ${s}`)
  // plain positive signals are unaffected
  assert.deepEqual(q(['raised a Series A', 'opened a new location']), ['Practice owner - raised a Series A', 'Practice owner - opened a new location'])
})

// Review (Hermes-PC) at 01387296. Roles in real prod wording ("front-desk staff", "an office manager", "recruiters").
test('#1043 Hermes 01387296: a hiring play needs the signal to start with hiring and carry no negating word; the listed funding wordings make no play', () => {
  const q = (signals: string[], who = ['Practice owner']) => businessPlays({ buyer: icp({ who, where: [], signals }) }, []).map(p => p.query)
  // 1. negating words before the hiring word: each made "companies hiring <role>" before
  for (const s of ['instead of hiring front-desk staff', 'outsourcing rather than hiring recruiters', 'against hiring an office manager', 'rejecting hiring recruiters',
    'avoiding hiring front-desk staff', 'avoid hiring SDRs', 'refuses hiring SDRs', 'declined hiring SDRs', 'gave up hiring SDRs', 'done hiring SDRs', 'ended hiring SDRs',
    'reduced hiring SDRs', 'cut hiring of SDRs', 'not B2C hiring SDRs', 'Outsourcing instead of hiring front-desk staff'])
    assert.deepEqual(q([s]), [], s)
  // ...and stop words after the role
  for (const s of ['hiring SDRs on hold', 'hiring SDRs was cancelled', 'hiring of SDRs stopped', 'hiring nobody', 'hiring no one', 'hiring zero SDRs', 'hiring fewer SDRs'])
    assert.deepEqual(q([s]), [], s)
  // 2. the plain play: wordings that compile to a positive funding or hire condition and mean the opposite
  for (const s of ['lost funding', 'funding fell through', 'funding round failed', 'ran out of funding', 'passed on funding', 'yet to raise funding', 'before raising funding',
    'prior to raising funding', 'pre-funding', 'sans funding', 'hired fewer SDRs', 'barely hiring', 'hardly hiring', 'rarely hiring', 'raised less funding'])
    assert.deepEqual(q([s]), [], s)
  // the real prod signals keep their plays (9 saved profiles, 21 signals, read-only 2026-11-13)
  assert.deepEqual(q(['Opened a new location', 'hiring front-desk staff', 'hiring an office manager']),
    ['Practice owner - Opened a new location', 'Practice owner at companies hiring front-desk staff', 'Practice owner at companies hiring office manager'])
  assert.deepEqual(q(['Opened a new office', 'hiring recruiters'], ['Agency owner']), ['Agency owner - Opened a new office', 'Agency owner at companies hiring recruiters'])
  assert.deepEqual(q(['Hiring their first SDR or salesperson', 'posting about outbound or lead gen pain'], ['Founder']), ['Founder at companies hiring SDR'])
  assert.deepEqual(q(['Company expressing frustration with enterprise software complexity', 'Team adopting remote or distributed work', 'Business rejecting venture capital funding',
    'Organization implementing calmer work policies', 'Company switching away from ad-supported or data-selling tools'], ['Small team leaders']), [])
  // a signal that only mentions hiring after something else is not a hiring play, but stays a plain one when nothing negates it
  assert.deepEqual(q(['raised a Series A, hiring SDRs']), ['Practice owner - raised a Series A, hiring SDRs'])
})
