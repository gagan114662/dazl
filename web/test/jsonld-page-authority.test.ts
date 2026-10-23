import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPeople } from '../lib/connectors/sitecrawl.ts'

const ld = (j: unknown) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`
const U = 'https://x.example/about'
const vals = (html: string) => extractPeople(html, U).map(p => p.value)
const dana = { '@type': 'Person', name: 'Dana Lee', jobTitle: 'Owner' }
const eve = { '@type': 'Person', name: 'Eve Stone', jobTitle: 'Founder' }

// RESIDUAL DEFECT on corrected tree ab674651: the >1-org guard is per <script> block.
// Two blocks each naming a DIFFERENT single organisation each pass the block-level check,
// so people from two different companies are both listed as this page's company people.
// Desired: page-level authority - conflicting organisations across blocks list no one.
test('REPRO two script blocks naming different companies must list no one', () => {
  const html = ld({ '@type': 'Organization', name: 'Acme Roofing', employee: dana })
    + ld({ '@type': 'Organization', name: 'Other Co', employee: eve })
  assert.deepEqual(vals(html), [])
})

// Safe same-org positives the page-level fix must PRESERVE (these pass today; keep them green).
test('same company split across two blocks, same person duplicated: still listed once', () => {
  const html = ld({ '@type': 'Organization', name: 'Acme Roofing', employee: dana })
    + ld({ '@type': 'Organization', name: 'Acme Roofing', employee: dana })
  assert.deepEqual(vals(html), ['Dana Lee, Owner'])
})
test('same company split across two blocks, different people of that company: both listed', () => {
  const html = ld({ '@type': 'Organization', name: 'Acme Roofing', employee: dana })
    + ld({ '@type': 'Organization', name: 'Acme Roofing', employee: eve })
  assert.deepEqual(vals(html), ['Dana Lee, Owner', 'Eve Stone, Founder'])
})
test('one org block plus a non-org block: unaffected positive', () => {
  const html = ld({ '@type': 'WebSite', name: 'Acme Roofing' })
    + ld({ '@type': 'Organization', name: 'Acme Roofing', employee: dana })
  assert.deepEqual(vals(html), ['Dana Lee, Owner'])
})
