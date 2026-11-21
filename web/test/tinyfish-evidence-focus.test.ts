import assert from 'node:assert/strict'
import test from 'node:test'
import { focusTerms, focusText, toEvidence } from '../lib/search/tinyfish.ts'

test('focus terms come from the request: scaffolding words and short filler dropped, written acronyms kept', () => {
  const t = focusTerms('Find B2B companies (5-200 employees) hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales')
  for (const w of ['hiring', 'sdr', 'bdr', 'funding', 'head', 'vp', 'sales']) assert.ok(t.includes(w), w)
  for (const w of ['find', 'companies', 'employees', 'or', 'a', 'new', '5-200', 'rep']) assert.ok(!t.includes(w), w)
})
test('a long page keeps its head plus the request-term windows, in page order, within the limit', () => {
  const page = 'Menu item. '.repeat(400) + 'Acme raised new funding today. ' + 'Filler text. '.repeat(400)
  const out = focusText(page, ['funding'], 2000)
  assert.ok(out.length <= 2000)
  assert.ok(out.startsWith('Menu item.'))
  assert.match(out, /Acme raised new funding today\./)
})
test('a short page, or no terms, is unchanged from the old head cut', () => {
  assert.equal(focusText('short page', ['x'], 4000), 'short page')
  assert.equal(focusText('a'.repeat(5000), [], 1200), 'a'.repeat(1200))
})
test('toEvidence without focus keeps the 1200-character head for every other source', () => {
  const text = 'Menu. '.repeat(400) + 'Acme raised new funding.'
  const [e] = toEvidence([{ url: 'https://acme.test/news', title: 'n', snippet: '', date: null } as never], [{ url: 'https://acme.test/news', text, title: 'n' }])
  assert.equal(e.quote.length, 1200)
  const [f] = toEvidence([{ url: 'https://acme.test/news', title: 'n', snippet: '', date: null } as never], [{ url: 'https://acme.test/news', text, title: 'n' }], undefined, 30, { terms: ['funding'], limit: 4000 })
  assert.match(f.quote, /Acme raised new funding/)
})
