import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyEntityMatch, classifyBoardMatch, nameTokens, urlSegments } from '../lib/signals/entity-match.ts'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

test('one-token company does not match a same-named fund filing', () => {
  assert.equal(classifyEntityMatch('Vesta', 'Vesta Ventures Fund II, LP'), 'unconfirmed')
  assert.equal(classifyEntityMatch('Vesta', 'Vesta Capital Partners LP'), 'unconfirmed')
})

test('entity with fund markers never confirms an operating company without them', () => {
  assert.equal(classifyEntityMatch('Ambi', 'Ambi Ventures'), 'unconfirmed')
  // both sides fund-flavoured: allowed to compare tokens normally
  assert.equal(classifyEntityMatch('Vesta Ventures', 'Vesta Ventures LP'), 'heuristic')
})

test('exact name after suffix stripping confirms', () => {
  assert.equal(classifyEntityMatch('Vesta', 'Vesta, Inc.'), 'heuristic')
  assert.equal(classifyEntityMatch('Acme Robotics', 'Acme Robotics, Inc.'), 'heuristic')
  assert.equal(classifyEntityMatch('Acme Robotics', 'ACME ROBOTICS CORPORATION'), 'heuristic')
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
  assert.equal(classifyBoardMatch('duvo.ai', 'https://api.ashbyhq.com/posting-api/job-board/duvo'), 'heuristic')
  assert.equal(classifyBoardMatch('duvo.ai', 'https://boards-api.greenhouse.io/v1/boards/duvo/jobs?content=true'), 'heuristic')
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

test('withinEventWindow: filing far from the claimed round date does not corroborate it', async () => {
  const { withinEventWindow } = await import('../lib/signals/index.ts')
  // July fund filing vs claimed October round: outside the window
  assert.equal(withinEventWindow('2026-07-01', '2026-10-14'), false)
  // 2022 filing vs 2026 claim: far outside
  assert.equal(withinEventWindow('2022-10-17', '2026-10-14'), false)
  // same-month filing corroborates
  assert.equal(withinEventWindow('2026-10-03', '2026-10-14'), true)
  // undated claim accepts any bounded filing; garbage dates never do
  assert.equal(withinEventWindow('2024-05-29', null), true)
  assert.equal(withinEventWindow('not-a-date', '2026-10-14'), false)
})

test('edgarFunding: stale filings are filtered client-side (startdt is not honoured server-side)', async () => {
  const { edgarFunding } = await import('../lib/signals/index.ts')
  const HITS = { hits: { hits: [
    { _id: 'a:primary_doc.xml', _source: { display_names: ['Zymtrace Inc  (CIK 0001904455)'], file_date: '2019-10-10', adsh: '0001904455-19-000056', ciks: ['0001904455'], form: 'D' } },
    { _id: 'b:primary_doc.xml', _source: { display_names: ['Zymtrace Inc  (CIK 0001904455)'], file_date: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), adsh: '0001904455-26-000056', ciks: ['0001904455'], form: 'D' } },
  ] } }
  const f = await edgarFunding('Zymtrace', async () => ok(HITS))
  assert.ok(f)
  assert.notEqual(f.date, '2019-10-10')
  const f2 = await edgarFunding('Zymtrace', async () => ok({ hits: { hits: [HITS.hits.hits[0]] } }))
  assert.equal(f2, null) // only a years-old filing: no "recent funding" signal
})

test('qualifyEvent: SEC events need entity match and claim-window, boards need domain slugs, press stays heuristic', async () => {
  const { qualifyEvent } = await import('../lib/signals/entity-match.ts')
  // the original Vesta case: a same-named fund's filing
  assert.equal(qualifyEvent('Vesta', null, { detail: 'Vesta Ventures Fund II, LP', source_url: 'https://www.sec.gov/Archives/edgar/data/2139575/000213957526000001/primary_doc.xml', source_published_at: '2026-07-01' }, '2026-10-14'), 'unconfirmed')
  // right entity but months outside the claimed round window: not corroboration of the claim
  assert.equal(qualifyEvent('Vesta', null, { detail: 'Vesta, Inc.', source_url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', source_published_at: '2026-07-01' }, '2026-10-14'), 'unconfirmed')
  // right entity within the window: a heuristic match, never proof of the round
  assert.equal(qualifyEvent('Vesta', null, { detail: 'Vesta, Inc.', source_url: 'https://www.sec.gov/Archives/edgar/data/1/0001/primary_doc.xml', source_published_at: '2026-10-10' }, '2026-10-14'), 'heuristic')
  // domain-derived board slug is a heuristic; bare-name slug is unconfirmed
  assert.equal(qualifyEvent('Duvo', 'duvo.ai', { detail: null, source_url: 'https://jobs.ashbyhq.com/duvo/abc', source_published_at: null }), 'heuristic')
  assert.equal(qualifyEvent('Vesta', null, { detail: null, source_url: 'https://jobs.ashbyhq.com/vesta/abc', source_published_at: null }), 'unconfirmed')
  // name-matched press can be neither verified nor condemned: heuristic
  assert.equal(qualifyEvent('Vesta', null, { detail: null, source_url: 'https://news.example.com/vesta-raises', source_published_at: '2026-10-10' }), 'heuristic')
})
