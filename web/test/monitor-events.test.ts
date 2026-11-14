// #387: continuous event detection on the monitor scheduler. Synthetic leads only, both engines, no network: each run
// goes through the real path (createMonitor -> runDueMonitors -> the job's leads -> collectMonitorResults).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { createMonitor, runDueMonitors, collectMonitorResults, listMonitors, monitorWindowDays, setMonitorEnabled } from '../lib/monitors.ts'
import { decide, detectionReport, entityKeyOf, eventKeyOf, missedRuns, uncoveredDays, DEFAULT_EVENT_WINDOW_DAYS, OTHER_EVENT_KINDS, HIRING_SIGNALS, AMBIENT_SIGNALS, type AlertPolicy, type RunLead } from '../lib/monitor-events.ts'
import { SIGNALS } from '../lib/scan/score.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000), DAY = 86400
const hex = () => randomBytes(12).toString('hex')
// proof: how the scan established the event day (leads.event_date_proof). Default 'page_bound', what the scanner writes for a day the
// cited page ties to the event. date_status is stored the way the scanner stores it today ('unverified' with a day, else 'undated');
// legacyStatus overrides it for rows written before 2026-10-23.
interface L { signals?: string[]; company?: string; domain?: string | null; date?: string | null; proof?: string | null; legacyStatus?: string; signal?: string; fit?: number | null; kind?: string | null; url?: string; review?: string | null; conf?: number | null; quarantined?: boolean; reachable?: boolean; held?: boolean }

async function play(db: Db, user: string, o: { query?: string; policy?: AlertPolicy } = {}): Promise<string> {
  // a monitor run is a scan on the account's own AI key (#759): every play here belongs to an account that has one
  await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '0000', ?) ON CONFLICT (tenant_id, vendor) DO NOTHING", [user, NOW])
  const r = await createMonitor(db, user, { query: o.query ?? 'dental practices opening a new location', alertPolicy: o.policy }, NOW)
  assert.ok('id' in r)
  return r.id
}

// One scheduled run of `mon` at `at` that returns `leads`; returns the run's new_count and the alerts it wrote.
async function run(db: Db, user: string, mon: string, at: number, leads: L[]) {
  await db.run('UPDATE monitors SET next_run_at = CASE WHEN id = ? THEN ? ELSE 9999999999 END', [mon, at])
  const jobs = await runDueMonitors(db, { now: at })
  assert.equal(jobs.length, 1)
  const job = jobs[0]
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  for (const l of leads) {
    const id = hex()
    const date = l.date === undefined ? '2026-10-20' : l.date
    await db.run(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, event_date_proof, confidence, review_reason, company_domain, signal_kind, quarantined_at, dedup_key, fit, signals)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, job, l.company ?? 'Harbor Dental', l.signal ?? 'opened a second location', l.url ?? 'https://news.example/harbor-opens', date, l.legacyStatus ?? (date ? 'unverified' : 'undated'), l.proof === undefined ? 'page_bound' : l.proof,
        l.conf === undefined ? 80 : l.conf, l.review ?? null, l.domain === undefined ? 'harbordental.example' : l.domain, l.kind === undefined ? 'expansion' : l.kind, l.quarantined ? at : null, id, l.fit ?? null, l.signals ? JSON.stringify(l.signals) : null])
    const enr = (connector: string, kind: string, value: string) => db.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [hex(), id, user, connector, kind, value, 'https://invalid.example/', '2026-10-30', at])
    if (l.reachable) await enr('scan:actionable', 'actionability', 'Actionable: domain, person and published contact confirmed')
    else if (!l.held) await enr('scan:actionable', 'actionability', 'Not actionable yet: no published contact')
    if (l.held) await enr('scan:gate', 'gate_failed', 'sales_hiring_check_failed')
  }
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, job])
  await collectMonitorResults(db, { now: at + 3600 })
  const r = (await db.get<{ id: string; new_count: number }>('SELECT id, new_count FROM monitor_runs WHERE job_id = ?', [job]))!
  const alerts = await db.all<{ kind: string; company: string }>('SELECT kind, company FROM monitor_alerts WHERE run_id = ? ORDER BY company, kind', [r.id])
  return { newCount: Number(r.new_count), kinds: alerts.map(a => a.kind) }
}

bothEngines('same company with a genuinely new event is surfaced once; repeated old news is suppressed', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  // the same event re-found next week, by another outlet, under another spelling of the company: not new
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ company: 'HARBOR DENTAL, Inc.', url: 'https://other.example/harbor' }]), { newCount: 0, kinds: [] })
  // a genuinely new, later event for the same company is surfaced once as a new signal
  const hire: L = { url: 'https://news.example/harbor-hires', date: '2026-11-02', kind: 'hiring' }
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [hire]), { newCount: 1, kinds: ['new_signal'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [hire, {}]), { newCount: 0, kinds: [] })
  // old news (outside the window) and future-dated events are never stored or alerted
  assert.deepEqual(await run(db, 'u1', mon, NOW + 28 * DAY, [{ company: 'Old Dental', domain: 'old.example', date: '2025-01-05' }, { company: 'Future Dental', domain: 'future.example', date: '2027-03-01' }]), { newCount: 0, kinds: [] })
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_events WHERE entity_key IN ('d:old.example', 'd:future.example')"))!.n), 0)
  const ev = await db.get<{ first_seen_at: number; last_checked_at: number; occurred_at: number }>("SELECT first_seen_at, last_checked_at, occurred_at FROM monitor_events WHERE user_id = 'u1' AND event_key LIKE '%|2026-10-20|%'")
  assert.deepEqual([Number(ev!.first_seen_at), Number(ev!.last_checked_at), Number(ev!.occurred_at)], [NOW + 3600, NOW + 21 * DAY + 3600, Date.parse('2026-10-20T00:00:00Z') / 1000], 'first seen / last checked are when the run was folded; occurred is the event day')
})

bothEngines('a blocked research item does not inflate new actionable leads; undated and unverified dates never surface', async ({ db }) => {
  const mon = await play(db, 'u1')
  const r = await run(db, 'u1', mon, NOW, [
    { review: 'blocked_by_site', conf: null },                                         // blocked research item
    { company: 'Quarantine Dental', domain: 'q.example', quarantined: true },
    { company: 'Held Dental', domain: 'held.example', held: true },                   // required gate failed, review write lost
    { company: 'Undated Dental', domain: 'undated.example', date: null, proof: null },
    { company: 'Guess Dental', domain: 'guess.example', proof: null },                 // a day the cited page does not tie to the event
  ])
  assert.deepEqual(r, { newCount: 0, kinds: [] })
  // the same event once the pipeline verified it: surfaced, once
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [{}, { review: 'blocked_by_site', conf: null, company: 'Other', domain: 'other.example' }]), { newCount: 0, kinds: [] })
  // a company seen only as research (quarantined above) is still a NEW company when its first actionable event arrives
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [{ company: 'Quarantine Dental', domain: 'q.example', url: 'https://news.example/q2', date: '2026-11-05', kind: 'hiring' }]), { newCount: 1, kinds: ['new_company'] })
})

bothEngines('a newly verified contact triggers a state-change alert, once', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ reachable: true }]), { newCount: 1, kinds: ['now_reachable'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 14 * DAY, [{ reachable: true }]), { newCount: 0, kinds: [] })
  // reachable at first sight: one new_company alert, no later now_reachable for the same event
  assert.deepEqual(await run(db, 'u1', mon, NOW + 21 * DAY, [{ company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', mon, NOW + 28 * DAY, [{ company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 0, kinds: [] })
})

bothEngines('alert policy: only the selected kinds alert; state is still tracked', async ({ db }) => {
  const mon = await play(db, 'u1', { policy: 'reachable' })
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{}, { company: 'Cedar Vet', domain: 'cedar.example', reachable: true }]), { newCount: 1, kinds: ['new_company'] })
  assert.equal((await db.get<{ company: string }>('SELECT company FROM monitor_alerts'))!.company, 'Cedar Vet')
  // the unreachable one was recorded (not re-alerted as new later) and alerts when its contact is confirmed
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ reachable: true }]), { newCount: 1, kinds: ['now_reachable'] })
  const only = await play(db, 'u2', { policy: 'new_companies' })
  assert.deepEqual(await run(db, 'u2', only, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u2', only, NOW + 7 * DAY, [{ reachable: true }, { url: 'https://news.example/h2', date: '2026-11-02', kind: 'hiring' }]), { newCount: 0, kinds: [] })
  assert.equal((await listMonitors(db, 'u2'))[0].alert_policy, 'new_companies')
})

bothEngines('deduped across plays, isolated across tenants', async ({ db }) => {
  const a = await play(db, 'u1'), b = await play(db, 'u1', { query: 'clinics expanding in Bristol' })
  assert.deepEqual(await run(db, 'u1', a, NOW, [{}]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u1', b, NOW + DAY, [{}]), { newCount: 0, kinds: [] }, 'another play does not alert the same event again')
  const other = await play(db, 'u2')
  assert.deepEqual(await run(db, 'u2', other, NOW + DAY, [{}]), { newCount: 1, kinds: ['new_company'] }, 'another tenant has its own state')
})

bothEngines("the play's own window rules what is old news", async ({ db }) => {
  const mon = await play(db, 'u1', { query: 'dental practices that opened a location in the past 30 days' })
  assert.equal(monitorWindowDays({ query: 'dental practices that opened a location in the past 30 days', icp: null }), 30)
  // 40 days before the run: inside the 90-day default, outside this play's 30 days
  assert.deepEqual(await run(db, 'u1', mon, NOW, [{ date: '2026-09-20' }, { company: 'Fresh Dental', domain: 'fresh.example', date: '2026-10-25' }]), { newCount: 1, kinds: ['new_company'] })
})

bothEngines('missed runs: one catch-up scan, never one per missed slot; latency, recovery and cursors are reported', async ({ db }) => {
  const mon = await play(db, 'u1')
  await run(db, 'u1', mon, NOW, [{}])
  // the tick did not run for three weekly slots: the late run is ONE scan (no extra paid calls) that records the gap
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW + 7 * DAY, mon])
  const before = Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs'))!.n)
  const jobs = await runDueMonitors(db, { now: NOW + 28 * DAY })
  assert.equal(jobs.length, 1)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM scan_jobs'))!.n), before + 1)
  assert.deepEqual(await runDueMonitors(db, { now: NOW + 28 * DAY }), [], 'nothing else is due until the next interval')
  assert.equal(Number((await db.get<{ m: number }>('SELECT missed_runs AS m FROM monitor_runs WHERE job_id = ?', [jobs[0]]))!.m), 3)
  const rep = await detectionReport(db, 'u1', mon, monitorWindowDays({ query: 'dental practices opening a new location', icp: null }))
  assert.deepEqual(rep.by_kind, { new_company: 1, new_signal: 0, now_reachable: 0 })
  assert.equal(rep.latency.median_s, NOW + 3600 - Date.parse('2026-10-20T00:00:00Z') / 1000, 'event day -> alert')
  assert.deepEqual(rep.last_run && [rep.last_run.missed_runs, rep.last_run.uncovered_days], [3, 0], '28 days late is still inside the 90-day window')
  assert.deepEqual(rep.sources, [{ source: 'news.example', last_event_at: Date.parse('2026-10-20T00:00:00Z') / 1000, last_checked_at: NOW + 3600 }])
  assert.deepEqual((await detectionReport(db, 'u2', mon, 90)).sources, [], "another tenant reads nothing of this monitor")
})

bothEngines('a run is folded only after its enrichment settles, so a contact confirmed by the scan is reachable at first sight', async ({ db }) => {
  const mon = await play(db, 'u1')
  await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [NOW, mon])
  const [job] = await runDueMonitors(db, { now: NOW })
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
  await db.run("INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, event_date_proof, confidence, company_domain) VALUES (?, ?, '', 'Harbor Dental', 's', 'https://news.example/a', '2026-10-20', 'unverified', 'page_bound', 80, 'harbordental.example')", [hex(), job])
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_started_at = ? WHERE id = ?", [NOW, NOW, job])
  assert.equal(await collectMonitorResults(db, { now: NOW + 60 }), 0)
  assert.equal(Number((await db.get<{ p: number }>('SELECT processed AS p FROM monitor_runs WHERE job_id = ?', [job]))!.p), 0, 'still enriching: not folded yet')
  await db.run('UPDATE scan_jobs SET enrich_finished_at = ? WHERE id = ?', [NOW + 120, job])
  assert.equal(await collectMonitorResults(db, { now: NOW + 180 }), 1)
})

// The 16 leads of a real staging scan, as stored (demo workspace, 2026-11-13, request "B2B software companies hiring
// account executives"; read through the read-only ops door): company, company_domain, signal, signal_kind, event_date, date_status,
// event_date_proof, confidence, review_reason, the scan:actionable verdict, source_url, fit. No row has date_status 'verified'.
// The one ready lead with a board-proven day (Flexport) was graded fit 0 by that scan: the Leads list hides it by default.
type RealRow = [string, string | null, string, string | null, string | null, string, string | null, number | null, string | null, string | null, string, number | null]
const REAL_SCAN: RealRow[] = [
  ["Zendesk", null, "Zendesk is hiring a Senior Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://zendesk.wd1.myworkdayjobs.com/en-US/zendesk/job/Senior-Enterprise-Account-Executive_R35179", null],
  ["Salesforce", null, "Salesforce is hiring an Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://www.salesforce.com/company/careers/jobs/jr332958/enterprise-account-executive-tech-media/", null],
  ["Luware US Inc.", null, "Luware US Inc. is hiring an Account Executive for IT/SaaS B2B", null, null, "undated", null, null, "quote_unconfirmed", null, "https://www.builtinnyc.com/job/account-executive-100-saas-b2b-new-york-city/10996508", null],
  ["Cisco", null, "Cisco is hiring an Account Executive for Splunk", null, null, "undated", null, null, "quote_unconfirmed", null, "https://careers.cisco.com/global/en/job/CISCISGLOBAL2027734EXTERNALENGLOBAL/Account-Executive-Splunk", null],
  ["Alteryx", null, "Alteryx is hiring an Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://alteryx.wd108.myworkdayjobs.com/alteryxcareers/job/massachusetts-usa---remote/enterprise-account-executive_r12452", null],
  ["Wash-Dry-Fold POS", null, "Wash-Dry-Fold POS is hiring an Account Executive for SaaS B2B", null, null, "undated", null, null, "quote_unconfirmed", null, "https://dynamitejobs.com/company/washdryfold/remote-job/account-executive-saas-b2b", null],
  ["Deel", null, "Deel is hiring an Account Executive for Expansion", null, null, "undated", null, null, "needs_javascript", null, "https://jobs.deel.com/deel/job-details/56c0a201-45b4-41c5-9b0c-9f8d7ec37144/overview", null],
  ["ServiceNow", null, "ServiceNow is hiring a Senior CRM Account Executive", null, null, "undated", null, null, "quote_unconfirmed", null, "https://careers.servicenow.com/jobs/744000161318480/sr-crm-account-executive-financial-services/", null],
  ["Flexport", "flexport.com", "Flexport is hiring an Account Executive for Enterprise", null, "2026-11-12", "unverified", "ats_structured", 60, null, "Not actionable yet: fit below threshold", "https://job-boards.greenhouse.io/flexport/jobs/8383190", 0],
  ["Zapier", null, "Hiring a Sales Assist Representative", null, "2026-06-08", "unverified", "ats_structured", null, "quote_unconfirmed", null, "https://jobs.ashbyhq.com/zapier/6adee270-03bf-4b1b-915b-eba5fb56d1b6", null],
  ["Qualtrics", "qualtrics.com", "Qualtrics is hiring enterprise account executives", null, null, "undated", null, 60, null, "Not actionable yet: fit below threshold", "https://builtin.com/articles/companies-hiring-enterprise-account-executives", 0],
  ["PagerDuty", null, "PagerDuty is hiring enterprise account executives", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://builtin.com/articles/companies-hiring-enterprise-account-executives", 0],
  ["Atlassian", null, "Atlassian is hiring an Account Executive Manager for SMB+", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://builtin.com/job/account-executive-manager-smb/12211862", 0],
  ["Geniebelt", null, "Geniebelt is hiring an Account Executive for B2B SaaS in the Nordics", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://thehub.io/jobs/6aacf42ef7b0b835b0a08c07", 0],
  ["Kong", null, "Kong is hiring an Enterprise Account Executive", null, "2026-11-12", "undated", null, null, "no_sales_hiring_evidence", null, "https://www.indexventures.com/startup-jobs/kong/enterprise-account-executive-austin/", 0],
  ["Dynatrace", "dynatrace.com", "Dynatrace is hiring an Enterprise Acquisition Account Executive", null, "2026-09-17", "undated", null, null, "no_sales_hiring_evidence", null, "https://www.dynatrace.com/careers/jobs/1409624000/", 0],
]
bothEngines('#882 real staging scan: its board-dated ready lead (Flexport) becomes an event; graded fit 0 it is hidden in Leads and raises no alert; the 15 others never become events', async ({ db }) => {
  const mon = await play(db, 'u1', { query: 'B2B software companies hiring account executives' })
  const at = Math.floor(Date.parse('2026-11-13T09:27:42Z') / 1000) // when the real scan started
  const fold = async (runAt: number, regrade?: number) => {
    await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [runAt, mon])
    const [job] = await runDueMonitors(db, { now: runAt })
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
    for (const [company, domain, signal, kind, date, status, proof, conf, review, actionability, url, fit] of REAL_SCAN) {
      const id = hex()
      await db.run(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, signal_kind, source_url, event_date, date_status, event_date_proof, confidence, review_reason, dedup_key, fit)
        VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, job, company, domain, signal, kind, url, date, status, proof, conf, review, id, regrade !== undefined && company === 'Flexport' ? regrade : fit])
      if (actionability) await db.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [hex(), id, 'u1', 'scan:actionable', 'actionability', actionability, 'https://invalid.example/', '2026-11-13', runAt])
    }
    await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_finished_at = ? WHERE id = ?", [runAt + 78, runAt + 176, job])
    await collectMonitorResults(db, { now: runAt + 300 })
    const r = (await db.get<{ id: string; new_count: number }>('SELECT id, new_count FROM monitor_runs WHERE job_id = ?', [job]))!
    return { newCount: Number(r.new_count), alerts: (await db.all<{ kind: string; company: string; event_key: string; latency_s: number }>('SELECT kind, company, event_key, latency_s FROM monitor_alerts WHERE run_id = ?', [r.id])).map(a => [a.kind, a.company, a.event_key, Number(a.latency_s)]) }
  }
  const events = async () => (await db.all<{ event_key: string; occurred_at: number; first_seen_at: number; last_checked_at: number; actionable_at: number | null; reachable_at: number | null }>("SELECT event_key, occurred_at, first_seen_at, last_checked_at, actionable_at, reachable_at FROM monitor_events WHERE user_id = 'u1'"))
    .map(e => [e.event_key, Number(e.occurred_at), Number(e.first_seen_at), Number(e.last_checked_at), e.actionable_at == null ? null : Number(e.actionable_at), e.reachable_at])
  const day = Date.parse('2026-11-12T00:00:00Z') / 1000
  // The rows exactly as the scan stored them. Before the fix nothing here could ever become an event (no row is 'verified').
  // Now Flexport's posting is an event with its three times and a source cursor, but no alert: its own scan graded it fit 0, so the
  // Leads list hides it. Zapier's board-dated posting is in review and from June; Qualtrics is ready but has no proven day (and fit 0);
  // Kong and Dynatrace carry a day the scan could not prove.
  assert.deepEqual(await fold(at), { newCount: 0, alerts: [] })
  assert.deepEqual(await events(), [['d:flexport.com|2026-11-12|hiring', day, at + 300, at + 300, null, null]])
  assert.deepEqual((await db.all<{ source: string; last_event_at: number }>('SELECT source, last_event_at FROM monitor_cursors WHERE monitor_id = ?', [mon])).map(c => [c.source, Number(c.last_event_at)]), [['job-boards.greenhouse.io', day]])
  // the next run returns the same 16 leads: still nothing new, the event is only re-checked
  assert.deepEqual(await fold(at + 7 * DAY), { newCount: 0, alerts: [] })
  assert.deepEqual(await events(), [['d:flexport.com|2026-11-12|hiring', day, at + 300, at + 7 * DAY + 300, null, null]])
  // NOT the real grade from here on: had a run graded that same lead as one the list shows (fit 3), it is a new company, once
  assert.deepEqual(await fold(at + 14 * DAY, 3), { newCount: 1, alerts: [['new_company', 'Flexport', 'd:flexport.com|2026-11-12|hiring', at + 14 * DAY + 300 - day]] })
  assert.deepEqual(await fold(at + 21 * DAY, 3), { newCount: 0, alerts: [] })
  assert.deepEqual(await events(), [['d:flexport.com|2026-11-12|hiring', day, at + 300, at + 21 * DAY + 300, at + 14 * DAY + 300, null]])
})

bothEngines('#882 a lead the Leads list hides (fit 0 or 1) never alerts; a shown one (fit 2+, or ungraded) does; a stored kind naming another event is never dated by a job board day', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [
    { company: 'Zero Dental', domain: 'zero.example', fit: 0 },
    { company: 'One Dental', domain: 'one.example', fit: 1 },
    // hiring wording in the signal, but the stored kind says funding: the posting's day is not the funding round's day
    { company: 'Series Dental', domain: 'series.example', proof: 'ats_structured', kind: 'raised_funding', signals: ['raised_funding', 'press_mention'], signal: 'Series Dental raised a Series B and is hiring 40 hygienists' },
  ]), { newCount: 0, kinds: [] })
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_events WHERE entity_key = 'd:series.example'"))!.n), 0)
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_events WHERE actionable_at IS NULL"))!.n), 2, 'the hidden leads are seen, not actionable')
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [
    { company: 'Two Dental', domain: 'two.example', fit: 2 },
    { company: 'Ungraded Dental', domain: 'ungraded.example', fit: null },
    // a graded hiring lead whose first graded signal is a hiring-type kind other than 'hiring': still dated by the board
    { company: 'Roles Dental', domain: 'roles.example', fit: 3, proof: 'ats_structured', kind: 'open_role_language', signals: ['open_role_language', 'hiring_relevant_role'], signal: 'Roles Dental is hiring a practice manager' },
    // the grader listed an expansion first and the hiring after it: still a hiring posting, dated by the board
    { company: 'Mixed Dental', domain: 'mixed.example', fit: 3, proof: 'ats_structured', kind: 'expansion', signals: ['expansion', 'hiring'], signal: 'Mixed Dental is hiring a hygienist' },
    { company: 'Zero Dental', domain: 'zero.example', fit: 4 },   // graded again, now shown: its first alert
  ]), { newCount: 5, kinds: ['new_company', 'new_company', 'new_company', 'new_company', 'new_company'] })
  assert.equal((await db.get<{ event_key: string }>("SELECT event_key FROM monitor_events WHERE entity_key = 'd:mixed.example'"))!.event_key, 'd:mixed.example|2026-10-20|hiring', 'dated by the board: recorded as the hiring event, not as an expansion on that day')
})

bothEngines('#882 detected once: the same posting returned by five runs under five different grades is one event and one alert; so is a page-proven event stored ungraded then graded', async ({ db }) => {
  const mon = await play(db, 'u1', { query: 'B2B software companies hiring account executives' })
  // The Flexport posting (real company, posting URL, day and signal; fit set to 3 so the list shows it: NOT its real grade), returned by
  // five weekly runs. Only the grader's label changes: none, hiring, hiring_relevant_role, job_board_presence, expansion (+hiring).
  const posting = (kind: string | null, signals?: string[]): L => ({ company: 'Flexport', domain: 'flexport.com', url: 'https://job-boards.greenhouse.io/flexport/jobs/8383190', date: '2026-10-28', proof: 'ats_structured', fit: 3, kind, signals, signal: 'Flexport is hiring an Account Executive for Enterprise' })
  const grades: [string | null, string[] | undefined][] = [[null, undefined], ['hiring', ['hiring']], ['hiring_relevant_role', ['hiring_relevant_role', 'hiring']], ['job_board_presence', ['job_board_presence']], ['expansion', ['expansion', 'hiring']]]
  const out = []
  for (const [i, [kind, signals]] of grades.entries()) out.push(await run(db, 'u1', mon, NOW + i * 7 * DAY, [posting(kind, signals)]))
  assert.deepEqual(out, [{ newCount: 1, kinds: ['new_company'] }, { newCount: 0, kinds: [] }, { newCount: 0, kinds: [] }, { newCount: 0, kinds: [] }, { newCount: 0, kinds: [] }])
  assert.deepEqual((await db.all<{ event_key: string }>("SELECT event_key FROM monitor_events WHERE user_id = 'u1'")).map(e => e.event_key), ['d:flexport.com|2026-10-28|hiring'])
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM monitor_alerts WHERE user_id = 'u1'"))!.n), 1)
  // A day the cited page ties to the event: stored ungraded, then graded expansion, then graded the same again: one event, one alert (one
  // side unlabelled is the same event as a labelled one). A later day is a new event (new_signal); a DIFFERENT labelled kind on the same
  // day is another event, as the tenant's alert record has it (#883).
  const news = (kind: string | null, date = '2026-10-21'): L => ({ company: 'Kestrel Freight', domain: 'kestrel.example', url: 'https://news.example/kestrel', date, proof: 'page_bound', fit: 3, kind, signal: 'Kestrel Freight opened a depot in Leeds' })
  const mon2 = await play(db, 'u2')
  assert.deepEqual(await run(db, 'u2', mon2, NOW, [news(null)]), { newCount: 1, kinds: ['new_company'] })
  assert.deepEqual(await run(db, 'u2', mon2, NOW + 7 * DAY, [news('expansion')]), { newCount: 0, kinds: [] })
  assert.deepEqual(await run(db, 'u2', mon2, NOW + 14 * DAY, [news('expansion'), news(null)]), { newCount: 0, kinds: [] })
  assert.deepEqual(await run(db, 'u2', mon2, NOW + 21 * DAY, [news('expansion', '2026-11-15')]), { newCount: 1, kinds: ['new_signal'] })
  assert.deepEqual((await db.all<{ event_key: string }>("SELECT event_key FROM monitor_events WHERE user_id = 'u2' ORDER BY event_key")).map(e => e.event_key), ['d:kestrel.example|2026-10-21|signal', 'd:kestrel.example|2026-11-15|expansion'])
})

test('#882 every grader signal id is in exactly one of the monitor\'s groups (another dated event / hiring-type / ambient)', () => {
  for (const id of SIGNALS) assert.equal([OTHER_EVENT_KINDS, HIRING_SIGNALS, AMBIENT_SIGNALS].filter(g => g.has(id)).length, 1, id)
  // nothing in the groups that the grader cannot store, except the legacy 'funding' label older rows carry
  assert.deepEqual([...OTHER_EVENT_KINDS, ...HIRING_SIGNALS, ...AMBIENT_SIGNALS].filter(id => !(SIGNALS as readonly string[]).includes(id)), ['funding'])
})

bothEngines('#882 a row from before 2026-10-23 with date_status verified and no proof never alerts; a board day dates a hiring trigger only', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [
    { company: 'Legacy Dental', domain: 'legacy.example', legacyStatus: 'verified', proof: null },                    // the old nearby-year verdict: no proof
    { company: 'Board Dental', domain: 'board.example', proof: 'ats_structured' },                                    // a posting day on an expansion signal
    { company: 'Future Dental', domain: 'future.example', date: '2026-11-20' },                                      // a proven-looking day that has not happened yet
    { company: 'Baddate Dental', domain: 'baddate.example', date: '2026-02-30' },                                    // not a calendar day
  ]), { newCount: 0, kinds: [] })
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitor_events'))!.n), 0)
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitor_cursors'))!.n), 0, 'no cursor moves for a lead that is not an event')
  assert.deepEqual(await run(db, 'u1', mon, NOW + 7 * DAY, [{ company: 'Board Dental', domain: 'board.example', proof: 'ats_structured', kind: 'hiring', signal: 'Board Dental is hiring a hygienist' }]), { newCount: 1, kinds: ['new_company'] })
})

bothEngines('#759 a monitor on an account with no AI key of its own pauses with the reason; no job is queued; with a key it runs again once resumed', async ({ db }) => {
  const made = await createMonitor(db, 'nokey', { query: 'dental practices opening a new location' }, NOW)
  assert.ok('id' in made)
  assert.deepEqual(await runDueMonitors(db, { now: NOW }), [])
  assert.equal(Number((await db.get<{ n: number }>("SELECT count(*) AS n FROM scan_jobs WHERE user_id = 'nokey'"))!.n), 0, 'nothing is left pending')
  const m = (await listMonitors(db, 'nokey') as { enabled: number; paused_reason: string | null }[])[0]
  assert.deepEqual([Number(m.enabled), m.paused_reason], [0, 'no_api_key'])
  assert.deepEqual(await runDueMonitors(db, { now: NOW + 600 }), [], 'a paused monitor stays paused')
  await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES ('nokey', 'anthropic', 'x', '0000', ?)", [NOW])
  // Resume, as the Plays button does it: the reason is cleared and the monitor runs
  assert.equal(await setMonitorEnabled(db, 'nokey', made.id, true), true)
  const resumed = (await listMonitors(db, 'nokey') as { enabled: number; paused_reason: string | null }[])[0]
  assert.deepEqual([Number(resumed.enabled), resumed.paused_reason], [1, null])
  assert.equal((await runDueMonitors(db, { now: NOW + 1200 })).length, 1)
})

test('pure rules: keys are spelling-independent; undated, out-of-window and unverified leads never alert', () => {
  const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: '2026-10-20', event_date_proof: 'page_bound', signal: 'opened a second location', signals: null, signal_kind: 'expansion', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, fit: null, held: false, reachable: false }
  assert.equal(entityKeyOf({ company: 'HARBOR Dental, Inc', company_domain: null }), entityKeyOf({ company: 'harbor dental', company_domain: null }))
  assert.equal(entityKeyOf({ company: 'x', company_domain: 'https://www.Harbor.example/about' }), 'd:harbor.example')
  assert.equal(eventKeyOf(l), eventKeyOf({ ...l, source_url: 'https://b.example/y' }))
  assert.notEqual(eventKeyOf(l), eventKeyOf({ ...l, event_date: '2026-10-21' }))
  const W = DEFAULT_EVENT_WINDOW_DAYS
  assert.deepEqual(decide({ ...l, event_date_proof: null }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date_proof: 'verified' }, null, false, 'all', W, NOW), { suppress: 'undated' }, 'only a recognised proof dates an event')
  // a job board's publish day dates a hiring trigger only
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured' }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: null, signal: 'Flexport is hiring an Account Executive for Enterprise' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'hiring' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'hiring_relevant_role' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  // a stored non-hiring kind wins over hiring wording in the text (the shared rule would let these through)
  for (const kind of ['raised_funding', 'funding', 'product_launch', 'leadership_change', 'partnership', 'layoffs']) assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: kind, signal: 'Acme raised a Series B and is hiring 40 engineers' }, null, false, 'all', W, NOW), { suppress: 'undated' }, kind)
  // the grader's list has no order: another event first and a hiring signal after it is still a hiring posting
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'expansion', signals: '["expansion","hiring_relevant_role"]', signal: 'Acme is hiring an Account Executive' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  // such a lead is recorded as the hiring event its date belongs to, never as the other event on the posting's day
  // the key never carries the graded kind: one posting is one event whatever the grader calls it, and a page-proven event stored ungraded then graded is one event too
  for (const kind of [null, 'hiring', 'hiring_relevant_role', 'job_board_presence', 'open_role_language', 'raised_funding', 'expansion']) assert.equal(eventKeyOf({ ...l, event_date_proof: 'ats_structured', signal_kind: kind }), 'n:harbor dental|2026-10-20|hiring', String(kind))
  // a page-proven day keeps its own labelled kind (#883: two labelled kinds on one day are two events); unlabelled is 'signal'
  for (const kind of [null, 'expansion', 'product_launch']) assert.equal(eventKeyOf({ ...l, event_date_proof: 'page_bound', signal_kind: kind }), `n:harbor dental|2026-10-20|${kind ?? 'signal'}`, String(kind))
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'expansion', signals: '["expansion","press_mention"]', signal: 'Acme is hiring an Account Executive' }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'expansion', signals: 'not json', signal: 'Acme is hiring an Account Executive' }, null, false, 'all', W, NOW), { suppress: 'undated' })
  // ...but a graded hiring lead keeps its board day whatever hiring-type or ambient kind the grader put first (the card's rule decides)
  for (const kind of ['open_role_language', 'growing_team', 'job_board_presence', 'press_mention', 'accelerator']) assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: kind, signal: 'Acme is hiring an Account Executive' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true }, kind)
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'open_role_language', signal: 'Acme opened a second office' }, null, false, 'all', W, NOW), { suppress: 'undated' }, 'no hiring wording and no hiring kind: the card rule already refuses it')
  assert.deepEqual(decide({ ...l, event_date_proof: 'ats_structured', signal_kind: 'expansion', signal: 'Harbor Dental expands its hiring team' }, null, false, 'all', W, NOW), { suppress: 'undated' })
  // the page itself tying the day to the event is not a board day: the kind does not matter
  assert.deepEqual(decide({ ...l, event_date_proof: 'page_bound', signal_kind: 'funding', signal: 'Acme raised a Series B and is hiring 40 engineers' }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  // the Leads list hides the low-fit tier: no alert opens on a hidden lead
  assert.deepEqual(decide({ ...l, fit: 0 }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide({ ...l, fit: 1 }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide({ ...l, fit: 2 }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true })
  assert.deepEqual(decide({ ...l, event_date: null }, null, false, 'all', W, NOW), { suppress: 'undated' })
  assert.deepEqual(decide({ ...l, event_date: '2026-02-30' }, null, false, 'all', W, NOW), { suppress: 'undated' }, 'not a calendar day: no proven day')
  assert.deepEqual(decide({ ...l, event_date: '2026-11-20' }, null, false, 'all', W, NOW), { suppress: 'undated' }, 'a future day is not a proven event day')
  assert.deepEqual(decide({ ...l, event_date: '2026-01-05' }, null, false, 'all', W, NOW), { suppress: 'out_of_window' })
  assert.deepEqual(decide({ ...l, review_reason: 'quote_unconfirmed', confidence: null }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide({ ...l, held: true }, null, false, 'all', W, NOW), { suppress: 'not_actionable' })
  assert.deepEqual(decide(l, null, true, 'all', W, NOW), { kind: 'new_signal', alert: true })
  assert.deepEqual(decide(l, null, true, 'new_companies', W, NOW), { kind: 'new_signal', alert: false })
  assert.deepEqual(decide({ ...l, reachable: true }, { actionable_at: 1, reachable_at: null }, true, 'reachable', W, NOW), { kind: 'now_reachable', alert: true })
  assert.deepEqual(decide(l, { actionable_at: 1, reachable_at: null }, true, 'all', W, NOW), { suppress: 'already_seen' })
})

test('missed-run arithmetic', () => {
  assert.equal(missedRuns(NOW, NOW + 60, 168), 0)
  assert.equal(missedRuns(NOW, NOW + 21 * DAY, 168), 3)
  assert.equal(uncoveredDays(null, NOW, 90), 0)
  assert.equal(uncoveredDays(NOW - 100 * DAY, NOW, 90), 10)
})

test('window boundary: 90 days back is inside, 91 is out_of_window; a play\'s own window beats the default', () => {
  const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: null, event_date_proof: 'page_bound', signal: 'opened a second location', signals: null, signal_kind: 'expansion', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, fit: null, held: false, reachable: false }
  const back = (days: number) => new Date((NOW - days * DAY) * 1000).toISOString().slice(0, 10)
  const W = DEFAULT_EVENT_WINDOW_DAYS
  assert.equal(W, 90)
  assert.deepEqual(decide({ ...l, event_date: back(90) }, null, false, 'all', W, NOW), { kind: 'new_company', alert: true }, 'the cutoff day itself is inside')
  assert.deepEqual(decide({ ...l, event_date: back(91) }, null, false, 'all', W, NOW), { suppress: 'out_of_window' })
  // the play's own window wins over the 90-day default, in both directions
  assert.deepEqual(decide({ ...l, event_date: back(31) }, null, false, 'all', 30, NOW), { suppress: 'out_of_window' }, '30-day play rejects 31 days')
  assert.deepEqual(decide({ ...l, event_date: back(30) }, null, false, 'all', 30, NOW), { kind: 'new_company', alert: true })
  assert.deepEqual(decide({ ...l, event_date: back(120) }, null, false, 'all', 180, NOW), { kind: 'new_company', alert: true }, 'a 180-day play accepts 120 days')
})
