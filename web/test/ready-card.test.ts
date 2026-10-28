import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyComplete, readyItems } from '../lib/ready-card.ts'
import type { ReadinessInput } from '../lib/readiness.ts'

const all: ReadinessInput = {
  profile: { website: 'https://www.brightsmile.example', sells: 'Online booking for dental practices', business_name: 'Brightsmile', buyer: { summary: 'Independent dental practices with 2-10 chairs', who: ['Practice owner'] } },
  usage: { has_key: true }, keys: [{ vendor: 'anthropic', last4: 'Ab12', validated_at: 1 }], rejection: null,
  outreach: { gmail: { email: 'dana@brightsmile.example', status: 'active' }, sender: { sender_name: 'Dana', postal_address: '1 Main St' }, daily_cap: 20 },
  sources: { web_index: false, news: true, websites: true }, advanced: { available: true, platforms: [{ platform: 'reddit', consent: false, connected: false, enabled: false }] },
}
const st = (i: ReadinessInput) => readyItems(i).map(x => `${x.id}:${x.state}${x.fix ? `>${x.fix.href}` : ''}`)

test('all four ready: the card is complete; sources names only what can run', () => {
  const items = readyItems(all)
  assert.deepEqual(st(all), ['brain:done', 'key:done', 'gmail:done', 'sources:done'])
  assert.equal(readyComplete(items), true)
  assert.equal(items[0].detail, 'brightsmile.example - Independent dental practices with 2-10 chairs')
  assert.equal(items[3].detail, '3 available: Web research with your AI key, News articles, Company websites', 'the operator-off index and unconsented Reddit are not named')
})

test('each missing item has one fix that goes straight to it', () => {
  const i: ReadinessInput = { ...all, profile: { ...all.profile, buyer: null }, usage: { has_key: false }, keys: [], outreach: { ...all.outreach, gmail: null } }
  assert.deepEqual(st(i), ['brain:todo>/app?setup=brain', 'key:todo>/app/settings#model-key', 'gmail:todo>/app/settings#gmail', 'sources:todo>/app/settings#model-key'])
  assert.deepEqual(readyItems(i).map(x => x.fix?.label), ['Build brain', 'Add key', 'Connect', 'Add key'])
  assert.equal(readyComplete(readyItems(i)), false)
  assert.deepEqual(st({ ...all, profile: { sells: 'x', buyer: null } })[0], 'brain:todo>/app?setup=site', 'no website: the website first')
  assert.deepEqual(st({ ...all, outreach: { ...all.outreach, gmail: { email: 'd@x.example', status: 'revoked' } } })[2], 'gmail:todo>/app/settings#gmail')
})

test('free searches count as a working key; a rejected key is a to-do with Replace key', () => {
  assert.deepEqual(st({ ...all, usage: { has_key: false, trial: { funded: true, remaining: 2 } }, keys: [] }).slice(1, 4), ['key:done', 'gmail:done', 'sources:done'])
  const rej = readyItems({ ...all, rejection: { error: 'key_rejected' } })
  assert.deepEqual(rej.map(x => `${x.id}:${x.state}:${x.fix?.label ?? ''}`).slice(1), ['key:todo:Replace key', 'gmail:done:', 'sources:todo:Replace key'])
})

test('reads that fail are "could not check", with no fix and the card kept up', () => {
  const i: ReadinessInput = { profile: null, usage: null, outreach: null, sources: null }
  assert.deepEqual(st(i), ['brain:unknown', 'key:unknown', 'gmail:unknown', 'sources:unknown'])
  assert.equal(readyComplete(readyItems(i)), false)
})
