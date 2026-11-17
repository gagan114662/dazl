// #1176 operator check: GET /api/internal/usable-check through the REAL route handler, over a lead the REAL scan stored with a
// structurally proven posting day (the same Flexport fixture as ready-gate-1176-runtime.mts). Readers 3 and 4 of #1176
// (the proof preview and the growth funnel's usable count) must both count it, the route needs the operator secret, and it
// writes nothing and never returns a company, a contact or a URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { NextRequest } from 'next/server'
import { setScanDb } from './tenant-route-db.ts'
import { runFixture, daysAgo } from './acceptance-harness.ts'
import { fetchPageDetailed, resetBoardMemo } from '../../lib/scan/fetch-page.ts'
import type { SafeGet } from '../../lib/sources/types.ts'
import { migrateAllSqlite } from '../../lib/db/sqlite-migrations.ts'
import { GET } from '../../app/api/internal/usable-check/route.ts'

const REQUEST = 'Find logistics and supply chain software companies that posted a new job in the past 90 days.'
const GH = 'https://job-boards.greenhouse.io/flexport/jobs/8383190'
const SIGNAL = 'Flexport is hiring an Account Executive for Enterprise'
const QUOTE = 'The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals'
const ICP = { summary: 'Logistics and supply chain software companies with a new job posting', who: ['Operations leader'], industries: ['Logistics software', 'Supply chain software'], sizes: [], where: [], signals: ['posted a new job'], exclude: [], country: 'US', language: 'en' }
const record = (published: string) => ({
  absolute_url: GH, id: 8383190, internal_job_id: 3618280, requisition_id: 'P-12539', title: 'Account Executive, Enterprise ', company_name: 'Flexport', language: 'en',
  location: { name: 'London, England' }, first_published: `${published}T12:34:11-05:00`, updated_at: `${published}T12:34:11-05:00`,
  departments: [{ id: 12334, name: 'Sales' }], offices: [{ id: 67638, name: 'London', location: 'London, England' }],
  content: '&lt;p&gt;Ready to tackle global challenges that impact business, society, and the environment? Come join us.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;The opportunity:&lt;/strong&gt;&lt;/p&gt;&lt;p&gt;The Enterprise Account Executive (ENT) is responsible for driving complex, high-value enterprise deals and establishing long-term strategic partnerships with large customers. This role owns advanced, multi-stakeholder sales cycles that often span regions, business units, and decision layers. The ENT AE operates with a high degree of autonomy, shaping deal strategy, influencing executive stakeholders, and orchestrating cross-functional teams to deliver differentiated, value-driven solutions.&lt;/p&gt;',
})
function fakeHttps(serve: (url: string) => { status: number; type: string; body: string }) {
  const real = https.request
  resetBoardMemo()
  ;(https as { request: unknown }).request = (url: URL, _o: unknown, cb: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
    req.destroy = () => {}
    req.end = () => { const r = serve(String(url)); const res = Object.assign(new EventEmitter(), { statusCode: r.status, headers: { 'content-type': r.type }, resume() {}, destroy() {} }); cb(res); res.emit('data', Buffer.from(r.body)); res.emit('end') }
    return req
  }
  return () => { (https as { request: unknown }).request = real }
}

async function scan() {
  const published = daysAgo(1)
  const restore = fakeHttps(u => u.startsWith('https://boards-api.greenhouse.io/v1/boards/flexport/jobs/8383190') ? { status: 200, type: 'application/json', body: JSON.stringify(record(published)) } : { status: 404, type: 'text/html', body: '' })
  try {
    const x = await runFixture({
      request: REQUEST, reviewedIcp: ICP, icpReviewed: true, modelIcp: ICP, modelQueries: ['logistics software company job posting'],
      hits: [{ url: GH, title: 'Account Executive, Enterprise - Flexport', snippet: QUOTE, date: null }], tfPages: {}, own: {},
      extraction: [{ company: 'Flexport', signal: SIGNAL, source_url: GH, excerpt: QUOTE, event_date: null }],
      deps: { fetchPage: (u: string) => fetchPageDetailed(u, async () => null), sourceHttp: (async () => null) as SafeGet },
    })
    migrateAllSqlite(x.db)   // the rest of the app's tables (the harness migrates only what a scan needs); idempotent
    return { x, published }
  } finally { restore() }
}

test('#1176 usable-check: operator secret only; the proven-day lead counts for the funnel and the proof preview; read-only; no names', async () => {
  const { x } = await scan()
  const row = x.db.prepare('SELECT scan_job_id, company, date_status, event_date_proof FROM leads').get() as { scan_job_id: string; company: string; date_status: string | null; event_date_proof: string | null }
  assert.equal(row.event_date_proof, 'ats_structured'); assert.notEqual(row.date_status, 'verified')
  setScanDb(x.db)
  const changes = () => (x.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const call = (auth?: string, q = `?job=${row.scan_job_id}`) => GET(new NextRequest(`https://dazl.test/api/internal/usable-check${q}`, { headers: auth ? { authorization: auth } : {} }))
  const saved = process.env.AUTOPILOT_TICK_SECRET
  delete process.env.AUTOPILOT_TICK_SECRET
  try {
    const c0 = changes()
    assert.equal((await call('Bearer undefined')).status, 404, 'no secret configured: the route does not exist')
    process.env.AUTOPILOT_TICK_SECRET = 's3cret'
    for (const bad of [undefined, 'Bearer wrong!', 'Bearer s3cre', 's3cret']) {
      const r = await call(bad)
      assert.equal(r.status, 404, String(bad)); assert.doesNotMatch(await r.text(), /usable|preview/)
    }
    assert.equal((await call('Bearer s3cret', '?job=../x')).status, 400)
    assert.equal((await call('Bearer s3cret', '?job=nosuchjob1')).status, 404)
    const ok = await call('Bearer s3cret')
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('cache-control') ?? '', /no-store/)
    const text = await ok.text()
    const j = JSON.parse(text) as { job: string; funnel_usable: number; proof_preview: { status: string; companies: number } }
    assert.equal(j.funnel_usable, 1, 'reader 4: the growth funnel counts the proven-day lead (it read 0 under the retired date_status gate)')
    assert.deepEqual(j.proof_preview, { status: 'ready', companies: 1 }, 'reader 3: the proof preview builds from it')
    assert.doesNotMatch(text, new RegExp(row.company, 'i'), 'never a company name')
    assert.doesNotMatch(text, /greenhouse|https?:\/\/(?!dazl)/i, 'never a source URL')
    assert.equal(changes(), c0, 'read-only: the store did not change')
  } finally {
    if (saved === undefined) delete process.env.AUTOPILOT_TICK_SECRET; else process.env.AUTOPILOT_TICK_SECRET = saved
  }
  console.log('USABLE CHECK ROUTE ok')
})
