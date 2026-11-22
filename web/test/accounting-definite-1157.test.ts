// #1157 part 3: a scan stopped as accounting_uncertain gives a definite answer, never "a paid step may already have been
// billed". dazl cannot read Anthropic's per-request billing, so the interrupted paid step is COUNTED AS BILLED at the most it
// could cost - the reservation that already stays against the limits - and the stopped scan says so, with the amount when the
// still-reserved spend rows can be read. Unchanged: the step is never re-run automatically (that could bill it twice).
// Real prod shape: staging job 3e7778a5 (the ledger Hermes read for this issue) - llm.anthropic, US$0.084666 reserved, never settled.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { createJob } from '../lib/scan/store-db.ts'
import { readScanStatus } from '../lib/scan/status-read-service.ts'
import { scanOutcome } from '../lib/scan/scan-outcome.ts'

const HEDGE = /may (already )?have been billed|may have been charged|cannot tell|not sure/i
const stopped = (extra: Record<string, unknown> = {}) => scanOutcome({ id: 'j', status: 'failed', error: 'accounting_uncertain', ...extra } as never)

test('#1157 accounting_uncertain: counted as billed at the most it could cost, with the amount; no hedge', () => {
  const o = stopped({ uncertain_usd: 0.084666 })
  assert.equal(o.kind, 'stopped')
  assert.equal(o.label, 'Stopped after an interruption - one paid step counted as billed ($0.08)')
  assert.match(o.detail ?? '', /counted as billed at the most it could cost \(\$0\.08\)/)
  assert.match(o.detail ?? '', /did not run it again/)   // the no-re-run rule is unchanged
  assert.doesNotMatch(`${o.label} ${o.detail}`, HEDGE)
  assert.doesNotMatch(`${o.label} ${o.detail}`, /found no companies|zero|nothing matches/i)
})

test('#1157 accounting_uncertain: amount not readable still answers definitely; trial and named-source variants', () => {
  const unread = stopped()
  assert.equal(unread.label, 'Stopped after an interruption - one paid step counted as billed')
  assert.match(unread.detail ?? '', /counted as billed at the most it could cost/)
  assert.doesNotMatch(`${unread.label} ${unread.detail}`, HEDGE)
  assert.match(stopped({ uncertain_usd: 0.084666, funded_by: 'trial' }).detail ?? '', /This free scan does not count toward your free scans\./)
  const src = stopped({ uncertain_usd: 0.0023, failed_sources: ['search:anthropic'] })
  assert.equal(src.kind, 'failed')
  assert.equal(src.label, 'Failed - search:anthropic had an error; one paid step counted as billed ($0.0023)')
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
  assert.equal((s?.outcome as { label: string }).label, 'Stopped after an interruption - one paid step counted as billed ($0.08)')
  assert.doesNotMatch(JSON.stringify(s?.outcome), HEDGE)
})
