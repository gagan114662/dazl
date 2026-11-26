import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverState } from '../lib/discover/card.ts'

for (const surname of ["O'Neill", 'O’Neill']) {
  test(`Ready binds a published address to the whole surname ${surname}`, () => {
    const state = (local: string, date: string | null = new Date().toISOString().slice(0, 10)) => discoverState({
      source_kind: 'discover', event_date: date, company_domain: 'sample.example',
      enrichments: [
        { connector: 'discover', kind: 'person', value: `Dana ${surname}`, source_url: 'https://sample.example/team' },
        { connector: 'discover', kind: 'email', value: `${local}@sample.example`, source_url: 'https://sample.example/team' },
      ],
    })
    assert.equal(state('dana.oneill'), 'ready_email')
    assert.equal(state('dana.neill'), 'no_contact')
    assert.equal(state('info'), 'no_contact')
    assert.equal(state('dana.oneill', null), 'research')
  })
}
