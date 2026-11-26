import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverApprove, discoverContact, discoverSources, discoverState } from '../lib/discover/card.ts'

const source = 'https://cedar.example/team'
const today = new Date().toISOString().slice(0, 10)
const lead = (mailbox: string) => ({
  source_kind: 'discover',
  event_date: today,
  company_domain: 'cedar.example',
  enrichments: [
    { kind: 'person', connector: 'discover', value: 'Dana Ruiz, Dentist', source_url: source },
    { kind: 'email', connector: 'discover', value: `${mailbox}@cedar.example`, source_url: source, label: 'email verified on source' },
  ],
})

for (const mailbox of ['drruiz', 'dr.ruiz', 'dr_ruiz', 'dr-ruiz']) {
  test(`#1910: a published ${mailbox} address makes the named dentist Ready`, () => {
    const row = lead(mailbox)
    assert.equal(discoverState(row), 'ready_email')
    assert.deepEqual(discoverApprove(row), { ok: true })
    assert.deepEqual(discoverContact(row)?.email, { address: `${mailbox}@cedar.example`, source })
    assert.equal(discoverSources(row).find(item => item.field === 'email')?.url, source)
  })
}

for (const mailbox of ['drmorgan', 'info', 'office', 'reception']) {
  test(`#1910: ${mailbox} stays out of the named dentist's Ready contact`, () => {
    const row = lead(mailbox)
    assert.equal(discoverState(row), 'no_contact')
    assert.equal(discoverApprove(row).ok, false)
    assert.equal(discoverContact(row)?.email, null)
  })
}

test('#1910: a practice manager cannot use a same-surname doctor mailbox', () => {
  const row = lead('drruiz')
  row.enrichments[0].value = 'Dana Ruiz, Practice Manager'
  assert.equal(discoverState(row), 'no_contact')
  assert.equal(discoverApprove(row).ok, false)
})
