import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src=readFileSync(new URL('../app/app/feature-discovery.tsx',import.meta.url),'utf8')
test('discovery points to existing CRM, competitors and Memory anchors',()=>{
  const settings=readFileSync(new URL('../app/app/settings/page.tsx',import.meta.url),'utf8')
  for(const id of ['crm','memory']) {assert.ok(settings.includes(`id="${id}"`));assert.ok(src.includes(`/app/settings#${id}`))}
  const competitors=readFileSync(new URL('../app/app/settings/competitors-panel.tsx',import.meta.url),'utf8')
  assert.ok(competitors.includes('id="competitors"'))
  assert.ok(src.includes('/app/settings#competitors'))
})
test('home includes discovery with honest setup and coverage limits',()=>{
  const page=readFileSync(new URL('../app/app/page.tsx',import.meta.url),'utf8')
  assert.ok(page.includes('<FeatureDiscovery />'))
  assert.ok(src.includes('coverage varies'))
  assert.ok(src.includes('Requires the Reddit connector and consent'))
  assert.ok(src.includes('It does not reply or post'))
})
