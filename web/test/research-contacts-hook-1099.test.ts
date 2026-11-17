// Refs #1099: the contacts step is registered by default in the research scan (lib/research/scan-job.ts), so a scan with the engine on keeps
// the addresses company research found printed on the company's own pages whichever stages are wired. Stubbed stages, invented company and page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateScan, createQueryJob } from '../lib/scan/store.ts'
import { migrateConnectors, enrichmentsForLeads } from '../lib/connectors/store.ts'
import { extendResearchStages, runResearchScan } from '../lib/research/scan-job.ts'
import type { Candidate, CompanyResearch, ResearchEvent, ResearchPlan, Verification } from '../lib/research/types.ts'

const SRC = 'https://news.test/kestrel-opens'
const SITE = 'https://kestrellaw.example'
const event: ResearchEvent = { company: 'Kestrel Law', website: SITE, pageIsCompanySite: false, triggerId: 't1', whatHappened: 'opened a Chicago office', whyNow: 'growing',
  quote: 'Kestrel Law opened a new office in Chicago', eventDate: '2026-10-02', dateQuote: 'October 2, 2026', locationQuote: null, people: [], sourceUrl: SRC, indexDate: null, foundBy: 'q' }
const verification: Verification = { triggerLiteral: true, triggerP: 0.9, triggerOk: true, date: '2026-10-02', dateTier: 'page', dateInWindow: true, personOk: true, personP: 0.9,
  personTier: 'page', personUrl: `${SITE}/team`, placeP: 0.9, categoryP: 0.9, placeCategoryOk: true, ready: true, why: [] }
const company: CompanyResearch = { site: SITE, sources: [], person: { name: 'Jane Doe', title: 'Managing Partner', sourceId: 's1', quote: 'Jane Doe, Managing Partner', profileUrl: null, from: 'research' },
  location: null, whatTheyDo: null, emails: [{ email: 'jane.doe@kestrellaw.example', url: `${SITE}/team` }, { email: 'info@kestrellaw.example', url: `${SITE}/contact` }] }
const plan: ResearchPlan = { persona: 'p', decisionMakerTitles: ['Managing Partner'], triggers: [{ id: 't1', name: 'New office', why: 'w', footprint: 'f', queries: ['q'] }], askingQueries: [], source: 'fallback' }
const cand: Candidate = { url: SRC, title: 't', snippet: '', date: null, triggerId: 't1', query: 'q', via: 'tinyfish' }

test('LEAD_ENGINE=research: the default after-save step saves the published addresses on the saved lead, with their pages', async () => {
  extendResearchStages((_ctx, base) => ({ ...base,
    plan: async () => plan,
    hunt: async () => ({ candidates: [cand], queries: 1, failed: {}, stopped: null, funnel: { stage: 'hunt', in: 1, out: 1, dropped: {} } }) as never,
    filter: async (_c, _p, all) => ({ all, keep: all }),
    read: async () => ({ events: [event], pageText: event.quote }),
    gate: async (_c, es) => es,
    company: async () => company,
    verify: async () => verification,
  }))
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const jobId = createQueryJob(db, 'A', { query: 'Law firms in Chicago that opened a new office', icp: '{}', offer: 'Intake software' } as never)
  const icp = { summary: 'x', who: [], industries: ['law firms'], sizes: [], where: ['Chicago, Illinois'], signals: ['opened an office'], exclude: [], window_days: 90 }
  const r = await runResearchScan({ db: db as never, job: { id: jobId, user_id: 'A', query: 'Law firms in Chicago that opened a new office', offer: 'Intake software' }, icp: icp as never, key: 'k',
    model: (() => ({ complete: async () => { throw new Error('no model call expected: every stage is stubbed') } })) as never, isRefusal: () => false }, { LEAD_ENGINE: 'research' })
  assert.ok(r?.afterSave, 'the engine ran and returned its after-save')
  // the runner saves the rows, then calls afterSave
  db.prepare("UPDATE scan_jobs SET status = 'running' WHERE id = ?").run(jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, fit, intent, action, why) VALUES ('lead1', ?, 'Jane Doe', 'Kestrel Law', 'kestrellaw.example', 'opened a Chicago office', ?, 4, 3, 4, 'x')").run(jobId, SRC)
  await r!.afterSave!(db, jobId)
  const rows = (enrichmentsForLeads(db, 'A', ['lead1']).lead1 ?? []).filter(e => e.kind === 'email').map(e => [e.value, e.source_url])
  assert.deepEqual(rows, [['jane.doe@kestrellaw.example', `${SITE}/team`], ['info@kestrellaw.example', `${SITE}/contact`]])
})
