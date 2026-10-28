import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreSources, socialSources, usableLabels, type SourceRow } from '../lib/scan/source-availability.ts'

const ALL_ON = { web_index: true, news: true, websites: true }
const byId = (rows: SourceRow[]): Record<string, SourceRow> => Object.fromEntries(rows.map(r => [r.id, r]))

test('core sources: operator switches and the key decide; off ones say why, and only the key has a user fix', () => {
  const r = byId(coreSources({ web_index: false, news: true, websites: false }, { has_key: true })!)
  assert.deepEqual(r.research, { id: 'research', label: 'Web research with your AI key', usable: true })
  assert.equal(r.web_index.fix, undefined, 'an operator switch has no user fix link')
  assert.deepEqual(r.web_index, { id: 'web_index', label: 'Web search index', usable: false, reason: 'not set up on this server' })
  assert.equal(r.news.usable, true)
  assert.equal(r.websites.reason, 'not set up on this server')
})

test('no key: research is unavailable with a link to add one; free searches left count as usable', () => {
  assert.deepEqual(byId(coreSources(ALL_ON, { has_key: false, trial: null })!).research, { id: 'research', label: 'Web research with your AI key', usable: false, reason: 'no key', fix: { href: '/app/settings#model-key', label: 'Add key' } })
  assert.equal(byId(coreSources(ALL_ON, { has_key: false, trial: { funded: true, remaining: 0 } })!).research.reason, 'free searches used up; no key')
  assert.equal(byId(coreSources(ALL_ON, { has_key: false, trial: { funded: true, remaining: 2 } })!).research.usable, true)
})

test('nothing is claimed when the checks could not load', () => {
  assert.equal(coreSources(null, { has_key: true }), null)
  assert.equal(coreSources(ALL_ON, null), null)
  assert.deepEqual(socialSources(null), [])
})

test('social sources: usable exactly when the Leads checkbox is offered; otherwise the first missing step, with a fix', () => {
  const rows = byId(socialSources({ available: true, platforms: [
    { platform: 'x', consent: true, connected: true, enabled: true },
    { platform: 'linkedin', consent: true, connected: false, enabled: false },
    { platform: 'reddit', consent: false, connected: true, enabled: true },
    { platform: 'xx', consent: true, connected: true, enabled: false },
    { platform: 'yy', consent: true, connected: false, enabled: false, operator_index: true },
    { platform: 'zz', allowed: false, consent: true, connected: true, enabled: true },
  ] }))
  assert.equal(rows['social:x'].usable, true)
  assert.deepEqual([rows['social:linkedin'].reason, rows['social:linkedin'].fix], ['not connected', { href: '/app/settings#social', label: 'Set up' }])
  assert.equal(rows['social:reddit'].reason, 'consent needed')
  assert.equal(rows['social:xx'].reason, 'turned off')
  assert.equal(rows['social:yy'].usable, true, 'operator web index needs consent only')
  assert.deepEqual([rows['social:zz'].reason, rows['social:zz'].fix], ['not set up on this server', undefined])
  assert.ok(socialSources({ available: false, platforms: [{ platform: 'x', consent: true, connected: true, enabled: true }] }).every(r => !r.usable && r.reason === 'not set up on this server'))
})

test('usable labels list only usable sources, in order', () => {
  assert.equal(usableLabels(coreSources({ web_index: false, news: true, websites: true }, { has_key: true })!), 'Web research with your AI key, News articles, Company websites')
  assert.equal(usableLabels(coreSources({ web_index: false, news: false, websites: false }, { has_key: false })!), '')
})
