import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { readPage, hitWindows, leadSignals } from '../lib/scan/page-signals.ts'

const POSTING = `About the role. You will own outbound prospecting for our mid-market segment and build the pipeline. We use Salesforce and Outreach.io today. We are evaluating a new sales tool this quarter. Experience with Salesforce required. Our platform helps sales teams book more meetings with cold email. Tips: how to improve cold email replies. Our community outreach program funds local schools.`

test('every shown quote is a verbatim slice of the page, and kinds stay separate', () => {
  const r = readPage(POSTING, 'posting')
  for (const s of r.signals) assert.ok(POSTING.includes(s.quote), s.quote)
  const by = (k: string) => r.signals.filter(s => s.kind === k).map(s => s.term)
  assert.deepEqual(by('team_task'), ['outbound'])
  assert.deepEqual(by('named_stack'), ['salesforce'])
  assert.deepEqual(by('candidate_requirement'), ['salesforce'])
})
test('vendor pitch and advice are counted but never shown as evidence', () => {
  const r = readPage(POSTING, 'posting')
  assert.equal(r.vendor_pitch, 1)
  assert.equal(r.advice, 1)
  assert.ok(!r.signals.some(s => /book more meetings|how to improve/.test(s.quote)))
})
test('a bare word like community outreach is not a topic hit, and no match is an empty result, not a score', () => {
  const r = readPage('Our community outreach program funds local schools. We love dogs and long walks on the beach.', 'posting')
  assert.deepEqual(r.signals, [])
  assert.equal(r.unclear, 0)
  assert.equal('score' in r, false)
})
test('word boundaries: substrings of longer words do not match', () => {
  assert.deepEqual(hitWindows('We run outbounds of cargo ships and gonging bells.', ['outbound', 'gong.io']), [])
  assert.equal(hitWindows('We do outbound.', ['outbound']).length, 1)
})
test('a company home page gives no team-task evidence from its own offer wording', () => {
  const r = readPage('We help teams do outbound prospecting at scale. Outbound prospecting is hard for teams everywhere.', 'company_home')
  assert.equal(r.signals.length, 0)
  assert.ok(r.vendor_pitch + r.unclear >= 2)
})
test('a stated evaluation counts only when the company speaks for itself', () => {
  assert.equal(readPage('We are evaluating new cold email tools for our SDR team.', 'posting').signals[0]?.kind, 'stated_problem')
  assert.equal(readPage('Analysts are evaluating cold email tools across the market.', 'posting').signals.length, 0)
})
test('long glued text without full stops still yields bounded quotes', () => {
  const glued = 'Responsibilities ' + 'word '.repeat(200) + 'Execute daily outbound prospecting against target lists ' + 'word '.repeat(200)
  const r = readPage(glued, 'posting')
  assert.equal(r.signals.length, 1)
  assert.ok(r.signals[0].quote.length <= 400)
  assert.ok(glued.includes(r.signals[0].quote))
})
test('duplicate windows for adjacent hits collapse and output is capped', () => {
  const dense = Array.from({ length: 40 }, (_, i) => `Item ${i}: you will run outbound prospecting for region ${i}. ${'filler '.repeat(60)}`).join('\n')
  assert.ok(readPage(dense, 'posting').signals.length <= 12)
  assert.equal(hitWindows('You will do outbound and outbound prospecting.', ['outbound', 'prospecting']).length, 1)
})

function setup() {
  const db = new Database(':memory:'); migrateScan(db)
  const mk = (user: string, id: string, domain: string | null, company = 'Acme') => {
    const job = createQueryJob(db, user, { query: 'q' })
    db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
    db.prepare("INSERT INTO leads(id,scan_job_id,company,signal,source_url,company_domain) VALUES (?,?,?,?,?,?)").run(id, job, company, 'Posted a role', 'https://weworkremotely.com/remote-jobs/acme-sdr', domain)
  }
  mk('u1', 'a'.repeat(24), 'acme.example'); mk('u1', 'b'.repeat(24), null); mk('u2', 'c'.repeat(24), 'other.example')
  return db
}
const fetcher = async (url: string) => url.includes('acme.example') ? { fail: 'blocked' as const } : { text: 'Acme: you will run outbound prospecting for the team.', title: 't', retrievedAt: 1 }
test('lead reading: own tenant only, posting must name the company, failed pages reported, no model flag', async () => {
  const db = setup()
  assert.equal(await leadSignals(db, 'u2', 'a'.repeat(24), fetcher), null)
  const s = await leadSignals(db, 'u1', 'a'.repeat(24), fetcher)
  assert.equal(s?.model_call, false)
  assert.deepEqual(s?.pages.map(p => [p.role, p.status]), [['posting', 'read'], ['company_home', 'failed']])
  assert.equal(s?.pages[0].reading?.signals[0].kind, 'team_task')
  const other = await leadSignals(db, 'u1', 'b'.repeat(24), async () => ({ text: 'A different company runs outbound prospecting.', title: 't', retrievedAt: 1 }))
  assert.deepEqual(other?.pages.map(p => [p.role, p.status]), [['posting', 'not_used']])
})
