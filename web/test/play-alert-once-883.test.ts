// #883 "alert sent once and deduped across plays". Both engines, no network, no provider, no paid call.
//
// The lead rows are production's (backup of 2026-11-13, read-only): the seven leads one finished play run stored there
// (company, signal, date, fit, review state and score exactly as stored; no account, run or person identifier is kept,
// and the plays' sentences and profile here are made up). With those rows, main's mail for that run lists Ngenaire,
// Campfire and Chesky; the test then lets the account's OTHER play find Campfire and Ngenaire again, which main mails a
// second time as "new leads you have not been shown before". Smile Avenue Dental, Zenithon, OpenRelay and Photon are
// more stored production leads.
// Each run goes through the production steps: createWatch -> a run's job and leads -> the runner's mark (writeWatchLeads,
// the Db-layer twin of markWatchLeads) -> the mail pass (sendPlayRunMails), and for monitors createMonitor ->
// runDueMonitors -> collectMonitorResults. A monitor lead is given date_status 'verified' by hand: no scan writes that
// value today (the open finding on #882), and that detector is not what this test is about.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { bothEngines } from './helpers/engines.ts'
import { sqliteDb } from '../lib/db/client.ts'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { saveKey } from '../lib/llm/key-store.ts'
import type { Provider } from '../lib/llm/provider.ts'
import { resetTinyfishState } from '../lib/search/tinyfish.ts'
import { claimKeyedJob, runJob as runScan } from '../lib/scan/runner.ts'
import { runDueWatches } from '../lib/watch.ts'
import type { Db } from '../lib/db/client.ts'
import { createWatch, listWatches, watchAction, writeWatchLeads } from '../lib/watch.ts'
import { sendPlayRunMails } from '../lib/play-mail.ts'
import { setTransportForTests } from '../lib/system-mail.ts'
import { playRuns } from '../lib/play-runs.ts'
import { playNew } from '../lib/play-now.ts'
import { repeatFirstPlays } from '../lib/play-repeat.ts'
import { collectMonitorResults, createMonitor, runDueMonitors } from '../lib/monitors.ts'

const DAY = 86400
const NOW = Math.floor(Date.parse('2026-11-13T12:00:00Z') / 1000)
let n = 0
const id24 = () => (++n).toString(16).padStart(24, '0')
const A = 'a'.repeat(32), B = 'b'.repeat(32)
// three saved plays of one account and the profile they share (made up; nothing depends on their wording)
const Q_SDR = 'B2B software companies hiring their first sales rep'
const Q_AGENCIES = 'Marketing agencies posting about outbound or lead generation pain'
const Q_LONDON = 'funded startups in London hiring'
const ICP = JSON.stringify({ summary: 'Small B2B sales teams', who: ['Founder', 'Head of Sales'], industries: ['B2B SaaS', 'Marketing agencies'], sizes: ['1-50 employees'], where: ['United States', 'Canada'], signals: ['Hiring their first salesperson', 'posting about outbound pain'], exclude: [] })

interface L { company: string; domain?: string | null; date?: string | null; kind?: string | null; signal: string; url: string; fit: number | null; review?: string | null; score: number; dateStatus?: string; conf?: number | null }
// the seven leads of one production play run (fit <= 1 is the hidden tier: Mercury, Clark, beehiiv, LeanPBX)
const MERCURY: L = { company: 'Mercury', signal: 'Hiring a Sales Development Representative', url: 'https://job-boards.greenhouse.io/mercury/jobs/6167220004', fit: 1, review: 'no_sales_hiring_evidence', score: 49 }
const CLARK: L = { company: 'Clark', signal: 'Hiring a Sales Development Representative', url: 'https://www.builtinnyc.com/job/sales-development-representative/11701959', fit: 1, review: 'no_sales_hiring_evidence', score: 49 }
const BEEHIIV: L = { company: 'beehiiv', signal: 'Hiring a Sales Development Representative', url: 'https://jobgether.com/offer/6aedba771c8aea01fb8d5e6d-sales-development-representative-u.s.', fit: 1, review: 'no_sales_hiring_evidence', score: 49 }
const NGENAIRE: L = { company: 'Ngenaire', date: '2026-09-08', signal: 'Hiring a B2B SaaS Sales Representative', url: 'https://wellfound.com/jobs/4688472-b2b-saas-sales-representative-commission-based-contractor', fit: 3, review: 'no_sales_hiring_evidence', score: 49 }
const LEANPBX: L = { company: 'LeanPBX', signal: 'Hiring Outbound SDRs', url: 'https://www.instagram.com/', fit: 1, review: 'no_sales_hiring_evidence', score: 49 }
const CAMPFIRE: L = { company: 'Campfire', signal: 'Building an AI native sales org', url: 'https://www.linkedin.com/posts/', fit: 2, review: 'no_sales_hiring_evidence', score: 75 }
const CHESKY: L = { company: 'Chesky', signal: 'Hiring a Founding Sales Development Representative', url: 'https://www.linkedin.com/jobs/view/founding-sales-development-representative-sdr-at-chesky-4483464804', fit: null, review: 'counterparty_signal', score: 98 }
const PROD_RUN = [MERCURY, CLARK, BEEHIIV, NGENAIRE, LEANPBX, CAMPFIRE, CHESKY]
// two more stored production leads, each with a confirmed domain and a date
const SMILE: L = { company: 'Smile Avenue Dental', domain: 'smileavenuedental.com', date: '2026-10-21', signal: 'New dental practice opened in Sunnyside in April 2026.', url: 'https://qns.com/2026/06/smile-avenue-dental-sunnyside/', fit: 5, score: 85, conf: 60 }
const ZENITHON: L = { company: 'Zenithon', domain: 'zenithon.ai', date: '2026-09-30', signal: 'London AI startup raised £7.5m seed funding in September 2026 and expanding delivery teams in the US', url: 'https://www.startupmag.co.uk/funding/zenithon-2026-seed-funding/', fit: 4, score: 75, conf: 60 }

async function account(db: Db, id: string, email: string) {
  await db.run("INSERT INTO users (id, email, name, business_name, password_hash, salt) VALUES (?, ?, 'n', 'b', 'x', 'y')", [id, email])
  await db.run('UPDATE users SET email_verified_at = ? WHERE id = ?', [NOW - 30 * DAY, id])
  await db.run("INSERT INTO organizations (id, name, kind, created_by, created_at) VALUES (?, '', 'personal', ?, ?)", [id, id, NOW - 30 * DAY])
  await db.run("INSERT INTO tenant_llm_keys (tenant_id, vendor, ciphertext, last4, validated_at) VALUES (?, 'anthropic', 'x', '1234', 1)", [id])
}
async function play(db: Db, t: string, query: string, at: number): Promise<string> {
  const r = await createWatch(db, t, query, ICP, null, at)
  assert.ok(r.watch, JSON.stringify(r))
  await db.run('UPDATE watches SET created_at = ? WHERE id = ?', [at, r.watch.id])
  return r.watch.id
}
const addLead = (db: Db, job: string, l: L) => db.run(
  `INSERT INTO leads (id, scan_job_id, name, company, company_domain, signal, source_url, score, fit, event_date, date_status, confidence, review_reason, signal_kind) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id24(), job, l.company, l.domain ?? null, l.signal, l.url, l.score, l.fit, l.date ?? null, l.dateStatus ?? 'undated', l.conf ?? null, l.review ?? null, l.kind ?? null])
// One run of a weekly / daily play that stored `leads`, up to the point the scan runner leaves it: leads marked by the
// runner's own step, the job done and its enrichment ended at `at`. `mark: false` leaves the marking to the caller.
async function runJob(db: Db, t: string, watch: string | null, query: string, at: number, leads: L[], o: { mark?: boolean } = {}): Promise<string> {
  const id = id24()
  await db.run("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, icp, status, created_at, watch_id) VALUES (?, ?, 'x', '-', '-', ?, ?, 'running', ?, ?)", [id, t, query, ICP, at - 300, watch])
  for (const l of leads) await addLead(db, id, l)
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ?, enrich_started_at = ?, enrich_finished_at = ? WHERE id = ?", [at, at, at, id])
  if (watch && o.mark !== false) await writeWatchLeads(db, watch, id)
  return id
}
const outbox = (db: Db, t: string) => db.all<{ subject: string; body: string }>('SELECT subject, body FROM system_mail_outbox WHERE user_id = ? ORDER BY created_at, subject', [t])
const listed = (body: string) => body.split('\n').filter(x => x.startsWith('- ')).map(x => x.slice(2).split(':')[0])
const alerts = (db: Db, t: string) => db.all<{ entity_key: string; play_kind: string; play_id: string }>('SELECT entity_key, play_kind, play_id FROM play_alerts WHERE tenant_id = ? ORDER BY entity_key', [t])
const newFlags = async (db: Db, job: string) => Object.fromEntries((await db.all<{ company: string; watch_new: number }>('SELECT company, watch_new FROM leads WHERE scan_job_id = ? ORDER BY company', [job])).map(r => [r.company, Number(r.watch_new)]))

bothEngines('#883 a company one play has mailed is not mailed, or counted as new, again by another play of the account (production play run)', async ({ db }) => {
  await account(db, A, 'founder@a.example')
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  const agencies = await play(db, A, Q_AGENCIES, NOW - 3 * DAY)

  // play 1 runs: production's run. Its mail lists the three leads the Leads list shows.
  const j1 = await runJob(db, A, sdr, Q_SDR, NOW, PROD_RUN)
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), 1)
  let box = await outbox(db, A)
  assert.equal(box.length, 1)
  assert.match(box[0].subject, /^3 new leads from your play /)
  assert.deepEqual(listed(box[0].body), ['Chesky', 'Campfire', 'Ngenaire'])

  // play 2 runs an hour later and finds Campfire and Ngenaire again (Ngenaire under another spelling), beehiiv as a
  // real lead this time (play 1 only had it in the hidden tier, so nobody was told about it), and one new company
  const j2 = await runJob(db, A, agencies, Q_AGENCIES, NOW + 3600, [CAMPFIRE, { ...NGENAIRE, company: 'Ngenaire, Inc.' }, { ...BEEHIIV, fit: 3 }, SMILE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3660 }), 1)
  box = await outbox(db, A)
  assert.equal(box.length, 2)
  const second = box.find(m => /Smile Avenue Dental/.test(m.body))!
  assert.ok(second, 'play 2 mails what only it found')
  assert.deepEqual(listed(second.body), ['Smile Avenue Dental', 'beehiiv'], 'Campfire and Ngenaire were alerted by play 1: not mailed again')
  assert.match(second.subject, /^2 new leads from your play /)
  assert.doesNotMatch(second.body, /Campfire|Ngenaire/)
  // the same on the Plays page: the run's "N new", the play card's count and its what's-new list
  assert.deepEqual(await newFlags(db, j2), { Campfire: 0, 'Ngenaire, Inc.': 0, 'Smile Avenue Dental': 1, beehiiv: 1 })
  assert.equal((await playRuns(db, A, 'watch', agencies))!.runs[0].new_leads, 2)
  assert.equal((await listWatches(db, A)).find(w => w.id === agencies)!.new_leads, 2)
  const fresh = await playNew(db, A, 'watch', agencies, 0)
  assert.ok(fresh)
  assert.deepEqual(fresh.items.map(i => i.company).sort(), ['Smile Avenue Dental', 'beehiiv'])
  // play 1's own run is untouched
  assert.deepEqual(await newFlags(db, j1), { Campfire: 1, Chesky: 1, Clark: 1, LeanPBX: 1, Mercury: 1, Ngenaire: 1, beehiiv: 1 })

  // one row per company, naming the play that alerted it first; hidden-tier leads claimed nothing
  assert.deepEqual(await alerts(db, A), [
    { entity_key: 'd:smileavenuedental.com', play_kind: 'watch', play_id: agencies },
    { entity_key: 'n:beehiiv', play_kind: 'watch', play_id: agencies },
    { entity_key: 'n:campfire', play_kind: 'watch', play_id: sdr },
    { entity_key: 'n:chesky', play_kind: 'watch', play_id: sdr },
    { entity_key: 'n:ngenaire', play_kind: 'watch', play_id: sdr },
    { entity_key: 'n:smile avenue dental', play_kind: 'watch', play_id: agencies },
  ])

  // sent once: later ticks send nothing more
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3720 }), 0)
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2 * 3600 }), 0)
  assert.equal((await outbox(db, A)).length, 2)

  // deleting play 1 does not forget what it alerted: a new third play that finds Chesky mails nothing for it
  assert.equal(await watchAction(db, A, sdr, 'delete'), true)
  const london = await play(db, A, Q_LONDON, NOW + 2 * 3600)
  const j3 = await runJob(db, A, london, Q_LONDON, NOW + 3 * 3600, [CHESKY])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3 * 3600 + 60 }), 0)
  assert.equal((await outbox(db, A)).length, 2)
  assert.deepEqual(await newFlags(db, j3), { Chesky: 0 })
  assert.deepEqual((await alerts(db, A)).find(a => a.entity_key === 'n:chesky'), { entity_key: 'n:chesky', play_kind: 'watch', play_id: sdr })

  // another account is not affected by any of it: its own play mails Campfire
  await account(db, B, 'founder@b.example')
  const other = await play(db, B, Q_SDR, NOW - 3 * DAY)
  await runJob(db, B, other, Q_SDR, NOW + 4 * 3600, [CAMPFIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 4 * 3600 + 60 }), 1)
  assert.deepEqual(listed((await outbox(db, B))[0].body), ['Campfire'])
  assert.deepEqual(await alerts(db, B), [{ entity_key: 'n:campfire', play_kind: 'watch', play_id: other }])
})

bothEngines('#883 the claim step: two runs marked before either is claimed still alert a company once; the claim is idempotent', async ({ db }) => {
  const { claimWatchAlerts } = await import('../lib/watch.ts') as unknown as { claimWatchAlerts?: (db: Db, watchId: string, jobId: string, now?: number) => Promise<number> }
  assert.equal(typeof claimWatchAlerts, 'function', 'lib/watch.ts claimWatchAlerts: the claim the mail pass makes')
  await account(db, A, 'founder@a.example')
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  const agencies = await play(db, A, Q_AGENCIES, NOW - 3 * DAY)
  // both runs are marked (the runner's post-finish step) before either is mailed: both see Campfire as new
  const j1 = await runJob(db, A, sdr, Q_SDR, NOW, [CAMPFIRE, NGENAIRE, MERCURY])
  const j2 = await runJob(db, A, agencies, Q_AGENCIES, NOW, [CAMPFIRE, SMILE])
  assert.deepEqual(await newFlags(db, j2), { Campfire: 1, 'Smile Avenue Dental': 1 })
  // the claim each run's mail transaction makes: the first holds the company, the second run's lead stops being new
  assert.equal(await claimWatchAlerts!(db, sdr, j1, NOW + 10), 2, 'Campfire and Ngenaire (Mercury is in the hidden tier: no claim)')
  assert.equal(await claimWatchAlerts!(db, agencies, j2, NOW + 11), 1)
  assert.deepEqual(await newFlags(db, j2), { Campfire: 0, 'Smile Avenue Dental': 1 })
  assert.deepEqual(await newFlags(db, j1), { Campfire: 1, Mercury: 1, Ngenaire: 1 })
  // a repeated claim of the same run keeps what it holds
  assert.equal(await claimWatchAlerts!(db, sdr, j1, NOW + 20), 2)
  assert.equal(await claimWatchAlerts!(db, agencies, j2, NOW + 21), 1)
  assert.deepEqual((await alerts(db, A)).map(a => [a.entity_key, a.play_id]), [['d:smileavenuedental.com', agencies], ['n:campfire', sdr], ['n:ngenaire', sdr], ['n:smile avenue dental', agencies]])
  // a run of another tenant's job, or of a deleted play, claims nothing
  await account(db, B, 'founder@b.example')
  const foreign = await runJob(db, B, null, Q_SDR, NOW, [ZENITHON], { mark: false })
  await db.run('UPDATE leads SET watch_new = 1 WHERE scan_job_id = ?', [foreign])
  assert.equal(await claimWatchAlerts!(db, sdr, foreign, NOW + 30), 0)
  assert.equal(await claimWatchAlerts!(db, 'no-such-play', j1, NOW + 31), 0)
  assert.equal((await alerts(db, B)).length, 0)
  // then one mail per run, each company in one of them
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), 2)
  const bodies = (await outbox(db, A)).map(m => listed(m.body)).sort((x, y) => x.length - y.length)
  assert.deepEqual(bodies, [['Smile Avenue Dental'], ['Campfire', 'Ngenaire']])
})

// Production, 2026-10-21: one scan stored OpenRelay and Photon with no website; the same request's next scan stored
// them with openrelay.com and photon.codes (fit 5). Replayed as play runs, main mails both twice.
// The four rows exactly as stored (company, domain, date, kind, signal, source, fit, score).
const OPENRELAY: L = { company: 'OpenRelay', date: '2026-09-01', signal: 'AI infrastructure company providing decentralized GPU infrastructure raised $9M in September 2026.', url: 'https://www.vcbacked.co/directory/industries/ai-infrastructure', fit: null, score: 88 }
const OPENRELAY_2: L = { company: 'OpenRelay', domain: 'openrelay.com', kind: 'raised_funding', signal: 'Raised $9M seed round for decentralized GPU infrastructure for AI inference', url: 'https://www.vcbacked.co/directory/industries/ai-infrastructure', fit: 5, score: 89 }
const PHOTON: L = { company: 'Photon', date: '2026-10-01', signal: 'AI agent deployment and messaging infrastructure startup raised $4.5M seed round in October 2026.', url: 'https://newmarketpitch.com/blogs/news/generative-ai-funding-news', fit: null, score: 89 }
const PHOTON_2: L = { company: 'Photon', domain: 'photon.codes', date: '2026-10-01', kind: 'raised_funding', signal: 'Raised $4.5M seed round for AI agent deployment and messaging infrastructure', url: 'https://newmarketpitch.com/blogs/news/generative-ai-funding-news', fit: 5, score: 87 }
const Q_SEED = 'startups that just raised a seed round for AI infrastructure'
bothEngines('#883 a company first stored without its website and then with it is alerted once (production: OpenRelay, Photon); two companies sharing a name are not merged', async ({ db }) => {
  await account(db, A, 'founder@a.example')
  const seed = await play(db, A, Q_SEED, NOW - 3 * DAY)
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  await runJob(db, A, seed, Q_SEED, NOW, [OPENRELAY, PHOTON])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), 1)
  assert.deepEqual(listed((await outbox(db, A))[0].body), ['Photon', 'OpenRelay'])
  // the same play's next run now knows their websites; another play finds OpenRelay under its website too
  const j2 = await runJob(db, A, seed, Q_SEED, NOW + 3600, [OPENRELAY_2, PHOTON_2])
  const j3 = await runJob(db, A, sdr, Q_SDR, NOW + 2 * 3600, [{ ...OPENRELAY_2, company: 'Open Relay, Inc.', domain: 'www.openrelay.com' }])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2 * 3600 + 60 }), 0, 'both companies were mailed by the first run')
  assert.deepEqual(await newFlags(db, j2), { OpenRelay: 0, Photon: 0 })
  assert.deepEqual(await newFlags(db, j3), { 'Open Relay, Inc.': 0 })
  assert.equal((await outbox(db, A)).length, 1)
  assert.deepEqual((await alerts(db, A)).map(a => [a.entity_key, a.play_id]), [['d:openrelay.com', seed], ['d:photon.codes', seed], ['n:open relay', seed], ['n:openrelay', seed], ['n:photon', seed]])
  // documented limit: Ngenaire is held by name only (no website was ever stored), so a later "Ngenaire" with any
  // website is taken as the same company (the first website binds the name)
  await runJob(db, A, seed, Q_SEED, NOW + 2.5 * 3600, [NGENAIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2.5 * 3600 + 60 }), 1)
  const j5 = await runJob(db, A, sdr, Q_SDR, NOW + 2.75 * 3600, [{ ...NGENAIRE, domain: 'ngenaire.example' }])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2.75 * 3600 + 60 }), 0)
  assert.deepEqual(await newFlags(db, j5), { Ngenaire: 0 })
  // another company that is also called Photon, with a different website: a different company, mailed once
  const j4 = await runJob(db, A, sdr, Q_SDR, NOW + 3 * 3600, [{ ...PHOTON_2, domain: 'photon.io' }])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3 * 3600 + 60 }), 1)
  assert.deepEqual(await newFlags(db, j4), { Photon: 1 })
  assert.deepEqual((await alerts(db, A)).filter(a => /photon/.test(a.entity_key)).map(a => [a.entity_key, a.play_id]), [['d:photon.codes', seed], ['d:photon.io', sdr], ['n:photon', seed]])
})

bothEngines('#883 no lost alert: a run that is not mailed (play paused or deleted before the mail pass, no confirmed address, outside the mail window, failed send) holds nothing', async ({ db }) => {
  await account(db, A, 'founder@a.example')
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  const agencies = await play(db, A, Q_AGENCIES, NOW - 3 * DAY)
  // play 1's run ends, then the person pauses it before the next tick: its mail is never sent
  await runJob(db, A, sdr, Q_SDR, NOW, PROD_RUN)
  assert.equal(await watchAction(db, A, sdr, 'pause'), true)
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), 0)
  assert.deepEqual(await alerts(db, A), [], 'nothing was mailed, so nothing is held')
  // so the other play, finding Campfire, mails it
  await runJob(db, A, agencies, Q_AGENCIES, NOW + 3600, [CAMPFIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3660 }), 1)
  assert.deepEqual(listed((await outbox(db, A))[0].body), ['Campfire'])

  // deleted before the mail pass: the same
  const london = await play(db, A, Q_LONDON, NOW + 2 * 3600)
  await runJob(db, A, london, Q_LONDON, NOW + 3 * 3600, [SMILE])
  assert.equal(await watchAction(db, A, london, 'delete'), true)
  assert.equal(await sendPlayRunMails(db, { now: NOW + 3 * 3600 + 60 }), 0)
  assert.deepEqual((await alerts(db, A)).map(a => a.entity_key), ['n:campfire'], 'only Campfire, which WAS mailed, is held')
  // a run the mail pass never reached inside its window (finished two days before the tick): nothing held either
  const late = await play(db, A, Q_SEED, NOW + 3 * 3600)
  await runJob(db, A, late, Q_SEED, NOW + 4 * 3600, [ZENITHON])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 4 * 3600 + 2 * DAY }), 0)
  assert.deepEqual((await alerts(db, A)).map(a => a.entity_key), ['n:campfire'])
  await runJob(db, A, agencies, Q_AGENCIES, NOW + 2 * DAY + 5 * 3600, [SMILE, ZENITHON, CAMPFIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2 * DAY + 5 * 3600 + 60 }), 1)
  assert.deepEqual((await outbox(db, A)).map(m => listed(m.body)), [['Campfire'], ['Smile Avenue Dental', 'Zenithon']])

  // an account with no confirmed address is never mailed: its runs hold nothing
  await account(db, B, 'founder@b.example')
  await db.run('UPDATE users SET email_verified_at = NULL WHERE id = ?', [B])
  const b1 = await play(db, B, Q_SDR, NOW - 3 * DAY)
  await runJob(db, B, b1, Q_SDR, NOW, [CAMPFIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 120 }), 0)
  assert.deepEqual(await alerts(db, B), [])

  // a send that fails (SMTP configured, the transport throws): not retried, and the run gives back what IT claimed,
  // nothing else: Ngenaire, mailed earlier by the other play, stays held, with the website this run learned for it
  await db.run('UPDATE users SET email_verified_at = 1 WHERE id = ?', [B])
  await runJob(db, B, b1, Q_SDR, NOW + 1800, [NGENAIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 1860 }), 1)
  const b2 = await play(db, B, Q_AGENCIES, NOW - 3 * DAY)
  await runJob(db, B, b2, Q_AGENCIES, NOW + 3600, [OPENRELAY_2, { ...NGENAIRE, domain: 'ngenaire.example' }], { mark: false })
  await db.run('UPDATE leads SET watch_new = 1 WHERE company = ? AND scan_job_id IN (SELECT id FROM scan_jobs WHERE watch_id = ?)', ['OpenRelay', b2])
  const smtp = { PUBLIC_BASE_URL: 'https://dazl.ai', SYSTEM_MAIL_SMTP_URL: 'smtp://mail.invalid', SYSTEM_MAIL_FROM: 'dazl <no-reply@dazl.ai>' }
  setTransportForTests(async () => { throw new Error('connection refused') })
  try { assert.equal(await sendPlayRunMails(db, { now: NOW + 3660, env: smtp }), 0) } finally { setTransportForTests(null) }
  assert.deepEqual((await alerts(db, B)).map(a => [a.entity_key, a.play_id]), [['d:ngenaire.example', b1], ['n:ngenaire', b1]], 'the mail never left: OpenRelay is not held; Ngenaire still is')
  const sent: string[] = []
  setTransportForTests(async m => { sent.push(m.text) })
  try {
    assert.equal(await sendPlayRunMails(db, { now: NOW + 3720, env: smtp }), 0, 'once only: the failed run is not mailed late')
    await runJob(db, B, b1, Q_SDR, NOW + 2 * 3600, [OPENRELAY_2])
    assert.equal(await sendPlayRunMails(db, { now: NOW + 2 * 3600 + 60, env: smtp }), 1)
  } finally { setTransportForTests(null) }
  assert.deepEqual(sent.map(listed), [['OpenRelay']])
})

bothEngines('#883 two claim passes at the same moment over the same companies in opposite orders: each company is held by exactly one run', async ({ db }) => {
  const { claimWatchAlerts } = await import('../lib/watch.ts') as unknown as { claimWatchAlerts: (db: Db, watchId: string, jobId: string, now?: number) => Promise<number> }
  await account(db, A, 'founder@a.example')
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  const agencies = await play(db, A, Q_AGENCIES, NOW - 3 * DAY)
  // the claim walks a run's leads best first: the two runs score the same four companies in opposite orders
  const four = [CAMPFIRE, { ...NGENAIRE }, SMILE, ZENITHON]
  const j1 = await runJob(db, A, sdr, Q_SDR, NOW, four.map((l, i) => ({ ...l, score: 90 - i })))
  const j2 = await runJob(db, A, agencies, Q_AGENCIES, NOW, four.map((l, i) => ({ ...l, score: 60 + i })))
  const [k1, k2] = await Promise.all([claimWatchAlerts(db, sdr, j1, NOW + 10), claimWatchAlerts(db, agencies, j2, NOW + 10)])
  assert.equal(k1 + k2, 4, `each company stays new in exactly one run (${k1} + ${k2})`)
  const f1 = await newFlags(db, j1), f2 = await newFlags(db, j2)
  for (const c of Object.keys(f1)) assert.equal(f1[c] + f2[c], 1, c)
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), [k1, k2].filter(k => k > 0).length)
  const named = (await outbox(db, A)).flatMap(m => listed(m.body)).sort()
  assert.deepEqual(named, ['Campfire', 'Ngenaire', 'Smile Avenue Dental', 'Zenithon'])
}, { pgMax: 4 })

// One scheduled run of a monitor that stored `leads` (dated and verified, as the detector needs), then the tick's fold.
async function monitorRun(db: Db, t: string, mon: string, at: number, leads: L[]) {
  await db.run('UPDATE monitors SET next_run_at = CASE WHEN id = ? THEN ? ELSE 9999999999 END', [mon, at])
  const jobs = await runDueMonitors(db, { now: at })
  assert.equal(jobs.length, 1)
  await db.run("UPDATE scan_jobs SET status = 'running', attempts = 1 WHERE id = ?", [jobs[0]])
  for (const l of leads) await addLead(db, jobs[0], { ...l, dateStatus: 'verified', conf: l.conf ?? 60, review: null })
  await db.run("UPDATE scan_jobs SET status = 'done', finished_at = ? WHERE id = ?", [at, jobs[0]])
  await collectMonitorResults(db, { now: at + 3600 })
  return db.all<{ kind: string; company: string }>('SELECT a.kind, a.company FROM monitor_alerts a JOIN monitor_runs r ON r.id = a.run_id WHERE r.job_id = ? ORDER BY a.company', [jobs[0]])
}

bothEngines('#883 across play kinds: a monitor does not repeat what a weekly play mailed, and a weekly play does not repeat a monitor\'s alert', async ({ db }) => {
  await account(db, A, 'founder@a.example')
  const sdr = await play(db, A, Q_SDR, NOW - 3 * DAY)
  // the weekly play mails Smile Avenue Dental (its opening, dated 2026-10-21) and Campfire (no date)
  await runJob(db, A, sdr, Q_SDR, NOW, [SMILE, CAMPFIRE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 60 }), 1)
  assert.deepEqual(listed((await outbox(db, A))[0].body), ['Smile Avenue Dental', 'Campfire'])

  const m = await createMonitor(db, A, { query: 'Independent dental practices in New York City that opened a new location' }, NOW)
  assert.ok('id' in m, JSON.stringify(m))
  // the monitor finds the same opening, Campfire (now dated: the play's lead had no date, so it cannot be told apart)
  // and Zenithon, which no play has alerted
  assert.deepEqual(await monitorRun(db, A, m.id, NOW + DAY, [SMILE, { ...CAMPFIRE, date: '2026-11-10', fit: 3 }, ZENITHON]), [{ kind: 'new_company', company: 'Zenithon' }])
  // the same events again: nothing
  assert.deepEqual(await monitorRun(db, A, m.id, NOW + 8 * DAY, [SMILE, ZENITHON]), [])
  // a later, different dated event of a company the play alerted is a new signal, once (never "new company")
  const second: L = { ...SMILE, date: '2026-11-18', signal: 'Smile Avenue Dental opened a second office', url: 'https://qns.com/2026/11/smile-avenue-dental-second-office/' }
  assert.deepEqual(await monitorRun(db, A, m.id, NOW + 15 * DAY, [second, SMILE]), [{ kind: 'new_signal', company: 'Smile Avenue Dental' }])
  assert.deepEqual(await monitorRun(db, A, m.id, NOW + 22 * DAY, [second]), [])

  // the other direction: the weekly play now finds Zenithon, which the monitor alerted. Not new, not mailed.
  const j = await runJob(db, A, sdr, Q_SDR, NOW + 23 * DAY, [ZENITHON])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 23 * DAY + 60 }), 0)
  assert.deepEqual(await newFlags(db, j), { Zenithon: 0 })
  assert.equal((await outbox(db, A)).length, 1)
  assert.deepEqual(await alerts(db, A), [
    { entity_key: 'd:smileavenuedental.com', play_kind: 'watch', play_id: sdr },
    { entity_key: 'd:zenithon.ai', play_kind: 'monitor', play_id: m.id },
    { entity_key: 'n:campfire', play_kind: 'watch', play_id: sdr },
    { entity_key: 'n:smile avenue dental', play_kind: 'watch', play_id: sdr },
    { entity_key: 'n:zenithon', play_kind: 'monitor', play_id: m.id },
  ])
})

bothEngines('#883 the first play\'s own leads are held by its automatic repeat: another play does not mail them as new', async ({ db }) => {
  await account(db, A, 'founder@a.example')
  // the account's first play (no saved play yet) finishes; the tick creates its daily repeat
  const first = await runJob(db, A, null, Q_SDR, NOW, PROD_RUN, { mark: false })
  const [repeat] = await repeatFirstPlays(db, { now: NOW + 60 })
  assert.ok(repeat)
  assert.deepEqual((await alerts(db, A)).map(a => [a.entity_key, a.play_id]), [['n:campfire', repeat], ['n:chesky', repeat], ['n:ngenaire', repeat]])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 120 }), 0, 'the first play itself mails nothing')
  // a second, hand-made play finds Campfire and one company the first play never showed
  const agencies = await play(db, A, Q_AGENCIES, NOW + 3600)
  await runJob(db, A, agencies, Q_AGENCIES, NOW + 2 * 3600, [CAMPFIRE, SMILE])
  assert.equal(await sendPlayRunMails(db, { now: NOW + 2 * 3600 + 60 }), 1)
  assert.deepEqual(listed((await outbox(db, A))[0].body), ['Smile Avenue Dental'])
  assert.deepEqual(await newFlags(db, first), { Campfire: 1, Chesky: 1, Clark: 1, LeanPBX: 1, Mercury: 1, Ngenaire: 1, beehiiv: 1 })
})

// The wiring, through the real scan runner (in-memory SQLite, stub provider, stub TinyFish, stub page read; the fixture
// of test/adaptive-yield.test.ts): two plays of one account are run by the scheduler one after the other and both scans
// verify the same company. The first run is mailed; the second run's lead must not be new when the runner finishes.
test('#883 real runner: the second play\'s scan of a company the first play alerted ends with that lead not new', async () => {
  const master = randomBytes(32)
  const envBefore = { DAZL_MASTER_KEY: process.env.DAZL_MASTER_KEY, TINYFISH_API_KEY: process.env.TINYFISH_API_KEY }
  process.env.DAZL_MASTER_KEY = master.toString('base64'); process.env.TINYFISH_API_KEY = 'test-tinyfish-key'
  const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  const REQUEST = 'Find Ohio companies with 10 to 100 employees that recently posted a payroll, HR or office manager job'
  const HIT = { url: 'https://jobs.example/a', company: 'Harbor Freight Supply', quote: 'Harbor Freight Supply of Columbus Ohio is hiring a payroll specialist to manage biweekly payroll' }
  const icp = JSON.stringify({ summary: 'Ohio SMBs hiring', who: ['Controller'], industries: [], sizes: ['10-100 employees'], where: ['Ohio'], signals: ['payroll job'], exclude: [] })
  const raw = new Database(':memory:')
  migrateAllSqlite(raw)
  const db = sqliteDb(raw)
  const realFetch = globalThis.fetch
  try {
    await account(db, A, 'founder@a.example')
    await db.run('DELETE FROM tenant_llm_keys WHERE tenant_id = ?', [A])
    saveKey(raw, A, 'anthropic', 'sk-ant-test-AAAA', master)
    const t0 = Math.floor(Date.now() / 1000)
    const w1 = (await createWatch(db, A, REQUEST, icp, null, t0 - 8 * DAY)).watch!, w2 = (await createWatch(db, A, `${REQUEST}.`, icp, null, t0 - 8 * DAY)).watch!
    await db.run('UPDATE watches SET created_at = ?', [t0 - 8 * DAY])
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      if (u.startsWith('https://api.search.tinyfish.ai')) {
        const q = new URL(u).searchParams.get('query') ?? ''
        if (q.startsWith('site:linkedin.com/in ')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
        return new Response(JSON.stringify({ results: [{ url: HIT.url, title: 'Job', snippet: HIT.quote, date: recent }] }), { status: 200 })
      }
      if (u.includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 10 }), { status: 200 })
      if (u.startsWith('https://api.fetch.tinyfish.ai')) {
        const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
        return new Response(JSON.stringify({ results: urls.map(() => ({ url: HIT.url, title: 'Job', text: `Posted ${recent}. ${HIT.quote}. Apply now.` })) }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const complete = async (_k: string, _p: string, _f?: typeof fetch, maxTokens?: number) => maxTokens === 300
      ? JSON.stringify(['small company hiring payroll specialist'])
      : JSON.stringify([{ name: '', company: HIT.company, contact: null, signal: 'Hiring for the role', source_url: HIT.url, score: 80, excerpt: HIT.quote, event_date: recent }])
    const providers: Record<'anthropic' | 'openai', Provider> = {
      anthropic: { configuredModel: () => 'claude-sonnet-4-5', research: async () => ({ text: '', citedUrls: [] }), complete,
        completeDetailed: async (k: string, p: string, f?: typeof fetch, mt?: number) => ({ text: await complete(k, p, f, mt), model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 100 } }) },
      openai: { research: async () => ({ text: '', citedUrls: [] }) },
    }
    const page = async () => ({ text: `Posted ${recent}. ${HIT.quote}. Apply now.`, title: 'Job', retrievedAt: Math.floor(Date.now() / 1000) })
    const runs: { watch: string; job: string }[] = []
    for (let i = 0; i < 2; i++) {
      resetTinyfishState()
      assert.equal((await runDueWatches(db, { now: t0 + i })).ran, 1, 'the scheduler queues one due play at a time')
      const job = claimKeyedJob(raw)!
      assert.ok(job?.watch_id)
      assert.equal(await runScan(raw, job, { providers, master, fetchPage: page, fetchImpl: globalThis.fetch, score: false, judge: null }), 'done')
      runs.push({ watch: job.watch_id!, job: job.id })
      // the tick's mail pass after the first run only: the second run is judged as the runner left it
      if (i === 0) assert.equal(await sendPlayRunMails(db, { now: Math.floor(Date.now() / 1000) + 60 }), 1)
    }
    assert.deepEqual(runs.map(r => r.watch).sort(), [w1.id, w2.id].sort())
    const lead = (job: string) => raw.prepare('SELECT company, watch_new, review_reason, fit, quarantined_at FROM leads WHERE scan_job_id = ?').all(job) as { company: string; watch_new: number; review_reason: string | null; fit: number | null; quarantined_at: number | null }[]
    assert.deepEqual(lead(runs[0].job).map(l => [l.company, l.watch_new]), [[HIT.company, 1]], JSON.stringify(lead(runs[0].job)))
    assert.deepEqual(lead(runs[1].job).map(l => [l.company, l.watch_new]), [[HIT.company, 0]], 'the second play found a company the first play had already alerted: not new')
    assert.deepEqual(await alerts(db, A), [{ entity_key: 'n:harbor freight supply', play_kind: 'watch', play_id: runs[0].watch }])
    // and the next mail pass sends nothing for the second run
    assert.equal(await sendPlayRunMails(db, { now: Math.floor(Date.now() / 1000) + 120 }), 0)
    assert.deepEqual((await outbox(db, A)).map(m => listed(m.body)), [[HIT.company]])
  } finally {
    globalThis.fetch = realFetch
    for (const [k, v] of Object.entries(envBefore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await db.close()
  }
})
