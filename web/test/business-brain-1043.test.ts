// #1043: "Your business" sections and suggested plays, built only from what is stored, with honest provenance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { businessSections, businessPlays, profilePayload, type BrainProfile, type ProfileForm } from '../lib/business-brain.ts'
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
