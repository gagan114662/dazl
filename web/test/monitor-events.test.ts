// #387: continuous event detection on the monitor scheduler. Synthetic leads only, both engines, no network: each run
// goes through the real path (createMonitor -> runDueMonitors -> the job's leads -> collectMonitorResults).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { bothEngines } from './helpers/engines.ts'
import { createMonitor, runDueMonitors, collectMonitorResults, listMonitors, monitorWindowDays } from '../lib/monitors.ts'
import { decide, detectionReport, entityKeyOf, eventKeyOf, missedRuns, uncoveredDays, DEFAULT_EVENT_WINDOW_DAYS, type AlertPolicy, type RunLead } from '../lib/monitor-events.ts'
import type { Db } from '../lib/db/client.ts'

const NOW = Math.floor(Date.parse('2026-10-30T12:00:00Z') / 1000), DAY = 86400
const hex = () => randomBytes(12).toString('hex')
// proof: how the scan established the event day (leads.event_date_proof). Default 'page_bound', what the scanner writes for a day the
// cited page ties to the event. date_status is stored the way the scanner stores it today ('unverified' with a day, else 'undated');
// legacyStatus overrides it for rows written before 2026-10-23.
interface L { company?: string; domain?: string | null; date?: string | null; proof?: string | null; legacyStatus?: string; signal?: string; kind?: string | null; url?: string; review?: string | null; conf?: number | null; quarantined?: boolean; reachable?: boolean; held?: boolean }

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
    await db.run(`INSERT INTO leads (id, scan_job_id, name, company, signal, source_url, event_date, date_status, event_date_proof, confidence, review_reason, company_domain, signal_kind, quarantined_at, dedup_key)
      VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, job, l.company ?? 'Harbor Dental', l.signal ?? 'opened a second location', l.url ?? 'https://news.example/harbor-opens', date, l.legacyStatus ?? (date ? 'unverified' : 'undated'), l.proof === undefined ? 'page_bound' : l.proof,
        l.conf === undefined ? 80 : l.conf, l.review ?? null, l.domain === undefined ? 'harbordental.example' : l.domain, l.kind === undefined ? 'expansion' : l.kind, l.quarantined ? at : null, id])
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

// The 16 leads of a real staging scan, as stored (job 13808d9c..., demo workspace, 2026-11-13, request "B2B software companies hiring
// account executives"; read through the read-only ops door): company, company_domain, signal, signal_kind, event_date, date_status,
// event_date_proof, confidence, review_reason, the scan:actionable verdict, source_url. No row has date_status 'verified'.
type RealRow = [string, string | null, string, string | null, string | null, string, string | null, number | null, string | null, string | null, string]
const REAL_SCAN: RealRow[] = [
  ["Zendesk", null, "Zendesk is hiring a Senior Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://zendesk.wd1.myworkdayjobs.com/en-US/zendesk/job/Senior-Enterprise-Account-Executive_R35179"],
  ["Salesforce", null, "Salesforce is hiring an Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://www.salesforce.com/company/careers/jobs/jr332958/enterprise-account-executive-tech-media/"],
  ["Luware US Inc.", null, "Luware US Inc. is hiring an Account Executive for IT/SaaS B2B", null, null, "undated", null, null, "quote_unconfirmed", null, "https://www.builtinnyc.com/job/account-executive-100-saas-b2b-new-york-city/10996508"],
  ["Cisco", null, "Cisco is hiring an Account Executive for Splunk", null, null, "undated", null, null, "quote_unconfirmed", null, "https://careers.cisco.com/global/en/job/CISCISGLOBAL2027734EXTERNALENGLOBAL/Account-Executive-Splunk"],
  ["Alteryx", null, "Alteryx is hiring an Enterprise Account Executive", null, null, "undated", null, null, "needs_javascript", null, "https://alteryx.wd108.myworkdayjobs.com/alteryxcareers/job/massachusetts-usa---remote/enterprise-account-executive_r12452"],
  ["Wash-Dry-Fold POS", null, "Wash-Dry-Fold POS is hiring an Account Executive for SaaS B2B", null, null, "undated", null, null, "quote_unconfirmed", null, "https://dynamitejobs.com/company/washdryfold/remote-job/account-executive-saas-b2b"],
  ["Deel", null, "Deel is hiring an Account Executive for Expansion", null, null, "undated", null, null, "needs_javascript", null, "https://jobs.deel.com/deel/job-details/56c0a201-45b4-41c5-9b0c-9f8d7ec37144/overview"],
  ["ServiceNow", null, "ServiceNow is hiring a Senior CRM Account Executive", null, null, "undated", null, null, "quote_unconfirmed", null, "https://careers.servicenow.com/jobs/744000161318480/sr-crm-account-executive-financial-services/"],
  ["Flexport", "flexport.com", "Flexport is hiring an Account Executive for Enterprise", null, "2026-11-12", "unverified", "ats_structured", 60, null, "Not actionable yet: fit below threshold", "https://job-boards.greenhouse.io/flexport/jobs/8383190"],
  ["Zapier", null, "Hiring a Sales Assist Representative", null, "2026-06-08", "unverified", "ats_structured", null, "quote_unconfirmed", null, "https://jobs.ashbyhq.com/zapier/6adee270-03bf-4b1b-915b-eba5fb56d1b6"],
  ["Qualtrics", "qualtrics.com", "Qualtrics is hiring enterprise account executives", null, null, "undated", null, 60, null, "Not actionable yet: fit below threshold", "https://builtin.com/articles/companies-hiring-enterprise-account-executives"],
  ["PagerDuty", null, "PagerDuty is hiring enterprise account executives", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://builtin.com/articles/companies-hiring-enterprise-account-executives"],
  ["Atlassian", null, "Atlassian is hiring an Account Executive Manager for SMB+", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://builtin.com/job/account-executive-manager-smb/12211862"],
  ["Geniebelt", null, "Geniebelt is hiring an Account Executive for B2B SaaS in the Nordics", null, null, "undated", null, null, "no_sales_hiring_evidence", null, "https://thehub.io/jobs/6aacf42ef7b0b835b0a08c07"],
  ["Kong", null, "Kong is hiring an Enterprise Account Executive", null, "2026-11-12", "undated", null, null, "no_sales_hiring_evidence", null, "https://www.indexventures.com/startup-jobs/kong/enterprise-account-executive-austin/"],
  ["Dynatrace", "dynatrace.com", "Dynatrace is hiring an Enterprise Acquisition Account Executive", null, "2026-09-17", "undated", null, null, "no_sales_hiring_evidence", null, "https://www.dynatrace.com/careers/jobs/1409624000/"],
]
bothEngines('#882 real staging scan: its one ready, board-dated hiring lead (Flexport) alerts once; the ready undated lead and the 14 review-lane leads never do', async ({ db }) => {
  const mon = await play(db, 'u1', { query: 'B2B software companies hiring account executives' })
  const at = Math.floor(Date.parse('2026-11-13T09:27:42Z') / 1000) // the real scan's start (scan_jobs.created_at 1794562062)
  const fold = async (runAt: number) => {
    await db.run('UPDATE monitors SET next_run_at = ? WHERE id = ?', [runAt, mon])
    const [job] = await runDueMonitors(db, { now: runAt })
    await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [job])
    for (const [company, domain, signal, kind, date, status, proof, conf, review, actionability, url] of REAL_SCAN) {
      const id = hex()
      await db.run(`INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, signal_kind, source_url, event_date, date_status, event_date_proof, confidence, review_reason, dedup_key)
        VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, job, company, domain, signal, kind, url, date, status, proof, conf, review, id])
      if (actionability) await db.run('INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, source_url, source_date, retrieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [hex(), id, 'u1', 'scan:actionable', 'actionability', actionability, 'https://invalid.example/', '2026-11-13', runAt])
    }
    await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_finished_at = ? WHERE id = ?", [runAt + 78, runAt + 176, job])
    await collectMonitorResults(db, { now: runAt + 300 })
    const r = (await db.get<{ id: string; new_count: number }>('SELECT id, new_count FROM monitor_runs WHERE job_id = ?', [job]))!
    return { newCount: Number(r.new_count), alerts: await db.all<{ kind: string; company: string; event_key: string; latency_s: number }>('SELECT kind, company, event_key, latency_s FROM monitor_alerts WHERE run_id = ?', [r.id]) }
  }
  const first = await fold(at)
  const day = Date.parse('2026-11-12T00:00:00Z') / 1000
  assert.equal(first.newCount, 1)
  assert.deepEqual(first.alerts.map(a => [a.kind, a.company, a.event_key, Number(a.latency_s)]), [['new_company', 'Flexport', 'd:flexport.com|2026-11-12|signal', at + 300 - day]])
  // only Flexport became an event: Zapier's board-dated posting is in review (and from June), Qualtrics is ready but has no proven day,
  // Kong and Dynatrace carry a day the scan could not prove
  const events = await db.all<{ event_key: string; occurred_at: number; first_seen_at: number; last_checked_at: number; actionable_at: number | null; reachable_at: number | null }>("SELECT event_key, occurred_at, first_seen_at, last_checked_at, actionable_at, reachable_at FROM monitor_events WHERE user_id = 'u1'")
  assert.deepEqual(events.map(e => [e.event_key, Number(e.occurred_at), Number(e.first_seen_at), Number(e.last_checked_at), Number(e.actionable_at), e.reachable_at]), [['d:flexport.com|2026-11-12|signal', day, at + 300, at + 300, at + 300, null]])
  assert.deepEqual((await db.all<{ source: string; last_event_at: number }>('SELECT source, last_event_at FROM monitor_cursors WHERE monitor_id = ?', [mon])).map(c => [c.source, Number(c.last_event_at)]), [['job-boards.greenhouse.io', day]])
  // the next run returns the same 16 leads: nothing new, the event is only re-checked
  const second = await fold(at + 7 * DAY)
  assert.deepEqual([second.newCount, second.alerts.length], [0, 0])
  const again = (await db.get<{ first_seen_at: number; last_checked_at: number }>("SELECT first_seen_at, last_checked_at FROM monitor_events WHERE user_id = 'u1'"))!
  assert.deepEqual([Number(again.first_seen_at), Number(again.last_checked_at)], [at + 300, at + 7 * DAY + 300])
})

bothEngines('#882 a row from before 2026-10-23 with date_status verified and no proof never alerts; a board day dates a hiring trigger only', async ({ db }) => {
  const mon = await play(db, 'u1')
  assert.deepEqual(await run(db, 'u1', mon, NOW, [
    { company: 'Legacy Dental', domain: 'legacy.example', legacyStatus: 'verified', proof: null },                    // the old nearby-year verdict: no proof
    { company: 'Board Dental', domain: 'board.example', proof: 'ats_structured' },                                    // a posting day on an expansion signal
  ]), { newCount: 0, kinds: [] })
  assert.equal(Number((await db.get<{ n: number }>('SELECT count(*) AS n FROM monitor_events'))!.n), 0)
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
  await db.run("UPDATE monitors SET enabled = 1, paused_reason = NULL WHERE id = ?", [made.id])
  assert.equal((await runDueMonitors(db, { now: NOW + 1200 })).length, 1)
})

test('pure rules: keys are spelling-independent; undated, out-of-window and unverified leads never alert', () => {
  const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: '2026-10-20', event_date_proof: 'page_bound', signal: 'opened a second location', signal_kind: 'expansion', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, held: false, reachable: false }
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
  const l: RunLead = { company: 'Harbor Dental', company_domain: null, event_date: null, event_date_proof: 'page_bound', signal: 'opened a second location', signal_kind: 'expansion', source_url: 'https://a.example/x', review_reason: null, confidence: 80, quarantined_at: null, held: false, reachable: false }
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
