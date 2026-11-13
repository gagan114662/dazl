// #883: one alert per company per tenant, across every saved play.
//
// Before this, "new" was decided per play: a weekly / daily play (lib/watch.ts) remembered the companies IT had
// surfaced (watch_seen, keyed by play), and monitors remembered events per tenant (lib/monitor-events.ts) but knew
// nothing of the other plays. So a company play A had already mailed ("N new leads from your play", lib/play-mail.ts)
// was mailed again as "a new lead you have not been shown before" when play B found it, and counted again in B's
// "N new" on the Plays page.
//
// play_alerts is the tenant's record of "this company was already alerted": one row per (tenant, company key), written
// when a play alerts it, naming the play and run that did. It is not tied to the play's row, so deleting a play does
// not forget what it alerted; it is erased with the tenant (lib/tenant/scope.ts: its own tenant column).
//   - A weekly / daily play's run claims each new, visible lead here in the transaction that sends its mail
//     (lib/play-mail.ts), so a company is held exactly when a mail naming or counting it goes out. A lead whose company
//     another run already holds is not new: leads.watch_new is cleared, so it is not mailed and not counted.
//   - A monitor's alert claims the company the same way, and a monitor does not alert an event for a company a
//     weekly / daily play already alerted when that play's lead carried the same event (same day and kind) or no date
//     at all; a different dated event still alerts once, as a new signal (lib/monitor-events.ts foldRunEvents).
// What "alerted" means: the run's mail went out, or (the first play only, lib/play-repeat.ts) the leads were that
// play's own results on screen. A run that is not mailed (paused or deleted play, no confirmed address, outside the
// mail window) claims nothing, and a send that fails gives its claim back (releaseRunAlertsStep): a lost alert is as
// bad as a repeated one. Known limits: a company held by name only takes the first website any later lead gives that
// name (a different company with the same name and a website is then treated as already alerted); a monitor's later
// "now reachable" alert for an event a play mailed is a state change, not a repeat, and still goes out; a run that is
// not mailed keeps its own "N new" on the Plays page even when another play later mails the same company.
// The claim and the send are not one step (the claim commits, then the mail is sent, at most once). Stated limits, in
// each of which the lead stays in the app as new for the first play and no email is sent for it, while another play
// that finds the company later treats it as already alerted:
//   - the process restarts between the claim and the send (production restarts on every deploy);
//   - the scheduler stalls past its 30-minute lease after the claim and that run's send then fails: the release is a
//     tick write, so the lease fence refuses it (it stays fenced on purpose);
//   - the release itself fails.
// Also: a send that throws after the server accepted the message gives the hold back and another play may mail the
// company again; a run marked while a hold stood that is then given back (failed send) was already judged not new.
// A durable send (the mail queued in the claim's own transaction and retried) would remove all of these; it belongs
// with the mail-delivery work.
// Identity (found on production's own data, 2026-11-13: OpenRelay and Photon were stored without a website by one run
// and with openrelay.com / photon.codes by the next, and were mailed twice): a lead is known by its confirmed domain
// AND by its normalized name (lib/monitor-events.ts alertKeysOf), one row per key. A lead is held when its domain is
// held, or when its name is held and the two do not carry different domains (two companies that share a name but have
// different websites stay two companies). A name first alerted without a domain takes the first domain seen for it.
// The claim is the primary key: two runs that finish at the same moment cannot both hold one company, on either engine.
// What was alerted BEFORE this table existed is read in once per account (seedPlayAlertsStep): every run a mail pass
// picked up (its 'mail:<job>' marker in watch_seen), the first play's own run, and every monitor alert, oldest first,
// so a company mailed before the deploy is not mailed again after it. No network and no paid call. Db layer (SQLite +
// Postgres); migratePlayAlerts is the SQLite setup, the Postgres one is its numbered migration
// (lib/db/migrations/pg/*_play_alerts.sql).
import type Database from 'better-sqlite3'
import type { Tx, TxBody } from './db/client.ts'

export function migratePlayAlerts(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS play_alerts (
    tenant_id   TEXT NOT NULL,
    entity_key  TEXT NOT NULL,
    play_kind   TEXT NOT NULL CHECK (play_kind IN ('watch','monitor')),
    play_id     TEXT NOT NULL,
    job_id      TEXT NOT NULL,
    event_date  TEXT,
    signal_kind TEXT,
    domain_key  TEXT,
    at          INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, entity_key)
  )`)
}

// The same visibility as the Leads list (lib/scan/store-db.ts): not quarantined, not the low-fit tier.
export const VISIBLE_LEAD = '(l.fit IS NULL OR l.fit > 1) AND l.quarantined_at IS NULL'

// entity_key is the row's own key (a domain key 'd:host' or a name key 'n:name'); domain_key is the domain key of the
// company the row stands for, when one is known.
export interface PlayAlert { entity_key: string; play_kind: 'watch' | 'monitor'; play_id: string; job_id: string; event_date: string | null; signal_kind: string | null; domain_key: string | null }
// A lead's keys (lib/monitor-events.ts alertKeysOf): its confirmed domain, when it has one, and its normalized name.
export interface AlertKeys { domainKey: string | null; nameKey: string | null }
export interface AlertClaim { tenantId: string; keys: AlertKeys; playKind: 'watch' | 'monitor'; playId: string; jobId: string; eventDate: string | null; signalKind: string | null; now: number }

export const ALERT_ROW_SQL = 'SELECT entity_key, play_kind, play_id, job_id, event_date, signal_kind, domain_key FROM play_alerts WHERE tenant_id = ? AND entity_key = ?'
// only the primary key can conflict: the first run to alert a company keeps it
const ALERT_CLAIM_SQL = 'INSERT INTO play_alerts (tenant_id, entity_key, play_kind, play_id, job_id, event_date, signal_kind, domain_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, entity_key) DO NOTHING'
// a name alerted before any domain was known takes the first domain seen for it
const BIND_DOMAIN_SQL = 'UPDATE play_alerts SET domain_key = ? WHERE tenant_id = ? AND entity_key = ? AND domain_key IS NULL'

// One claim pass at a time per tenant. On Postgres two passes that claim the same companies in different orders would
// otherwise wait on each other's uncommitted rows (a deadlock one of them loses); SQLite's write transaction is already
// exclusive. Taken first by every pass that claims (a play's run, the mail pass, a monitor's fold).
export function* lockAlertsStep(t: Tx, tenantId: string): TxBody<void> {
  if (t.kind === 'pg') yield* t.get("SELECT pg_advisory_xact_lock(hashtextextended('play_alerts:' || ?, 0)) AS x", [tenantId])
}
// A play's run whose mail failed to send gives back what it claimed, so another play that finds those companies
// still mails them.
export function* releaseRunAlertsStep(t: Tx, tenantId: string, jobId: string): TxBody<number> {
  return (yield* t.run("DELETE FROM play_alerts WHERE tenant_id = ? AND job_id = ? AND play_kind = 'watch'", [tenantId, jobId])).changes
}

// Pure: who holds this company, given the rows found under its domain key and its name key. The name row counts unless
// both sides carry a domain and the domains differ. A row of another run wins over this run's own (so of two runs that
// claimed different keys of one company at the same moment, only the earlier keeps it).
export function holderOf(k: AlertKeys, byDomain: PlayAlert | null | undefined, byName: PlayAlert | null | undefined, jobId: string): PlayAlert | null {
  const rows = [byDomain, byName && (!k.domainKey || byName.domain_key == null || byName.domain_key === k.domainKey) ? byName : null].filter((r): r is PlayAlert => !!r)
  return rows.find(r => r.job_id !== jobId) ?? rows[0] ?? null
}
// True when another run already alerted this company.
export const heldElsewhere = (held: Pick<PlayAlert, 'job_id'> | null | undefined, jobId: string): boolean => !!held && held.job_id !== jobId

// Who alerted this company first, if anyone (read only).
export function* alertHolderStep(t: Tx, tenantId: string, k: AlertKeys, jobId: string): TxBody<PlayAlert | null> {
  const byDomain = k.domainKey ? yield* t.get<PlayAlert>(ALERT_ROW_SQL, [tenantId, k.domainKey]) : null
  const byName = k.nameKey ? yield* t.get<PlayAlert>(ALERT_ROW_SQL, [tenantId, k.nameKey]) : null
  return holderOf(k, byDomain, byName, jobId)
}
// Every key of the lead ends up held by `owner`: a key the holder did not have yet is recorded under the holder's
// play and run, so a later spelling or a later-confirmed website of the same company is recognised too.
function* holdKeysStep(t: Tx, tenantId: string, k: AlertKeys, owner: Pick<PlayAlert, 'play_kind' | 'play_id' | 'job_id' | 'event_date' | 'signal_kind'>, now: number): TxBody<void> {
  for (const key of [k.domainKey, k.nameKey]) {
    if (key) yield* t.run(ALERT_CLAIM_SQL, [tenantId, key, owner.play_kind, owner.play_id, owner.job_id, owner.event_date, owner.signal_kind, k.domainKey, now])
  }
  if (k.domainKey && k.nameKey) yield* t.run(BIND_DOMAIN_SQL, [k.domainKey, tenantId, k.nameKey])
}
// Claims the company for this run and answers who holds it afterwards: this run (it may alert), or the earlier one.
export function* claimAlertStep(t: Tx, c: AlertClaim): TxBody<PlayAlert | null> {
  const before = yield* alertHolderStep(t, c.tenantId, c.keys, c.jobId)
  yield* holdKeysStep(t, c.tenantId, c.keys, before ?? { play_kind: c.playKind, play_id: c.playId, job_id: c.jobId, event_date: c.eventDate, signal_kind: c.signalKind }, c.now)
  return yield* alertHolderStep(t, c.tenantId, c.keys, c.jobId)
}
// A lead that is not new and claims nothing: when its company is already held, the keys this lead adds (a website the
// holder's lead did not have, another spelling) are recorded under the holder. Returns the holder, if any.
export function* learnAlertKeysStep(t: Tx, tenantId: string, k: AlertKeys, jobId: string, now: number): TxBody<PlayAlert | null> {
  const held = yield* alertHolderStep(t, tenantId, k, jobId)
  if (held) yield* holdKeysStep(t, tenantId, k, held, now)
  return held
}
// The same event as the one the holder alerted: the same day, and the same kind when both sides name one. One run can
// store an event with no kind and the next label it (production did for OpenRelay and Photon), so an event with no kind
// on either side cannot be told apart from another event of that company on that day and counts as the same; two
// events that each name a different kind on one day are two events. A holder with no date at all counts as the same.
export const sameEventAs = (held: Pick<PlayAlert, 'event_date' | 'signal_kind'>, l: { event_date: string | null; signal_kind: string | null }): boolean =>
  held.event_date == null || (held.event_date === l.event_date && (held.signal_kind == null || l.signal_kind == null || held.signal_kind === l.signal_kind))

// --- What was alerted before this table existed ---------------------------------------------------------------------
// Once per account, in the caller's transaction and under the account's claim lock (take lockAlertsStep first): the
// companies main already mailed or alerted are recorded, oldest first, so the first holder keeps each company exactly as
// a live claim would. Read from what main left behind:
//   - a weekly / daily play's run the mail pass picked up (watch_seen 'mail:<job id>') and the first play's own run
//     (the repeat's one job older than the play): that run's leads still marked new and shown in the Leads list. A run
//     the mail pass picked up but did not mail (play paused at that moment, no confirmed address) cannot be told apart
//     any more and counts as mailed;
//   - every monitor alert for a new company or a new signal (its event key carries the company and the day).
// Not read in (each can mail a company once more after the deploy): what a since-deleted play mailed (its markers went with it),
// and a mailed lead that has since left the Leads list (quarantined or re-scored into the hidden tier).
// Bounded: the newest SEED_MAX rows of each kind. The marker row (entity_key SEEDED) makes it once only; it is not a
// company key (those start "d:" or "n:"). `keysOf` is lib/monitor-events.ts alertKeysOf (passed in: this module sits
// below it).
export const SEEDED = '~seeded'
export const SEED_MAX = 5000
const SEED_PLAY_SQL = `SELECT q.company, q.company_domain, q.event_date, q.signal_kind, q.job_id, q.play_id, q.at FROM (
    SELECT l.company, l.company_domain, l.event_date, l.signal_kind, j.id AS job_id, w.id AS play_id, COALESCE(j.finished_at, j.created_at) AS at, l.score AS score, l.id AS lead_id
    FROM watches w JOIN scan_jobs j ON j.watch_id = w.id AND j.user_id = w.user_id JOIN leads l ON l.scan_job_id = j.id
    WHERE w.user_id = ? AND j.status = 'done' AND l.watch_new = 1 AND ${VISIBLE_LEAD}
      AND (j.created_at < w.created_at OR EXISTS (SELECT 1 FROM watch_seen s WHERE s.watch_id = w.id AND s.seen_key = 'mail:' || j.id))
    ORDER BY at DESC, j.id DESC, l.score DESC, l.id LIMIT ${SEED_MAX}) q ORDER BY q.at, q.job_id, q.score DESC, q.lead_id`
const SEED_MONITOR_SQL = `SELECT q.company, q.event_key, q.play_id, q.job_id, q.at FROM (
    SELECT a.company, a.event_key, a.monitor_id AS play_id, r.job_id AS job_id, a.at AS at, a.id AS id
    FROM monitors m JOIN monitor_alerts a ON a.monitor_id = m.id JOIN monitor_runs r ON r.id = a.run_id
    WHERE m.user_id = ? AND a.kind IN ('new_company', 'new_signal') ORDER BY a.at DESC, a.id LIMIT ${SEED_MAX}) q ORDER BY q.at, q.id`
type SeedPlay = { company: string; company_domain: string | null; event_date: string | null; signal_kind: string | null; job_id: string; play_id: string; at: number }
type SeedMonitor = { company: string; event_key: string; play_id: string; job_id: string; at: number }
export function* seedPlayAlertsStep(t: Tx, tenantId: string, keysOf: (l: { company: string; company_domain: string | null }) => AlertKeys): TxBody<boolean> {
  if (yield* t.get(ALERT_ROW_SQL, [tenantId, SEEDED])) return false
  // A SQLite store set up by one module alone (some tests) may lack the other kind's tables: nothing of that kind was alerted there.
  // Postgres always has every table (numbered migrations).
  const has = function* (table: string): TxBody<boolean> { return t.kind !== 'sqlite' || !!(yield* t.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [table])) }
  const plays = (yield* has('watches')) && (yield* has('watch_seen')) ? yield* t.all<SeedPlay>(SEED_PLAY_SQL, [tenantId]) : []
  const mons = (yield* has('monitors')) && (yield* has('monitor_alerts')) ? yield* t.all<SeedMonitor>(SEED_MONITOR_SQL, [tenantId]) : []
  const items: { keys: AlertKeys; owner: Pick<PlayAlert, 'play_kind' | 'play_id' | 'job_id' | 'event_date' | 'signal_kind'>; at: number }[] = []
  for (const r of plays) items.push({ keys: keysOf(r), owner: { play_kind: 'watch', play_id: r.play_id, job_id: r.job_id, event_date: r.event_date ?? null, signal_kind: r.signal_kind ?? null }, at: Number(r.at) })
  for (const r of mons) {
    // the monitor's own event key: "<d:host | n:name>|<day>|<kind>"; the company key in it is the one the alert was raised under
    const [entity, day, kind] = String(r.event_key).split('|')
    const named = keysOf({ company: r.company, company_domain: entity?.startsWith('d:') ? entity.slice(2) : null })
    // an alert raised under the name carries that exact key (the stored company text is cut at 150 characters)
    const k: AlertKeys = entity?.startsWith('n:') ? { domainKey: null, nameKey: entity } : named
    items.push({ keys: k, owner: { play_kind: 'monitor', play_id: r.play_id, job_id: r.job_id, event_date: /^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? day : null, signal_kind: kind && kind !== 'signal' ? kind : null }, at: Number(r.at) })
  }
  items.sort((a, b) => a.at - b.at)   // stable: each list is already oldest first
  for (const it of items) {
    if (!it.keys.domainKey && !it.keys.nameKey) continue
    const held = yield* alertHolderStep(t, tenantId, it.keys, it.owner.job_id)
    yield* holdKeysStep(t, tenantId, it.keys, held ?? it.owner, it.at)
  }
  yield* t.run(ALERT_CLAIM_SQL, [tenantId, SEEDED, 'watch', '', '', null, null, null, 0])
  return true
}
