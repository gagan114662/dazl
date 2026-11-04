// #352 owner decision (Gagan, 2026-11-03): "Yes: run one extra trial search to rescue research-only leads." A free-trial scan now gets the same bounded automatic
// recovery pass as a keyed scan (the free news search for at most 3 held companies, then ONE extraction through the trial's guard). A user's own paid_fallback=false
// still switches it off; the pass never pushes the trial into its budget stop (it runs only with room for itself plus one more call of the same size).
// Stubbed pages / news / model through the real runJob; invented companies and URLs; no network, no key, no credits; no gate is relaxed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runFixture, daysAgo, type Fixture, type Cand } from './helpers/acceptance-harness.ts'
import { trialRoomCheck, TRIAL_NO_ROOM } from '../lib/scan/runner.ts'
import { SpendGuard, callCostUsd } from '../lib/llm/spend-guard.ts'
import { recoveryNote } from '../lib/lead-state.ts'
import type { Provider } from '../lib/llm/provider.ts'
import type { SafeGet } from '../lib/sources/types.ts'

const MODEL = 'claude-sonnet-4-5'
const REQUEST = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const ICP = { summary: 'London seed B2B SaaS', who: ['Founder'], industries: ['SaaS'], sizes: [], where: ['London, UK'], signals: ['announced seed funding'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const filler = ' More about the company, its product and its people.'.repeat(10)
const VENDOR = 'https://acmecrm.example/customers/orbitly', PRESS = 'https://sifted.example/orbitly-raises-seed'
const FUND = 'Orbitly, a London B2B SaaS startup, raised a 3m GBP seed round this month'
const gdelt = (urls: string[]) => JSON.stringify({ articles: urls.map(u => ({ url: u, title: 'Orbitly raises seed round', seendate: '20261016T100000Z' })) })
const TRIAL_ENV = (reserve: number) => ({ DAZL_TRIAL_ANTHROPIC_KEY: 'sk-ant-trial-fixture', DAZL_TRIAL_SCAN_RESERVE_USD: String(reserve), DAZL_TRIAL_ACCOUNT_TOTAL_USD: '5',
  DAZL_TRIAL_GLOBAL_DAILY_USD: '10', TINYFISH_ENABLED: '1', DAZL_TRIAL_TINYFISH_SEARCH_USD: '0', DAZL_TRIAL_TINYFISH_FETCH_USD: '0' })
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env, { TINYFISH_API_KEY: 'tf-test' })
  try { return await fn() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
interface Opt { trial?: boolean; reserve?: number; runBudget?: string; paid?: boolean }
async function run(o: Opt) {
  const newsCalls: string[] = []
  // The recovery search names the held company in quotes; any other news query (first5's own news source) finds only the customer story.
  const newsHttp: SafeGet = async url => { newsCalls.push(url); return { status: 200, body: gdelt([decodeURIComponent(url).includes('"Orbitly"') ? PRESS : VENDOR]) } }
  const vendorCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: VENDOR, excerpt: FUND, event_date: daysAgo(10) }
  const pressCand: Cand = { company: 'Orbitly', signal: 'raised a seed round', source_url: PRESS, excerpt: FUND, event_date: daysAgo(10) }
  const f: Fixture = { request: REQUEST, modelIcp: ICP, modelQueries: ['london saas startup seed round'], hits: [{ url: VENDOR, title: 'Orbitly runs on AcmeCRM', snippet: FUND, date: null }], tfPages: {},
    own: {
      [VENDOR]: { title: 'Customer story: Orbitly runs on AcmeCRM', text: `On ${daysAgo(10)}, ${FUND}. Orbitly uses AcmeCRM to run its sales team.${filler}` },
      [PRESS]: { title: 'Orbitly raises seed round', text: `On ${daysAgo(10)}, ${FUND}.${filler}` },
    },
    extraction: [vendorCand, pressCand], model: MODEL, ...(o.trial === false ? {} : { fundedBy: 'trial' as const }), ...(o.runBudget ? { runBudget: o.runBudget } : {}),
    deps: { newsHttp, ...(o.paid === false ? { paidFallback: false } : {}) } }
  const x = await withEnv(TRIAL_ENV(o.reserve ?? 1), () => runFixture(f))
  const lead = x.db.prepare("SELECT id, review_reason, source_url FROM leads WHERE company = 'Orbitly'").get() as { id: string; review_reason: string | null; source_url: string } | undefined
  const rec = lead ? x.db.prepare("SELECT value, label FROM lead_enrichments WHERE lead_id = ? AND connector = 'scan:recovery'").get(lead.id) as { value: string; label: string } | undefined : undefined
  const fallbackRuns = (x.db.prepare("SELECT count(*) AS n FROM scan_source_runs WHERE collector = 'fallback:news'").get() as { n: number }).n
  const extractions = x.calls.prompts.filter(p => p.startsWith('You turn pre-collected public items')).length
  const reserved = (x.db.prepare('SELECT spend_reserved_usd AS s FROM scan_jobs').get() as { s: number | null }).s ?? 0
  return { x, lead, rec, fallbackRuns, newsCalls, extractions, reserved }
}
const state = (l?: { review_reason: string | null }) => (!l ? 'none' : l.review_reason === null ? 'verifier-passed' : `held:${l.review_reason}`)

test('TRIAL, room to spare: the recovery pass runs and the company\'s own press rescues the customer-mention hold (main before the decision: held, "did not run")', async () => {
  const r = await run({})
  assert.equal(r.x.job.status, 'done', JSON.stringify(r.x.job))
  assert.equal(r.fallbackRuns, 1, 'the recovery pass searched'); assert.ok(r.newsCalls.length >= 1)
  assert.equal(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rec])); assert.equal(r.lead!.source_url, PRESS)
  assert.equal(r.rec, undefined, 'rescued: no "none verified" record')
  assert.ok(r.reserved > 0 && r.reserved <= 1, `every call stayed inside the trial reserve (${r.reserved})`)
})

test('TRIAL, the user set paid_fallback=false: their opt-out still switches the pass off, and the hold says so', async () => {
  const r = await run({ runBudget: JSON.stringify({ paid_fallback: false }) })
  assert.equal(r.fallbackRuns, 0); assert.equal(state(r.lead), 'held:counterparty_signal')
  assert.match(r.rec!.value, /^Recovery pass did not run \(the run disabled the paid fallback\)\./)
})

test('TRIAL first5: the synthesized paid_fallback=false of the fast first scan is not an opt-out - the pass runs', async () => {
  const r = await run({ runBudget: JSON.stringify({ first5: true, paid_fallback: false, credit_enrichment: false }) })
  assert.equal(r.fallbackRuns, 1, JSON.stringify([r.lead, r.rec, r.newsCalls])); assert.equal(state(r.lead), 'verifier-passed', JSON.stringify([r.lead, r.rec])); assert.equal(r.lead!.source_url, PRESS)
})

test('NOT a trial, paid fallback disabled: unchanged - no pass (the decision covers trial scans only)', async () => {
  const r = await run({ trial: false, paid: false })
  assert.equal(r.fallbackRuns, 0); assert.equal(state(r.lead), 'held:counterparty_signal')
})

test('TRIAL, too little room: the extraction is never sent, nothing is reserved for it, the scan is NOT budget-stopped, and the hold records why', async () => {
  const roomy = await run({})
  // The recovery extraction's maximum, priced exactly as the guard prices it.
  const recoveryPrompt = roomy.x.calls.prompts.filter(p => p.startsWith('You turn pre-collected public items')).at(-1)!
  const rCost = callCostUsd(MODEL, Buffer.byteLength(recoveryPrompt), 3000)
  // A reserve that fits everything the scan did except the room the pass needs (itself + one more call of its size).
  const tight = await run({ reserve: roomy.reserved - rCost + rCost * 1.5 })
  assert.equal(tight.x.job.status, 'done', JSON.stringify(tight.x.job)); assert.notEqual(tight.x.job.error, 'trial_budget_reached')
  assert.equal(tight.extractions, roomy.extractions - 1, 'the recovery extraction was not sent')
  assert.ok(Math.abs(tight.reserved - (roomy.reserved - rCost)) < 1e-9, `nothing reserved for the skipped call (${tight.reserved} vs ${roomy.reserved - rCost})`)
  assert.equal(state(tight.lead), 'held:counterparty_signal')
  assert.equal(tight.rec!.value, `Recovery pass did not run (${TRIAL_NO_ROOM}).`)
  assert.deepEqual(recoveryNote({ enrichments: [{ connector: 'scan:recovery', label: tight.rec!.label, value: tight.rec!.value }] }), { ran: false, text: 'dazl did not search other sources for it: the free scan had no budget left for an extra search.' })
})

test('trialRoomCheck: room for 2x the call or skip; unpriced / throwing model, refused guard, NaN or absurd sizes skip; never reserves', async () => {
  const sent: string[] = []
  const mk = (model: unknown): Provider => ({ research: async () => ({ text: '', citedUrls: [] }), complete: async (_k: string, p: string) => { sent.push(p); return 'REAL' },
    configuredModel: () => { if (model instanceof Error) throw model; return model as string } }) as unknown as Provider
  const c = callCostUsd(MODEL, Buffer.byteLength('hello'), 3000)
  const call = async (p: Provider, g: SpendGuard, prompt = 'hello', max: unknown = 3000, noMax = false) => { const r = trialRoomCheck(p, g); const out = noMax ? await r.provider.complete!('k', prompt) : await r.provider.complete!('k', prompt, undefined, max as number); return { out, skipped: r.skipped() } }
  assert.deepEqual(await call(mk(MODEL), new SpendGuard(2 * c + 1e-9)), { out: 'REAL', skipped: false })
  assert.deepEqual(await call(mk(MODEL), new SpendGuard(2 * c - 1e-9)), { out: '[]', skipped: true })
  assert.deepEqual(await call(mk(MODEL), new SpendGuard(1, 1 - 1.5 * c)), { out: '[]', skipped: true }, 'already-reserved spend counts')
  for (const m of ['unpriced-model', undefined, null, 42, {}, new Error('boom')]) assert.deepEqual(await call(mk(m), new SpendGuard(100)), { out: '[]', skipped: true }, String(m))
  const refused = new SpendGuard(100); refused.refused = true
  assert.deepEqual(await call(mk(MODEL), refused), { out: '[]', skipped: true }, 'a guard already refused never gets an extra call')
  assert.deepEqual(await call(mk(MODEL), new SpendGuard(100), 'x'.repeat(50_000_000)), { out: '[]', skipped: true }, 'a huge prompt does not fit')
  for (const max of [-5, 0, Number.NaN, '3000']) assert.equal((await call(mk(MODEL), new SpendGuard(2 * callCostUsd(MODEL, 5, 4096) - 1e-9), 'hello', max)).skipped, true, `max=${String(max)} is priced at the 4096 default`)
  assert.equal((await call(mk(MODEL), new SpendGuard(2 * callCostUsd(MODEL, 5, 4096) - 1e-9), 'hello', undefined, true)).skipped, true, 'no max: priced at the 4096 default')
  const g = new SpendGuard(100); await call(mk(MODEL), g)
  assert.equal(g.reservedUsd, 0, 'the check never reserves: the real guard inside the provider does')
  assert.equal(sent.filter(p => p === 'hello').length, 2, 'only the calls with room were sent')
  const noComplete = { research: async () => ({ text: '', citedUrls: [] }) } as unknown as Provider
  assert.equal(trialRoomCheck(noComplete, new SpendGuard(1)).provider.complete, undefined)
})
