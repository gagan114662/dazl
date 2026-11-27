import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverApprove, discoverContact, discoverState } from '../lib/discover/card.ts'

function published(address: string, source: string) {
  return { kind: 'email', connector: 'discover', value: address, source_url: source, label: 'published on a public page' }
}

test('a dated hiring lead selects the valid named work mailbox after an ineligible address', () => {
  const address = 'maya.chen@orchard.example'
  const source = 'https://orchard.example/team'
  const lead = {
    source_kind: 'discover',
    event_date: new Date().toISOString().slice(0, 10),
    event_date_proof: 'page_bound' as const,
    company_domain: 'orchard.example',
    name: 'Maya Chen',
    enrichments: [
      published('maya.chen@elsewhere.example', 'https://directory.example/orchard'),
      published(address, source),
    ],
  }
  assert.equal(discoverState(lead), 'ready_email')
  assert.deepEqual(discoverApprove(lead), { ok: true })
  assert.deepEqual(discoverContact(lead)?.email, { address, source })
})

test('a dated hiring lead with only a directory mailbox remains held', () => {
  const lead = {
    source_kind: 'discover',
    event_date: new Date().toISOString().slice(0, 10),
    event_date_proof: 'page_bound' as const,
    company_domain: 'harbor.example',
    name: 'Ari Flores',
    enrichments: [published('ari.flores@elsewhere.example', 'https://directory.example/harbor')],
  }
  assert.equal(discoverState(lead), 'no_contact')
  assert.equal(discoverApprove(lead).ok, false)
})
