import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyComplete, readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const job = (id: string, status: string, created_at = 1) => ({ id, status, error: null, query: `play ${id}`, csv_domain: null, created_at, lead_count: 3 })
// A campaign row as /api/campaigns returns it. ready = qualified leads not held; contacts default to ready ones.
const camp = (o: { id?: string; sc?: number; you?: number; held?: number; review?: number; contacts?: number; ready?: number; draftable?: number; drafts?: number; sent?: number; status?: string } = {}) => ({
  id: o.id ?? 'a1', status: o.status ?? 'done',
  qualification: { rejected: 0, sourceChecked: o.sc ?? 0, confirmedByYou: o.you ?? 0, held: o.held ?? 0, needsReview: o.review ?? 0 },
  contact: { withContact: o.contacts ?? o.ready ?? 0, readyWithContact: o.ready ?? 0, draftable: o.draftable ?? 0 },
  outreach: { drafts: o.drafts ?? 0, approved: 0, sent: o.sent ?? 0 } })
const all: ReadinessInput = {
  profile: { website: 'https://www.brightsmile.example', sells: 'Online booking for dental practices', business_name: 'Brightsmile', buyer: { summary: 'Independent dental practices with 2-10 chairs', who: ['Practice owner'] } },
  usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
  outreach: { gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana Smith', postal_address: '1 Main St' }, daily_cap: 20 },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [{ platform: 'reddit', consent: false, connected: false, enabled: false }] },
  jobs: [job('a1', 'done')], totals: { searches: 1, finished: 1 }, campaigns: [camp({ sc: 2, ready: 1, drafts: 1 })], messages: [{ status: 'draft' }],
}
const st = (i: ReadinessInput) => readyItems(i).map(x => `${x.id}:${x.state}${x.next ? '*' : ''}${x.fix ? `>${x.fix.label}@${x.fix.href}` : ''}`)

test('seven steps in order; all done -> complete; sources name only what can run', () => {
  const items = readyItems(all)
  assert.deepEqual(items.map(x => x.id), ['profile', 'search', 'play', 'qualified', 'contact', 'draft', 'sender'])
  assert.deepEqual(items.map(x => x.state), Array(7).fill('done'))
  assert.equal(readyComplete(items), true)
  assert.match(items[1].detail, /Sources: Web research with your AI key, News articles, Company websites$/, 'the operator-off index and unconsented Reddit are not named')
  assert.equal(items[0].detail, 'brightsmile.example - Independent dental practices with 2-10 chairs')
})

test('a new account: one fix per step it can act on; later steps wait without a button', () => {
  const i: ReadinessInput = { ...all, profile: { website: 'https://brightsmile.example', buyer: null }, usage: { has_key: false }, keys: [], outreach: { ...all.outreach, gmail: null }, jobs: [], totals: { searches: 0, finished: 0 }, campaigns: [], messages: [] }
  assert.deepEqual(st(i), [
    'profile:todo*>Build profile@/app?setup=brain', 'search:todo>Add key@/app/settings#model-key', 'play:todo>Run a search@/app/leads',
    'qualified:todo', 'contact:todo', 'draft:todo', 'sender:todo>Connect@/app/settings#gmail'])
  assert.equal(readyComplete(readyItems(i)), false)
  assert.equal(st({ ...i, profile: { sells: 'x', buyer: null } })[0], 'profile:todo*>Add website@/app?setup=site')
})

test('Hermes case: searches ran, 0 source-checked, 0 contacts, Gmail on but sender details missing', () => {
  const i: ReadinessInput = { ...all, jobs: [job('a1', 'done', 1), job('b2', 'done', 5)], totals: { searches: 6, finished: 6 }, campaigns: [camp({ id: 'b2' }), camp({ id: 'a1' })], messages: [], outreach: { ...all.outreach, sender: { sender_name: '', postal_address: '' } } }
  assert.deepEqual(st(i), [
    'profile:done', 'search:done', 'play:done',
    'qualified:todo*>Review leads@/app/leads?job_id=b2', 'contact:todo', 'draft:todo', 'sender:todo>Add sender details@/app/settings#gmail'])
  assert.match(readyItems(i)[6].detail, /sending from dana@brightsmile\.example; your sender name and mailing address are missing/)
})

test('contact then draft: each fix opens the latest search\'s leads', () => {
  const i: ReadinessInput = { ...all, campaigns: [camp({ sc: 3 })], messages: [] }
  assert.deepEqual(st(i).slice(3, 6), ['qualified:done', 'contact:todo*>Find contact@/app/leads?job_id=a1', 'draft:todo'])
  const j: ReadinessInput = { ...all, campaigns: [camp({ sc: 3, ready: 2, draftable: 2 })], messages: [] }
  assert.deepEqual(st(j).slice(4, 6), ['contact:done', 'draft:todo*>Review leads@/app/leads?job_id=a1'])
  // Contacts on qualified leads that a draft check still holds: the step says so and opens that search.
  assert.equal(st({ ...all, campaigns: [camp({ sc: 2, ready: 2, draftable: 0 })], messages: [] })[5], 'draft:todo*>See why@/app/leads?job_id=a1')
  assert.equal(st({ ...all, campaigns: [camp({ you: 1 })] })[3], 'qualified:done', 'a lead you confirmed counts')
})

test('a running first search links to its live view; free searches count as a working key; a rejected key is Replace key', () => {
  assert.equal(st({ ...all, jobs: [job('r1', 'running')], totals: { searches: 1, finished: 0 }, campaigns: [] })[2], 'play:todo*>Watch it live@/app/leads?job_id=r1')
  assert.equal(st({ ...all, usage: { has_key: false, trial: { funded: true, remaining: 2 } }, keys: [] })[1], 'search:done')
  assert.equal(st({ ...all, rejection: { error: 'key_rejected' } })[1], 'search:todo*>Replace key@/app/settings#model-key')
})

test('failed or capped reads are "could not check": no button, never a tick, card kept up', () => {
  assert.deepEqual(readyItems({ profile: null, usage: null, outreach: null, sources: null, jobs: null, totals: null, campaigns: null, messages: null }).map(x => `${x.state}${x.fix ? '+fix' : ''}`), Array(7).fill('unknown'))
  const capped = readyItems({ ...all, campaigns: Array.from({ length: 10 }, () => camp()), messages: [] })
  assert.deepEqual(capped.slice(3, 6).map(x => x.state), ['unknown', 'unknown', 'unknown'])
  assert.equal(readyComplete(capped), false)
})

test('Instinct #341: a used-up scan allowance blocks the search step, and adding a key is not offered as the fix', () => {
  const i: ReadinessInput = { ...all, usage: { has_key: true, scans_used: 50, scan_limit: 50 } }
  const s = readyItems(i)[1]
  assert.deepEqual([s.state, s.detail, s.fix], ['todo', "this month's scan allowance is used up (50 of 50)", { href: '/app/settings#plan', label: 'See your plan' }])
  assert.equal(readyItems({ ...i, usage: { has_key: false, scans_used: 50, scan_limit: 50 }, keys: [] })[1].fix?.label, 'See your plan', 'the allowance, not the key, is the blocker named first')
  assert.equal(readyItems({ ...all, usage: { has_key: true, scans_used: 49, scan_limit: 50 } })[1].state, 'done')
})

test('Instinct #341: each fix opens the search that holds what the step needs, not just the newest one', () => {
  // Newest search found nothing; an older one has 2 checked leads without a contact.
  const i: ReadinessInput = { ...all, campaigns: [camp({ id: 'new0' }), camp({ id: 'old2', sc: 2 })], messages: [] }
  assert.deepEqual(st(i).slice(3, 5), ['qualified:done', 'contact:todo*>Find contact@/app/leads?job_id=old2'])
  // Newest has a qualified lead with no contact; an older one has a draftable lead with a contact.
  const j: ReadinessInput = { ...all, campaigns: [camp({ id: 'new1', sc: 1 }), camp({ id: 'old3', sc: 1, ready: 1, draftable: 1 })], messages: [] }
  assert.equal(st(j)[5], 'draft:todo*>Review leads@/app/leads?job_id=old3')
  // Every fix target is an id from the returned campaigns.
  const ids = new Set(['new0', 'old2', 'new1', 'old3'])
  for (const x of [...readyItems(i), ...readyItems(j)]) if (x.fix?.href.startsWith('/app/leads?job_id=')) assert.ok(ids.has(x.fix.href.split('=')[1]), x.fix.href)
})

test('Instinct #341: held or rejected contact rows never tick qualified or contact', () => {
  // 2 source-checked leads with contacts, both held for timing; 1 rejected row with a contact is not counted at all.
  const i: ReadinessInput = { ...all, campaigns: [camp({ id: 'h1', sc: 2, held: 2, contacts: 2, ready: 0 })], messages: [] }
  assert.deepEqual(st(i).slice(3, 6), ['qualified:todo*>Review leads@/app/leads?job_id=h1', 'contact:todo', 'draft:todo'])
  assert.equal(readyItems(i)[3].detail, '2 checked leads wait for their event date to be confirmed')
})

test('Instinct #341: one real draft in both reads is one draft; approved and sent too', () => {
  for (const status of ['draft', 'approved', 'sent']) {
    const i: ReadinessInput = { ...all, campaigns: [camp({ sc: 1, ready: 1, drafts: status === 'draft' ? 1 : 0, sent: status === 'sent' ? 1 : 0 })], messages: [{ status, lead_id: 'l1' }] }
    if (status === 'approved') i.campaigns = [{ ...camp({ sc: 1, ready: 1 }), outreach: { drafts: 0, approved: 1, sent: 0 } }]
    const d = readyItems(i)[5]
    assert.deepEqual([d.state, d.detail], ['done', '1 email drafted'], status)
  }
  // A capped emails read cannot give the whole count: at least the larger of the two reads, never their sum.
  const capped = readyItems({ ...all, campaigns: [camp({ sc: 1, ready: 1, drafts: 3 })], messages: Array.from({ length: 200 }, (_, n) => ({ status: n < 2 ? 'draft' : 'skipped' })) })[5]
  assert.deepEqual([capped.state, capped.detail], ['done', 'at least 3 emails drafted'])
})

test('Instinct #341: a test-only send never completes a real-work step', () => {
  const t = { status: 'draft', lead_id: 'test-l', test: 1 }
  const i: ReadinessInput = { ...all, campaigns: [], messages: [t] }
  assert.equal(readyItems(i)[5].state, 'todo', 'a test draft is not a first draft')
  for (const status of ['approved', 'sent']) assert.equal(readyItems({ ...i, messages: [{ ...t, status }] })[5].state, 'todo', status)
  assert.equal(readyComplete(readyItems(i)), false)
  // Test sends are left out after the cap is judged: 200 rows of which only test ones are drafts is still a capped read.
  assert.equal(readyItems({ ...all, campaigns: [camp({ sc: 1 })], messages: Array.from({ length: 200 }, () => t) })[5].state, 'unknown')
})

// #420: a saved manual business profile (what you sell + the buyer profile, no website) completes the business-profile
// step, as one read from a website does; the next action is the step actually unmet. Search-can-run stays separate.
const manual: ReadinessInput['profile'] = { sells: 'Bookkeeping for trades businesses', business_name: 'Ledgerly', website: '', buyer: { summary: 'Plumbing and electrical firms with 5-50 staff in Ontario', who: ['Owner', 'Office manager'] } }

test('#420 a saved manual profile (no website) completes the business profile step; reload reads the same', () => {
  const noKey: ReadinessInput = { ...all, profile: manual, usage: { has_key: false, trial: { funded: false, remaining: 0 } }, keys: [], jobs: [], totals: { searches: 0, finished: 0 }, campaigns: [], messages: [] }
  for (const input of [noKey, JSON.parse(JSON.stringify(noKey)) as ReadinessInput]) { // the same saved rows after a reload
    const [profile, search] = readyItems(input)
    assert.deepEqual([profile.state, profile.fix, profile.detail], ['done', null, 'Plumbing and electrical firms with 5-50 staff in Ontario'])
    assert.equal(search.state, 'todo', 'search-can-run is still its own step when no key or trial is available')
    assert.equal(readyItems(input).find(x => x.next)?.id, 'search', 'the next action is the step actually unmet, not "Add website"')
  }
  assert.ok(!st(noKey).some(x => x.includes('Add website')))
})

test('#420 missing or partial profiles stay to-do with the right fix; a later edit that empties the buyer profile reopens it', () => {
  const at = (profile: ReadinessInput['profile']) => st({ ...all, profile })[0]
  assert.equal(at({ ...manual, buyer: null }), 'profile:todo*>Add website@/app?setup=site', 'no website and no buyer profile')
  assert.equal(at({ ...manual, buyer: { summary: '  ', who: [] } }), 'profile:todo*>Add website@/app?setup=site', 'an empty buyer profile is not a profile')
  assert.equal(at({ ...manual, sells: '' }), 'profile:todo*>Add what you sell@/app?setup=site')
  assert.equal(at({ ...manual, website: 'https://ledgerly.example', buyer: null }), 'profile:todo*>Build profile@/app?setup=brain', 'website saved, buyer profile not built')
  assert.equal(at({ ...manual, website: 'https://ledgerly.example' }), 'profile:done', 'the website path still completes it')
  assert.equal(readyItems({ ...all, profile: null })[0].state, 'unknown', 'a profile that did not load is never shown as to-do or done')
})
