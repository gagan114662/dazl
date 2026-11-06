// #919: key-based web research was retired fail-closed (#510): both real providers refuse research before any network
// call. Source availability must never name it as a usable source, for a saved key or for funded free searches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreSources, NO_SOURCE, socialSources, usableLabels, usableSourceRows } from '../lib/scan/source-availability.ts'
import { readinessRows } from '../lib/readiness.ts'
import { readyItems } from '../lib/ready-card.ts'
import { anthropicProvider, openaiProvider } from '../lib/llm/provider.ts'

const OFF = { web_index: false, news: false, websites: false }
const KEYED = [{ has_key: true }, { has_key: false, trial: { funded: true, remaining: 3 } }]

test('both real providers refuse research before any request, so it is not a capability to advertise', async () => {
  for (const p of [anthropicProvider, openaiProvider] as unknown as { research: (...a: unknown[]) => Promise<unknown> }[]) {
    await assert.rejects(() => p.research('k', 'q'), (e: Error) => /research_unbounded/.test(`${(e as { reason?: string }).reason ?? ''} ${e.message}`))
  }
})

test('a key or funded free searches is a prerequisite, never a usable source', () => {
  for (const key of KEYED) {
    const core = coreSources(OFF, key)!
    assert.equal(usableLabels(core), '', 'all real sources off: nothing is usable')
    assert.deepEqual(usableSourceRows([...core, ...socialSources(null)]), [])
    for (const r of core) assert.doesNotMatch(r.label, /web research/i, 'no row promises key-based web research')
    const research = core.find(r => r.id === 'research')!
    assert.deepEqual([research.usable, research.kind], [true, 'prerequisite'], 'the key still satisfies the start prerequisite')
  }
})

test('with a key but no discovery source, setup and Home say no source is available', () => {
  const ADV = { available: true, platforms: [] }
  for (const usage of KEYED) {
    const row = readinessRows({ profile: null, usage: usage as never, outreach: null, sources: OFF, advanced: ADV }).find(r => r.id === 'sources')!
    assert.equal(row.state, 'todo')
    assert.match(row.detail, new RegExp(`^${NO_SOURCE}`))
    assert.doesNotMatch(row.detail, /a scan can use/)
  }
  const search = readyItems({ profile: null, usage: { has_key: true } as never, outreach: null, sources: OFF, advanced: ADV } as never).find(x => x.id === 'search')!
  assert.deepEqual([search.state, search.detail], ['todo', NO_SOURCE])
})

test('a real source on: only it is named, and the row is done', () => {
  const core = coreSources({ ...OFF, news: true }, { has_key: true })!
  assert.equal(usableLabels(core), 'News articles')
  const row = readinessRows({ profile: null, usage: { has_key: true } as never, outreach: null, sources: { ...OFF, news: true } }).find(r => r.id === 'sources')!
  assert.equal(row.state, 'done')
  assert.match(row.detail, /^a scan can use News articles\./)
})

test('all core sources off and the social read failed: could not check, never a definitive no-source to-do', () => {
  for (const advanced of [null, undefined]) {
    const row = readinessRows({ profile: null, usage: { has_key: true } as never, outreach: null, sources: OFF, advanced }).find(r => r.id === 'sources')!
    assert.deepEqual([row.state, row.fix], ['unknown', null])
    assert.doesNotMatch(row.detail, new RegExp(NO_SOURCE))
    const search = readyItems({ profile: null, usage: { has_key: true } as never, outreach: null, sources: OFF, advanced } as never).find(x => x.id === 'search')!
    assert.equal(search.state, 'unknown')
  }
  // A loaded response with a usable social source: that source is named and the row is done.
  const row = readinessRows({ profile: null, usage: { has_key: true } as never, outreach: null, sources: OFF, advanced: { available: true, platforms: [{ platform: 'x', consent: true, connected: true, enabled: true }] } }).find(r => r.id === 'sources')!
  assert.deepEqual([row.state, row.detail.startsWith('a scan can use X posts')], ['done', true])
})
