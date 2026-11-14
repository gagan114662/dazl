// #1192 acceptance 2: /app/settings links to Memory and to Competitors, and what those pages show is the tenant's own stored rows,
// including for the account shape every real account has (no website read: 0 of 34 production users have a sourced hypothesis,
// so the branch with no `research` block is the one CI must render, not only the hasSite=true fixture of test/ui/business-1043.ui.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { SETTINGS_SECTIONS } from '../app/app/settings/sections.ts'
import { businessSections, type BrainProfile } from '../lib/business-brain.ts'
import type { Icp } from '../lib/scan/icp.ts'

const dir = new URL('../app/app/settings/', import.meta.url)
const source = readdirSync(dir).filter(f => /\.tsx$/.test(f)).map(f => readFileSync(new URL(f, dir), 'utf8')).join('\n')

test('#1192 the Settings section nav links Memory and Competitors, and every link has an element to scroll to', () => {
  const ids = SETTINGS_SECTIONS.map(([id]) => id)
  assert.ok(ids.includes('memory'), 'Memory is in the nav')
  assert.ok(ids.includes('competitors'), 'Competitors is in the nav (its panel was on the page without a link)')
  assert.deepEqual(SETTINGS_SECTIONS.find(([id]) => id === 'competitors'), ['competitors', 'Competitors'])
  assert.equal(new Set(ids).size, ids.length, 'no id twice')
  for (const id of ids) assert.ok(source.includes(`id="${id}"`), `the nav link #${id} has an element with that id on /app/settings or in one of its panels`)
  // the Competitors anchor exists in every state of its panel (loading, failed, loaded): a direct visit to /app/settings#competitors lands on it
  const panel = readFileSync(new URL('competitors-panel.tsx', dir), 'utf8')
  assert.match(panel, /if \(!loaded\) return <div id="competitors"/)
  assert.equal((panel.match(/id="competitors"/g) ?? []).length, 3, 'one anchor per render state (loading, failed, loaded), never two at once')
  // page.tsx renders the nav from this list, not from a second copy
  const page = readFileSync(new URL('page.tsx', dir), 'utf8')
  assert.match(page, /SETTINGS_SECTIONS\.map\(/)
  assert.doesNotMatch(page, /const SECTIONS = \[/)
})

const icp = (o: Partial<Icp> = {}): Icp => ({ summary: 'Independent dental practices', who: ['Practice owner'], industries: ['Dental'], sizes: [], where: ['Ohio'], signals: ['opened a new location'], exclude: [], ...o })
// the shape of every real account: a profile with no website read at all (no `research` block, no site, no source link)
const noSite: BrainProfile = { business_name: 'Bright Smile', sells: 'Online booking for dental practices', website: '', buyer: icp() }

test('#1192 an account with NO website read: Memory and Competitors rows show as stored, with their own source, and nothing claims a site read', () => {
  const memory = { tone: 'Plain and friendly', objections: [{ q: 'We already have a phone system', a: 'It works alongside it' }], exclusions: ['corporate chains'], positioning: 'Booking that fits the front desk', icp: '' }
  const sections = Object.fromEntries(businessSections(noSite, memory, ['Zocdoc', 'NexHealth']).map(s => [s.id, s]))
  assert.deepEqual(sections.competitors.items.map(i => [i.text, i.source.kind]), [['Zocdoc', 'competitors'], ['NexHealth', 'competitors']])
  assert.deepEqual(sections.voice.items.map(i => [i.text, i.source.kind]), [['Plain and friendly', 'memory']])
  assert.deepEqual(sections.objections.items.map(i => [i.label, i.text, i.source.kind]), [['We already have a phone system', 'It works alongside it', 'memory']])
  assert.ok(sections.customer.items.some(i => i.text === 'corporate chains' && i.source.kind === 'memory'))
  assert.ok(sections.company.items.some(i => i.label === 'Positioning' && i.source.kind === 'memory'))
  const all = Object.values(sections).flatMap(s => s.items)
  assert.equal(all.filter(i => i.source.kind === 'site').length, 0, 'no item is "from your site" when no site was read')
  assert.ok(all.every(i => ['profile', 'memory', 'competitors'].includes(i.source.kind)))
  // the editors Settings and the business page share read the same rows (the page names each section's own editor)
  assert.deepEqual([sections.competitors.edit, sections.objections.edit, sections.voice.edit], ['competitors', 'memory', 'memory'])
})

test('#1192 no website read and nothing stored (the real account shape today): empty sections, no throw, nothing invented, no source link', () => {
  for (const profile of [noSite, { ...noSite, website: null, buyer: icp({ research: undefined }) } as unknown as BrainProfile, null]) {
    const sections = businessSections(profile, null, null)
    assert.equal(sections.length, 7)
    const competitors = sections.find(s => s.id === 'competitors')!
    assert.deepEqual(competitors.items, [])
    assert.deepEqual(sections.find(s => s.id === 'voice')!.items, [])
    assert.equal(sections.flatMap(s => s.items).filter(i => i.source.kind === 'site').length, 0)
  }
})
