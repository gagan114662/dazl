// #352 (Instinct review of #628, 2026-11-04): a free-trial scan gets NO recovery pass and makes NO extra paid call. paidFallback stays forced false for trials
// (lib/scan/runner.ts), so a research-only hold is kept and records "did not run", exactly as on origin/main. No caller-supplied flag, run budget or extra dep can
// switch it back on. Stubbed pages / news / model through the real runJob; invented companies and URLs; no network, no key, no credits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const MODEL = 'claude-sonnet-4-5'   // a priced model, so every trial call is reserved against the trial guard and the reservation is measurable
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const VENDOR = 'https://acmecrm.example/customers/orbitly', PRESS = 'https://sifted.example/orbitly-raises-seed'
const FUND = 'Orbitly, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Orbitly raises seed round', seendate: '20261016T100000Z' })) })
const TRIAL_ENV = { DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-test-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: '1', DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' }
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries([...Object.keys(env), 'TINYFISH_API_KEY'].map(k => [k, process.env[k]]))
  Object.assign(process.env, env, { TINYFISH_API_KEY: 'tf-test' })
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const EXTRACT = 'You turn pre-collected public items'
async function run(o: { trial?: boolean; runBudget?: string; deps?: Record<string, unknown> }) {
  const newsCalls: string[] = []
  // The recovery search names the held company in quotes; it is the only news query that finds the company's own press.
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt([decodeURIComponent(url).includes('"Orbitly"') ? PRESS : VENDOR]) } }
  const vendorCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: VENDOR, excerpt: FUND, event_date: daysAgo(10) }
  const pressCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(10) }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: VENDOR, title: 'Orbitly runs on AcmeCRM', snippet: FUND, date: null }], tfPages: {},
    own: {
      [VENDOR]: { title: 'Customer story: Orbitly runs on AcmeCRM', text: `On ${daysAgo(10)}, ${FUND}. Orbitly uses AcmeCRM to run its sales team.${filler}` },
      [PRESS]: { title: 'Orbitly raises seed round', text: `On ${daysAgo(10)}, ${FUND}.${filler}` },
    },
    extraction: [vendorCand, pressCand], model: MODEL, ...(o.trial === false ? {} : { fundedBy: 'trial' as const }), ...(o.runBudget !== undefined ? { runBudget: o.runBudget } : {}),
    deps: { newsHttp, ...(o.deps ?? {}) } }
  const x = await withEnv(TRIAL_ENV, () => runFixture(f))
  const lead = x.db.prepare("SELECT id, review_reason, source_url FROM leads WHERE company = 'Orbitly'").get() as { id: string; review_reason: string | null; source_url: string } | undefined
  const rec = lead ? x.db.prepare("SELECT value FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:recovery'").get(lead.id) as { value: string } | undefined : undefined
  const fallbackRuns = (x.db.prepare("SELECT count(*) AS n FROM scan_source_runs WHERE collector = 'fallback:news'").get() as { n: number }).n
  const extractions = x.calls.prompts.filter(p => p.startsWith(EXTRACT)).length
  const reserved = (x.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0
  const recoverySearches = newsCalls.filter(u => decodeURIComponent(u).includes('"Orbitly"')).length
  return { x, lead, rec, fallbackRuns, extractions, reserved, recoverySearches }
}
const NOT_RUN = 'Recovery pass did not run (the run disabled the paid fallback).'

test('#352 fail-closed: a TRIAL scan makes no recovery search, no recovery extraction and no reservation for one; the hold stays and records why', async () => {
  const keyed = await run({ trial: false })   // the control: a keyed scan with the paid fallback on DOES run the pass (so the fixture really offers one)
  assert.equal(keyed.fallbackRuns, 1, 'control: the keyed scan ran the recovery pass'); assert.ok(keyed.recoverySearches >= 1)
  const t = await run({})
  assert.equal(t.x.job.status, 'done', JSON.stringify(t.x.job))
  assert.equal(t.fallbackRuns, 0, 'no fallback:news run on a trial'); assert.equal(t.recoverySearches, 0, 'no recovery news search on a trial')
  assert.equal(t.extractions, keyed.extractions - 1, 'the trial sent every extraction except the recovery one')
  assert.equal(t.lead?.review_reason, 'counterparty_signal', JSON.stringify(t.lead)); assert.equal(t.lead!.source_url, VENDOR)
  assert.equal(t.rec?.value, NOT_RUN)
  assert.ok(t.reserved > 0 && t.reserved <= 1, `the trial's own calls stay inside its reserve (${t.reserved})`)
  // Spend equals a trial whose user ALSO opted out (paid_fallback=false): nothing is reserved for a recovery call that the opt-out would have suppressed.
  const optedOut = await run({ runBudget: JSON.stringify({ paid_fallback: false }) })
  assert.equal(optedOut.extractions, t.extractions); assert.ok(Math.abs(optedOut.reserved - t.reserved) < 1e-12, `${optedOut.reserved} vs ${t.reserved}`)
})

test('#352 fail-closed: no run budget, dep or extra key turns a trial\'s recovery pass back on (malformed, widening, first5, injected flags)', async () => {
  const base = await run({})
  const cases: { name: string; runBudget?: string; deps?: Record<string, unknown> }[] = [
    { name: 'budget paid_fallback=true (a widening attempt)', runBudget: JSON.stringify({ paid_fallback: true }) },
    { name: 'budget first5', runBudget: JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false }) },
    { name: 'budget not JSON', runBudget: '{not json' },
    { name: 'budget array', runBudget: '[]' },
    { name: 'budget null', runBudget: 'null' },
    { name: 'budget wrong types', runBudget: JSON.stringify({ paid_fallback: 'yes', max_usd: '100', first5: 1 }) },
    { name: 'budget extra keys', runBudget: '{"trialRecovery":true,"trial_recovery":true,"__proto__":{"paid_fallback":true}}' },
    { name: 'dep paidFallback=true', deps: { paidFallback: true } },
    { name: 'dep trialRecovery=true (the removed flag)', deps: { trialRecovery: true } },
  ]
  for (const c of cases) {
    const r = await run({ runBudget: c.runBudget, deps: c.deps })
    assert.equal(r.fallbackRuns, 0, c.name); assert.equal(r.recoverySearches, 0, c.name)
    assert.ok(r.extractions <= base.extractions, `${c.name}: no extra extraction (${r.extractions} vs ${base.extractions})`)
    assert.ok(r.reserved <= base.reserved + 1e-12, `${c.name}: no extra reservation (${r.reserved} vs ${base.reserved})`)
    if (r.lead) assert.notEqual(r.lead.source_url, PRESS, `${c.name}: never rescued through a recovery search`)
  }
})
