// #1185: the job-board title check (titleIsRole) held about a third of real account-executive postings, because the words it allowed
// before the role were a short fixed list and no word was allowed after it without a separator. Every title below is copied verbatim from a
// public Greenhouse board record (boards-api.greenhouse.io, read 2026-11-21, no spend): it goes through the real gate and the real store,
// as the lead's own board-dated posting, exactly as the runner hands the verifier-read title to the gate.
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { applySalesHiringGate, postingKey, titleIsRole } from '../lib/scan/sales-hiring-gate.ts'
import { requestedHiringRoles } from '../lib/scan/hiring-role-match.ts'
import { migrateScan, createJob } from '../lib/scan/store.ts'
import { migrateConnectors, enrichmentsForLeads } from '../lib/connectors/store.ts'

const NOW = Date.parse('2026-11-21T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10)
const URL_ = 'https://job-boards.greenhouse.io/brightloop/jobs/7301185'
const QUERY = 'B2B SaaS companies hiring an account executive in the last 30 days'
const noFetch = (async () => new Response('nope', { status: 404 })) as never

function seedOwnPosting() {
  const db = new Database(':memory:'); migrateScan(db); migrateConnectors(db)
  const icp = JSON.stringify({ signals: ['hiring an account executive'] })
  const jobId = createJob(db, 'u1', { business_name: 'B', industry: 'I', location: 'L' })
  db.prepare("UPDATE scan_jobs SET status = 'running', query = ?, icp = ? WHERE id = ?").run(QUERY, icp, jobId)
  db.prepare("INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, evidence_excerpt, confidence, score, why, event_date, event_date_proof, date_status) VALUES ('L1', ?, '', 'Brightloop', NULL, 'hiring an Account Executive', ?, 'Brightloop helps teams ship faster.', 80, 80, '', ?, 'ats_structured', 'verified')")
    .run(jobId, URL_, day(9))
  db.prepare("UPDATE scan_jobs SET status = 'done', verified = 1, needs_review = 0 WHERE id = ?").run(jobId)
  return { db, job: { id: jobId, user_id: 'u1', query: QUERY, icp } }
}
async function gate(title: string) {
  const { db, job } = seedOwnPosting()
  await applySalesHiringGate(db, job, noFetch, { now: NOW, postingTitles: new Map([[postingKey(URL_)!, title]]) })
  const reason = (db.prepare("SELECT review_reason FROM leads WHERE id = 'L1'").get() as { review_reason: string | null }).review_reason
  const rows = (enrichmentsForLeads(db, 'u1', ['L1']).L1 ?? []).filter(x => x.kind === 'hiring')
  db.close()
  return { reason, rows }
}

// real account-executive openings held before #1185 (board, verbatim title)
const REAL_OPENINGS: [string, string][] = [
  ['toast', 'Territory Account Executive, Retail - Columbus, OH'],
  ['cloudflare', 'Senior Territory Account Executive'],
  ['toast', 'Flex Territory Account Executive- Canada West Coast'],
  ['datadog', 'Mid Market Account Executive'],
  ['databricks', 'Strategic Core Account Executive - Life Sciences'],
  ['databricks', 'Named Core Account Executive'],
  ['databricks', 'Emerging Enterprise Core Account Executive'],
  ['cloudflare', 'Senior Majors Account Executive - Dallas'],
  ['zscaler', 'Sales Account Executive, Enterprise'],
  ['okta', 'Federal Account Executive, FSI'],
  ['cloudflare', 'Federal Account Executive, Treasury'],
  ['databricks', 'Digital Native Hunter Account Executive'],
  ['cloudflare', 'Enterprise Account Executive Mexico'],
  ['trustpilot', 'Account Executive Mid Market Benelux'],
  ['trustpilot', 'Account Executive Mid Market - Spain'],
  ['okta', 'Strategic Account Executive UK/I'],
  ['okta', 'Account Executive Large Enterprise Public Sector'],
]
// another role, a pool or a mention of the role: held before #1185 and still held (#1155's held titles first)
const NOT_THE_OPENING = [
  'Sales Engineer for Account Executives', 'Team Lead, Account Executive', 'Account Executive Manager', 'Chief of Staff to the Account Executive org',
  'Account Executive Talent Community', 'Future Opportunities - Account Executive',
  'Team Lead Account Executive - Italy & Spain', 'Manager, Account Executives', 'Technical Recruiter, Account Executive Team', 'Account Executive Support Specialist',
  'Director of Account Executive Operations', 'Account Executive Enablement', 'Account Executive Internship',
  // the newly allowed segment words never make another title the opening
  'Account Executive Territory Manager', 'Federal Account Executive Manager', 'Sales Engineer Account Executive', 'Territory Account Executive Team Lead',
  'Account Executive Lead', 'Account Executive Team', 'Account Executive Specialist', 'Account Executive Mexico Manager',
]

test('#1185 PASS: real Territory / Mid Market / Core / Majors / Sales / Federal / place-suffixed account-executive postings are the requested role through the real gate and store', async () => {
  for (const [board, title] of REAL_OPENINGS) {
    const { reason, rows } = await gate(title)
    assert.equal(reason, null, `${board}: ${title}`)
    assert.equal(rows.length, 1, `${board}: ${title}`)
    assert.equal(rows[0].value, `Open role on its Greenhouse job board: ${title} - posted ${day(9)}`)
    assert.equal(rows[0].source_date, day(9))
  }
})

test('#1185 HELD: other roles, pools and mentions of the role stay held as no_sales_hiring_evidence through the real gate and store', async () => {
  for (const title of NOT_THE_OPENING) {
    const { reason, rows } = await gate(title)
    assert.equal(reason, 'no_sales_hiring_evidence', title)
    assert.equal(rows.length, 0, title)
  }
})

test('#1185: titleIsRole agrees with the gate on every title above', () => {
  const roles = requestedHiringRoles(QUERY, JSON.stringify({ signals: ['hiring an account executive'] }))
  for (const [, t] of REAL_OPENINGS) assert.ok(titleIsRole(t, roles), t)
  for (const t of NOT_THE_OPENING) assert.equal(titleIsRole(t, roles), null, t)
})
