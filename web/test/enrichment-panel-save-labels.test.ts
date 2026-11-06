// #594/#363: every Save control in the enrichment panel needs a distinct accessible name. The browser smoke
// locates buttons by name; bare text "Save" matched 5 elements once the credit-limit controls shipped
// (job 127140323821) and made the smoke fail. Source pin: the real browser proof is the smoke in CI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const panel = readFileSync(fileURLToPath(new URL('../app/app/settings/enrichment-panel.tsx', import.meta.url)), 'utf8')
const smoke = readFileSync(fileURLToPath(new URL('smoke/enrichment-fallback.smoke.mjs', import.meta.url)), 'utf8')

test('credit-limit Save buttons carry per-provider-window aria-labels', () => {
  assert.match(panel, /aria-label=\{`Save \$\{u\.provider\} \$\{u\.window\} credit limit`\}/, 'each limit Save names its provider and window')
})

test('key Save buttons carry per-connector aria-labels', () => {
  assert.match(panel, /aria-label=\{`Save \$\{s\.name\} key`\}/, 'each key Save names its connector')
})

test('the smoke never locates a bare "Save" button', () => {
  assert.ok(!smoke.includes("name: 'Save', exact: true"), 'bare Save matched 5 buttons with the credit limits; use the specific accessible names')
  assert.ok(smoke.includes("name: 'Save Apollo.io key'"), 'the Apollo key save uses its specific name')
  assert.ok(smoke.includes("name: 'Save People Data Labs key'"), 'the PDL key save uses its specific name')
})
