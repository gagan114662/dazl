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

// Quest (#1237): fail closed. The rule reads at most the first 3,000 characters of the page, so a company name longer than that can never be
// found in it, and the rule could never clear it. Such a lead is held for review, never passed as "no counterparty".
test('a company name longer than the text the rule reads is held, not cleared (news page and customer page)', () => {
  const huge = 'b'.repeat(50_000)
  for (const [url, brand] of [['https://finsmes.com/2026/09/x.html', 'finsmes'], ['https://linear.app/customers/x', 'linear'], ['https://linear.app/blog/x', 'linear']]) {
    assert.equal(cp(huge, url, 'Linear news', `${huge} uses Linear. Linear customers love it.`), `unchecked_name:${brand}`, url)
    assert.equal(cp(huge, url, 'Linear news', 'Linear shipped a new release.'), `unchecked_name:${brand}`, url)
  }
  // a name that fits in the text the rule reads keeps today's answer
  const fits = 'b'.repeat(3_000)
  assert.equal(cp(fits, 'https://finsmes.com/2026/09/x.html', 'Linear news', 'Linear shipped a new release.'), null)
})

// Council (#1237): on the brand's own customer pages the company must sit within 200 characters of the brand, so a longer name can never
// be found there and the rule could never clear it: held. The hold comes after the own-source checks: a long name on its own site or its
// own board posting is still the lead's own page.
test('on a customer page a name longer than the brand window is held; own sources stay free', () => {
  for (const n of [201, 450, 1000, 2900]) {
    const co = 'b'.repeat(n)
    assert.equal(cp(co, 'https://linear.app/customers/x', 'Linear', `Linear customers: ${co} uses Linear.`), 'unchecked_name:linear', String(n))
  }
  assert.equal(cp('Brightloop', 'https://linear.app/customers/x', 'Linear', 'Linear customers: Brightloop uses Linear.'), 'source_owner:linear')
  assert.equal(cp(`linear ${'b'.repeat(5000)}`, 'https://linear.app/customers/x', 'Linear', 'Linear customers.'), null)
  // a short first word inside the brand ("a" in "linear") is no proof of an own source for a name the rule cannot read
  assert.equal(cp(`a ${'b'.repeat(50_000)}`, 'https://linear.app/blog/x', 'Linear news', 'Linear shipped a new release.'), 'unchecked_name:linear')
  assert.equal(cp(`a ${'b'.repeat(300)}`, 'https://linear.app/customers/x', 'Linear', 'Linear customers.'), 'unchecked_name:linear')
  const slug = 'b'.repeat(40)
  assert.equal(cp(slug + 'c'.repeat(5000), `https://jobs.ashbyhq.com/${slug}/0b6f3c1e-4b8a-4c1e-9f2d-1a2b3c4d5e6f`, 'Role', 'A job.'), 'unchecked_name:' + slug)
  assert.equal(cp(slug, `https://jobs.ashbyhq.com/${slug}/0b6f3c1e-4b8a-4c1e-9f2d-1a2b3c4d5e6f`, 'Role', 'x'.repeat(4000)), null)
})
