// Public ATS board API (lib/sources/ats-board-api.ts, moved from the deleted research engine, #1393) on REAL recorded board answers
// (test/fixtures/research-ats-boards.json, 15 Nov 2026). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { boardApi, boardOf, boardRoles, type Board } from '../lib/sources/ats-board-api.ts'

const FX = JSON.parse(readFileSync(new URL('./fixtures/research-ats-boards.json', import.meta.url), 'utf8')) as Record<'greenhouse' | 'ashby' | 'lever', { token: string; body: unknown }> & { lever_city: string }
const GH: Board = { ats: 'greenhouse', token: 'tenstorrent' }, AB: Board = { ats: 'ashby', token: 'expressable' }, LV: Board = { ats: 'lever', token: 'palantir' }

test('a search result names a board only on a board host; anything else (the company site, an aggregator, http) is not a board', () => {
  assert.deepEqual(boardOf('https://job-boards.greenhouse.io/tenstorrent/jobs/4651190007'), GH)
  assert.deepEqual(boardOf('https://boards.greenhouse.io/embed/job_board?for=Tenstorrent'), GH)
  assert.deepEqual(boardOf('https://jobs.lever.co/palantir/6ed76ce8-4156-4b60-b120-403538bd66cd'), LV)
  assert.deepEqual(boardOf('https://jobs.eu.lever.co/acme'), { ats: 'lever', token: 'acme', host: 'eu' })
  assert.equal(boardOf('https://job-boards.eu.greenhouse.io/acme'), null, 'EU Greenhouse boards have another API host: not read rather than misread as missing')
  assert.deepEqual(boardOf('https://jobs.ashbyhq.com/expressable/34413f8d'), AB)
  for (const u of ['https://www.linkedin.com/jobs/view/1', 'https://tenstorrent.com/careers', 'http://jobs.lever.co/palantir', 'https://greenhouse.io/tenstorrent', 'not a url']) assert.equal(boardOf(u), null, u)
  assert.equal(boardApi(GH), 'https://boards-api.greenhouse.io/v1/boards/tenstorrent/jobs')
  assert.equal(boardApi({ ats: 'lever', token: 'acme', host: 'eu' }), 'https://api.eu.lever.co/v0/postings/acme?mode=json')
})


test("each board's own posting day and location, on real boards", () => {
  const gh = boardRoles(GH, FX.greenhouse.body)!, ab = boardRoles(AB, FX.ashby.body)!, lv = boardRoles(LV, FX.lever.body)!
  assert.ok(gh.length === 11 && ab.length > 0 && lv.length > 0)
  assert.ok([...gh, ...ab, ...lv].every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.posted) && /^https:\/\//.test(r.url)))
  assert.equal(boardRoles(LV, { ok: false, error: 'rate limited' }), null, 'a 200 without the board shape is unreadable, not empty')
  assert.equal(boardRoles(GH, { error: 'x' }), null)
})
