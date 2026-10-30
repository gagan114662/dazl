import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { requesterRole } from '../lib/replies/requester.ts'
import { migrateThreadReplies, setQueries, listThreads, refreshReplies } from '../lib/replies/threads.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'

process.env.DB_PATH = process.env.DB_PATH || `/tmp/requester-screen-test-${process.pid}.db`

// Synthetic threads covering the #401 rubric: who is asking, not which keywords appear.
const T = (title: string, quote: string) => ({ title, quote })
const ELIGIBLE = [
  T('Where do you find B2B leads for a small SaaS?', 'Founder here, we sell scheduling software to clinics and need more customers. Any lead sources you trust?'),
  T('How do agencies get clients without referrals?', 'We run a small marketing agency. Referrals dried up, how do we find new clients with outbound?'),
  T('Our contact data bounces like crazy, alternatives to our provider?', 'Bounce rate is 18% on our cold email. Which data provider do you use?'),
  T("We're hiring an SDR but also need leads now - what tool?", 'Hiring is slow, meanwhile we need pipeline. Anyone recommend a prospecting tool?'),
  T('We built an MVP, how do we land our first customers?', 'We built a CRM add-on for plumbers. How do we get customers beyond friends?'),
]
const SCREENED: [ReturnType<typeof T>, string][] = [
  [T('HELPPPP What organizations should I cold email?', "I've given up on internships so now I'm cold emailing labs for a role. Here's my resume."), 'job_seeker'],
  [T('New grad - how do I get leads on job openings?', 'Graduating in May and looking for a job in sales.'), 'job_seeker'],
  [T('Looking for candidates for a sales role?', 'DM me your CV, remote AE position, we are hiring now.'), 'recruiter'],
  [T('We just launched our AI SDR - check out our tool!', 'It writes cold emails for you. DM me for a demo.'), 'vendor_promo'],
  [T('Any good plumber near me?', 'Need someone for my house this week, a leak under the sink.'), 'consumer'],
  [T('Acme raised a $20M Series B for outbound automation', 'The company announced the round today, led by a large fund.'), 'announcement'],
]

test('requesterRole: business demand stays eligible, including agencies and hiring founders', () => {
  for (const t of ELIGIBLE) assert.equal(requesterRole(t.title, t.quote), null, t.title)
})

test('requesterRole: each disqualified requester is named', () => {
  for (const [t, role] of SCREENED) assert.equal(requesterRole(t.title, t.quote), role, t.title)
})

test('requesterRole: same text, same answer (deterministic, no tenant input)', () => {
  const [t] = SCREENED[0]
  assert.equal(requesterRole(t.title, t.quote), requesterRole(t.title, t.quote))
  assert.equal(requesterRole('', ''), null)
})

test('refresh: screened requesters are counted as filtered and never sent for grading', async () => {
  const d = new Database(':memory:')
  migrateThreadReplies(d); migrateOutreach(d); migrateScan(d); migrateSequences(d); migrateConnectors(d); migrateAdvanced(d); migrateKeys(d)
  const master = randomBytes(32)
  saveKey(d, 't1', 'anthropic', 'sk-test', master)
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['cold email'])
  const graded: string[] = []
  const fetchImpl = (async (_u: unknown, init: { body?: string } = {}) => {
    graded.push(init.body ?? '')
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'yes' }] }), { status: 200 })
  }) as unknown as typeof fetch
  const day = new Date(Date.now() - 86400_000).toISOString().slice(0, 10)
  const worker = async ({ platform }: { platform: string }) => [
    { url: `https://reddit.com/${platform}/buyer`, title: 'Which cold email tool do you use for outbound?', quote: 'Founder, need more customers, our cold email bounces.', date: day, login_walled: false },
    { url: `https://reddit.com/${platform}/seeker`, title: 'Should I cold email for internships?', quote: 'Student here, attaching my resume to cold email.', date: day, login_walled: false },
    { url: `https://reddit.com/${platform}/promo`, title: 'We just launched a cold email tool - check out our app?', quote: 'DM me for a demo.', date: day, login_walled: false },
  ]
  const r = await refreshReplies(d, 't1', { worker, fetchImpl, master, env: { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://w.example', ADVANCED_WORKER_TOKEN: 't' }, now: Date.now() })
  const threads = listThreads(d, 't1')
  assert.ok(threads.length >= 1)
  assert.ok(threads.every(t => /buyer$/.test(t.url)))
  assert.ok(graded.length >= 1)
  assert.ok(graded.every(b => !/internships|check out our app/i.test(b)), 'a screened thread reached the grader')
  assert.equal(r.filtered, 2 * Object.values(r.platforms).filter(s => s === 'ok').length)
})
