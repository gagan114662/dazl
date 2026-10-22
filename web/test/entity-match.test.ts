import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyEntityMatch, classifyBoardMatch, nameTokens, urlSegments } from '../lib/signals/entity-match.ts'

test('one-token company does not match a same-named fund filing', () => {
  assert.equal(classifyEntityMatch('Vesta', 'Vesta Ventures Fund II, LP'), 'unconfirmed')
  assert.equal(classifyEntityMatch('Vesta', 'Vesta Capital Partners LP'), 'unconfirmed')
})

test('entity with fund markers never confirms an operating company without them', () => {
  assert.equal(classifyEntityMatch('Ambi', 'Ambi Ventures'), 'unconfirmed')
  // both sides fund-flavoured: allowed to compare tokens normally
  assert.equal(classifyEntityMatch('Vesta Ventures', 'Vesta Ventures LP'), 'confirmed')
})

test('exact name after suffix stripping confirms', () => {
  assert.equal(classifyEntityMatch('Vesta', 'Vesta, Inc.'), 'confirmed')
  assert.equal(classifyEntityMatch('Acme Robotics', 'Acme Robotics, Inc.'), 'confirmed')
  assert.equal(classifyEntityMatch('Acme Robotics', 'ACME ROBOTICS CORPORATION'), 'confirmed')
})

test('extra distinctive tokens do not confirm, even when the name is contained', () => {
  assert.equal(classifyEntityMatch('Ambi', 'Ambi Robotics, Inc.'), 'unconfirmed')
  assert.equal(classifyEntityMatch('Clueso', 'Clueso Labs GmbH'), 'unconfirmed')
})

test('empty or suffix-only names never confirm', () => {
  assert.equal(classifyEntityMatch('', 'Acme Inc'), 'unconfirmed')
  assert.equal(classifyEntityMatch('Acme', ''), 'unconfirmed')
  assert.equal(classifyEntityMatch('Inc', 'Inc LLC'), 'unconfirmed')
})

test('nameTokens strips legal-form words anywhere', () => {
  assert.deepEqual(nameTokens('Vesta Ventures Fund II, LP'), ['vesta', 'ventures', 'fund', 'ii'])
  assert.deepEqual(nameTokens('Limited Brands Inc'), ['brands'])
})

test('board match confirms only when the slug came from the company domain', () => {
  assert.equal(classifyBoardMatch('duvo.ai', 'https://api.ashbyhq.com/posting-api/job-board/duvo'), 'confirmed')
  assert.equal(classifyBoardMatch('duvo.ai', 'https://boards-api.greenhouse.io/v1/boards/duvo/jobs?content=true'), 'confirmed')
  // null domain: the slug can only have been name-derived - unconfirmed
  assert.equal(classifyBoardMatch(null, 'https://jobs.ashbyhq.com/vesta/fda6030d-5655-4077-8345-b3d5ee66527c'), 'unconfirmed')
  // domain slug absent from the board URL: the board was found under another slug
  assert.equal(classifyBoardMatch('vesta.com', 'https://jobs.ashbyhq.com/vestahq/abc'), 'unconfirmed')
  assert.equal(classifyBoardMatch('co.uk', 'https://jobs.lever.co/co'), 'unconfirmed')
})

test('urlSegments drops board-API structure segments', () => {
  assert.deepEqual(urlSegments('https://boards-api.greenhouse.io/v1/boards/duvo/jobs'), ['duvo'])
  assert.deepEqual(urlSegments('not a url'), [])
})
