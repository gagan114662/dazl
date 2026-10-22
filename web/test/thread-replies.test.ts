import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateThreadReplies, setQueries, listQueries, looksLikeQuestion, isRelevantToQuery, refreshReplies, listThreads, dismissThread, draftReply, saveDraft, markDraft } from '../lib/replies/threads.ts'
import { effectiveStepStatus, sequenceStepsView, migrateSequences } from '../lib/outreach/sequences.ts'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateAdvanced, acceptConsent } from '../lib/advanced/index.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'

const master = randomBytes(32)
const ENV_ON = { ADVANCED_CONNECTORS: '1', ADVANCED_WORKER_URL: 'https://w.example', ADVANCED_WORKER_TOKEN: 't' } as Record<string, string>
const NOW = Date.UTC(2026, 9, 22)
const FRESH = '2026-10-21'
const OLD = '2026-09-01'
const item = (url: string, title: string, date: string | null) => ({ url, title, quote: 'Some quoted thread text long enough to be useful.', date, login_walled: false })

function db() {
  const d = new Database(':memory:')
  migrateConnectors(d); migrateAdvanced(d); migrateKeys(d); migrateThreadReplies(d)
  return d
}

test('queries: cleaned, deduped, ordered, max 5, min length', () => {
  const d = db()
  const r = setQueries(d, 't1', [' outbound tool ', 'outbound tool', 'cold email software', ''])
  assert.equal(r.ok, true)
  assert.deepEqual(listQueries(d, 't1'), ['outbound tool', 'cold email software'])
  assert.equal(setQueries(d, 't1', ['q1','q2','q3','q4','q5','q6']).ok, false)
  assert.equal(setQueries(d, 't1', ['ab']).ok, false)
})

test('question detection: question mark or question-word title', () => {
  assert.equal(looksLikeQuestion('Anyone use a tool for outbound?'), true)
  assert.equal(looksLikeQuestion('Best cold email software for a small team'), true)
  assert.equal(looksLikeQuestion('How do you find B2B leads'), true)
  assert.equal(looksLikeQuestion('We just launched our new dashboard'), false)
  assert.equal(looksLikeQuestion(''), false)
})

test('refresh: no consent means no worker calls; disabled means disabled', async () => {
  const d = db()
  setQueries(d, 't1', ['outbound tool'])
  let calls = 0
  const worker = async () => { calls++; return [] }
  const r1 = await refreshReplies(d, 't1', { worker, env: ENV_ON, now: NOW })
  assert.equal(calls, 0)
  assert.equal(r1.platforms.reddit, 'no_consent')
  const r2 = await refreshReplies(d, 't1', { worker, env: {}, now: NOW })
  assert.equal(r2.platforms.reddit, 'disabled')
  assert.equal(calls, 0)
})

test('refresh: keeps only fresh, on-topic question threads, dedupes by url, tenant-scoped', async () => {
  const d = db()
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['outbound tool'])
  const worker = async () => [
    item('https://www.reddit.com/r/sales/comments/a1', 'Anyone use a tool for outbound?', FRESH),
    item('https://www.reddit.com/r/sales/comments/a2', 'Anyone use a tool for outbound?', OLD),
    item('https://www.reddit.com/r/sales/comments/a3', 'We just launched our dashboard', FRESH),
    item('https://www.reddit.com/r/sales/comments/a4', 'Anyone use a tool for outbound?', null),
    item('https://x.com/founder/status/55', 'Best cold email software for a small team?', FRESH),
  ]
  const r = await refreshReplies(d, 't1', { worker, env: ENV_ON, now: NOW })
  // The X item asks about cold email software - a fresh question, but off-topic for the
  // "outbound tool" query, so the relevance gate filters it instead of presenting it.
  assert.equal(r.added, 1)
  // The mock returns the same list for both platform passes, so the off-topic
  // candidate is counted once per pass.
  assert.equal(r.filtered, 2)
  assert.equal(r.platforms.reddit, 'ok')
  const threads = listThreads(d, 't1')
  assert.equal(threads.length, 1)
  assert.ok(threads.every(t => t.date === FRESH && t.query === 'outbound tool'))
  const again = await refreshReplies(d, 't1', { worker, env: ENV_ON, now: NOW })
  assert.equal(again.added, 0)
  assert.equal(listThreads(d, 't1').length, 1)
  assert.equal(listThreads(d, 't2').length, 0)
})

test('relevance gate: the live-observed defect cases (2026-10-22)', () => {
  // Real threads returned by worker search for "cold email software" that were shown as fits:
  assert.equal(isRelevantToQuery('cold email software', 'Does GPA actually matter?', 'Hi guys. I am doing a bachelor of economics and I really cared about my GPA'), false)
  assert.equal(isRelevantToQuery('cold email software', 'Long-shot 1987 cold case: Did someone you know in NY fly out to Washington State?', 'deep dive into the police files'), false)
  assert.equal(isRelevantToQuery('cold email software', 'Looking for a few groups of playtesters.', 'I have created a tabletop card game'), false)
  // And the genuinely relevant one that must survive:
  assert.equal(isRelevantToQuery('cold email software', 'too many filters that automatically reject emails ?', 'supposed to be scaling the cold email program'), true)
  assert.equal(isRelevantToQuery('cold email software', 'What cold email software do you use?', 'Comparing tools'), true)
  // Two-word queries need both words; phrase match always wins.
  assert.equal(isRelevantToQuery('outbound tool', 'Anyone use a tool for outbound?', ''), true)
  assert.equal(isRelevantToQuery('outbound tool', 'Best cold email software for a small team?', ''), false)
  assert.equal(isRelevantToQuery('sales', 'How do you find B2B sales leads', ''), true)
  assert.equal(isRelevantToQuery('', 'Anything?', 'x'), false)
})

test('sequence step view: a sent step 1 is never labeled stopped (live mislabel 2026-10-22)', () => {
  const d = new Database(':memory:')
  migrateOutreach(d); migrateSequences(d)
  d.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, sent_at) VALUES ('m1','t1','l1','a@b.c','Hello there','Body of the first step here.','sent', 1)").run()
  d.prepare("INSERT INTO sequences (id, tenant_id, lead_id, message_id, to_email, status, stop_reason) VALUES ('s1','t1','l1','m1','a@b.c','replied','reply')").run()
  d.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status) VALUES ('t1','s1',1,'Hello there','Body of the first step here.','approved')").run()
  d.prepare("INSERT INTO sequence_steps (tenant_id, sequence_id, step, subject, body, status) VALUES ('t1','s1',2,'Re: Hello','Follow-up body long enough.','approved')").run()
  const steps = sequenceStepsView(d, 't1', { id: 's1', message_id: 'm1', status: 'replied' })
  // Production data showed step 1 as 'stopped' even though its email went out: the send
  // path flips outreach_messages, not sequence_steps. Step 1 must read 'sent'.
  assert.equal(steps[0].status, 'sent')
  assert.equal(steps[1].status, 'stopped')
  // A non-terminal sequence keeps the approved label on pending steps.
  d.prepare("UPDATE sequences SET status = 'active' WHERE id = 's1'").run()
  const active = sequenceStepsView(d, 't1', { id: 's1', message_id: 'm1', status: 'active' })
  assert.equal(active[0].status, 'sent')
  assert.equal(active[1].status, 'approved')
})

test('refresh: worker error reported per platform, nothing stored', async () => {
  const d = db()
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['outbound tool'])
  const r = await refreshReplies(d, 't1', { worker: async () => null, env: ENV_ON, now: NOW })
  assert.equal(r.added, 0)
  assert.equal(r.platforms.reddit, 'worker_error')
  const row = d.prepare("SELECT status FROM connector_audit WHERE connector = 'adv:reddit-replies'").get() as { status: string }
  assert.equal(row.status, 'worker_error')
})

test('refresh: hourly budget is shared with other advanced features', async () => {
  const d = db()
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['outbound tool'])
  // 10 prior adv:reddit calls this hour exhaust the shared budget (default 10/hour)
  const ins = d.prepare("INSERT INTO connector_audit (id, tenant_id, connector, lookup, status, results) VALUES (?, 't1', 'adv:reddit', 'q', 'ok', 1)")
  for (let i = 0; i < 10; i++) ins.run(`a${i}`)
  let calls = 0
  const r = await refreshReplies(d, 't1', { worker: async () => { calls++; return [] }, env: ENV_ON, now: NOW })
  assert.equal(r.platforms.reddit, 'rate_limited')
  assert.equal(r.platforms.x, 'ok') // x has its own budget
  assert.equal(calls, 1) // only x was fetched; reddit was gated before any worker call
})

const LONG_DRAFT = 'Start with a tight ICP and a short list. Manual first, then automate the two steps that repeat. Happy to share what worked for us.'

test('draft: not found, no key, then drafted on the tenant key with edit and marks', async () => {
  const d = db()
  acceptConsent(d, 't1', 'advanced')
  setQueries(d, 't1', ['outbound tool'])
  await refreshReplies(d, 't1', { worker: async () => [item('https://www.reddit.com/r/sales/comments/a1', 'Anyone use a tool for outbound?', FRESH)], env: ENV_ON, now: NOW })
  const thread = listThreads(d, 't1')[0]

  assert.deepEqual(await draftReply(d, 't1', 'f'.repeat(24), { sells: '', website: '' }, { master }), { error: 'not_found' })
  assert.deepEqual(await draftReply(d, 't1', thread.id, { sells: '', website: '' }, { master }), { error: 'no_key' })

  saveKey(d, 't1', 'anthropic', 'sk-ant...1234', master)
  let sentKey = ''
  let prompt = ''
  const f = (async (_u: string, init: RequestInit) => {
    sentKey = (init.headers as Record<string, string>)['x-api-key']
    prompt = JSON.parse(String(init.body)).messages[0].content
    return new Response(JSON.stringify({ content: [{ type: 'text', text: LONG_DRAFT }] }), { status: 200 })
  }) as unknown as typeof fetch
  const r = await draftReply(d, 't1', thread.id, { sells: 'lead research for agencies', website: 'https://dazl.ai' }, { fetchImpl: f, master, now: 1_800_000_000 })
  assert.ok(!('error' in r))
  assert.equal(sentKey, 'sk-ant...1234') // the tenant's own key, never the operator's
  assert.match(prompt, /Anyone use a tool for outbound\?/)
  assert.match(prompt, /lead research for agencies/)
  assert.match(prompt, /Reddit reacts badly to marketing/)
  assert.equal(listThreads(d, 't1')[0].draft_status, 'draft')

  assert.equal(saveDraft(d, 't1', thread.id, '  my edited reply ').ok, true)
  assert.equal(listThreads(d, 't1')[0].draft, 'my edited reply')
  assert.equal(listThreads(d, 't1')[0].draft_status, 'edited')
  assert.equal(markDraft(d, 't1', thread.id, 'copied'), true)
  assert.equal(markDraft(d, 't1', thread.id, 'posted'), true)
  assert.equal(listThreads(d, 't1')[0].draft_status, 'posted')

  // regenerate overwrites with a fresh draft
  const r2 = await draftReply(d, 't1', thread.id, { sells: '', website: '' }, { fetchImpl: f, master })
  assert.ok(!('error' in r2))
  assert.equal(listThreads(d, 't1')[0].draft_status, 'draft')

  assert.equal(dismissThread(d, 't1', thread.id), true)
  assert.equal(listThreads(d, 't1').length, 0)
})

test('effective step status: unsent steps of a terminal sequence read as stopped', () => {
  assert.equal(effectiveStepStatus('replied', 'approved'), 'stopped')
  assert.equal(effectiveStepStatus('stopped', 'approved'), 'stopped')
  assert.equal(effectiveStepStatus('done', 'approved'), 'stopped')
  assert.equal(effectiveStepStatus('active', 'approved'), 'approved')
  assert.equal(effectiveStepStatus('approved', 'approved'), 'approved')
  assert.equal(effectiveStepStatus('replied', 'sent'), 'sent')
  assert.equal(effectiveStepStatus('replied', 'uncertain'), 'uncertain')
})