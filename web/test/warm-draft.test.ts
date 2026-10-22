import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { draftFirstDegreeMessage, draftIntroRequest, signalClause } from '../lib/warm/draft.ts'

describe('warm draft templates', () => {
  it('first-degree draft uses first name, company and grounded signal', () => {
    const d = draftFirstDegreeMessage({ connectionName: 'Ada Lovelace', company: 'Acme', signal: 'Hiring a Sales Operations Manager.' })
    assert.match(d, /^Hi Ada - I would like to ask about Acme/)
    assert.ok(!d.includes('Hiring'))
    assert.match(d, /\[One line on what you offer/)
    assert.ok(!d.includes('great catching up'))
  })
  it('handles empty company and signal without inventing', () => {
    const d = draftFirstDegreeMessage({ connectionName: 'Grace Hopper', company: ' ', signal: '' })
    assert.match(d, /Hi Grace - I would like to ask about your company\./)
    assert.ok(!d.includes('undefined'))
  })
  it('intro request names the mutual and contact, claims no familiarity', () => {
    const d = draftIntroRequest({ mutualName: 'Alan Turing', contactName: 'Grace Hopper', company: 'Acme' })
    assert.match(d, /Hi Alan - do you know Grace Hopper well enough/)
    assert.match(d, /Would you be comfortable making an introduction\?/)
  })
  it('signalClause truncates long signals at a word boundary', () => {
    const long = 'A'.repeat(200)
    const c = signalClause('Hiring now. ' + long, 60)
    assert.ok(c.length <= 64)
    assert.ok(c.endsWith('...'))
    assert.equal(c[0], c[0].toLowerCase())
  })
})
