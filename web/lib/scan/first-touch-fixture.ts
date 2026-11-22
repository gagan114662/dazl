import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { fixtureAvailable, FixtureError } from '../outreach/test-fixture.ts'
import { TEST_INBOX } from '../outreach/service.ts'
import { tableExists } from '../outreach/send-budget.ts'

// Test-only FIRST-TOUCH fixture for the operator-designated test tenant (#411 live journey).
//
// The held-first-touch drain (#411) can only be checked on staging through the real UI if the test account has one lead
// autopilot may draft to, and no no-spend route creates one (a scan needs an AI key, CSV import starts paid research).
// This creates exactly that ONE lead and nothing else: no draft, no approval, no autopilot setting, no hold, no send.
// Everything after it runs through the real code paths: the user confirms the lead from "Needs your review" (the real
// confirm route), turns autopilot on in the real panel, and the real createDraft, hold, scheduler tick and send gates do
// the rest.
//
// Same gate as the other test fixtures: OUTREACH_TEST_TENANT_ID plus the allowlisted test inbox; every other account
// gets FixtureError('test_tenant_only'). The contact is the allowlisted own test inbox, so the only address any later
// draft or send can reach is the owner's own inbox (recipientAllowed already restricts the test tenant to it).
//
// Every row is visibly test-only: the company, play, signal, excerpt and source URL say so. The lead is held in review
// (quote_unconfirmed) until the user confirms it, so it is never drafted, by hand or by autopilot, before a person has
// looked at it. Idempotent: one fixture lead per tenant. DELETE removes the rows this fixture created plus the outreach
// rows the real paths later attached to its lead, and refuses while a send to it is in flight or uncertain or was sent
// within the last 24 h (see deleteFirstTouchFixture).

export const FIRST_TOUCH_FIXTURE_JOB = 'dazl first-touch fixture (test only)'
export const FIRST_TOUCH_FIXTURE_COMPANY = 'dazl first-touch fixture company (test only)'
export const FIRST_TOUCH_FIXTURE_SRC = 'https://dazl.ai/test-only-first-touch-fixture'
export const FIRST_TOUCH_FIXTURE_SIGNAL = 'Test-only fixture for checking held first touches and the autopilot scheduler on the test account. Not a real company or person. dazl did not find, scrape or verify anything and claims no evidence.'
export const FIRST_TOUCH_FIXTURE_EXCERPT = 'Test-only fixture text (not a real quote from any page).'

export interface FirstTouchFixture { jobId: string; leadId: string; created: boolean }

function fixtureLead(db: Database.Database, tenantId: string): { jobId: string; leadId: string } | null {
  const r = db.prepare(`SELECT j.id AS job_id, l.id AS lead_id FROM scan_jobs j JOIN leads l ON l.scan_job_id = j.id
    WHERE j.user_id = ? AND j.business_name = ? AND j.industry = 'test only' AND j.location = 'test only'
      AND l.company = ? AND l.source_kind = 'test' ORDER BY j.created_at, j.id LIMIT 1`)
    .get(tenantId, FIRST_TOUCH_FIXTURE_JOB, FIRST_TOUCH_FIXTURE_COMPANY) as { job_id: string; lead_id: string } | undefined
  return r ? { jobId: r.job_id, leadId: r.lead_id } : null
}

export function firstTouchFixtureExists(db: Database.Database, tenantId: string): boolean {
  return !!fixtureLead(db, tenantId)
}

export function createFirstTouchFixture(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): FirstTouchFixture {
  if (typeof tenantId !== 'string' || !tenantId || !fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  return db.transaction((): FirstTouchFixture => {
    const existing = fixtureLead(db, tenantId)
    if (existing) return { ...existing, created: false }
    const jobId = randomBytes(12).toString('hex')
    const leadId = randomBytes(12).toString('hex')
    // A finished play with no run budget and not trial-funded (autopilot's candidate rule, newLeadsSql), no request text
    // or saved window (so no time-window or sales-hiring hold applies), and no offer of its own: the draft uses the
    // tenant's own offer exactly as for any real play.
    db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, status) VALUES (?, ?, ?, 'test only', 'test only', 'running')").run(jobId, tenantId, FIRST_TOUCH_FIXTURE_JOB)
    db.prepare(`INSERT INTO leads (id, scan_job_id, name, company, contact, signal, source_url, evidence_excerpt, confidence, score, fit, intent, action, review_reason, source_kind, created_at)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, 90, 90, 4, 3, 3, 'quote_unconfirmed', 'test', ?)`)
      .run(leadId, jobId, FIRST_TOUCH_FIXTURE_COMPANY, TEST_INBOX, FIRST_TOUCH_FIXTURE_SIGNAL, FIRST_TOUCH_FIXTURE_SRC, FIRST_TOUCH_FIXTURE_EXCERPT, now)
    db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = ? AND status = 'running'").run(jobId)
    return { jobId, leadId, created: true }
  }).immediate()
}

// Removes the fixture play and lead, and the outreach rows the real paths attached to that lead (draft, held work,
// sequence and its steps, follow-up thread with its messages and re-opens). The autopilot audit is kept, but it covers
// only part of the limits: the account-wide rolling cap (accountSendCount, send-budget.ts) reads the delivery rows over
// 24 h, and the one-email-per-company-per-7-days rule in autopilot's run, drain and drain authority
// (domainSentRecently, drainAuthorize) reads outreach_messages.claimed_at over 7 days. So cleanup refuses (FixtureError
// 'recent_send') while a first touch to the fixture lead was sent with claimed_at inside 7 days, or any message to it
// (first touch, sequence step, follow-up, re-open) is still inside the 24 h window: it never hands a send slot back
// early. It also refuses (FixtureError 'send_in_flight') while any message to the fixture lead is being sent or its
// outcome is uncertain (a re-open's in-flight claim is 'approved'), so a cleanup never erases the row that pauses the
// tenant's sends (anyUncertainSend) until the user resolves it. Every check and delete runs in one immediate transaction.
export function deleteFirstTouchFixture(db: Database.Database, tenantId: string, now = Math.floor(Date.now() / 1000)): { deleted: boolean } {
  if (typeof tenantId !== 'string' || !tenantId || !fixtureAvailable(db, tenantId)) throw new FixtureError('test_tenant_only')
  return db.transaction((): { deleted: boolean } => {
    const ids = fixtureLead(db, tenantId)
    if (!ids) return { deleted: false }
    const has = (t: string) => tableExists(db, t)
    const seq = has('sequence_steps') && has('sequences'), fup = has('followup_messages') && has('followup_threads')
    const SEQ_OF_LEAD = 'sequence_id IN (SELECT id FROM sequences WHERE tenant_id = ? AND lead_id = ?)'
    const THREAD_OF_LEAD = 'thread_id IN (SELECT thread_id FROM followup_threads WHERE tenant_id = ? AND lead_id = ?)'
    const rop = has('reopen_messages')
    const any = (sql: string, ...args: unknown[]) => !!db.prepare(sql).get(...args)
    const inFlight = (has('outreach_messages') && any("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND lead_id = ? AND status IN ('sending','uncertain')", tenantId, ids.leadId))
      || (seq && any(`SELECT 1 FROM sequence_steps WHERE tenant_id = ? AND status IN ('sending','uncertain') AND ${SEQ_OF_LEAD}`, tenantId, tenantId, ids.leadId))
      || (fup && any(`SELECT 1 FROM followup_messages WHERE tenant_id = ? AND status IN ('sending','uncertain') AND ${THREAD_OF_LEAD}`, tenantId, tenantId, ids.leadId))
      // A re-open has no 'uncertain' state: 'approved' is its in-flight claim (reopen.ts), and anyUncertainSend stops
      // the tenant on it. Deleting its thread would hide it from listReopens (inner join) while sends stay paused.
      || (rop && any("SELECT 1 FROM reopen_messages WHERE tenant_id = ? AND lead_id = ? AND status = 'approved'", tenantId, ids.leadId))
    if (inFlight) throw new FixtureError('send_in_flight')
    // The same time columns accountSendCount (24 h) and the 7-day domain rule read, so no row they still count is removed.
    const since = now - 86400
    const recent = (has('outreach_messages') && any("SELECT 1 FROM outreach_messages WHERE tenant_id = ? AND lead_id = ? AND status = 'sent' AND (COALESCE(claimed_at,sent_at,created_at) >= ? OR claimed_at >= ?)", tenantId, ids.leadId, since, now - 7 * 86400))
      || (seq && any(`SELECT 1 FROM sequence_steps WHERE tenant_id = ? AND status = 'sent' AND COALESCE(claimed_at,sent_at,created_at) >= ? AND ${SEQ_OF_LEAD}`, tenantId, since, tenantId, ids.leadId))
      || (fup && any(`SELECT 1 FROM followup_messages WHERE tenant_id = ? AND status = 'sent' AND created_at >= ? AND ${THREAD_OF_LEAD}`, tenantId, since, tenantId, ids.leadId))
      || (rop && any("SELECT 1 FROM reopen_messages WHERE tenant_id = ? AND lead_id = ? AND status = 'sent' AND COALESCE(sent_at,created_at) >= ?", tenantId, ids.leadId, since))
    if (recent) throw new FixtureError('recent_send')
    if (has('autopilot_work')) db.prepare('DELETE FROM autopilot_work WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (seq) db.prepare(`DELETE FROM sequence_steps WHERE tenant_id = ? AND ${SEQ_OF_LEAD}`).run(tenantId, tenantId, ids.leadId)
    if (has('sequences')) db.prepare('DELETE FROM sequences WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (fup) db.prepare(`DELETE FROM followup_messages WHERE tenant_id = ? AND ${THREAD_OF_LEAD}`).run(tenantId, tenantId, ids.leadId)
    if (rop) db.prepare('DELETE FROM reopen_messages WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (has('followup_threads')) db.prepare('DELETE FROM followup_threads WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (has('outreach_messages')) db.prepare('DELETE FROM outreach_messages WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (has('lead_enrichments')) db.prepare('DELETE FROM lead_enrichments WHERE tenant_id = ? AND lead_id = ?').run(tenantId, ids.leadId)
    if (has('lead_sources')) db.prepare('DELETE FROM lead_sources WHERE lead_id = ?').run(ids.leadId)
    db.prepare('DELETE FROM leads WHERE id = ? AND scan_job_id = ?').run(ids.leadId, ids.jobId)
    db.prepare('DELETE FROM scan_jobs WHERE id = ? AND user_id = ?').run(ids.jobId, tenantId)
    return { deleted: true }
  }).immediate()
}
