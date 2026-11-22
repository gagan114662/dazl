// Run 679a7354 (case 1, on #1509): Monaco and HowGood passed the required sales-hiring gate yet were held buying_need_unproven:plan_ambiguous.
// The only "ambiguity" was the resolved bare-role choice for "a new Head of Sales/VP Sales" (each reading proven on its own dated source),
// and behind it every OR plan reads hiring_one_of_choices. A lead the required gate actually PASSED (its scan:gate gate_passed row) stands on
// that dated trigger: trigger-only, never verified need. Without that row nothing changes.
import assert from 'node:assert/strict'
import type { Db } from '../lib/db/client.ts'
import { createQueryJob } from '../lib/scan/store-db.ts'
import { compileTargeting } from '../lib/scan/targeting.ts'
import { planNeedSupport, recordNeedEvidence, currentBuyingNeed } from '../lib/scan/need-evidence.ts'
import { bothEngines } from './helpers/engines.ts'
import test from 'node:test'

const Q = 'Find B2B companies (5-200 employees) doing outbound sales that show a dated buying signal in the last 45 days: hiring their first SDR/BDR or sales rep, new funding, a new Head of Sales/VP Sales, or a founder still doing sales. Buyer: Founder, CEO or Head of Sales. seller = dazl (dazl.ai): AI that finds high-intent leads and drafts reviewed cold outreach from your own Gmail.'
const ICP = JSON.stringify({ summary: 'x', who: ['Founder', 'CEO', 'Head of Sales'], industries: [], sizes: ['5-200 employees'], where: [], signals: ['Hiring first SDR', 'Hiring first BDR', 'Hiring first sales rep', 'New funding in last 45 days', 'New Head of Sales hired in last 45 days', 'New VP Sales hired in last 45 days', 'Founder still doing sales'], exclude: ['Non-B2B companies'], window_days: 45 })
const AS_OF = new Date('2026-11-22T01:00:00Z'), NOW = Math.floor(AS_OF.getTime() / 1000), T = 'd'.repeat(32)

test('case-1 plan: a resolved either-reading choice is not an open ambiguity', () => {
  assert.deepEqual(planNeedSupport(compileTargeting(Q, ICP)), { support: 'none', reason: 'hiring_one_of_choices' })
})
bothEngines('case-1 OR plan: a lead that passed the required gate is trigger-only; one without a gate pass stays unproven', async ({ db }: { db: Db }) => {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt, sells) VALUES (?, 'd@example.test', 'n', 'Dazl', 'x', 'y', '')", [T])
  const job = await createQueryJob(db, T, { query: Q, icp: ICP })
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1, claimed_at = ? WHERE id = ?", [NOW, job])
  for (const id of ['passed', 'nogate']) await db.run(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, confidence, review_reason, created_at)
    VALUES (?, ?, '', ?, NULL, 'Founding SDR', ?, 80, 80, NULL, ?)`, [id, job, `Co ${id}`, `https://jobs.lever.co/co${id}/a9cf54b8-b57f-4293-ac40-009ebb3aadd9`, NOW])
  await db.run(`INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at)
    VALUES ('g1', 'passed', ?, 'scan:gate', 'gate_passed', 'requested_role_v1', 'passed', NULL, 'https://jobs.lever.co/copassed/a9cf54b8-b57f-4293-ac40-009ebb3aadd9', '2026-11-21', ?)`, [T, NOW])
  await recordNeedEvidence(db, T, job, { asOf: AS_OF })
  assert.equal((await currentBuyingNeed(db, T, job, 'passed', { asOf: AS_OF })).status, 'trigger_only')
  assert.deepEqual(await currentBuyingNeed(db, T, job, 'nogate', { asOf: AS_OF }), { status: 'unproven', reason: 'buying_need_unproven:hiring_one_of_choices' })
})
