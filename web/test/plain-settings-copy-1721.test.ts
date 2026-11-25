// #1721: the Settings panels and the pre-run estimate box speak to a customer, not to an operator or a developer.
// Reads the rendered copy from the component sources (the strings are literals in the JSX).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const web = path.resolve(import.meta.dirname, '..')
const src = (f: string) => readFileSync(path.join(web, f), 'utf8')

const FILES = {
  advanced: 'app/app/settings/advanced-panel.tsx',
  memory: 'app/app/settings/memory-panel.tsx',
  usage: 'app/app/settings/usage-panel.tsx',
  estimate: 'app/app/leads/estimate-confirm.tsx',
}

test('connectors panel: no env var names, tier jargon, API-key talk or "throwaway"', () => {
  const s = src(FILES.advanced)
  assert.doesNotMatch(s, /ADVANCED_CONNECTORS/, 'an env var name is shown to the customer')
  assert.doesNotMatch(s, /The operator turns it on/)
  assert.doesNotMatch(s, /Tier 0 channels/)
  assert.doesNotMatch(s, /outside API key/)
  assert.doesNotMatch(s, /throwaway/i)
  // Plain wording must not drop the third-party disclosure from the original caveat.
  assert.match(s, /third-party services that receive the URLs or search terms/)
  // The ban risk is still said plainly.
  assert.match(s, /can limit or ban the account you use/)
  assert.match(s, /never your main one/)
})

test('memory panel: no "ICP" label and no AI-key or token talk', () => {
  const s = src(FILES.memory)
  assert.doesNotMatch(s, /\(ICP\)/)
  assert.doesNotMatch(s, /your own AI key/)
  assert.doesNotMatch(s, /tokens per call/)
  assert.match(s, /Who you sell to/)
  assert.match(s, /Exclusions are hard rules/)
})

test('usage panel: no "provider-reported usage" wording', () => {
  const s = src(FILES.usage)
  assert.doesNotMatch(s, /provider-reported/)
  assert.doesNotMatch(s, /what your provider reported back/)
  assert.doesNotMatch(s, /your AI provider bills you directly/)
  assert.match(s, /not a cost estimate/)
})

test('estimate box: plain column names and labels', () => {
  const s = src(FILES.estimate)
  for (const jargon of ['Provider / source', 'Unit price', 'Expected use', 'Projected', '>Assumptions<', 'counts against your limit']) {
    assert.ok(!s.includes(jargon), `estimate box still says ${JSON.stringify(jargon)}`)
  }
  for (const plain of ['What it uses', 'Price each', 'How much', 'Estimate', 'Estimated total', 'How we worked this out']) {
    assert.ok(s.includes(plain), `estimate box missing ${JSON.stringify(plain)}`)
  }
  // The #1319 customer view and its test ids stay.
  assert.match(s, /customerView\(est\)/)
  assert.match(s, /data-testid="estimate-assumptions"/)
  assert.match(s, /data-testid="estimate-total"/)
})
