// #1139 route seam: GET /api/leads (real handler, real store, stubbed session, no network). A lead stored with no signal kind,
// an ats_structured board date and the live #533 wording surfaces its stored intent as proof_backed; the same lead whose posted
// role carries a state word in parentheses ("(filled)", "(closed)") is not a hiring trigger, so the board date never backs it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { setScanDb, setUser } from './tenant-route-db.ts'
import { migrateScan, createJob } from '../../lib/scan/store.ts'
import { migrateSourceReview } from '../../lib/scan/source-review.ts'
import { migrateWatch } from '../../lib/watch.ts'
import { migrateKeys } from '../../lib/llm/key-store.ts'
import { migratePlans } from '../../lib/plans.ts'
import { migrateConnectors } from '../../lib/connectors/store.ts'
import { migrateAdvanced } from '../../lib/advanced/index.ts'
import { migrateBilling } from '../../lib/billing/stripe.ts'
import { migrateOutreach } from '../../lib/outreach/store.ts'
import { migrateAutopilot } from '../../lib/outreach/autopilot.ts'
import { migrateLedger } from '../../lib/outreach/ledger.ts'
import { migrateReplies } from '../../lib/outreach/replies.ts'
import { migrateThreadReplies } from '../../lib/replies/threads.ts'
import { migrateSequences } from '../../lib/outreach/sequences.ts'
import { migrateTrial } from '../../lib/scan/trial.ts'
import { migrateCompetitors } from '../../lib/signals/competitor-reddit.ts'
import { migrateEvents } from '../../lib/events/store.ts'
import { migrateWarm } from '../../lib/warm/connections.ts'
import { migrateSeo } from '../../lib/seo/audit.ts'
import { migrateMonitors } from '../../lib/monitors.ts'
import { migrateCsv } from '../../lib/scan/csv-import.ts'
import { migrateCommenterImport } from '../../lib/scan/commenter-import.ts'
import { migrateMemory } from '../../lib/memory.ts'
import { migrateReopen } from '../../lib/outreach/reopen.ts'
import { GET as leadsGET } from '../../app/api/leads/route.ts'

globalThis.fetch = (async () => { throw new Error('Unexpected network call') }) as typeof fetch

const daysAgoISO = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
// the live #533 signal (Tekion on Ashby, verbatim) and the #1139 parenthesised-state variants of it
const LIVE = 'Posted a Sales Operations Manager - Deal Desk role on Ashby'
const STATES = ['Posted a Sales Operations Manager - Deal Desk (filled) role on Ashby', 'Posted a (closed) Sales Operations Manager - Deal Desk role on Ashby']

test('GET /api/leads #1139: a parenthesised state word in a posted role is not hiring, so its board date backs no intent', async () => {
  const db = new Database(':memory:')
  for (const m of [migrateScan, migrateSourceReview, migrateWatch, migrateKeys, migratePlans, migrateConnectors, migrateAdvanced, migrateBilling, migrateOutreach, migrateAutopilot, migrateLedger, migrateReplies, migrateThreadReplies, migrateSequences, migrateTrial, migrateCompetitors, migrateEvents, migrateWarm, migrateSeo, migrateMonitors, migrateCsv, migrateCommenterImport, migrateMemory, migrateReopen]) m(db)
  setScanDb(db)
  setUser({ id: 'A', business_name: 'Acme' })
  const job = createJob(db, 'A', { business_name: 'Synthetic A', industry: 'test', location: 'test' })
  db.prepare("UPDATE scan_jobs SET status='running' WHERE id=?").run(job)
  const ids = new Map<string, string>()
  for (const signal of [LIVE, ...STATES]) {
    const id = randomBytes(12).toString('hex'); ids.set(signal, id)
    db.prepare("INSERT INTO leads(id,scan_job_id,company,name,contact,signal,source_url,evidence_excerpt,confidence,score,fit,intent,action,why,signal_kind,event_date,event_date_proof) VALUES(?,?,'Tekion','Pat','pat@tekion.test',?,'https://jobs.ashbyhq.com/tekion/b1f00000-0000-4000-8000-0000000000c1','Sales Operations Manager - Deal Desk Location Virtual - California (Bay Area) Employment Type Full time',80,70,5,4,3,'Strong fit: hiring sales ops.',NULL,?,'ats_structured')").run(id, job, signal, daysAgoISO(2))
  }
  const res = await leadsGET(new NextRequest(`http://test/api/leads?job_id=${job}`))
  assert.equal(res.status, 200)
  const body = await res.json() as { leads: { id: string; intent: number; stored_intent: number | null; timing: string; timing_reason: string | null }[] }
  const row = (s: string) => body.leads.find(l => l.id === ids.get(s))!
  assert.deepEqual([row(LIVE).timing, row(LIVE).intent], ['proof_backed', 4], `the live wording is hiring: ${JSON.stringify(row(LIVE))}`)
  for (const s of STATES) {
    assert.ok(row(s), `${s}: the seeded lead is returned`)
    assert.deepEqual([row(s).timing, row(s).intent, row(s).timing_reason, row(s).stored_intent], ['unconfirmed', 0, 'proof_kind_mismatch', 4], `${s}: ${JSON.stringify(row(s))}`)
  }
})
