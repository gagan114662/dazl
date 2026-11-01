import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateOutreach } from '../lib/outreach/store.ts'
import { migrateAutopilot } from '../lib/outreach/autopilot.ts'
import { migrateReplies, acceptReadConsent, hasReadConsent } from '../lib/outreach/replies.ts'
import { migrateBounceLedger, bounceCount } from '../lib/outreach/bounce-ledger.ts'
import { migrateBounceScan, acceptBounceScanConsent, hasBounceScanConsent, revokeBounceScanConsent, BOUNCE_SCAN_CONSENT_VERSION, syncBounceNotices, type BounceScanDeps } from '../lib/outreach/bounce-scan.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const SEND_ID = 'a1a2b3c4d5e6f7a8b9c0d1e2'
const MSGID = `dazl.${SEND_ID}@sender.example`
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const env = { DAZL_ENV: 'staging' } // getAccessToken returns the stub token: no OAuth fetch in these tests

const db = () => { const d = new Database(':memory:'); migrateOutreach(d); migrateAutopilot(d); migrateReplies(d); migrateBounceLedger(d); migrateBounceScan(d); return d }
const withAccount = (d: Database.Database) => {
  d.prepare("INSERT INTO gmail_accounts (tenant_id, email, refresh_ct, status, read_granted) VALUES ('A', 'me@sender.example', 'x', 'active', 1)").run()
  d.prepare("INSERT INTO outreach_messages (id, tenant_id, lead_id, to_email, subject, body, status) VALUES (?, 'A', 'l1', 'lead@prospect.example', 'Hello', 'A message long enough to be valid', 'sent')").run(SEND_ID)
  return d
}
const dsnPayload = (opts: { auth?: string | null; msgId?: string | null } = {}) => ({
  mimeType: 'multipart/report',
  headers: [
    { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' },
    ...(opts.auth ? [{ name: 'Authentication-Results', value: opts.auth }] : []),
    { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@mx.prospect.example>' },
  ],
  parts: [
    { mimeType: 'text/plain', body: { data: b64('Delivery failed') } },
    { mimeType: 'message/delivery-status', body: { data: b64('Reporting-MTA: dns; mx.prospect.example\n\nFinal-Recipient: rfc822;lead@prospect.example\nAction: failed\nStatus: 5.1.1\n') } },
    { mimeType: 'text/rfc822-headers', headers: opts.msgId === null ? [] : [{ name: 'Message-ID', value: `<${opts.msgId ?? MSGID}>` }], body: { data: b64('') } },
  ],
})
const AUTH_OK = 'mx.google.com; spf=pass smtp.mailfrom=mx.prospect.example; dkim=pass header.d=prospect.example'
const gmail = (messages: Record<string, unknown>, calls: string[]) => (async (u: unknown) => {
  const url = String(u); calls.push(url)
  const list = url.match(/messages\?/) ? { messages: Object.keys(messages).map(id => ({ id })) } : undefined
  if (list) return json(list)
  const m = url.match(/messages\/([^?]+)/)
  if (m && messages[m[1]]) return json({ id: m[1], payload: messages[m[1]] })
  return json({}, 404)
}) as typeof fetch
const deps = (messages: Record<string, unknown>, calls: string[]): BounceScanDeps => ({ env, fetchImpl: gmail(messages, calls), resolveMxFor: async () => ['mx.prospect.example'] })

test('consent is its own version: reply-reading consent does not authorize the scan, and the scan leaves reply reading untouched', () => {
  const d = withAccount(db())
  acceptReadConsent(d, 'A') // the 2026-10-21 grant
  assert.equal(hasReadConsent(d, 'A'), true)
  assert.equal(hasBounceScanConsent(d, 'A'), false, 'the old grant must not unlock the new scan')
  acceptBounceScanConsent(d, 'A')
  assert.equal(hasBounceScanConsent(d, 'A'), true)
  assert.equal(hasReadConsent(d, 'A'), true, 'separated: the scan consent does not disturb thread reading')
  revokeBounceScanConsent(d, 'A')
  assert.equal(hasBounceScanConsent(d, 'A'), false)
  assert.equal(hasReadConsent(d, 'A'), true)
})

test('without the scan consent there is no list and no fetch at all', async () => {
  const d = withAccount(db())
  const calls: string[] = []
  const r = await syncBounceNotices(d, 'A', deps({ g1: dsnPayload() }, calls), { apply: true })
  assert.equal(r.error, 'bounce_scan_not_enabled')
  assert.equal(calls.length, 0, 'no mailbox call happens before consent')
})

test('an unmatched notice is discarded: nothing from it is kept, even when applying', async () => {
  const d = withAccount(db()); acceptBounceScanConsent(d, 'A')
  const r = await syncBounceNotices(d, 'A', deps({ g1: dsnPayload({ msgId: 'dazl.ffffffffffffffffffffffff@sender.example' }) }, []), { apply: true })
  assert.deepEqual([r.listed, r.fetched, r.matched, r.discarded], [1, 1, 0, 1])
  assert.equal(bounceCount(d, 'A'), 0)
  assert.equal((d.prepare('SELECT count(*) AS n FROM inbound_messages').get() as { n: number }).n, 0, 'no trace of the unmatched notice is stored')
})

test('a verified match counts but writes nothing until application is cleared; with apply it records and suppresses exactly once', async () => {
  const d = withAccount(db()); acceptBounceScanConsent(d, 'A')
  const messages = { g1: dsnPayload({ auth: AUTH_OK }) }
  const dry = await syncBounceNotices(d, 'A', deps(messages, [])) // apply defaults off
  assert.deepEqual([dry.matched, dry.recorded, dry.applied], [1, 0, false])
  assert.equal(bounceCount(d, 'A'), 0, 'no ledger row before clearance')
  const live = await syncBounceNotices(d, 'A', deps(messages, []), { apply: true })
  assert.deepEqual([live.matched, live.recorded, live.duplicate], [1, 1, 0])
  assert.ok(d.prepare("SELECT 1 FROM suppressions WHERE tenant_id = 'A' AND email = 'lead@prospect.example'").get())
  const again = await syncBounceNotices(d, 'A', deps({ g2: dsnPayload({ auth: AUTH_OK }) }, []), { apply: true })
  assert.deepEqual([again.recorded, again.duplicate], [0, 1], 'the same send+recipient under a new Gmail id is a duplicate')
})

test('an unverifiable notice is held as unknown and never written, even when applying', async () => {
  const d = withAccount(db()); acceptBounceScanConsent(d, 'A')
  const r = await syncBounceNotices(d, 'A', deps({ g1: dsnPayload() }, []), { apply: true }) // no Authentication-Results
  assert.deepEqual([r.held, r.recorded, r.matched], [1, 0, 0])
  assert.equal(bounceCount(d, 'A'), 0)
})

test('a DNS failure narrows origin evidence to the recipient domain from the recorded send (never from the notice)', async () => {
  const d = withAccount(db()); acceptBounceScanConsent(d, 'A')
  const failing: BounceScanDeps = { env, fetchImpl: gmail({ g1: dsnPayload({ auth: AUTH_OK }) }, []), resolveMxFor: async () => { throw new Error('ENOTFOUND') } }
  const r = await syncBounceNotices(d, 'A', failing, { apply: true })
  assert.deepEqual([r.matched, r.recorded], [1, 1], 'dkim alignment with the exact recipient domain still verifies')
  const unrelated: BounceScanDeps = { env, fetchImpl: gmail({ g2: dsnPayload({ auth: 'mx.google.com; spf=pass smtp.mailfrom=mx.other.example; dkim=pass header.d=other.example' }) }, []), resolveMxFor: async () => { throw new Error('ENOTFOUND') } }
  const r2 = await syncBounceNotices(d, 'A', unrelated, { apply: true })
  assert.deepEqual([r2.held, r2.recorded], [1, 0], 'with no MX evidence, an unrelated passing domain is held')
  assert.equal(bounceCount(d, 'A'), 1)
})

test('a follow-up step Message-ID (dazl.s2.<id>@domain) correlates to the original send', async () => {
  const d = withAccount(db()); acceptBounceScanConsent(d, 'A')
  const r = await syncBounceNotices(d, 'A', deps({ g1: dsnPayload({ auth: AUTH_OK, msgId: `dazl.s2.${SEND_ID}@sender.example` }) }, []), { apply: true })
  assert.deepEqual([r.matched, r.recorded], [1, 1])
})
