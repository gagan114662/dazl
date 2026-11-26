import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { jobQueryIcp, latestQueryJob } from '../lib/scan/store-db.ts'
import { journey } from '../lib/journey.ts'

const IN = Math.floor(Date.now() / 1000)
const job = (id: string, user: string, query: string, icp: object, at: number): [string, [string, string, string, string, number]] =>
  ["INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, icp, icp_inferred, created_at) VALUES (?, ?, 'x', 'test', 'test', 'done', ?, ?, 0, ?)", [id, user, query, JSON.stringify(icp), at]]

bothEngines("#1772: the card's ICP read is keyed by the play's job id, not the newest scan", async ({ db }) => {
  const query = 'marketing agencies hiring'   // two plays share the request text; the ICP carries the place
  await db.run(...job('a'.repeat(24), 'A', query, { where: ['Austin, TX'], summary: 'Marketing agencies' }, IN - 100))
  await db.run(...job('b'.repeat(24), 'A', query, { where: ['Toronto, ON'], summary: 'Marketing agencies' }, IN))
  const latest = await latestQueryJob(db, 'A')
  assert.equal(JSON.parse(latest!.icp!).where[0], 'Toronto, ON', 'the globally newest scan belongs to the other play - the mix-up source')
  const own = await jobQueryIcp(db, 'A', 'a'.repeat(24))
  assert.equal(JSON.parse(own!.icp!).where[0], 'Austin, TX', "the play-keyed read returns the featured play's own ICP")
  assert.equal(await jobQueryIcp(db, 'B', 'a'.repeat(24)), undefined, "another tenant's job never resolves")
})

test('#1772: the journey card guards its ICP by play id, and the latest route accepts job_id', () => {
  const tsx = readFileSync(new URL('../app/app/journey.tsx', import.meta.url), 'utf8')
  assert.match(tsx, /playIcp\.jobId === j\.play\.id/, 'the card guard keys on the play id')
  assert.doesNotMatch(tsx, /playIcp\.query === j\.play\.query/, 'the query-text guard (the mix-up) is gone')
  assert.match(tsx, /\/api\/scan\/latest\?job_id=/, 'the ICP read is scoped to the featured play')
  const route = readFileSync(new URL('../app/api/scan/latest/route.ts', import.meta.url), 'utf8')
  assert.match(route, /searchParams\.get\('job_id'\)/, 'the route takes the play id')
  assert.match(route, /jobQueryIcp/, 'the route reads the play-keyed ICP')
})

test("#1875: the card's title, tooltip and link all read the one featured play", () => {
  // Two plays share the request text (the #1772 collision family; the place lives in the ICP). Whichever run Home
  // features, the card's name, the request behind its (i) and its action link are that same run's - never a mix
  // of one play's title over another play's request or leads.
  const Q = 'dental clinics hiring in the past 90 days'
  const base = { status: 'done', error: null, query: Q, csv_domain: null, candidates: 3, verified: 1, needs_review: 1, dropped: 1, lead_count: 3, test_only: false }
  const A = { ...base, id: 'a'.repeat(24), created_at: 100 }
  const B = { ...base, id: 'b'.repeat(24), created_at: 200 }
  // currentPlay takes the first watch whose sentence matches the newest job, so the watch order decides the
  // featured run; pin each order to its play so a selection regression cannot pass both iterations.
  for (const [watches, expected] of [
    [[{ query: Q, last_job_id: B.id }, { query: Q, last_job_id: A.id }], B.id],
    [[{ query: Q, last_job_id: A.id }, { query: Q, last_job_id: B.id }], A.id],
  ] as const) {
    const j = journey({ profile: { website: 'https://x.example', sells: 'y', buyer: null }, jobs: [A, B], leads: null, drafts: null, watches: [...watches] })
    assert.equal(j.play?.id, expected, 'the first matching watch supplies the featured run')
    assert.equal(j.action?.href, `/app/leads?job_id=${expected}`, 'the action link opens the featured run, never another play')
  }
  const tsx = readFileSync(new URL('../app/app/journey.tsx', import.meta.url), 'utf8')
  assert.match(tsx, /playName\(j\.play\.query, icp\)/, 'the title names the featured play')
  assert.match(tsx, /data-testid="play-request">\{j\.play\.query\}</, 'the (i) tooltip shows the featured play\'s own request')
  assert.match(tsx, /playIcp\.jobId === j\.play\.id/, 'the title ICP is keyed to the featured play (#1772)')
  const lib = readFileSync(new URL('../lib/journey.ts', import.meta.url), 'utf8')
  assert.match(lib, /leadsHref = `\/app\/leads\?job_id=\$\{play\.id\}`/, 'the card link carries the featured play\'s job id')
})

const jobWithSource = (id: string, user: string, query: string, icp: object, inferred: number, at: number): [string, [string, string, string, string, number, number]] =>
  ["INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status, query, icp, icp_inferred, created_at) VALUES (?, ?, 'x', 'test', 'test', 'done', ?, ?, ?, ?)", [id, user, query, JSON.stringify(icp), inferred, at]]

bothEngines("#1875: a profile carried onto the featured job is never read as its own (the prod Toronto/Austin pair)", async ({ db }) => {
  // The exact prod pair: the featured job 'marketing agencies in Austin hiring' holds the PAUSED Toronto play's
  // profile (summary Marketing agencies, where Toronto, signal hiring SDRs) marked carried (icp_inferred=3) - the
  // carry paths (a saved play's run, a new search started from a restored profile) all store it that way. Read
  // play-keyed, that profile titled the Home card 'Toronto marketing agencies hiring' over the Austin request.
  const torontoIcp = { summary: 'Marketing agencies', who: ['small marketing agencies'], where: ['Toronto, ON'], signals: ['hiring SDRs'] }
  await db.run(...jobWithSource('c'.repeat(24), 'A', 'Toronto agencies hiring an SDR', torontoIcp, 3, IN - 50))
  await db.run(...jobWithSource('d'.repeat(24), 'A', 'marketing agencies in Austin hiring', torontoIcp, 3, IN))
  const own = await jobQueryIcp(db, 'A', 'd'.repeat(24))
  assert.equal(own?.query, 'marketing agencies in Austin hiring', "the featured job's own request still comes back")
  assert.equal(own?.icp, null, "a carried profile can be another play's - the card derives the title from the job's own request instead")
  assert.equal(own?.icp_inferred, null, 'no profile origin is reported for a profile that is not shown')
  // A profile authored for the job itself still titles its card: inferred (1), request-derived (2), user-reviewed (0).
  await db.run(...jobWithSource('e'.repeat(24), 'A', 'marketing agencies in Austin hiring', { summary: 'Marketing agencies', where: ['Austin, TX'], signals: ['hiring SDRs'] }, 1, IN + 1))
  const authored = await jobQueryIcp(db, 'A', 'e'.repeat(24))
  assert.equal(JSON.parse(authored!.icp!).where[0], 'Austin, TX', "the job's own inferred profile is shown")
  assert.equal(authored?.icp_inferred, 1)
})
