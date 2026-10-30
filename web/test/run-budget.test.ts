// Per-run explicit budget controls on CSV company-import jobs: a run can narrow
// itself (no paid fallback, no credit enrichment, no judge) for an explicitly
// bounded run. Absent or malformed controls mean current behavior - the control
// only ever narrows, never widens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, getJob, reapStaleJobs } from '../lib/scan/store.ts'
import { ProviderError } from '../lib/llm/provider.ts'
import { migratePlans } from '../lib/plans.ts'
import { migrateConnectors, saveCredential } from '../lib/connectors/store.ts'
import { migrateEvents } from '../lib/events/store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { claimKeyedJob, runJob, parseRunBudget, type Judge } from '../lib/scan/runner.ts'
import { createBatch, queuePendingRows, migrateCsv, normalizeRunBudget } from '../lib/scan/csv-import.ts'
import { ENRICH_APOLLO } from '../lib/enrich/index.ts'

const master = randomBytes(32)
// enrichLeadContacts resolves its decryption key from the env when the signals
// caller does not pass one (production sets DAZL_MASTER_KEY); scope it to this file's process.
process.env.DAZL_MASTER_KEY = master.toString('base64')
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function setup() {
  const db = new Database(':memory:')
  migrateScan(db); migrateKeys(db); migratePlans(db); migrateCsv(db); migrateConnectors(db); migrateEvents(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  return db
}

const QUOTE = 'Acme announced it is hiring three account executives for the Toronto market'
const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
const lead = { name: 'Pat', company: 'Acme', contact: null, signal: 'Hiring AEs', source_url: 'https://news.com/acme', score: 80, excerpt: QUOTE, event_date: recent }
const page = async () => ({ text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.`, title: 'Acme news', retrievedAt: 1_700_000_000 })

function researchProvider(calls: { n: number }): Record<'anthropic' | 'openai', Provider> {
  return {
    anthropic: { research: async () => { calls.n++; return { text: 'Here: ' + JSON.stringify([lead]), citedUrls: ['https://news.com/acme'] } } },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
}

test('parseRunBudget: absent or malformed means current behavior; only explicit false narrows', () => {
  assert.equal(parseRunBudget(null), null)
  assert.equal(parseRunBudget(undefined), null)
  assert.equal(parseRunBudget(''), null)
  assert.equal(parseRunBudget('not json'), null)
  assert.equal(parseRunBudget('{}'), null)
  assert.equal(parseRunBudget('{"paid_fallback":true}'), null) // true never widens
  assert.equal(parseRunBudget('["paid_fallback"]'), null)
  assert.deepEqual(parseRunBudget('{"paid_fallback":false}'), { paid_fallback: false })
  assert.deepEqual(parseRunBudget('{"judge":false,"credit_enrichment":false,"judge_extra":"x"}'), { judge: false, credit_enrichment: false })
})

test('normalizeRunBudget: absent means current behavior; an explicitly supplied invalid budget is REJECTED, never widened', () => {
  assert.deepEqual(normalizeRunBudget(undefined, false), { ok: true, value: null }) // field absent: legacy default
  assert.deepEqual(normalizeRunBudget(null, false), { ok: true, value: null }) // not supplied, raw value irrelevant
  assert.equal(normalizeRunBudget(null, true).ok, false) // explicit null never quietly widens
  assert.equal(normalizeRunBudget(undefined, true).ok, false) // supplied-but-empty is a contract violation
  assert.equal(normalizeRunBudget('paid_fallback', true).ok, false)
  assert.equal(normalizeRunBudget([], true).ok, false)
  assert.equal(normalizeRunBudget({}, true).ok, false) // explicit but empty: would silently widen
  assert.equal(normalizeRunBudget({ paid_fallback: true }, true).ok, false) // only false narrows
  assert.equal(normalizeRunBudget({ paid_fallback: 0 }, true).ok, false)
  assert.equal(normalizeRunBudget({ unknown_control: false }, true).ok, false)
  assert.deepEqual(normalizeRunBudget({ paid_fallback: false }, true), { ok: true, value: '{"paid_fallback":false}' })
  const all = normalizeRunBudget({ paid_fallback: false, credit_enrichment: false, judge: false }, true)
  assert.equal(all.ok, true)
  assert.deepEqual(JSON.parse((all as { value: string }).value), { paid_fallback: false, credit_enrichment: false, judge: false })
})

test('queuePendingRows stores the per-run budget on the job row and claim returns it', () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com', 'beta.io'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false }))
  const rows = db.prepare('SELECT csv_domain, run_budget FROM scan_jobs ORDER BY csv_domain').all() as { csv_domain: string; run_budget: string | null }[]
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.run_budget === '{"paid_fallback":false}'))
  const job = claimKeyedJob(db)!
  assert.deepEqual(parseRunBudget(job.run_budget), { paid_fallback: false })
  // default: no budget stored
  const b2 = createBatch(db, 'A', ['gamma.io'])
  queuePendingRows(db, 'A', b2)
  const r2 = db.prepare("SELECT run_budget FROM scan_jobs WHERE csv_domain = 'gamma.io'").get() as { run_budget: string | null }
  assert.equal(r2.run_budget, null)
})

test('paid_fallback=false stops the run before the paid research call; no budget keeps current behavior', async () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page }), 'failed')
  assert.equal(calls.n, 0) // the paid fallback was never attempted
  assert.equal(getJob(db, 'A', job.id)?.error, 'budget_stopped')

  const db2 = setup()
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page }), 'done')
  assert.equal(calls2.n, 1) // control: the fallback runs as today
})

test('judge=false forces the judge off even when the caller provides one', async () => {
  let judged = 0
  const judge: Judge = async () => { judged++; return 'supports' }
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ judge: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page, judge }), 'done')
  assert.equal(judged, 0)

  let judgedControl = 0
  const judgeControl: Judge = async () => { judgedControl++; return 'supports' }
  const db2 = setup()
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page, judge: judgeControl }), 'done')
  assert.ok(judgedControl > 0) // control: the judge runs as today
})

function recordingFetch(urls: string[]) {
  return (async (url: string | URL) => {
    urls.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

test('credit_enrichment=false skips the BYOK Apollo pass; default still runs it', async () => {
  const urls: string[] = []
  const db = setup()
  saveCredential(db, 'A', ENRICH_APOLLO, 'test-apollo-key', master)
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ credit_enrichment: false }))
  const job = claimKeyedJob(db)!
  const calls = { n: 0 }
  assert.equal(await runJob(db, job, { providers: researchProvider(calls), master, fetchPage: page, fetchImpl: recordingFetch(urls) }), 'done')
  assert.equal(urls.filter(u => u.includes('api.apollo.io')).length, 0)

  const urls2: string[] = []
  const db2 = setup()
  saveCredential(db2, 'A', ENRICH_APOLLO, 'test-apollo-key', master)
  const b2 = createBatch(db2, 'A', ['acme.com'])
  queuePendingRows(db2, 'A', b2)
  const job2 = claimKeyedJob(db2)!
  const calls2 = { n: 0 }
  assert.equal(await runJob(db2, job2, { providers: researchProvider(calls2), master, fetchPage: page, fetchImpl: recordingFetch(urls2) }), 'done')
  assert.ok(urls2.some(u => u.includes('api.apollo.io'))) // control: the credit pass runs as today
})

// --- TinyFish-primary paid extraction path (enabled flags, stubbed transport) ---

function tinyfishStubFetch(urls: string[]) {
  return (async (url: string | URL) => {
    const u = String(url)
    urls.push(u)
    if (u.startsWith('https://api.search.tinyfish.ai')) {
      return new Response(JSON.stringify({ results: [{ url: 'https://news.com/acme', title: 'Acme news', snippet: QUOTE, date: recent }] }), { status: 200 })
    }
    if (u.startsWith('https://api.fetch.tinyfish.ai')) {
      return new Response(JSON.stringify({ results: [{ url: 'https://news.com/acme', title: 'Acme news', text: `News ${recent.slice(0, 4)}. ${QUOTE}. More text.` }] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
}

function withTinyfishEnv(fn: () => Promise<void>) {
  return async () => {
    process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
    try { await fn() } finally { delete process.env.TINYFISH_API_KEY }
  }
}

test('TinyFish-primary path makes exactly ONE paid extraction call (complete, maxTokens 3000); fallback and judge stay off under budget', withTinyfishEnv(async () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false, credit_enrichment: false, judge: false }))
  const job = claimKeyedJob(db)!
  const tfUrls: string[] = []
  let researchCalls = 0
  let completeCalls: { prompt: string; maxTokens?: number }[] = []
  let judged = 0
  const judge: Judge = async () => { judged++; return 'supports' }
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { researchCalls++; return { text: '', citedUrls: [] } },
      complete: async (_key: string, prompt: string, _f?: typeof fetch, maxTokens?: number) => { completeCalls.push({ prompt, maxTokens }); return 'Here: ' + JSON.stringify([lead]) },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  assert.equal(await runJob(db, job, { providers, master, fetchPage: page, fetchImpl: tinyfishStubFetch(tfUrls), judge }), 'done')
  assert.equal(completeCalls.length, 1, 'exactly one paid LLM call: the TinyFish evidence extraction')
  assert.equal(completeCalls[0].maxTokens, 3000, 'extraction output is hard-capped')
  assert.ok(completeCalls[0].prompt.length <= 40_000, 'extraction input is evidence-capped by code')
  assert.equal(researchCalls, 0, 'paid_fallback=false: the paid research fallback never ran')
  assert.equal(judged, 0, 'judge=false: no judge calls even though a judge was provided')
  assert.ok(tfUrls.some(u => u.startsWith('https://api.search.tinyfish.ai')), 'TinyFish search used')
  assert.ok(tfUrls.some(u => u.startsWith('https://api.fetch.tinyfish.ai')), 'TinyFish fetch used')
  const leads = db.prepare('SELECT company FROM leads').all() as { company: string }[]
  assert.equal(leads.length, 1)
}))

test('RESTRICTED flags: a failed extraction stops the run as budget_stopped - zero research calls, one paid attempt, no retry', withTinyfishEnv(async () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, JSON.stringify({ paid_fallback: false, credit_enrichment: false, judge: false }))
  const job = claimKeyedJob(db)!
  const tfUrls: string[] = []
  let completeCalls = 0
  let researchCalls = 0
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { researchCalls++; return { text: '', citedUrls: [] } },
      complete: async () => { completeCalls++; throw new ProviderError('retry', 'boom') },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  assert.equal(await runJob(db, job, { providers, master, fetchPage: page, fetchImpl: tinyfishStubFetch(tfUrls) }), 'failed')
  assert.equal(getJob(db, 'A', job.id)?.error, 'budget_stopped')
  assert.equal(completeCalls, 1, 'the failed extraction was the only paid call')
  assert.equal(researchCalls, 0, 'paid_fallback=false: the failed extraction never widened into the paid research fallback')
  assert.equal(claimKeyedJob(db), null, 'budget stop is terminal - no re-pend, no second attempt')
}))

test('DEFAULT budget state: a retry re-runs the whole attempt including both paid surfaces, the budget persists across re-claims, and MAX_ATTEMPTS caps it at 3', withTinyfishEnv(async () => {
  // NOTE: this job intentionally leaves paid_fallback unrestricted - the legacy
  // default. It documents that retries multiply paid calls when no budget narrows
  // the run. The RESTRICTED profile used for a bounded run is tested next.
  const db = setup()
  const budget = JSON.stringify({ judge: false, credit_enrichment: false })
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b, budget)
  const tfUrls: string[] = []
  let completeCalls = 0
  let researchCalls = 0
  const providers: Record<'anthropic' | 'openai', Provider> = {
    anthropic: {
      research: async () => { researchCalls++; return { text: '', citedUrls: [] } },
      complete: async () => { completeCalls++; throw new ProviderError('retry', 'boom') },
    },
    openai: { research: async () => ({ text: '', citedUrls: [] }) },
  }
  // Attempt 1 and 2 fail transiently and re-queue; attempt 3 fails terminally.
  const j1 = claimKeyedJob(db)!
  assert.equal(j1.attempts, 1)
  assert.equal(j1.run_budget, budget, 'budget persisted on the claimed row')
  assert.equal(await runJob(db, j1, { providers, master, fetchPage: page, fetchImpl: tinyfishStubFetch(tfUrls) }), 'retry')
  const j2 = claimKeyedJob(db)!
  assert.equal(j2.attempts, 2)
  assert.equal(j2.run_budget, budget, 'budget survives the re-queue')
  assert.equal(await runJob(db, j2, { providers, master, fetchPage: page, fetchImpl: tinyfishStubFetch(tfUrls) }), 'retry')
  const j3 = claimKeyedJob(db)!
  assert.equal(j3.attempts, 3)
  assert.equal(await runJob(db, j3, { providers, master, fetchPage: page, fetchImpl: tinyfishStubFetch(tfUrls) }), 'failed')
  // The thrown extraction call is swallowed into the paid fallback by design
  // (TinyFish 'unavailable'), so each attempt runs BOTH paid surfaces before the
  // empty fallback output re-pends the job as 'bad_output'.
  assert.equal(getJob(db, 'A', j1.id)?.error, 'bad_output')
  assert.equal(completeCalls, 3, 'the paid extraction call ran once per attempt - capped by MAX_ATTEMPTS')
  assert.equal(researchCalls, 3, 'the paid research fallback also ran once per attempt - retries multiply paid calls')
  assert.equal(claimKeyedJob(db), null, 'no fourth attempt exists')
}))

test('stale-claim recovery re-pends a crashed run below MAX_ATTEMPTS and fails it terminally at MAX_ATTEMPTS', () => {
  const db = setup()
  const b = createBatch(db, 'A', ['acme.com'])
  queuePendingRows(db, 'A', b)
  const claimed = claimKeyedJob(db)!
  assert.equal(claimed.attempts, 1)
  const old = Math.floor(Date.now() / 1000) - 21 * 60 // beyond STALE_RUNNING_S default (20m)
  db.prepare("UPDATE scan_jobs SET claimed_at = ? WHERE id = ?").run(old, claimed.id)
  reapStaleJobs(db)
  assert.equal(getJob(db, 'A', claimed.id)?.status, 'pending', 'crashed attempt re-pends for one more claim')
  const reclaimed = claimKeyedJob(db)!
  assert.equal(reclaimed.attempts, 2, 'the re-run counts as another attempt (another paid call)')
  // A job that already burned all attempts and then crashed reaps to failed.
  db.prepare("UPDATE scan_jobs SET attempts = 3, status = 'running', claimed_at = ? WHERE id = ?").run(old, claimed.id)
  reapStaleJobs(db)
  const j = getJob(db, 'A', claimed.id)!
  assert.equal(j.status, 'failed')
  assert.equal(j.error, 'timeout')
  assert.equal(claimKeyedJob(db), null, 'no resurrection past MAX_ATTEMPTS')
})

const OHM_ROLES_TEXT = 'Careers at Ohm. Help us reimagine how physical products are engineered. At Ohm we work on problems at the intersection of engineering, science, and artificial intelligence. Hiring update 2026. Founding Account Executive San Francisco, CA · Hybrid Apply Founding Account Executive, EMEA United Kingdom · Remote Apply Chief of Staff San Francisco, CA / Remote (London, UK) Apply Forward Deployed Engineer, Battery Engineering San Francisco, CA · Hybrid Apply'
const OHM_TINYFISH_STUB = (async (url: string | URL) => {
  const u = String(url)
  if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://www.ohm.ai/careers', title: 'Careers | Ohm', snippet: 'Ohm is hiring', date: recent }] }), { status: 200 })
  if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: 'https://www.ohm.ai/careers', title: 'Careers | Ohm', text: OHM_ROLES_TEXT }] }), { status: 200 })
  return new Response('{}', { status: 200 })
}) as typeof fetch
const OHM_LIVE_PAGE = async () => ({ text: OHM_ROLES_TEXT, title: 'Careers | Ohm', retrievedAt: 1_700_000_000 })
const ohmProviders = (calls: { complete: number; research: number }, signal: string): Record<'anthropic' | 'openai', Provider> => ({
  anthropic: {
    research: async () => { calls.research++; return { text: '', citedUrls: [] } },
    complete: async () => { calls.complete++; return 'Here: ' + JSON.stringify([{ name: '', company: 'Ohm', contact: null, signal, source_url: 'https://www.ohm.ai/careers', score: 95, excerpt: 'Ohm is actively hiring for multiple senior go-to-market roles', event_date: recent }]) },
  },
  openai: { research: async () => ({ text: '', citedUrls: [] }) },
})
const RESTRICTED = JSON.stringify({ paid_fallback: false, credit_enrichment: false, judge: false })

test('supported-signal extraction: gloss-free paraphrase attaches a supporting verbatim window, verified, inside the restricted paid envelope (ONE complete call)', withTinyfishEnv(async () => {
  const { resetTinyfishState } = await import('../lib/search/tinyfish.ts')
  resetTinyfishState() // process-wide rate stamps are shared across tests in this file
  const db = setup()
  const b = createBatch(db, 'A', ['ohm.ai'])
  queuePendingRows(db, 'A', b, RESTRICTED)
  const job = claimKeyedJob(db)!
  const calls = { complete: 0, research: 0 }
  const signal = 'Ohm is actively hiring for multiple senior go-to-market roles including two Founding Account Executive positions and a Chief of Staff.'
  assert.equal(await runJob(db, job, { providers: ohmProviders(calls, signal), master, fetchPage: OHM_LIVE_PAGE, fetchImpl: OHM_TINYFISH_STUB }), 'done')
  assert.equal(calls.complete, 1, 'the extraction call was the only paid LLM call - no grounding pass added')
  assert.equal(calls.research, 0, 'paid_fallback=false: no research fallback')
  const rows = db.prepare('SELECT evidence_excerpt, review_reason FROM leads').all() as { evidence_excerpt: string | null; review_reason: string | null }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].review_reason, null, 'the real on-page signal passes instead of landing in review')
  assert.ok(rows[0].evidence_excerpt && OHM_ROLES_TEXT.includes(rows[0].evidence_excerpt!), 'attached evidence is verbatim page text')
  assert.ok(rows[0].evidence_excerpt!.includes('Founding Account Executive') && rows[0].evidence_excerpt!.includes('Chief of Staff'))
}))

test('supported-signal extraction: analyst gloss in the claim routes to review with the original excerpt preserved, still ONE complete call', withTinyfishEnv(async () => {
  const { resetTinyfishState } = await import('../lib/search/tinyfish.ts')
  resetTinyfishState()
  const db = setup()
  const b = createBatch(db, 'A', ['ohm.ai'])
  queuePendingRows(db, 'A', b, RESTRICTED)
  const job = claimKeyedJob(db)!
  const calls = { complete: 0, research: 0 }
  const signal = 'Ohm is actively hiring for multiple senior go-to-market roles including two Founding Account Executive positions and a Chief of Staff, indicating significant expansion and investment in sales capacity.'
  assert.equal(await runJob(db, job, { providers: ohmProviders(calls, signal), master, fetchPage: OHM_LIVE_PAGE, fetchImpl: OHM_TINYFISH_STUB }), 'done')
  assert.equal(calls.complete, 1, 'no extra paid calls on the review path either')
  const rows = db.prepare('SELECT signal, evidence_excerpt, review_reason FROM leads').all() as { signal: string; evidence_excerpt: string | null; review_reason: string | null }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].review_reason, 'quote_unconfirmed', 'gloss is never trimmed silently - the unresolved claim stays in review')
  assert.equal(rows[0].signal, signal, 'the original claim text is preserved untouched')
  assert.equal(rows[0].evidence_excerpt, 'Ohm is actively hiring for multiple senior go-to-market roles', "the model's original failed excerpt is preserved on the review row")
}))

// Production-caller negatives (round 2): the same runJob path as the Ohm positive, with a page/domain that must NOT attach.
const stubFor = (host: string, text: string) => (async (url: string | URL) => {
  const u = String(url)
  if (u.startsWith('https://api.search.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: `https://www.${host}/careers`, title: 'Careers | Ohm', snippet: 'Ohm is hiring', date: recent }] }), { status: 200 })
  if (u.startsWith('https://api.fetch.tinyfish.ai')) return new Response(JSON.stringify({ results: [{ url: `https://www.${host}/careers`, title: 'Careers | Ohm', text }] }), { status: 200 })
  return new Response('{}', { status: 200 })
}) as typeof fetch
const providersFor = (calls: { complete: number; research: number }, signal: string, host: string, excerpt = 'Ohm is actively hiring for multiple senior go-to-market roles'): Record<'anthropic' | 'openai', Provider> => ({
  anthropic: {
    research: async () => { calls.research++; return { text: '', citedUrls: [] } },
    complete: async () => { calls.complete++; return 'Here: ' + JSON.stringify([{ name: '', company: 'Ohm', contact: null, signal, source_url: `https://www.${host}/careers`, score: 95, excerpt, event_date: recent }]) },
  },
  openai: { research: async () => ({ text: '', citedUrls: [] }) },
})
const OHM_CLAIM_SIGNAL = 'Ohm is actively hiring for multiple senior go-to-market roles including two Founding Account Executive positions and a Chief of Staff.'
async function negativeRun(domain: string, host: string, text: string, signal = OHM_CLAIM_SIGNAL, excerpt?: string) {
  const { resetTinyfishState } = await import('../lib/search/tinyfish.ts')
  resetTinyfishState()
  const db = setup(); const b = createBatch(db, 'A', [domain]); queuePendingRows(db, 'A', b, RESTRICTED)
  const job = claimKeyedJob(db)!; const calls = { complete: 0, research: 0 }
  const live = async () => ({ text, title: 'Careers | Ohm', retrievedAt: 1_700_000_000 })
  assert.equal(await runJob(db, job, { providers: providersFor(calls, signal, host, excerpt), master, fetchPage: live, fetchImpl: stubFor(host, text) }), 'done')
  const rows = db.prepare('SELECT signal, evidence_excerpt, review_reason FROM leads').all() as { signal: string; evidence_excerpt: string | null; review_reason: string | null }[]
  return { calls, rows }
}
for (const rival of ['rival robotics', 'RIVAL ROBOTICS', 'Rival Robotics']) {
  test(`production caller: a ${rival === rival.toLowerCase() ? 'lowercase' : rival === rival.toUpperCase() ? 'uppercase' : 'mixed-case'} foreign employer on the company's own page never attaches - review, original text kept, ONE complete call`, withTinyfishEnv(async () => {
    const { calls, rows } = await negativeRun('ohm.ai', 'ohm.ai', `Ohm careers. ${rival} is hiring software engineers. Apply today to ${rival}.`, 'Ohm is hiring software engineers.', 'Ohm is actively hiring software engineers')
    assert.equal(calls.complete, 1); assert.equal(rows.length, 1)
    assert.equal(rows[0].review_reason, 'quote_unconfirmed', 'the foreign employer\'s sentence was not attached as Ohm\'s evidence')
    assert.equal(rows[0].evidence_excerpt, 'Ohm is actively hiring software engineers', "the model's original failed excerpt is preserved")
  }))
}
test('production caller: a lookalike validated domain (ohm-rival.ai) never attaches Ohm evidence - review, original text kept, ONE complete call', withTinyfishEnv(async () => {
  const { calls, rows } = await negativeRun('ohm-rival.ai', 'ohm-rival.ai', 'Ohm careers. Ohm is hiring software engineers. Apply today.', 'Ohm is hiring software engineers.', 'Ohm is actively hiring software engineers')
  assert.equal(calls.complete, 1); assert.equal(rows.length, 1)
  assert.equal(rows[0].review_reason, 'quote_unconfirmed'); assert.equal(rows[0].evidence_excerpt, 'Ohm is actively hiring software engineers')
}))

test('production caller control: the same simple claim on the real validated domain attaches and verifies (expected: verified, ONE complete call)', withTinyfishEnv(async () => {
  const { calls, rows } = await negativeRun('ohm.ai', 'ohm.ai', 'Ohm careers. Ohm is hiring software engineers. Apply today.', 'Ohm is hiring software engineers.', 'Ohm is actively hiring software engineers')
  assert.equal(calls.complete, 1); assert.equal(rows.length, 1)
  assert.equal(rows[0].review_reason, null); assert.equal(rows[0].evidence_excerpt, 'Ohm is hiring software engineers.')
}))
