// The Claude discovery lane inside a real scan job (lib/scan/runner.ts runDiscoverLane): the leads the loop returns are stored, the
// ones whose proof names the company are READY the way Home and the Leads page decide it, and the rest go to review. The loop itself
// is replaced by a canned answer; invented companies only, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import { createQueryJob, listLeads } from '../lib/scan/store.ts'
import { claimKeyedJob, discoverLaneEnabled, runJob } from '../lib/scan/runner.ts'
import { enrichmentsForLeads } from '../lib/connectors/store.ts'
import { leadHoldReason, timingOptsFor } from '../lib/outreach/lead-hold.ts'
import type { DiscoverResult, DiscoveredLead } from '../lib/discover/agent.ts'

const lead = (o: Partial<DiscoveredLead>): DiscoveredLead => ({ company: 'Northwind Dental', domain: 'northwind-dental.example', signal: 'Opening a second clinic', signal_date: '2026-10-14', evidence_url: 'https://news.example/northwind', evidence_quote: 'Northwind Dental will open its second clinic', person: 'Dana Ruiz', title: 'Practice Owner', person_source_url: 'https://northwind-dental.example/team', linkedin_url: null, confidence: 'high', why: 'expanding', ...o })

test('the lane runs for an ordinary request on the workspace\'s own Anthropic key, and only then', () => {
  const job = { query: 'dental clinics expanding', csv_domain: null, watch_id: null, funded_by: 'user' }
  assert.equal(discoverLaneEnabled(job, 'anthropic', {}), true)
  assert.equal(discoverLaneEnabled(job, 'anthropic', { DAZL_DISCOVER_LANE: '0' }), false, 'the switch turns it off')
  assert.equal(discoverLaneEnabled(job, 'openai', {}), false)
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}), false, 'a free-trial scan with no stated reserve keeps the older path')
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}, 0.3), false, 'a trial reserve too small for one run keeps the older path')
  assert.equal(discoverLaneEnabled({ ...job, funded_by: 'trial' }, 'anthropic', {}, 0.75), true, 'a trial reserve that covers one run uses the lane')
  assert.equal(discoverLaneEnabled({ ...job, csv_domain: 'acme.example' }, 'anthropic', {}), false)
  assert.equal(discoverLaneEnabled({ ...job, watch_id: 'w1' }, 'anthropic', {}), false)
})

test('a scan through the lane: confirmed leads are ready, an undated one too, an unconfirmed proof goes to review; the person and website are kept', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor' })
  const job = claimKeyedJob(db, id)
  assert.ok(job)
  const canned: DiscoverResult = {
    leads: [
      lead({}),
      lead({ company: 'Harbour Smiles', domain: null, evidence_url: 'https://harboursmiles.example/news', evidence_quote: null, signal_date: null, person: null, title: null, person_source_url: null, confidence: 'medium' }),
      lead({ company: 'Ghost Dental', evidence_url: 'https://nowhere.example/ghost' }),
    ],
    seen: [
      { url: 'https://news.example/northwind', title: 'Northwind Dental', page_age: null, text: 'On 14 October 2026 Northwind Dental will open its second clinic downtown.' },
      { url: 'https://harboursmiles.example/news', title: 'News', page_age: null, text: 'Harbour Smiles is opening a new location this year.' },
    ],
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, searches: 3, requests: 1, usd: 0.044 }, stop: 'end_turn', model: 'claude-opus-5-5', note: null,
  }
  let asked: { query: string; offer?: string | null } | null = null
  const blocked = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch   // dazl's own read of the unseen proof fails
  const result = await runJob(db, job!, { master, fetchImpl: blocked, discover: true, discoverImpl: async input => { asked = input; return canned },
    // the second pass fills the website of the lead that had none, and costs a little more
    enrichImpl: async leads => ({ leads: leads.map(l => l.company === 'Harbour Smiles' ? { ...l, domain: 'harboursmiles.example' } : l), usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.011 }, seen: [], enriched: 1 }) })
  assert.equal(result, 'done')
  assert.deepEqual(asked, { query: 'Dental clinics in a city opening a new location', offer: 'Clinic fit-out contractor' }, 'the request and the offer go to the loop as written')
  const j = db.prepare('SELECT status, error, candidates, verified, needs_review, query, icp FROM scan_jobs WHERE id = ?').get(id) as { status: string; error: string | null; candidates: number; verified: number; needs_review: number; query: string; icp: string | null }
  assert.deepEqual([j.status, j.error, j.candidates, j.verified, j.needs_review], ['done', null, 3, 2, 1])
  const leads = listLeads(db, 'T', id, 50, false) as (Record<string, unknown> & { id: string; company: string })[]
  const enr = enrichmentsForLeads(db, 'T', leads.map(l => l.id)) as Record<string, { kind: string; value: string; source_url: string }[]>
  const why = (company: string) => { const l = leads.find(x => x.company === company)!; return leadHoldReason(db, 'T', l, enr[l.id] ?? [], timingOptsFor(j), new Date()) }
  assert.equal(why('Northwind Dental'), null, 'a confirmed, dated lead is ready')
  assert.equal(why('Harbour Smiles'), null, 'no date, no person and no website lower the confidence; they do not hold the lead')
  assert.equal(why('Ghost Dental'), 'needs your review', 'a proof page the run never saw and dazl could not read is not shown as ready')
  const nw = leads.find(l => l.company === 'Northwind Dental')!
  assert.deepEqual([nw.source_kind, nw.company_domain, nw.event_date, nw.event_date_proof, nw.name], ['discover', 'northwind-dental.example', '2026-10-14', 'page_bound', 'Dana Ruiz'])
  assert.deepEqual(enr[nw.id].filter(e => e.kind === 'person').map(e => [e.value, e.source_url]), [['Dana Ruiz, Practice Owner', 'https://northwind-dental.example/team']])
  const spend = db.prepare("SELECT kind, status, actual_usd FROM scan_spend_calls WHERE scan_job_id = ?").all(id) as { kind: string; status: string; actual_usd: number | null }[]
  assert.deepEqual(spend.map(s => [s.kind, s.actual_usd]), [['llm.anthropic.web_search', 0.055]], 'the run is reserved before the call and settled at what both passes cost')
  assert.equal(leads.find(l => l.company === 'Harbour Smiles')!.company_domain, 'harboursmiles.example', 'the second pass filled the empty website')
})

test('a request with its own lower limit gets the smaller search budget and never reserves more than its limit', async () => {
  const master = randomBytes(32)
  process.env.DAZL_MASTER_KEY = master.toString('base64')
  const db = new Database(':memory:')
  migrateAllSqlite(db)
  saveKey(db, 'T', 'anthropic', 'sk-ant-test', master)
  const id = createQueryJob(db, 'T', { query: 'Dental clinics in a city opening a new location', seller: 'Clinic fit-out contractor', runBudget: JSON.stringify({ max_usd: 1 }) })
  const job = claimKeyedJob(db, id)
  let asked: Record<string, unknown> | null = null
  const empty: DiscoverResult = { leads: [], seen: [], usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, searches: 1, requests: 1, usd: 0.2 }, stop: 'end_turn', model: 'm', note: null }
  assert.equal(await runJob(db, job!, { master, discover: true, enrichImpl: null, discoverImpl: async input => { asked = input as unknown as Record<string, unknown>; return empty } }), 'done')
  assert.deepEqual([asked!.maxSearches, asked!.maxFetches], [10, 8], 'US$1 of room is less than a full run: the smaller budget')
  const spend = db.prepare('SELECT reserve_usd, actual_usd FROM scan_spend_calls WHERE scan_job_id = ?').all(id) as { reserve_usd: number; actual_usd: number }[]
  assert.equal(spend.length, 1)
  assert.ok(spend[0].reserve_usd <= 1 && spend[0].actual_usd === 0.2, JSON.stringify(spend))
})
