// The job-board source through the REAL runJob (stubbed: search, board JSON, pages, model). Wrong-city postings never reach extraction, and a
// board source that is not selected says so. Postings are INVENTED.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const REQUEST = 'Find independent dental practices in New York City that posted a front desk receptionist job in the past 90 days.'
const ICP = { summary: 'NYC dental practices hiring', who: ['Practice manager'], industries: ['dental'], sizes: [], where: ['New York City'], signals: ['posted a front desk receptionist job'], exclude: [], country: 'US', language: 'en' }
const LOCS = ['Albany, New York', 'Buffalo, NY', 'New York State, USA', 'Remote - New York', 'Brooklyn, NY', 'New York, NY 10019']
const QUOTE = (i: number) => `${['Albany', 'Buffalo', 'Statewide', 'Remote', 'Brooklyn', 'Manhattan'][i]} Smiles Dental is hiring a front desk receptionist to greet patients at its ${['Albany', 'Buffalo', 'state', 'remote', 'Brooklyn', 'Manhattan'][i]} office`
const gh = (i: number) => `https://boards.greenhouse.io/multi/jobs/${i + 1}`
function board() {
  const seen: string[] = []
  const http: SafeGet = async url => {
    if (new URL(url).hostname === 'hn.algolia.com') return null
    seen.push(url); const j = (o: unknown) => ({ status: 200, body: JSON.stringify(o) })
    if (url === 'https://boards-api.greenhouse.io/v1/boards/multi/jobs') return j({ jobs: LOCS.map((l, i) => ({ id: i + 1, title: 'Front Desk Receptionist', updated_at: daysAgo(1), location: { name: l }, absolute_url: gh(i) })) })
    const d = url.match(/\/jobs\/(\d+)$/); if (d) { const i = +d[1] - 1; return j({ id: i + 1, title: 'Front Desk Receptionist', first_published: daysAgo(9), content: `&lt;p&gt;${QUOTE(i)}.&lt;/p&gt;`, location: { name: LOCS[i] }, absolute_url: gh(i) }) }
    return null
  }
  return { http, seen }
}
function fx(sourceHttp: SafeGet, request = REQUEST, icp: object = ICP): Fixture {
  // The stubbed model would happily turn EVERY posting into a candidate - location must be settled before extraction, not by it.
  const extraction: Cand[] = LOCS.map((_, i) => ({ company: QUOTE(i).split(' Smiles')[0] + ' Smiles Dental', signal: 'front desk receptionist job', source_url: gh(i), excerpt: QUOTE(i), event_date: daysAgo(9) }))
  return { request, modelIcp: icp, modelQueries: ['dental front desk receptionist job New York'], hits: [{ url: gh(4), title: 'Front Desk Receptionist', snippet: QUOTE(4), date: daysAgo(9) }], tfPages: {},
    own: Object.fromEntries(LOCS.map((_, i) => [gh(i), { title: 'Front Desk Receptionist', text: `Posted ${daysAgo(9)}. ${QUOTE(i)}. ${' The practice welcomes patients every week.'.repeat(8)}` }])), extraction, deps: { sourceHttp } }
}
test('runJob: for an exact New York City request, Albany / Buffalo / New York State / remote postings are never detail-fetched and never reach extraction; the Brooklyn and Manhattan postings do', async () => {
  const { http, seen } = board()
  const x = await runFixture(fx(http))
  assert.deepEqual(seen.filter(u => /\/jobs\/\d+$/.test(u)).map(u => u.split('/').pop()).sort(), ['5', '6'], 'only the NYC postings were detail-fetched')
  const adapterPrompt = x.calls.prompts.find(p => p.includes('"source":"jobboards"'))!
  assert.ok(adapterPrompt, 'the adapter items were given to extraction')
  for (const i of [4, 5]) assert.ok(adapterPrompt.includes(gh(i)), `NYC posting ${i + 1} reached extraction`)
  for (const i of [0, 1, 2, 3]) assert.ok(!adapterPrompt.includes(gh(i)), `wrong-city posting ${i + 1} never reached extraction`)
  const run = x.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string }
  assert.ok(['ok', 'partial'].includes(run.status), `attempted: ${run.status}`)
})
test('runJob: even when a (stubbed) model returns the wrong-city postings as candidates, none of them is a qualified lead', async () => {
  const { http } = board()
  const x = await runFixture(fx(http))
  const qualified = x.leads.filter(l => !l.review_reason).map(l => l.source_url)
  for (const i of [0, 1, 2, 3]) assert.ok(!qualified.includes(gh(i)), `wrong-city posting ${i + 1} is not qualified`)
})
test('source status is never silent: no hiring signal, no place, or explicit sources each say why the job boards were skipped', async () => {
  const none = fx(board().http, 'Find independent dental practices in New York City that opened a new location in the past 90 days.', { ...ICP, signals: ['opened a new location'] })
  const a = await runFixture(none)
  assert.equal((a.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string }).status, 'skipped_no_hiring_signal')
  const noPlace = fx(board().http, 'Find independent dental practices that posted a front desk receptionist job in the past 90 days.', { ...ICP, where: [] })
  const b = await runFixture(noPlace)
  assert.equal((b.db.prepare("SELECT status FROM scan_source_runs WHERE collector = 'adapter:jobboards'").get() as { status: string }).status, 'skipped_no_place')
  assert.equal(board().seen.length, 0)
})
