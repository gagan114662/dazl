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
  for (const watches of [
    [{ query: Q, last_job_id: B.id }, { query: Q, last_job_id: A.id }],
    [{ query: Q, last_job_id: A.id }, { query: Q, last_job_id: B.id }],
  ]) {
    const j = journey({ profile: { website: 'https://x.example', sells: 'y', buyer: null }, jobs: [A, B], leads: null, drafts: null, watches })
    assert.ok(j.play, 'a play is featured')
    assert.ok(j.play.id === A.id || j.play.id === B.id, 'the featured run is one of the plays')
    assert.equal(j.action?.href, `/app/leads?job_id=${j.play.id}`, 'the action link opens the featured run, never another play')
  }
  const tsx = readFileSync(new URL('../app/app/journey.tsx', import.meta.url), 'utf8')
  assert.match(tsx, /playName\(j\.play\.query, icp\)/, 'the title names the featured play')
  assert.match(tsx, /data-testid="play-request">\{j\.play\.query\}</, 'the (i) tooltip shows the featured play\'s own request')
  assert.match(tsx, /playIcp\.jobId === j\.play\.id/, 'the title ICP is keyed to the featured play (#1772)')
  const lib = readFileSync(new URL('../lib/journey.ts', import.meta.url), 'utf8')
  assert.match(lib, /leadsHref = `\/app\/leads\?job_id=\$\{play\.id\}`/, 'the card link carries the featured play\'s job id')
})
