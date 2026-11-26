import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bothEngines } from './helpers/engines.ts'
import { jobQueryIcp, latestQueryJob } from '../lib/scan/store-db.ts'

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
