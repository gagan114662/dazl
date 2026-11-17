// The flake behind research-ats-boards.test.ts "no board read past the deadline" (failed at random on test-sqlite/test-postgres, 15 Nov 2026).
// huntWithRegistry races the registry half against a setTimeout(left()) deadline timer, then decided whether to read the boards by asking
// the wall clock again (left() <= 0). A timer can fire while Date.now() still reads a millisecond or two short of the deadline (the timer
// runs on the monotonic clock, Date.now() is rounded wall time), so on a loaded CI runner the boards were read AFTER the deadline fired.
// Deterministic repro: a clock that never advances, so the timer fires while left() still says time remains.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { huntWithRegistry } from '../lib/research/hunt.ts'
import type { Candidate, ResearchCase } from '../lib/research/types.ts'

const AUSTIN: ResearchCase = { tenant: 't', jobId: 'j', query: 'chip startups in Austin', offer: 'x', where: 'Austin, Texas', category: 'semiconductor companies', windowDays: 90, today: '2026-11-15' }
const found: Candidate[] = [
  { url: 'https://job-boards.greenhouse.io/tenstorrent/jobs/1', title: 'a job', snippet: '', date: null, triggerId: 't1', query: 'q1', via: 'tinyfish' },
  { url: 'https://news.example/austin-chips', title: 'news', snippet: '', date: '2026-10-01', triggerId: 't2', query: 'q4', via: 'tinyfish' },
]
const plan = { persona: 'p', decisionMakerTitles: [], triggers: [{ id: 't1', name: 'n', why: '', footprint: '', queries: ['q'] }], askingQueries: [], source: 'fallback' as const }
const search = async () => ({ ok: true as const, hits: found.map(f => ({ url: f.url, title: f.title, snippet: f.snippet, date: f.date })) })

test('once the deadline timer has fired, no board is read, even if the clock still reads just short of the deadline', async () => {
  const stall = { id: 'stall', covers: () => true, collect: () => new Promise<never>(() => {}) }
  const frozen = Date.now()
  let boardAsked = 0
  const late = await huntWithRegistry(AUSTIN, plan, search, async () => { boardAsked++; return { status: 200, body: '[]' } },
    { env: { LEAD_ENGINE: 'research' }, sources: [stall], deadline: frozen + 50, now: () => frozen })
  assert.equal(late.funnel.dropped.registry_registry_deadline, 1, 'the registry half stopped at the deadline timer')
  assert.equal(boardAsked, 0, 'no board read after the deadline fired')
  assert.equal(late.funnel.dropped['registry_ats-boards_deadline'], 1, 'the boards say they were skipped for the deadline')
  assert.equal(late.candidates.filter(x => x.via === 'tinyfish').length, 2, "the search's candidates are kept")
})

test('control: with time really left and no stalled source, the boards are still read', async () => {
  let boardAsked = 0
  const r = await huntWithRegistry(AUSTIN, plan, search, async () => { boardAsked++; return { status: 200, body: '{"jobs":[]}' } },
    { env: { LEAD_ENGINE: 'research' }, sources: [], deadline: Date.now() + 60_000 })
  assert.equal(boardAsked, 1, 'one request for the one board the search found')
  assert.equal(r.funnel.dropped['registry_ats-boards_deadline'], undefined)
})
