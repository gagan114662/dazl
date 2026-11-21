// #1163: the targeting compiler read negated, stopped and shrinking wordings as POSITIVE conditions, so a search typed as "stopped
// hiring SDRs" or "lost funding" looked for the opposite of what was written. Every wording from the issue and its two review comments
// must compile to no positive funding / hiring / completed-hire condition (negated, with the reading recorded on the plan). Ordinary
// positive requests stay positive. The store test runs the real job row through classifyLeads, the gate that decides what is shown.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { compileTargeting, planConditions, planView } from '../lib/scan/targeting.ts'
import { classifyLeads } from '../lib/scan/actionable.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors } from '../lib/connectors/store.ts'
import { migrateMemory } from '../lib/memory.ts'

const TRIGGER = new Set(['funding', 'hiring', 'hire_made'])
const triggers = (q: string) => planConditions(compileTargeting(q).root).filter(x => TRIGGER.has(x.cond.kind))

// The issue body ("Business rejecting venture capital funding" is a real saved signal on prod).
const BODY = ['Business rejecting venture capital funding', 'stopped hiring SDRs', "isn't hiring a receptionist", 'instead of hiring front-desk staff',
  'hiring SDRs on hold', 'lost funding', 'funding fell through', 'ran out of funding', 'yet to raise funding', 'pre-funding', 'hired fewer SDRs', 'barely hiring']
// Review comment 1 (PR #1145 at c12ab77d).
const C1 = [...['postponed', 'delayed', 'shelved', 'scrapped', 'abandoned', 'discontinued', 'terminated', 'is unlikely', 'is off the table', 'is over'].map(w => `hiring SDRs ${w}`),
  ...['slowdown', 'moratorium', 'ban', 'cap', 'cutbacks', 'restrictions', 'down 30%'].map(w => `hiring ${w}`),
  'hired SDRs and fired them', 'hired SDRs then let them go', 'backed out of hiring SDRs']
// Review comment 2 (PR #1145 at 970f8a7a).
const C2 = ['hiring ban in place', 'hiring slowdown across the practice',
  ...['slump', 'hiatus', 'stoppage', 'shutdown', 'crunch', 'crisis', 'stall', 'stalls', 'rumours', 'rumors', 'denial', 'withdrawn'].map(w => `hiring ${w}`),
  ...['on ice', 'put on ice', 'in doubt', 'doubtful', 'uncertain', 'under review', 'in limbo', 'at risk', 'a mistake', 'unaffordable', 'proves futile', 'backfires', 'fizzles', 'going badly', 'withdrawn', 'gone', 'rumour', 'maybe'].map(w => `hiring SDRs ${w}`),
  'hiring office manager role withdrawn',
  'Series A rumoured', 'Series A denied',
  // council review: stop wordings the first lists missed
  'ceased hiring SDRs', 'hiring SDRs ceased', 'quit hiring SDRs', 'reduced hiring SDRs', 'scaled back hiring SDRs', 'trimmed SDR hiring', 'wound down hiring SDRs',
  'hiring SDRs ended', 'ended hiring SDRs', 'Series A funding ended', 'hiring SDRs has stopped', 'raising funding has stopped', 'raised funding but stopped',
  'we no longer raise funding', 'hiring SDRs: paused', 'hired SDRs and let our team go',
  'hiring SDRs stopped', 'hiring SDRs paused', 'hiring SDRs is paused', 'hiring SDRs halted', 'funding rejected', 'funding declined', 'turned down VC funding',
  'failed to raise funding', 'unable to raise funding', 'funding round failed', 'hired a VP Sales, then fired him', 'funding round rumored', 'funding ban', 'funding slowdown', 'funding talks collapsed', 'funding round pulled', 'funding dried up']

for (const q of [...BODY, ...C1, ...C2]) {
  test(`#1163 "${q}" compiles to no positive funding / hiring / hire condition`, () => {
    const t = triggers(q)
    const plan = compileTargeting(q)
    assert.ok(t.length > 0 || plan.ambiguities.length > 0, `${q}: neither a negated condition nor a recorded refusal`)
    for (const x of t) assert.equal(x.negated, true, `${q}: ${x.cond.kind} "${x.cond.text}" compiled POSITIVE`)
    if (t.length) assert.ok(plan.ambiguities.some(a => /^NOT /.test(a.chosen)), `${q}: the plan does not say why it reads NOT`)
  })
}

test('#1163 a stopped hiring condition keeps a clean role, and the plan view says NOT', () => {
  for (const [q, role] of [['hiring SDRs postponed', 'SDRs'], ['hiring SDRs is off the table', 'SDRs'], ['hiring SDRs on hold', 'SDRs'], ['hiring office manager role withdrawn', 'office manager'], ['stopped hiring SDRs', 'SDRs'], ['hiring SDRs has slowed', 'SDRs'], ['hiring SDRs has stopped', 'SDRs'], ['hiring down 30%', ''], ['hired a VP Sales, then fired him', 'VP Sales'], ['hired fewer SDRs', 'SDRs']] as const) {
    const [x] = triggers(q)
    assert.deepEqual([x.cond.kind === 'hire_made' ? 'hiring' : x.cond.kind, x.negated, x.cond.role], ['hiring', true, role], q)
    assert.match(planView(compileTargeting(q)).summary, /^NOT C1 /, q)
  }
})

test('#1163 ordinary positive requests stay positive (real roles, double negative, funded startups, completed hires)', () => {
  for (const q of ['hiring a registered dental hygienist', 'hiring a licensed practical nurse', 'hiring certified dental assistants', 'hiring experienced SDRs',
    'hiring 3 SDRs', 'hiring a Sr. Account Executive', 'hiring a Head of Business Development and Partnerships', 'never stopped hiring SDRs',
    'raised seed funding and are hiring account executives', 'VC-backed startups', 'Companies that hired their first VP of Sales within 30 days',
    'lost a CEO and raised a seed round', 'B2B SaaS startups that raised seed funding in the last 90 days or are hiring account executives',
    'dental clinics hiring a front desk manager', 'hiring SDRs to cut onboarding time',
    // a stop word elsewhere in the clause is not about the condition (council review: these were read NOT and would hide real leads)
    'companies hiring SDRs at capped salaries', 'hiring SDRs at Cap Gemini', 'hiring SDRs in a crunch market', 'hiring SDRs for a crisis management firm',
    'hiring SDRs after a rumor of acquisition', 'hiring SDRs gone remote', 'hiring SDRs in Gone Fishing Inc', 'companies hiring a restrictions analyst',
    'hiring SDRs on hold music software', 'companies that lost a deal and raised Series A', 'hiring SDRs to stop churn', 'raised funding to avoid layoffs',
    'Series A startups with fewer than 50 employees', 'companies with fewer than 50 employees hiring SDRs', 'dental clinics with fewer than 20 staff hiring a receptionist',
    'raised funding from fewer than 5 investors', 'hiring cap table managers', 'hiring freezer technicians', 'Declining retail chains hiring store managers',
    'Cancellation management software companies hiring SDRs', 'Scrap metal recyclers hiring drivers', 'hiring SDRs to fix sales delays', 'Lost Dog Rescue hiring a receptionist',
    "agencies that aren't franchises hiring SDRs", "firms that don't outsource sales hiring SDRs", 'startups that lost their founder hiring SDRs',
    'avoid agencies hiring SDRs', 'firms rather than agencies hiring SDRs', 'clinics hiring crisis counselors', 'airlines hiring cancellation agents',
    'hiring a capped commission SDR', 'startups hiring SDRs with fewer than 50 employees', 'hiring SDRs again after a freeze', 'venture backed down-market SaaS']) {
    const t = triggers(q)
    assert.ok(t.length > 0, `${q}: no condition`)
    for (const x of t) assert.equal(x.negated, false, `${q}: ${x.cond.kind} "${x.cond.text}" read NEGATED`)
    assert.ok(!compileTargeting(q).ambiguities.some(a => /^NOT /.test(a.chosen)), `${q}: a stop reading was recorded`)
  }
})

// Real route: the saved job's own query, read back from the store by classifyLeads (the gate that decides what a person sees).
const NOW = Date.now()
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString().slice(0, 10)
function classify(query: string, company: string, quote: string, gatePassed = false) {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db); migrateMemory(db)
  const jobId = createJob(db, 'u1', { business_name: 'Seller', industry: 'software', location: 'Austin, TX' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ? WHERE id = ?").run(query, jobId)
  const job = db.prepare('SELECT id, user_id, query, icp FROM scan_jobs WHERE id = ?').get(jobId) as { id: string; user_id: string; query: string; icp: string | null }
  const id = company.toLowerCase()
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, event_date, confidence, score, fit) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 80, 80, 5)")
    .run(id, jobId, company, `${id}.example`, query, `https://${id}.example/news`, quote, day(10))
  // The sales-hiring gate runs before the plan gate; its durable pass record lets the lead reach the plan, as after a real gate pass.
  if (gatePassed) for (const v of ['sales_hiring', 'requested_role_v1']) db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, 'u1', 'scan:gate', 'gate_passed', ?, 'x', NULL, 'https://invalid.example/', ?, 1)").run(`${id}g${v}`, id, v, day(1))
  return classifyLeads(db, job)[0]
}

test('#1163 real route: the prod saved signal "Business rejecting venture capital funding" never shows a company that just raised a round', () => {
  const r = classify('Business rejecting venture capital funding', 'Fundco', 'Fundco raised a $12M Series A round led by Northline Ventures to grow its platform.')
  assert.equal(r.actionable, false)
  assert.ok(r.missing.includes('targeting_not_proven'), JSON.stringify(r))
  assert.deepEqual(r.targeting?.map(c => [c.id, c.negated, c.truth]), [['C1', true, 'pass']], 'the raise is proven, and the request says NOT funding')
})

test('#1163 real route: "stopped hiring SDRs" never shows a company that is hiring SDRs', () => {
  const r = classify('stopped hiring SDRs', 'Hireco', 'Hireco is hiring Sales Development Representatives (SDRs) to grow its outbound team.', true)
  assert.equal(r.actionable, false)
  assert.ok(r.missing.includes('targeting_not_proven'), JSON.stringify(r))
  assert.deepEqual(r.targeting?.map(c => [c.id, c.negated]), [['C1', true]])
})
