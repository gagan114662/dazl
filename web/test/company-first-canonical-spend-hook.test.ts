import assert from 'node:assert/strict'
import { bothEngines } from './helpers/engines.ts'
import { runWithScanSpend, reserveScanSpend, scanCapConfig } from '../lib/scan/spend-cap.ts'
import { SpendRefused } from '../lib/llm/spend-guard.ts'

bothEngines('scorecard-tagged job cannot spend through the existing canonical transport without a verified lane', async ({ db }) => {
  const tenantId = 'z'.repeat(32), jobId = 'abcdef'.repeat(4), ordinaryJobId = '123456'.repeat(4)
  for (const [id, marker] of [[jobId, 'd'.repeat(64)], [ordinaryJobId, null]]) {
    await db.run(`INSERT INTO scan_jobs
      (id, user_id, business_name, industry, location, status, attempts, company_scorecard_claim_nonce,
       company_scorecard_dispatch_started_at) VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?)`,
      [id, tenantId, 'Synthetic business', 'Synthetic category', 'Synthetic place', marker, marker ? 1785000000000 : null])
  }
  const cap = scanCapConfig({})
  const context = { db, tenantId, attempt: 1, cap, accountLimits: null, clock: () => 1_785_000_000 }
  await assert.rejects(
    runWithScanSpend({ ...context, jobId }, () => reserveScanSpend('llm.anthropic', () => 0.1)),
    (err: unknown) => err instanceof SpendRefused,
  )
  assert.equal(Number((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM scan_spend_calls WHERE scan_job_id = ?', [jobId]))?.n), 0)
  const blocked = await db.get<{ spend_cap_reserved_usd: number }>('SELECT spend_cap_reserved_usd FROM scan_jobs WHERE id = ?', [jobId])
  assert.equal(Number(blocked?.spend_cap_reserved_usd), 0, 'refusal rolls back the canonical reservation too')
  const ordinary = await runWithScanSpend({ ...context, jobId: ordinaryJobId }, () => reserveScanSpend('llm.anthropic', () => 0.1))
  assert.ok(ordinary, 'existing ordinary path still reserves normally')
  await ordinary.settle(0.06)
})
