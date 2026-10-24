import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSources } from '../lib/sources/ui-sources.ts'
import { normalizeSources } from '../lib/sources/index.ts'
const off = { github: false, youtube: false, v2ex: false, jobboards: false, feedText: '', pageText: '', advPick: [] as string[] }
test('nothing ticked: no sources object at all (default unchanged)', () => assert.equal(buildSources(off), null))
test('job boards ticked alone: one adapter, accepted by the server validator', () => {
  const s = buildSources({ ...off, jobboards: true })
  assert.deepEqual(s, { adapters: ['jobboards'], feeds: [], pages: [], advanced: [] })
  assert.deepEqual(normalizeSources(s), { adapters: ['jobboards'], feeds: [], pages: [] })
})
test('existing combinations keep their order and fields; job boards is added last', () => {
  const s = buildSources({ ...off, github: true, v2ex: true, jobboards: true, feedText: 'https://a.example/f.xml\n', pageText: ' https://b.example/p ' })
  assert.deepEqual(s, { adapters: ['github', 'v2ex', 'rss', 'web', 'jobboards'], feeds: ['https://a.example/f.xml'], pages: ['https://b.example/p'], advanced: [] })
})
