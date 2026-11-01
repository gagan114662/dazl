import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDsn, decideDsn, firstAuthenticationResults, dsnProvenance, type DsnVerdict } from '../lib/outreach/dsn.ts'
import type { GPart } from '../lib/outreach/reply-text.ts'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const MSGID = 'dazl.abc123@sender.example'
const dsnBody = (recipient: string, action: string, status: string) => `Reporting-MTA: dns; mx.example.com

Final-Recipient: rfc822;${recipient}
Action: ${action}
Status: ${status}
Diagnostic-Code: smtp; 550 5.1.1 user unknown
`
const fixture = (opts: { recipient?: string; action?: string; status?: string; auth?: string; msgId?: string | null; extraBlock?: string }): GPart => ({
  mimeType: 'multipart/report',
  headers: [
    { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status; boundary="b"' },
    ...(opts.auth === undefined ? [] : [{ name: 'Authentication-Results', value: opts.auth }]),
    { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@mx.example.com>' },
  ],
  parts: [
    { mimeType: 'text/plain', body: { data: b64('This is an automatically generated Delivery Status Notification. Delivery failed for dazl.abc123@sender.example apparently') } },
    { mimeType: 'message/delivery-status', body: { data: b64(dsnBody(opts.recipient ?? 'lead@prospect.example', opts.action ?? 'failed', opts.status ?? '5.1.1') + (opts.extraBlock ?? '')) } },
    { mimeType: 'text/rfc822-headers', headers: opts.msgId === null ? [] : [{ name: 'Message-ID', value: `<${opts.msgId ?? MSGID}>` }], body: { data: b64('') } },
  ],
})
const send = { id: 'abc123', to_email: 'lead@prospect.example' }
const known = (id: string) => id === MSGID ? send : undefined
// Trusted posture for the fixture: Gmail's receiving MX as authserv-id, and the recipient domain's MX hosts as the
// only legitimate bounce origins (caller-supplied; never taken from the notice).
const TRUST = { trustedAuthservIds: ['mx.google.com'], expectedBounceDomains: ['mx.example.com', 'example.com'] }
const AUTH_OK = 'mx.google.com; spf=pass smtp.mailfrom=mx.example.com; dkim=pass header.d=example.com; dmarc=pass header.from=example.com'

test('structured fields parse: recipient blocks and the original Message-ID from returned headers, not the human part', () => {
  const d = parseDsn(fixture({}))!
  assert.equal(d.originalMessageId, MSGID)
  assert.equal(d.recipients.length, 1)
  assert.deepEqual(d.recipients[0], { finalRecipient: 'lead@prospect.example', action: 'failed', status: '5.1.1' })
})

test('authenticated 5.x.x for the recorded send and recipient is permanent', () => {
  const v = decideDsn(fixture({ auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(v, { kind: 'permanent', recipient: 'lead@prospect.example', originalMessageId: MSGID, outreachMessageId: 'abc123' })
})

test('an otherwise-perfect but unauthenticated notice is held, never a permanent suppression', () => {
  const v = decideDsn(fixture({ auth: 'mx.google.com; spf=fail; dkim=fail; dmarc=fail' }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(v, { kind: 'hold', reason: 'domain_not_aligned' })
  const v2 = decideDsn(fixture({}), 'mailer-daemon@mx.example.com', known, TRUST) // no Authentication-Results at all
  assert.deepEqual(v2, { kind: 'hold', reason: 'no_authentication_results' })
})

test('attacker-own-domain pass is not provenance: aligned origin domains are required', () => {
  // a real receiving-MX header authenticating the ATTACKER's domain on a notice that quotes the real Message-ID
  const evil = decideDsn(fixture({ auth: 'mx.google.com; spf=pass smtp.mailfrom=evil.example; dkim=pass header.d=evil.example' }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(evil, { kind: 'hold', reason: 'domain_not_aligned' })
})

test('a forged or injected Authentication-Results from an untrusted authserv-id is held', () => {
  // first header claims a pass but its authserv-id is not the tenant's receiving MX: injectable, not trusted
  const forged = decideDsn(fixture({ auth: 'mail.evil.example; spf=pass smtp.mailfrom=mx.example.com; dkim=pass header.d=example.com' }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(forged, { kind: 'hold', reason: 'untrusted_authserv' })
  // multiple headers: a trusted-looking SECOND header cannot rescue an untrusted first one
  const multi = fixture({ auth: 'mail.evil.example; spf=pass smtp.mailfrom=mx.example.com' })
  multi.headers!.push({ name: 'Authentication-Results', value: AUTH_OK })
  assert.deepEqual(decideDsn(multi, 'mailer-daemon@mx.example.com', known, TRUST), { kind: 'hold', reason: 'untrusted_authserv' })
})

test('without caller-supplied expected origins every correlated notice is held: no offline provenance posture', () => {
  const v = decideDsn(fixture({ auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, { trustedAuthservIds: ['mx.google.com'], expectedBounceDomains: [] })
  assert.deepEqual(v, { kind: 'hold', reason: 'no_expected_origins' })
  assert.deepEqual(decideDsn(fixture({ auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known), { kind: 'hold', reason: 'untrusted_authserv' })
})

test('a forged notice quoting a real Message-ID from the wrong sender name is ignored before parsing', () => {
  const v = decideDsn(fixture({ auth: AUTH_OK }), 'notices@evil.example', known, TRUST)
  assert.equal(v.kind, 'ignore')
})

test('4.x and non-failed actions are soft forever, even authenticated', () => {
  for (const [action, status] of [['failed', '4.4.2'], ['delayed', '4.0.0'], ['expanded', '2.0.0']] as const) {
    const v = decideDsn(fixture({ action, status, auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST)
    assert.equal(v.kind, 'soft', `${action}/${status}`)
  }
})

test('a notice for a different recipient is ignored: unrelated contacts are never suppressed', () => {
  const v = decideDsn(fixture({ recipient: 'someone.else@other.example', auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(v, { kind: 'ignore', reason: 'recipient_mismatch' })
})

test('an unknown or missing original Message-ID is ignored: no correlation, no action', () => {
  assert.deepEqual(decideDsn(fixture({ msgId: 'dazl.unknown@sender.example', auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST), { kind: 'ignore', reason: 'unknown_original' })
  assert.deepEqual(decideDsn(fixture({ msgId: null, auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST), { kind: 'ignore', reason: 'no_original_message_id' })
})

test('multi-recipient DSN: only the block matching the recorded recipient acts', () => {
  const extra = '\nFinal-Recipient: rfc822;other@elsewhere.example\nAction: failed\nStatus: 5.2.1\n'
  const v = decideDsn(fixture({ extraBlock: extra, auth: AUTH_OK }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.equal(v.kind, 'permanent')
  assert.equal((v as { recipient: string }).recipient, 'lead@prospect.example')
})

test('not a DSN at all', () => {
  assert.equal(parseDsn({ mimeType: 'text/plain', headers: [], body: { data: b64('hello') } }), null)
  assert.equal(decideDsn(fixture({}), 'lead@prospect.example', known).kind, 'ignore')
})
