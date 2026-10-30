// The demand rubric on stored reply threads (#401, part 2): listThreads attaches the assessment for the seller's own offer
// to every thread on read (who is asking, which demand, evidence/fit/intent scored separately, never permission to
// contact), and threads stored before the screen existed that it would have filtered are not presented as fits, unless
// the tenant already engaged with them. Synthetic threads only; no worker, model or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateThreadReplies, listThreads } from '../lib/replies/threads.ts'

const LEADS = 'Evidence-backed lead research for B2B founders'
const DAY = '2026-10-28'
let n = 0
const id = () => (++n).toString(16).padStart(24, '0')
function store() {
  const d = new Database(':memory:'); migrateThreadReplies(d)
  const add = (tenant: string, query: string, title: string, quote: string, date: string | null = DAY) => {
    const i = id()
    d.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, date) VALUES (?, ?, 'reddit', ?, ?, ?, ?, ?)").run(i, tenant, `https://reddit.com/r/x/${i}`, title, quote, query, date)
    return i
  }
  const founder = add('t1', 'b2b leads', 'Where can I find B2B leads for my SaaS?', 'I am the founder of a 10-person analytics startup and we need a reliable lead source for outbound; any recommendations for a data provider?')
  // only a contextual trigger (funding, growth) and no demand for this offer: stored before the rubric screened it
  const growth = add('t1', 'scaling fast', 'We just raised funding and are scaling fast', 'Any tips on onboarding new hires quickly?')
  const recruiter = add('t1', 'sales role', 'Looking for candidates for a sales role?', 'DM me your CV, remote AE position, we are hiring now.')
  const other = add('t2', 'b2b leads', 'Where can I find B2B leads for my agency?', 'We run a small agency and need leads for our clients, any data provider you like?')
  return { d, founder, growth, recruiter, other, add }
}

test('every thread carries its demand assessment for the seller\'s offer: scores apart, never permission to contact', () => {
  const s = store()
  const rows = listThreads(s.d, 't1', 50, { sells: LEADS })
  assert.deepEqual(rows.map(r => r.id), [s.founder], 'the growth-only and recruiter threads are not presented')
  const d = rows[0].demand
  assert.equal(d.rubric, 'lead-generation@1'); assert.equal(d.verdict, 'high_intent'); assert.ok(d.categories.includes('vendor_request'))
  // evidence: source link and date, but no named author on a stored thread; fit: a founder asking for their business
  assert.deepEqual(d.scores, { evidence: 2, fit: 3, intent: 3 }); assert.ok(d.reasons.includes('author not named'))
  assert.equal(d.requester.authority, 'decision_maker'); assert.equal(d.contact_permitted, false)
})

test('a thread the tenant already drafted on stays visible, with the screen\'s reason shown, not hidden', () => {
  const s = store()
  s.d.prepare("INSERT INTO reply_drafts (thread_id, tenant_id, draft) VALUES (?, 't1', 'A draft the tenant wrote.')").run(s.growth)
  const g = listThreads(s.d, 't1', 50, { sells: LEADS }).find(r => r.id === s.growth)!
  assert.ok(g, 'kept: the tenant engaged with it')
  assert.equal(g.demand.screen_out, true); assert.equal(g.demand.verdict, 'not_demand')
  assert.ok(g.demand.reasons.some(r => /only a contextual trigger/.test(r)), g.demand.reasons.join('; '))
})

test('the rubric follows the offer on read: no rubric for this offer means only the requester screen applies', () => {
  const s = store()
  const rows = listThreads(s.d, 't1', 50, { sells: 'Handmade ceramic tableware for restaurants' })
  assert.deepEqual(rows.map(r => r.id).sort(), [s.founder, s.growth].sort(), 'the recruiter is still screened; the growth question is not judged without a rubric')
  for (const r of rows) { assert.equal(r.demand.rubric, null); assert.ok(r.demand.reasons.includes('no demand rubric for this offer')); assert.equal(r.demand.contact_permitted, false) }
  // switching the offer back re-applies the rubric to the same stored rows
  assert.deepEqual(listThreads(s.d, 't1', 50, { sells: LEADS }).map(r => r.id), [s.founder])
})

test('tenant isolation: one tenant\'s threads and assessments never include another\'s', () => {
  const s = store()
  const t1 = listThreads(s.d, 't1', 50, { sells: LEADS }), t2 = listThreads(s.d, 't2', 50, { sells: LEADS })
  assert.ok(!t1.some(r => r.id === s.other)); assert.deepEqual(t2.map(r => r.id), [s.other])
  assert.ok(!JSON.stringify(t2).includes('analytics startup'))
})

test('without an explicit offer, the tenant\'s stored seller profile is used; an unreadable profile means no rubric', async () => {
  process.env.DB_PATH = process.env.DB_PATH || `/tmp/demand-threads-test-${process.pid}.db`
  const { getAuthDb, setSellerProfile } = await import('../lib/auth-db.ts')
  const auth = getAuthDb()
  auth.prepare("INSERT OR REPLACE INTO users (id, email, password_hash, salt) VALUES ('t1', 't1@test.local', 'x', 'y')").run()
  setSellerProfile(auth, 't1', LEADS, '')
  const s = store()
  assert.deepEqual(listThreads(s.d, 't1').map(r => [r.id, r.demand.rubric]), [[s.founder, 'lead-generation@1']])
  // a tenant with no profile: no rubric, the requester screen alone
  assert.equal(listThreads(s.d, 't2')[0].demand.rubric, null)
})
