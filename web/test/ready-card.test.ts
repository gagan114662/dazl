import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyComplete, readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const job = (id: string, status: string, created_at = 1) => ({ id, status, error: null, query: `play ${id}`, csv_domain: null, created_at, lead_count: 3 })
const camp = (o: { sc?: number; you?: number; contacts?: number; drafts?: number; sent?: number } = {}) => ({ id: 'c', qualification: { rejected: 0, sourceChecked: o.sc ?? 0, confirmedByYou: o.you ?? 0 }, contact: { withContact: o.contacts ?? 0 }, outreach: { drafts: o.drafts ?? 0, approved: 0, sent: o.sent ?? 0 } })
const all: ReadinessInput = {
  profile: { website: 'https://www.brightsmile.example', sells: 'Online booking for dental practices', business_name: 'Brightsmile', buyer: { summary: 'Independent dental practices with 2-10 chairs', who: ['Practice owner'] } },
  usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
  outreach: { gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana Smith', postal_address: '1 Main St' }, daily_cap: 20 },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [{ platform: 'reddit', consent: false, connected: false, enabled: false }] },
  jobs: [job('a1', 'done')], totals: { searches: 1, finished: 1 }, campaigns: [camp({ sc: 2, contacts: 1, drafts: 1 })], messages: [{ status: 'draft' }],
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
  const i: ReadinessInput = { ...all, jobs: [job('a1', 'done', 1), job('b2', 'done', 5)], totals: { searches: 6, finished: 6 }, campaigns: [camp(), camp()], messages: [], outreach: { ...all.outreach, sender: { sender_name: '', postal_address: '' } } }
  assert.deepEqual(st(i), [
    'profile:done', 'search:done', 'play:done',
    'qualified:todo*>Review leads@/app/leads?job_id=b2', 'contact:todo', 'draft:todo', 'sender:todo>Add sender details@/app/settings#gmail'])
  assert.match(readyItems(i)[6].detail, /sending from dana@brightsmile\.example; your sender name and mailing address are missing/)
})

test('contact then draft: each fix opens the latest search\'s leads', () => {
  const i: ReadinessInput = { ...all, campaigns: [camp({ sc: 3 })], messages: [] }
  assert.deepEqual(st(i).slice(3, 6), ['qualified:done', 'contact:todo*>Find contact@/app/leads?job_id=a1', 'draft:todo'])
  const j: ReadinessInput = { ...all, campaigns: [camp({ sc: 3, contacts: 2 })], messages: [] }
  assert.deepEqual(st(j).slice(4, 6), ['contact:done', 'draft:todo*>Review leads@/app/leads?job_id=a1'])
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
