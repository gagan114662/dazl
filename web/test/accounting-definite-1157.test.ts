// #1157 part 3: a scan stopped as accounting_uncertain gives a definite answer, never "a paid step may already have been
// billed". dazl cannot read Anthropic's per-request billing, so the interrupted paid step is COUNTED AS BILLED at the amount
// reserved for it - the reservation that already stays against the limits (for the web search that is an estimate, not a
// ceiling, so the copy never calls it the most it could cost) - and the stopped scan says so, with the count and the amount
// when the still-reserved spend rows can be read. Unchanged: the step is never re-run automatically (that could bill it twice).
// Ledger shape from a staging run read for this issue: llm.anthropic, US$0.084666 reserved, never settled.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { readUncertainHold } from '../lib/scan/status-reads.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const HEDGE = /may (already )?have been billed|may have been charged|cannot tell|not sure/i
const stopped = (extra: Record<string, unknown> = {}) => scanOutcome({ id: 'j', status: 'failed', error: 'accounting_uncertain', ...extra } as never)

test('#1157 accounting_uncertain: counted as billed at the amount reserved for it, with the amount rounded up; no hedge', () => {
  const o = stopped({ uncertain_usd: 0.084666, uncertain_steps: 1 })
  assert.equal(o.kind, 'stopped')
  // rounded UP: the page never names less than the ledger keeps counted ($0.08 would understate 0.084666)
  assert.equal(o.label, 'Stopped after an interruption - one paid step counted as billed ($0.0847)')
  assert.match(o.detail ?? '', /counted as billed at the amount reserved for it \(\$0\.0847\)/)
  assert.doesNotMatch(o.detail ?? '', /most it could cost/)   // a web-search reservation is an estimate, not a ceiling
  assert.match(o.detail ?? '', /did not run it again/)   // the no-re-run rule is unchanged
  assert.doesNotMatch(`${o.label} ${o.detail}`, HEDGE)
  assert.doesNotMatch(`${o.label} ${o.detail}`, /found no companies|zero|nothing matches/i)
})

test('#1157 accounting_uncertain: amount not readable still answers definitely; trial and named-source variants', () => {
  const unread = stopped()
  // neither the count nor the amount could be read: the copy names neither, and still answers definitely
  assert.equal(unread.label, 'Stopped after an interruption - the interrupted paid step counted as billed')
  assert.match(unread.detail ?? '', /counted as billed at the amount reserved for it,/)
  assert.doesNotMatch(`${unread.label} ${unread.detail}`, HEDGE)
  assert.match(stopped({ uncertain_usd: 0.084666, funded_by: 'trial', trial_attempt_restored: true }).detail ?? '', /This free scan does not count toward your free scans\./)
  const src = stopped({ uncertain_usd: 0.0023, uncertain_steps: 1, failed_sources: ['search:anthropic'] })
  assert.equal(src.kind, 'failed')
  assert.equal(src.label, 'Failed - search:anthropic had an error; one paid step counted as billed ($0.0023)')
  assert.equal(stopped({ uncertain_usd: 0.084641, uncertain_steps: 1 }).label, 'Stopped after an interruption - one paid step counted as billed ($0.0847)')   // up, never to nearest ($0.0846)
  assert.equal(stopped({ uncertain_usd: 0.68, uncertain_steps: 1 }).label, 'Stopped after an interruption - one paid step counted as billed ($0.68)')
  assert.doesNotMatch(`${src.label} ${src.detail}`, HEDGE)
})

bothEngines('#1157 the status read carries the still-reserved amount into the stopped scan (prod ledger shape), owner-scoped', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)"
  await db.run(ins, ['m1', 'A', job, 'llm.anthropic', 0.0211, 0.0019, 'settled', 1001, 1003])
  await db.run(ins, ['s1', 'A', job, 'tinyfish.search', 0, 0, 'settled', 1004, 1006])
  await db.run(ins, ['m2', 'A', job, 'llm.anthropic', 0.084666, null, 'reserved', 1008, null])
  await db.run(ins, ['x1', 'B', job, 'llm.anthropic', 5, null, 'reserved', 1009, null])   // another tenant's row is never read
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = 2213, claimed_at = NULL WHERE id = ?", [job])
  const s = await readScanStatus(db, 'A', job)
  assert.equal((s?.outcome as { label: string }).label, 'Stopped after an interruption - one paid step counted as billed ($0.0847)')
  assert.doesNotMatch(JSON.stringify(s?.outcome), HEDGE)
})

// Council: paid calls run in parallel (judge calls), so a crash can leave several reserved rows. The copy counts them.
bothEngines('#1157 two still-reserved paid calls: the stopped scan names two steps and their total, never "one paid step"', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  const ins = "INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES (?, 'A', ?, 1, 'llm.anthropic', ?, NULL, 'reserved', NULL, ?, NULL)"
  await db.run(ins, ['p1', job, 0.03, 1001])
  await db.run(ins, ['p2', job, 0.05, 1002])
  await db.run(ins, ['p0', job, 0, 1003])   // a $0 hold (a free call) is no billed step
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = 2213, claimed_at = NULL WHERE id = ?", [job])
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail: string }
  assert.equal(o.label, 'Stopped after an interruption - 2 paid steps counted as billed ($0.08)')
  assert.match(o.detail, /^2 paid steps were interrupted before their answers came back, so they are counted as billed at the amount reserved for them \(\$0\.08\), and they stay counted against your limits\. dazl did not run them again automatically/)
})

// Council: the reaper can stop a job as accounting_uncertain with no reserved row left (e.g. the ledger itself was unreadable).
bothEngines('#1157 no still-reserved row: the stopped scan answers definitely and names no count or amount', async ({ db }) => {
  const job = await createJob(db, 'A', { business_name: 'b', industry: 'manufacturing', location: 'Bangalore' }, '{}')
  await db.run("UPDATE scan_jobs SET status = 'running', claimed_at = 1000, attempts = 1 WHERE id = ?", [job])
  await db.run("INSERT INTO scan_spend_calls (id, user_id, scan_job_id, attempt, kind, reserve_usd, actual_usd, status, reason, created_at, settled_at) VALUES ('k1', 'A', ?, 1, 'llm.anthropic', 0.02, 0.001, 'settled', NULL, 1001, 1002)", [job])
  await db.run("UPDATE scan_jobs SET status = 'failed', error = 'accounting_uncertain', finished_at = 2213, claimed_at = NULL WHERE id = ?", [job])
  const o = (await readScanStatus(db, 'A', job))?.outcome as { label: string; detail: string }
  assert.equal(o.label, 'Stopped after an interruption - the interrupted paid step counted as billed')
  assert.doesNotMatch(`${o.label} ${o.detail}`, HEDGE)
})

test('#1157 a ledger read that fails gives no count and no amount (never a made-up one)', async () => {
  const failing = { get: async () => { throw new Error('read failed') } } as never
  assert.equal(await readUncertainHold(failing, 'A', 'a1157b000000000000000005'), null)
})
