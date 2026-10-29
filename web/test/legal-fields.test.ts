import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LEGAL_FIELDS, legalReport, type LegalPage } from '../lib/legal-fields.ts'

const src = (p: LegalPage) => readFileSync(new URL(`../app/${p}/page.tsx`, import.meta.url), 'utf8')

test('the inventory lists exactly the placeholders the Terms and Privacy pages still contain', () => {
  for (const p of ['terms', 'privacy'] as const) {
    const r = legalReport(p, src(p))
    assert.deepEqual(r.unlisted, [], `${p}: a placeholder is not in LEGAL_FIELDS - add it`)
    assert.deepEqual(r.missing.map(f => f.token).sort(), LEGAL_FIELDS.filter(f => f.page === p).map(f => f.token).sort(), `${p}: LEGAL_FIELDS lists a field the page no longer has - remove it`)
  }
})

test('while any field is missing or the DRAFT banner is up, neither page is final; the validator supplies no value', () => {
  for (const p of ['terms', 'privacy'] as const) { const r = legalReport(p, src(p)); assert.equal(r.final, false); assert.equal(r.draftBanner, true); assert.ok(r.missing.length > 0) }
  for (const f of LEGAL_FIELDS) assert.ok(f.needs.length > 10 && (f.owner === 'site owner' || f.owner === 'counsel'))
  assert.ok(LEGAL_FIELDS.some(f => f.owner === 'counsel'), 'counsel-owned clauses are named, not drafted')
})

test('a page with every placeholder resolved and no banner is final; one resolved placeholder alone is not', () => {
  assert.equal(legalReport('terms', '<main>Final text with no placeholders</main>').final, true)
  assert.equal(legalReport('terms', '<main>Last updated: 1 Jan. [COMPANY LEGAL NAME]</main>').final, false)
  assert.equal(legalReport('terms', '<p>DRAFT - placeholder text for review</p> done').final, false)
  assert.deepEqual(legalReport('privacy', 'x [SURPRISE FIELD] y').unlisted, ['[SURPRISE FIELD]'])
})
