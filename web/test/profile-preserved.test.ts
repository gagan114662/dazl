// A profile the user REVIEWED must reach the scan exactly as reviewed. Scan 3 (London) lost it: the page showed the restored profile but Find leads
// posted only the sentence, so the runner inferred a different one (Managing Director / Head of Sales added, industries widened, the AND signal split
// into alternatives). Stubbed data only. The rendered part (restore, Find leads, reload, repeat, edited sentence) is test/ui/profile-preserve.ui.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture } from './helpers/acceptance-harness.ts'
import { normalizeIcp, icpPrompt } from '../lib/scan/icp.ts'

const REQUEST = 'Find London UK B2B SaaS startups with 10-50 employees that announced seed funding within the past 90 days AND are currently hiring sales staff. Exclude agencies and recruiters. Include founder contacts and dated evidence.'
// The reviewed profile of scan 2/3: founders only, London, seed funding within 90 days AND currently hiring sales, no widening.
const REVIEWED = { summary: 'Seed-funded London B2B SaaS startups (10-50 employees) that are also hiring sales', who: ['Founder', 'Co-founder', 'CEO'], industries: ['B2B SaaS'], sizes: ['10-50 employees'], where: ['London, UK'],
  signals: ['announced seed funding within the past 90 days AND currently hiring sales staff'], exclude: ['agencies', 'recruiters'], country: 'GB', language: 'en', window_days: 90 }
const INFERENCE_PREFIX = icpPrompt('x').slice(0, 60)

test('normalizeIcp keeps a reviewed profile as it is: same roles, place, size, signal (AND stays one signal), exclusions, window', () => {
  const n = normalizeIcp(REVIEWED)!
  for (const k of ['who', 'industries', 'sizes', 'where', 'signals', 'exclude', 'window_days', 'country', 'language'] as const) assert.deepEqual(n[k], REVIEWED[k], k)
  assert.deepEqual(normalizeIcp(n), n, 'idempotent: re-sending what the page holds changes nothing')
  assert.equal(n.signals.length, 1); assert.match(n.signals[0], /seed funding within the past 90 days AND currently hiring sales staff/)
})

test('the real runner uses a reviewed profile as stored: no profile inference, the profile is not altered, icp_inferred stays 0', async () => {
  const r = await runFixture({
    request: REQUEST, reviewedIcp: REVIEWED,
    modelIcp: { ...REVIEWED, who: ['Managing Director', 'Head of Sales'], industries: ['SaaS', 'fintech', 'AI'], signals: ['seed funding', 'hiring sales'] },   // what an inference WOULD have produced (must never be used)
    modelQueries: ['London SaaS startup seed round'], hits: [], tfPages: {}, own: {}, extraction: [],
  })
  assert.equal(r.calls.prompts.filter(p => p.startsWith(INFERENCE_PREFIX)).length, 0, 'the runner did not call profile inference')
  const job = r.db.prepare('SELECT icp, icp_inferred FROM scan_jobs').get() as { icp: string; icp_inferred: number }
  assert.equal(job.icp_inferred, 0, 'still a reviewed (user) profile')
  assert.deepEqual(JSON.parse(job.icp), normalizeIcp(REVIEWED), 'stored profile identical to the reviewed one')
})

test('a reviewed profile without a window gains only the window the request itself states (90 days), nothing else', async () => {
  const { window_days: _w, ...noWindow } = REVIEWED
  const r = await runFixture({ request: REQUEST, reviewedIcp: noWindow, modelIcp: REVIEWED, modelQueries: ['q'], hits: [], tfPages: {}, own: {}, extraction: [] })
  assert.equal(r.calls.prompts.filter(p => p.startsWith(INFERENCE_PREFIX)).length, 0)
  const stored = JSON.parse((r.db.prepare('SELECT icp FROM scan_jobs').get() as { icp: string }).icp)
  assert.deepEqual(stored, { ...normalizeIcp(noWindow), window_days: 90 })
})

