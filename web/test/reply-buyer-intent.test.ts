import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateThreadReplies, setQueries, listThreads, refreshReplies } from '../lib/replies/threads.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateScan } from '../lib/scan/store.ts'
import { migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { randomBytes } from 'node:crypto'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'

process.env.DB_PATH = process.env.DB_PATH || `/tmp/reply-bi-test-${process.pid}.db`
const { getAuthDb, setSellerProfile } = await import('../lib/auth-db.ts')

const ENV_ON = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://w.example', ADVANCED_WORKER_TOKEN: 't' } as Record<string, string>
const NOW = Date.now()
const DAY = new Date(NOW - 86400_000).toISOString().slice(0, 10)

// The designated test tenant's actual seller profile (read live 2026-10-22).
function setup(sells = 'Sales prospecting software for B2B sales teams') {
  const d = new Database(':memory:')
  migrateThreadReplies(d); migrateOutreach(d); migrateScan(d); migrateSequences(d); migrateConnectors(d); migrateAdvanced(d); migrateKeys(d)
  const master = randomBytes(32)
  saveKey(d, 't1', 'anthropic', 'sk-test', master)
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['cold email software'])
  const auth = getAuthDb()
  auth.prepare("INSERT OR REPLACE INTO users (id, email, password_hash, salt) VALUES ('t1', 't1@test.local', 'x', 'y')").run()
  setSellerProfile(auth, 't1', sells, '')
  return { d, master }
}

const fetchSays = (word: string) => (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: word }] }), { status: 200 })) as unknown as typeof fetch

// Verbatim threads from the designated tenant's live reply list (2026-10-22): a real
// buyer thread and the internship thread that passed the keyword gate in production.
const CANDIDATES = [
  { url: 'https://reddit.com/r/sysadmin/1', title: 'too many filters that automatically reject emails ?', quote: "how are you dealing with all the spam filters and other ones that filter out your email and make them dead on arrival? I've noticed a huge uptick in that over the last year and I'm supposed to be scaling the cold email program", date: DAY, login_walled: false },
  { url: 'https://reddit.com/r/jobs/2', title: 'HELPPPP What organizations should I cold email?', quote: "I'm aiming for something drug discovery/pharmaceutical related in the West-Coast area, and I've entirely given up on internships :( so now I'm trying to cold email some PI's. Relevant research experience: A lot in molecules.", date: DAY, login_walled: false },
]

test('buyer-intent grading: buyer thread stored with verdict, internship thread filtered as no', async () => {
  const { d, master } = setup()
  {
    // model verdict by thread content: internship seeker = not a buyer
    const fetchImpl = (async (_url: unknown, init: { body?: string } = {}) => {
      const word = /internship/i.test(init?.body ?? '') ? 'no' : 'yes'
      return new Response(JSON.stringify({ content: [{ type: 'text', text: word }] }), { status: 200 })
    }) as unknown as typeof fetch
    const worker = async () => CANDIDATES
    const r = await refreshReplies(d, 't1', { worker, fetchImpl, master, env: ENV_ON, now: NOW })
    assert.equal(r.added, 1)
    assert.equal(r.filtered, 2) // the internship thread is graded 'no' once per platform pass
    const threads = listThreads(d, 't1')
    assert.equal(threads.length, 1)
    assert.match(threads[0].title, /filters/)
    assert.equal(threads[0].buyer_intent, 'yes')
  }
})

test('provider error: thread stored keyword-matched only (buyer_intent NULL), never hidden', async () => {
  const { d, master } = setup()
  {
    const fetchImpl = (async () => { throw new Error('upstream down') }) as unknown as typeof fetch
    const worker = async () => [CANDIDATES[0]]
    const r = await refreshReplies(d, 't1', { worker, fetchImpl, master, env: ENV_ON, now: NOW })
    assert.equal(r.added, 1)
    assert.equal(listThreads(d, 't1')[0].buyer_intent, null)
  }
})

test('no AI key: no grading calls, keyword behavior unchanged', async () => {
  const d = new Database(':memory:')
  migrateThreadReplies(d); migrateOutreach(d); migrateScan(d); migrateSequences(d); migrateConnectors(d); migrateAdvanced(d); migrateKeys(d)
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['cold email software'])
  const worker = async () => [CANDIDATES[1]] // internship thread passes the keyword gate
  const r = await refreshReplies(d, 't1', { worker, env: ENV_ON, now: NOW })
  assert.equal(r.added, 1) // keyword-only storage, honestly labelled (buyer_intent NULL)
  assert.equal(listThreads(d, 't1')[0].buyer_intent, null)
})

test('existing keyword-only rows are re-graded inside a manual refresh: internship row verdict no is hidden, drafted rows stay visible', async () => {
  const { d, master } = setup()
  // Pre-existing rows stored before grading existed (buyer_intent NULL), like the live tenant.
  const ins = d.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, date, login_walled, buyer_intent) VALUES (?, 't1', 'reddit', ?, ?, ?, 'cold email software', ?, 0, NULL)")
  ins.run('old1', 'https://reddit.com/r/jobs/2', 'HELPPPP What organizations should I cold email?', "I'm trying to cold email some PI's for an internship in drug discovery", DAY)
  ins.run('old2', 'https://reddit.com/r/sysadmin/1', 'too many filters that automatically reject emails ?', 'scaling the cold email program, deliverability got harder', DAY)
  // The tenant drafted on the internship thread - their work is never hidden.
  d.prepare("INSERT INTO reply_drafts (thread_id, tenant_id, draft, status) VALUES ('old1', 't1', 'my reply', 'draft')").run()
  const fetchImpl = (async (_url: unknown, init: { body?: string } = {}) => {
    const word = /internship/i.test(init?.body ?? '') ? 'no' : 'yes'
    return new Response(JSON.stringify({ content: [{ type: 'text', text: word }] }), { status: 200 })
  }) as unknown as typeof fetch
  const worker = async () => [] as { url: string; title: string; quote: string; date: string | null; login_walled: boolean }[]
  await refreshReplies(d, 't1', { worker, fetchImpl, master, env: ENV_ON, now: NOW })
  const rows = d.prepare('SELECT id, buyer_intent FROM reply_threads ORDER BY id').all() as { id: string; buyer_intent: string | null }[]
  assert.deepEqual(rows, [{ id: 'old1', buyer_intent: 'no' }, { id: 'old2', buyer_intent: 'yes' }])
  // old1 keeps its verdict but stays listed because a draft exists; old2 shows normally.
  assert.deepEqual(listThreads(d, 't1').map(t => t.id).sort(), ['old1', 'old2'])
  // Without the draft, a 'no' verdict would drop the row from the list.
  d.prepare("DELETE FROM reply_drafts WHERE thread_id = 'old1'").run()
  assert.deepEqual(listThreads(d, 't1').map(t => t.id), ['old2'])
})

test('refresh reports graded count: new candidates graded once each, no backlog left', async () => {
  const { d, master } = setup()
  const fetchImpl = (async (_url: unknown, init: { body?: string } = {}) => {
    const word = /internship/i.test(init?.body ?? '') ? 'no' : 'yes'
    return new Response(JSON.stringify({ content: [{ type: 'text', text: word }] }), { status: 200 })
  }) as unknown as typeof fetch
  const worker = async () => CANDIDATES
  const r = await refreshReplies(d, 't1', { worker, fetchImpl, master, env: ENV_ON, now: NOW })
  // The mock worker returns the same 2 candidates for both platforms (reddit + x), and each
  // platform pass grades them independently: 2 candidates x 2 platforms = 4 verdicts.
  assert.equal(r.graded, 4)
  assert.equal(r.ungraded_remaining, 0)
})

test('per-refresh cap is honest: 12 backlog rows, cap 10 - graded 10, ungraded_remaining 2, no full-backfill promise', async () => {
  const { d, master } = setup()
  const ins = d.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, date, login_walled, buyer_intent) VALUES (?, 't1', 'reddit', ?, ?, ?, 'cold email software', ?, 0, NULL)")
  for (let i = 0; i < 12; i++) ins.run(`old${i}`, `https://reddit.com/r/sysadmin/${i}`, `deliverability question ${i}`, `scaling cold email, filters got harder ${i}`, DAY)
  const worker = async () => [] as { url: string; title: string; quote: string; date: string | null; login_walled: boolean }[]
  const r = await refreshReplies(d, 't1', { worker, fetchImpl: fetchSays('yes'), master, env: ENV_ON, now: NOW })
  assert.equal(r.graded, 10)
  assert.equal(r.ungraded_remaining, 2)
  const remaining = d.prepare('SELECT COUNT(*) AS n FROM reply_threads WHERE buyer_intent IS NULL').get() as { n: number }
  assert.equal(remaining.n, 2)
  // A second manual refresh grades the rest - the cap is per click, not permanent.
  const r2 = await refreshReplies(d, 't1', { worker, fetchImpl: fetchSays('yes'), master, env: ENV_ON, now: NOW })
  assert.equal(r2.graded, 2)
  assert.equal(r2.ungraded_remaining, 0)
})

test('provider errors count nothing: graded 0, rows stay NULL, ungraded_remaining reports the backlog', async () => {
  const { d, master } = setup()
  const ins = d.prepare("INSERT INTO reply_threads (id, tenant_id, platform, url, title, quote, query, date, login_walled, buyer_intent) VALUES (?, 't1', 'reddit', ?, ?, ?, 'cold email software', ?, 0, NULL)")
  ins.run('old1', 'https://reddit.com/r/sysadmin/1', 'deliverability one', 'scaling cold email', DAY)
  ins.run('old2', 'https://reddit.com/r/sysadmin/2', 'deliverability two', 'spam filters got harder', DAY)
  const fetchImpl = (async () => { throw new Error('upstream down') }) as unknown as typeof fetch
  const worker = async () => [] as { url: string; title: string; quote: string; date: string | null; login_walled: boolean }[]
  const r = await refreshReplies(d, 't1', { worker, fetchImpl, master, env: ENV_ON, now: NOW })
  assert.equal(r.graded, 0)
  assert.equal(r.ungraded_remaining, 2)
  assert.ok((d.prepare('SELECT COUNT(*) AS n FROM reply_threads WHERE buyer_intent IS NULL').get() as { n: number }).n === 2)
})

test('unreadable stored key: refresh completes keyword-only, rows stay NULL, graded 0, backlog counted', async () => {
  const { d, master } = setup()
  d.prepare("UPDATE tenant_llm_keys SET ciphertext = 'not-valid-ciphertext' WHERE tenant_id = 't1'").run()
  const worker = async () => [CANDIDATES[1]] // internship thread passes the keyword gate
  const r = await refreshReplies(d, 't1', { worker, master, env: ENV_ON, now: NOW })
  assert.equal(r.added, 1)
  assert.equal(r.graded, 0)
  assert.equal(r.ungraded_remaining, 1)
  assert.equal(listThreads(d, 't1')[0].buyer_intent, null)
})
