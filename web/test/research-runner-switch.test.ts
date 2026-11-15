// MISSION v2 part A: the runner switch. LEAD_ENGINE=research runs the research engine (stubbed stages) and writes its leads through the runner's
// own finish(), ready ones to the list and held ones to the review lane; with the switch off, or a stage missing, the old engine runs.
// Also the research search queue, the research search budget and the fixed-model provider with the Haiku price.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { migrateScan, createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, runJob } from '../lib/scan/runner.ts'
import { extendResearchStages, extendResearchAfterSave, toScanRow, RESEARCH_HELD } from '../lib/research/scan-job.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'
import { SearchQueue, researchSearchBudget } from '../lib/research/search-queue.ts'
import { anthropicModel } from '../lib/llm/provider.ts'
import { modelCostUsd } from '../lib/scan/spend-cap.ts'
import type { Candidate, CompanyResearch, ResearchEvent, Verification } from '../lib/research/types.ts'

const master = randomBytes(32)
const ICP = { summary: 'x', who: [], industries: ['law firms'], sizes: [], where: ['Chicago, Illinois'], signals: ['opened an office'], exclude: [], window_days: 90 }
const PLAN = JSON.stringify({ persona: 'p', decision_maker_titles: ['Managing Partner'], triggers: [{ name: 'New office', queries: ['Chicago law firm new office 2026'] }], asking_queries: [] })
let modelPrompts: string[] = []
let refuseOn: { company: string; reason: string } | null = null
let onCompany: (() => void) | null = null   // runs inside the company stage (R5: another attempt takes the job over)
let currentDb: Database.Database | null = null
let verifyCalls = 0   // the company stage throws this refusal for that company (R1)
async function scan(env: string | undefined) {
  if (env) process.env.LEAD_ENGINE = env; else delete process.env.LEAD_ENGINE
  const db = new Database(':memory:'); currentDb = db; migrateScan(db); migrateKeys(db); saveKey(db, 'A', 'anthropic', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', master)
  const id = createQueryJob(db, 'A', { query: 'Law firms in Chicago that opened a new office in the last 90 days', icp: JSON.stringify(ICP), offer: 'Legal intake software' } as never)
  modelPrompts = []
  const complete = async (_k: string, p: string) => { modelPrompts.push(p); return p.includes('head of research') ? PLAN : '[]' }
  const prov = { anthropic: { research: async () => ({ text: '[]', citedUrls: [] }), complete, configuredModel: () => 'claude-sonnet-4-5' }, openai: { research: async () => ({ text: '[]', citedUrls: [] }), complete: async () => '[]' } }
  const http = async () => null
  const r = await runJob(db, claimKeyedJob(db, id)!, { providers: prov as never, master, fetchPage: (async () => null) as never, sourceHttp: http as never, newsHttp: http as never, crawlGet: async () => null, score: false })
  try { return { r, db, id, leads: listLeads(db, 'A', id, 200, true) as unknown as Record<string, unknown>[] } } finally { delete process.env.LEAD_ENGINE }
}
const ev = (company: string): ResearchEvent => ({ company, website: null, pageIsCompanySite: false, triggerId: 't1', whatHappened: 'moved into a larger Chicago office', whyNow: 'growing',
  quote: `${company} has moved into a new downtown Chicago office`, eventDate: '2026-10-02', dateQuote: 'October 2, 2026', locationQuote: null, people: [], sourceUrl: `https://news.test/${company.replace(/\s/g, '-')}`, indexDate: null, foundBy: 'q' })
const ver = (ready: boolean): Verification => ({ triggerLiteral: true, triggerP: 0.9, triggerOk: true, date: '2026-10-02', dateTier: 'page', dateInWindow: true, personOk: ready, personP: ready ? 0.9 : 0, personTier: ready ? 'page' : null, personUrl: null, placeP: 1, categoryP: 1, placeCategoryOk: true, ready, why: ready ? [] : ['no named person'] })
const comp = (person: boolean): CompanyResearch => ({ site: 'https://firm.test', sources: [], person: person ? { name: 'Adam Zayed', title: 'Founder', sourceId: 'S1', quote: 'Adam Zayed, Founder', profileUrl: null, from: 'research' } : null, location: null, whatTheyDo: null, emails: [] })

test('switch off, or a stage missing: the old engine runs and the research stages are never called', async () => {
  // the old engine with empty stub answers ends no_candidates: that IS the old engine's own outcome, so it ran
  const err = (x: { db: Database.Database; id: string }) => (x.db.prepare('SELECT error FROM scan_jobs WHERE id = ?').get(x.id) as { error: string | null }).error
  const off = await scan(undefined)
  assert.equal(err(off), 'no_candidates'); assert.ok(!modelPrompts.some(p => p.includes('head of research')), 'no research plan without LEAD_ENGINE=research')
  const missing = await scan('research')   // no extension registered yet: filter/read/gate/research/verify do not exist
  assert.equal(err(missing), 'no_candidates'); assert.equal(missing.leads.length, 0)
})

test('LEAD_ENGINE=research: the plan on the job\'s model, the stages in order, ready leads listed and held ones in review, then afterSave', async () => {
  const saved: string[] = []
  extendResearchStages((_ctx, base) => ({ ...base,
    hunt: async () => ({ candidates: [{ url: 'https://news.test/a', title: 'a', snippet: '', date: null, triggerId: 't1', query: 'q', via: 'tinyfish' } as Candidate], queries: 1, failed: {}, stopped: null, funnel: { stage: 'hunt', in: 1, out: 1, dropped: {} } }),
    filter: async (_c, _p, all) => ({ all, keep: all }),
    read: async () => { const e = [ev('Zayed Law'), ev('Ogletree Deakins')]; return { events: e, pageText: e.map(x => x.quote).join('. ') } },
    gate: async (_c, es) => es,
    company: async (_c, _p, e) => { onCompany?.(); if (refuseOn && e.company === refuseOn.company) throw new SpendRefused(refuseOn.reason); return comp(e.company === 'Zayed Law') },
    verify: async (_c, e) => (verifyCalls++, ver(e.company === 'Zayed Law')),
  }))
  extendResearchAfterSave((_db, jobId, run) => { saved.push(`${jobId}:${run.leads.length}`) })
  const s = await scan('research')
  assert.equal(s.r, 'done')
  assert.ok(modelPrompts.some(p => p.includes('head of research') && p.includes('Chicago, Illinois') && p.includes('law firms')), 'the plan was written for the job\'s place and category')
  const zayed = s.leads.find(l => l.company === 'Zayed Law')!, ogle = s.leads.find(l => l.company === 'Ogletree Deakins')!
  assert.equal(zayed.review_reason, null); assert.equal(zayed.name, 'Adam Zayed'); assert.equal(zayed.event_date, '2026-10-02'); assert.equal(zayed.event_date_proof, 'page_bound')
  assert.equal(ogle.review_reason, RESEARCH_HELD); assert.equal(ogle.name, '')
  assert.deepEqual(saved, [`${s.id}:2`])
  const job = s.db.prepare('SELECT status, candidates FROM scan_jobs WHERE id = ?').get(s.id) as { status: string; candidates: number }
  assert.equal(job.status, 'done'); assert.equal(job.candidates, 1)
})

test('toScanRow: an index-dated day is kept unproven; the score and confidence are the trigger check\'s probability', () => {
  const r = toScanRow({ event: ev('X Firm'), company: comp(true), verification: { ...ver(false), dateTier: 'index' } }, new Date('2026-11-15T00:00:00Z'))
  assert.equal(r.event_date_proof, null); assert.equal(r.date_status, 'unverified'); assert.equal(r.confidence, 90); assert.equal(r.review_reason, RESEARCH_HELD); assert.equal(r.name, '', 'no person unless verified')
})

test('the search queue spaces calls 60/perMinute apart in call order; the research budget defaults to 160', async () => {
  let t = 0; const slept: number[] = []
  const q = new SearchQueue(18, () => t, async ms => { slept.push(Math.round(ms)); t += ms })
  await Promise.all([q.slot(), q.slot(), q.slot()])
  assert.equal(slept.length, 2, 'the first caller goes at once, two wait'); assert.ok(slept.every(ms => Math.abs(ms - 3333) <= 1), `${slept}`); assert.ok(Math.abs(t - 6667) <= 2, 'the third call goes two gaps after the first')
  assert.equal(researchSearchBudget({}), 160); assert.equal(researchSearchBudget({ RESEARCH_SEARCH_BUDGET: '120' }), 120); assert.equal(researchSearchBudget({ RESEARCH_SEARCH_BUDGET: 'x' }), 160)
})

test('a fixed-model provider reports its model, and Haiku is priced (US$1 / US$5 per million tokens)', () => {
  assert.equal(anthropicModel('claude-haiku-4-5').configuredModel!(), 'claude-haiku-4-5')
  const usd = modelCostUsd('claude-haiku-4-5', 'x'.repeat(4000), 1000)
  assert.ok(usd !== null && usd > 0 && usd < modelCostUsd('claude-sonnet-4-5', 'x'.repeat(4000), 1000)!, `haiku ${usd}`)
})

test('a refusal is read as the old engine reads it: a numeric budget keeps what was verified (budget_stopped); any other refusal fails the run', async () => {
  // the extension registered above serves these runs too; it is read in order (Zayed Law, then Ogletree Deakins)
  refuseOn = { company: 'Ogletree Deakins', reason: 'over_limit' }
  try {
    const b = await scan('research')
    const j = b.db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(b.id) as { status: string; error: string | null }
    assert.deepEqual([j.status, j.error], ['done', 'budget_stopped'])
    assert.ok(b.leads.some(l => l.company === 'Zayed Law' && l.review_reason === null), 'the lead verified before the refusal is kept, ready')
    refuseOn = { company: 'Ogletree Deakins', reason: 'count_failed' }
    const f = await scan('research')
    const k = f.db.prepare('SELECT status, error FROM scan_jobs WHERE id = ?').get(f.id) as { status: string; error: string | null }
    assert.equal(k.status, 'failed', `a refusal no budget can fix is never a budget stop: ${JSON.stringify(k)}`)
    assert.notEqual(k.error, 'budget_stopped')
  } finally { refuseOn = null }
})

test('ready is recomputed from its fields: a stage\'s ready flag with no dated day, no person or a failed place check goes to review', () => {
  const base = { event: ev('X Firm'), company: comp(true), verification: ver(true) }
  assert.equal(toScanRow(base).review_reason, undefined, 'positive control: every field holds')
  for (const [name, l] of [
    ['no day', { ...base, verification: { ...ver(true), date: null, dateTier: null, dateInWindow: false } }],
    ['outside the window', { ...base, verification: { ...ver(true), dateInWindow: false } }],
    ['index-dated', { ...base, verification: { ...ver(true), dateTier: 'index' as const } }],
    ['no person', { ...base, company: comp(false) }],
    ['place or category', { ...base, verification: { ...ver(true), placeCategoryOk: false } }],
  ] as const) assert.equal(toScanRow(l as never).review_reason, RESEARCH_HELD, name)
})

test('the ownership check runs between stages: a job another attempt took over mid-run writes nothing and stops at the next stage', async () => {
  onCompany = () => { currentDb!.prepare("UPDATE scan_jobs SET attempts = attempts + 1").run() }
  verifyCalls = 0
  try {
    const s = await scan('research')
    assert.equal(s.leads.length, 0, 'finish() never writes for the lost attempt')
    assert.equal(verifyCalls, 0, 'the checkpoint after company research stops the run before verify')
  } finally { onCompany = null }
})
