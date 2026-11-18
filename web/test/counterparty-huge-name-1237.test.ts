// #1237: counterpartySignal builds a regex from the lead's company name. A 50,000-character company used to throw
// "Regular expression too large"; it must return (null or a hold) instead. Pure function test: no network, no model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { counterpartySignal } from '../lib/scan/counterparty.ts'

const cand = (company: string, source_url: string) => ({ name: '', company, contact: null, signal: '', source_url, score: 80, excerpt: '', event_date: null })
const cp = (company: string, url: string, title: string, text: string) => counterpartySignal(cand(company, url) as never, { title, text, retrievedAt: 0 } as never, '')

test('a 50,000-character company name returns instead of throwing (news page and customer page)', () => {
  const huge = 'b'.repeat(50_000)
  for (const url of ['https://finsmes.com/2026/09/x.html', 'https://linear.app/customers/x']) {
    let out: string | null | undefined
    assert.doesNotThrow(() => { out = cp(huge, url, 'Linear news', `${huge} uses Linear. Linear customers love it.`) })
    assert.ok(out === null || typeof out === 'string')
  }
})

test('realistic names keep their answers (written relationship still held, plain news still free)', () => {
  assert.equal(cp('Brightloop', 'https://linear.app/blog/x', 'Linear blog', 'Brightloop uses Linear for planning.'), 'source_owner:linear')
  assert.equal(cp('mika', 'https://finsmes.com/2026/09/x.html', 'mika raises', 'mika raised a seed round.'), null)
})

test('written relationships match whole long names and preserve word boundaries', () => {
  const company = `${'a'.repeat(300)}b`
  const url = 'https://linear.app/blog/x'
  assert.equal(cp(company, url, 'Linear news', `${company} uses Linear.`), 'source_owner:linear')
  assert.equal(cp(company, url, 'Linear news', `${company}c uses Linear.`), null)
  assert.equal(cp(company, url, 'Linear news', `${company.slice(0, 300)} uses Linear.`), null)
})
