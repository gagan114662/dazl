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

function setup(sells = 'cold email software for sales teams') {
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

const CANDIDATES = [
  { url: 'https://reddit.com/r/sysadmin/1', title: 'too many filters that automatically reject emails ?', quote: 'scaling the cold email program, deliverability got harder', date: DAY, login_walled: false },
  { url: 'https://reddit.com/r/jobs/2', title: 'HELPPPP What organizations should I cold email?', quote: 'I want to cold email PIs for an internship in drug discovery', date: DAY, login_walled: false },
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
