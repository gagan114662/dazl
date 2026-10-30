import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreSources, socialLabel, socialSources, usableLabels, type SourceRow } from '../lib/scan/source-availability.ts'

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

test('social sources: only platforms the server offers; usable exactly when the Leads checkbox is offered; otherwise the first missing step, with a fix', () => {
  const rows = socialSources({ available: true, platforms: [
    { platform: 'x', allowed: true, consent: true, connected: true, enabled: true },
    { platform: 'linkedin', allowed: true, consent: true, connected: false, enabled: false },
    { platform: 'reddit', allowed: true, consent: false, connected: true, enabled: true },
    { platform: 'facebook', allowed: true, consent: true, connected: true, enabled: false },
    { platform: 'yy', consent: true, connected: false, enabled: false, operator_index: true },
    { platform: 'instagram', allowed: false, consent: true, connected: true, enabled: true },
    { platform: 'bilibili', allowed: false, consent: false, connected: false, enabled: false },
  ] })
  const r = byId(rows)
  assert.deepEqual(Object.keys(r), ['social:x', 'social:linkedin', 'social:reddit', 'social:facebook', 'social:yy'], 'platforms the server does not offer are not listed at all')
  assert.equal(r['social:x'].usable, true)
  assert.deepEqual([r['social:linkedin'].reason, r['social:linkedin'].fix], ['not connected', { href: '/app/settings#social', label: 'Set up' }])
  assert.equal(r['social:reddit'].reason, 'consent needed')
  assert.deepEqual([r['social:facebook'].label, r['social:facebook'].reason], ['Facebook', 'turned off'])
  assert.equal(r['social:yy'].usable, true, 'operator web index needs consent only')
  // Instinct-reported live copy: "instagram (not set up on this server); ... bilibili (...)" - the tier off lists nothing.
  assert.deepEqual(socialSources({ available: false, platforms: [{ platform: 'x', consent: true, connected: true, enabled: true }, { platform: 'instagram', consent: false, connected: false, enabled: false }] }), [])
  for (const row of rows) assert.doesNotMatch(row.reason ?? '', /not set up on this server/, 'no "not on this server" social rows')
})

test('social platform names are proper names, never raw ids', () => {
  assert.deepEqual(['x', 'linkedin', 'reddit', 'instagram', 'facebook', 'xiaohongshu', 'bilibili', 'mastodon'].map(socialLabel), ['X posts', 'LinkedIn', 'Reddit', 'Instagram', 'Facebook', 'Xiaohongshu', 'Bilibili', 'Mastodon'])
})

test('usable labels list only usable sources, in order', () => {
  assert.equal(usableLabels(coreSources({ web_index: false, news: true, websites: true }, { has_key: true })!), 'Web research with your AI key, News articles, Company websites')
  assert.equal(usableLabels(coreSources({ web_index: false, news: false, websites: false }, { has_key: false })!), '')
})
