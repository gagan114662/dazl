import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreSources, socialLabel, socialSources, usableLabels, enrichmentLabels, analysisPrerequisite, type SourceRow } from '../lib/scan/source-availability.ts'

const ALL_ON = { web_index: true, news: true, websites: true }
const byId = (rows: SourceRow[]): Record<string, SourceRow> => Object.fromEntries(rows.map(r => [r.id, r]))

test('discovery uses operator switches only; model funding is a separate analysis prerequisite', () => {
  const r = byId(coreSources({ web_index: false, news: true, websites: true }, { has_key: true })!)
  assert.equal(r.research, undefined)
  assert.equal(r.web_index.fix, undefined)
  assert.deepEqual(r.web_index, { id: 'web_index', label: 'Web search index', usable: false, reason: 'not set up on this server' })
  assert.equal(r.news.usable, true)
  assert.equal(usableLabels(Object.values(r)), 'News articles')
  assert.equal(enrichmentLabels(Object.values(r)), 'Company website enrichment')
  assert.equal(analysisPrerequisite({has_key:true})?.usable,true)
  assert.equal(analysisPrerequisite({has_key:false,trial:{funded:true,remaining:2}})?.usable,true)
  assert.equal(analysisPrerequisite({has_key:false,trial:{funded:true,remaining:0}})?.reason,'free searches used up; no key')
  assert.equal(analysisPrerequisite({has_key:false})?.fix?.href,'/app/settings#model-key')
  assert.equal(analysisPrerequisite(null),null)
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
  assert.equal(usableLabels(coreSources({ web_index: false, news: true, websites: true }, { has_key: true })!), 'News articles')
  assert.equal(usableLabels(coreSources({ web_index: false, news: false, websites: false }, { has_key: false })!), '')
})

// Couple UI capability claims to both actual provider implementations, not a model-key proxy or mocked provider.
import { anthropicProvider, openaiProvider } from '../lib/llm/provider.ts'
import { SpendRefused, guardProvider } from '../lib/llm/spend-guard.ts'
import { readFileSync } from 'node:fs'
import { normalizeScanBudget } from '../lib/scan/run-budget.ts'
const OFF = {web_index:false, news:false, websites:false}
for (const [name,key] of Object.entries({byok:{has_key:true},trial:{has_key:false,trial:{funded:true,remaining:2}},exhausted:{has_key:false,trial:{funded:true,remaining:0}},nokey:{has_key:false},unfunded:{has_key:false,trial:{funded:false,remaining:2}}})) {
  test(`${name}: no primary discovery with all switches off, regardless of analysis funding or budget form`, async () => {
    for (const budget of [null, {max_usd:1}, {paid_fallback:false}, {first5:true}]) {
      // Availability has no budget opt-in: none may restore a retired provider capability.
      const checked=normalizeScanBudget(budget,budget!==null)
      assert.equal(checked.ok,true)
      const rows=coreSources(OFF,key)!
      assert.equal(usableLabels(rows),''); assert.equal(enrichmentLabels(rows),'')
      assert.equal(rows.some(r=>r.id==='research'),false)
      let calls=0
      const fetcher=(async ()=>{calls++;throw new Error('no network')}) as typeof fetch
      for(const provider of [anthropicProvider,openaiProvider]) {
        await assert.rejects(provider.research('synthetic-key','synthetic prompt',fetcher),e=>e instanceof SpendRefused && e.reason==='research_unbounded')
        // Guarded budget routes refuse too; a legacy research allowance cannot bypass the actual provider retirement.
        const guarded=guardProvider(provider,[],undefined,budget && 'max_usd' in budget ? undefined : {reserveUsd:0})
        await assert.rejects(guarded.research('synthetic-key','synthetic prompt',fetcher),e=>e instanceof SpendRefused && e.reason==='research_unbounded')
      }
      assert.equal(calls,0)
    }
    assert.equal(usableLabels(coreSources({...OFF,news:true},key)!), 'News articles')
    assert.equal(usableLabels(coreSources({...OFF,websites:true},key)!), '', 'website crawl enriches existing leads, not discovery')
  })
}
test('entry and progress bind discovery and enrichment separately, key requirement never inferred from research row',()=>{
  const ui=readFileSync(new URL('../app/app/leads/leads-client.tsx',import.meta.url),'utf8')
  assert.match(ui,/analysisPrerequisite\(keyState\)/)
  assert.match(ui,/Discovery sources a scan here can use/)
  assert.match(ui,/Discovery sources this scan can use: \$\{\[usableLabels\(core\)/)
  assert.match(ui,/enrichmentLabels\(core\)/)
  assert.doesNotMatch(ui,/id === 'research'/)
  assert.match(ui,/Could not check which sources this scan can use/)
})
