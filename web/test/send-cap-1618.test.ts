// #1618: the cap on emails a person sends by hand protects their Gmail. 20 a day for an account's first 14 days, then 10 more a
// day for each further week up to 50; the count starts again at midnight in Toronto; the page says so in plain words.
// Synthetic rows only, no network, nothing sent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrateAllSqlite } from '../lib/db/sqlite-migrations.ts'
import { ACCOUNT_SEND_CAP, accountCreatedAt, accountSendCount, manualSendCap, sendCapForAge, sendDayStart } from '../lib/outreach/send-budget.ts'
import { approve, saveSettings, sendBlockReason, sendCapToday, sentToday } from '../lib/outreach/service.ts'

const DAY = 86400
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
// 2026-12-02 15:00 UTC = 10:00 in Toronto (winter, UTC-5); that Toronto day began at 05:00 UTC.
const NOW = Date.UTC(2026, 11, 2, 15, 0, 0) / 1000
const MIDNIGHT = Date.UTC(2026, 11, 2, 5, 0, 0) / 1000

function account(createdAt: number | null) {
  const db = new Database(':memory:'); migrateAllSqlite(db)
  if (createdAt !== null) db.prepare("INSERT INTO users (id, email, password_hash, salt, created_at) VALUES ('A', 'owner@seller.example', 'x', 'y', ?)").run(createdAt)
  db.prepare("INSERT INTO scan_jobs (id, user_id, business_name, industry, location, query, status, created_at) VALUES ('j', 'A', 'x', '(from request)', '-', 'q', 'running', 1000)").run()
  db.prepare("INSERT INTO leads (id, scan_job_id, company, signal, source_url, confidence, evidence_excerpt, human_confirmed_at, contact) VALUES ('l', 'j', 'Co', 'opened an office', 'https://news.example/x', NULL, NULL, 5, 'pat@cap.example')").run()
  db.prepare("UPDATE scan_jobs SET status = 'done' WHERE id = 'j'").run()
  db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES ('m', 'A', 'l', 'pat@cap.example', 'Hello', 'A body that is long enough to pass the check.', 'draft')").run()
  saveSettings(db, 'A', { sender_name: 'Dana', postal_address: '1 Main St, Columbus OH 43004' })
  db.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status) VALUES ('A', 'me@example.test', 'x', 'active')").run()
  approve(db, 'A', 'm')
  return db
}
const sent = (db: Database.Database, n: number, at: number, tag = 's') => { for (let i = 0; i < n; i++) db.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status, claimed_at, sent_at) VALUES (?, 'A', ?, ?, 'Hello', 'A body that is long enough to pass the check.', 'sent', ?, ?)").run(`${tag}${i}`, `${tag}-lead-${i}`, `${tag}${i}@example.test`, at, at) }

test('#1618 the cap by account age: 20 for 14 days, then +10 a week, never above 50; unknown age counts as new', () => {
  assert.equal(ACCOUNT_SEND_CAP, 20)
  for (const [days, cap] of [[0, 20], [1, 20], [13.99, 20], [14, 30], [20.99, 30], [21, 40], [27.99, 40], [28, 50], [35, 50], [400, 50]] as const) assert.equal(sendCapForAge(days * DAY), cap, `${days} days`)
  assert.equal(sendCapForAge(null), 20)
  assert.equal(sendCapForAge(-5), 20, 'a creation time in the future is not an old account')
  assert.equal(sendCapForAge(Number.NaN), 20)
})

test('#1618 the sending day starts at midnight in Toronto, winter and summer', () => {
  assert.equal(sendDayStart(NOW), MIDNIGHT)
  assert.equal(sendDayStart(MIDNIGHT), MIDNIGHT)
  assert.equal(sendDayStart(MIDNIGHT - 1), MIDNIGHT - DAY)
  // 2026-07-10 02:30 UTC is still 9 July, 22:30, in Toronto (UTC-4): that day began at 04:00 UTC on the 9th
  assert.equal(sendDayStart(Date.UTC(2026, 6, 10, 2, 30, 0) / 1000), Date.UTC(2026, 6, 9, 4, 0, 0) / 1000)
})

test('#1618 a new account is refused its 21st send of the Toronto day and may send again after midnight', () => {
  const db = account(NOW - 3 * DAY)
  assert.equal(accountCreatedAt(db, 'A'), NOW - 3 * DAY)
  assert.equal(manualSendCap(db, 'A', NOW, {}), 20)
  sent(db, 19, NOW - 600)
  assert.equal(sendBlockReason(db, 'A', 'm', { now: NOW }), null, '19 sent: the 20th is allowed')
  sent(db, 1, NOW - 60, 'last')
  assert.deepEqual(sendCapToday(db, 'A', NOW), { cap: 20, sent_today: 20 })
  assert.equal(sendBlockReason(db, 'A', 'm', { now: NOW }), 'daily_cap')
  // late the same evening in Toronto: still refused
  assert.equal(sendBlockReason(db, 'A', 'm', { now: MIDNIGHT + DAY - 1 }), 'daily_cap')
  // one second later it is the next day there: the count starts again, though the same 20 are inside the last 24 hours
  assert.equal(sentToday(db, 'A', MIDNIGHT + DAY), 0)
  assert.equal(accountSendCount(db, 'A', MIDNIGHT + DAY), 20, 'the rolling 24 hours the automated senders use still counts them')
  assert.equal(sendBlockReason(db, 'A', 'm', { now: MIDNIGHT + DAY }), null)
})

test('#1618 yesterday evening in Toronto does not count against today', () => {
  const db = account(NOW - 3 * DAY)
  sent(db, 20, MIDNIGHT - 3600)
  assert.equal(sentToday(db, 'A', NOW), 0)
  assert.equal(sendBlockReason(db, 'A', 'm', { now: NOW }), null)
})

test('#1618 after 14 days the cap is 30, and an account with no creation time is held to 20', () => {
  const older = account(NOW - 15 * DAY)
  sent(older, 20, NOW - 600)
  assert.equal(manualSendCap(older, 'A', NOW, {}), 30)
  assert.equal(sendBlockReason(older, 'A', 'm', { now: NOW }), null, 'the 21st is allowed')
  sent(older, 10, NOW - 300, 'more')
  assert.equal(sendBlockReason(older, 'A', 'm', { now: NOW }), 'daily_cap', 'the 31st is refused')

  const unknown = account(null)
  assert.equal(accountCreatedAt(unknown, 'A'), null)
  assert.equal(manualSendCap(unknown, 'A', NOW, {}), 20)
  sent(unknown, 20, NOW - 600)
  assert.equal(sendBlockReason(unknown, 'A', 'm', { now: NOW }), 'daily_cap')
})

test('#1618 the operator ceiling lowers a cap and never raises one', () => {
  const db = account(NOW - 60 * DAY)
  assert.equal(manualSendCap(db, 'A', NOW, {}), 50)
  assert.equal(manualSendCap(db, 'A', NOW, { OUTREACH_DAILY_CAP: '5' }), 5)
  assert.equal(manualSendCap(db, 'A', NOW, { OUTREACH_DAILY_CAP: '500' }), 50)
  assert.equal(manualSendCap(db, 'A', NOW, { OUTREACH_DAILY_CAP: 'lots' }), 50)
  assert.equal(manualSendCap(account(NOW - DAY), 'A', NOW, { OUTREACH_DAILY_CAP: '500' }), 20)
})

test('#1618 the send itself checks the same cap, and the page says how many were sent and why', () => {
  const service = src('lib/outreach/service.ts')
  // a person's click: age cap per Toronto day; an automated caller (it passes authorize): the fixed cap over a rolling 24 hours
  assert.match(service, /if \(d\.authorize \? accountSendCount\(db, tenantId, nowS\(d\)\) > DAILY_CAP : sentToday\(db, tenantId, nowS\(d\)\) > manualSendCap\(db, tenantId, nowS\(d\)\)\) release\('daily_cap'\)/)
  assert.match(src('app/api/outreach/[id]/route.ts'), /e\.code === 'daily_cap' && tenantId \? \{ cap: sendCapToday\(getScanDb\(\), tenantId\)\.cap \}/)
  const page = src('app/app/outreach/outreach-client.tsx')
  assert.match(page, /`Sent \$\{cap\} today, more tomorrow to keep your Gmail safe\.`/)
  assert.match(page, /j\.error === 'daily_cap' && Number\.isInteger\(j\.cap\) \? sendCapNote\(j\.cap\)/)
  assert.doesNotMatch(page, /Daily sending limit reached/)
  // Settings shows the same cap and the same day's count, not a fixed 20 over 24 hours
  assert.match(src('app/api/outreach/settings/route.ts'), /daily_cap: today\.cap, sent_today: today\.sent_today,/)
  const panel = src('app/app/settings/gmail-panel.tsx')
  assert.match(panel, /Sent today: \{s\.sent_today \?\? s\.sent_24h\} of \{s\.daily_cap\}\. The count starts again at midnight Toronto time\./)
  assert.doesNotMatch(panel, /Sent in the last 24 hours/)
})
