import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findPublishedOwnDomainEmail, isRoleMailbox } from '../lib/company-first/company-first-buyer-search.ts'

const company = 'https://studio.example'
const buyer = 'Jane Quinn'
const title = 'Head of Sales'
const address = 'jquinn@studio.example'
const find = (text:string) => findPublishedOwnDomainEmail(buyer, [{url:`${company}/team`,text}], company, title)

test('a named-looking address under the following heading never belongs to the previous buyer', () => {
  assert.equal(find(`${buyer} — ${title}\nSam Lee — Communications Director\n${address}`), null)
  assert.equal(find(`${buyer}\n${title}\nSam Lee\n${address}`), null)
  assert.equal(find(`${buyer}\n${title}\n\n${address}`), null)
  assert.equal(find(`Former member ${buyer}\n${title}\n${address}`), null)
})

test('shared/role variants are held, even if they appear beside a real buyer', () => {
  for (const local of ['support+vip','support2','postmaster.eu','no-reply+notify','careers-team']) assert.equal(isRoleMailbox(local),true,local)
  assert.equal(find(`${buyer}\n${title}\nTeam email: ${address}`),null)
  assert.equal(find(`${buyer}\n${title}\nContact the group at ${address}`),null)
  assert.equal(find(`${buyer}\n${title}\n${address}\n\nShared directory\n${address}`),null)
})

test('only exact literal owned adjacency qualifies; case is not manufactured', () => {
  assert.equal(find(`${buyer} — ${title}\nEmail: ${address}`), address)
  assert.equal(find(`${buyer}\n${title}\nEmail: JQuinn@studio.example`), 'JQuinn@studio.example')
  assert.equal(find(`${buyer}\n${title}\nEmail: ｊquinn@studio.example`),null)
  assert.equal(find(`${buyer}\n${title}\n${address} or jane.quinn@studio.example`),null)
})
