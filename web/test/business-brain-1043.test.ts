// #1043: "Your business" sections and suggested plays, built only from what is stored, with honest provenance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { businessSections, businessPlays, type BrainProfile } from '../lib/business-brain.ts'
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
  assert.deepEqual(site.map(i => [i.text, (i.source as { url: string }).url]), [['https://brightsmile.example', 'https://brightsmile.example'], ['Online booking', 'https://brightsmile.example/booking'], ['Office manager', 'https://brightsmile.example/for-practices']])
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
  assert.ok(plays.length >= 1 && plays.length <= 5)
  const noHiring = businessPlays({ buyer: icp({ signals: ['opened a new location'] }) }, [])
  assert.ok(!noHiring.some(p => /hiring/.test(p.query)), 'no hiring signal saved: no hiring play (a buyer role is not a role being hired)')
  assert.ok(businessPlays({ buyer: icp() }, ['A', 'B', 'C', 'D']).length <= 5)
})
