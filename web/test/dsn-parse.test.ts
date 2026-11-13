import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDsn, decideDsn, dsnProvenance, firstAuthenticationResults } from '../lib/outreach/dsn.ts'
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

// #676: a real bounce has a NULL return path, so Gmail authenticates it by the HELO identity and writes
// `spf=pass (google.com: domain of postmaster@<helo> designates ...) smtp.helo=<helo>`. That header, as Gmail actually
// prints it (folded, with a comment), must count as provenance when the HELO host aligns with the recipient's MX.
const HELO_AR = 'mx.google.com;\r\n       spf=pass (google.com: domain of postmaster@mx.example.com designates 192.0.2.7 as permitted sender) smtp.helo=mx.example.com'

test('#676: Gmail null-sender bounce authenticated by SPF HELO (smtp.helo=) and aligned with the recipient MX is permanent', () => {
  assert.deepEqual(firstAuthenticationResults(fixture({ auth: HELO_AR })), { authservId: 'mx.google.com', passDomains: ['mx.example.com'] })
  const v = decideDsn(fixture({ auth: HELO_AR }), 'mailer-daemon@mx.example.com', known, TRUST)
  assert.deepEqual(v, { kind: 'permanent', recipient: 'lead@prospect.example', originalMessageId: MSGID, outreachMessageId: 'abc123' })
})

test('#676: smtp.mailfrom given as a full address (the form Gmail prints) yields its domain', () => {
  const ar = 'mx.google.com; spf=pass (google.com: domain of bounce@mx.example.com designates 192.0.2.7 as permitted sender) smtp.mailfrom=bounce@mx.example.com'
  assert.deepEqual(firstAuthenticationResults(fixture({ auth: ar }))!.passDomains, ['mx.example.com'])
})

test('#676 adversarial: an SPF HELO result never proves anything it should not', () => {
  const hold = (auth: string, why: string) => assert.equal(decideDsn(fixture({ auth }), 'mailer-daemon@mx.example.com', known, TRUST).kind, 'hold', why)
  hold('mx.google.com; spf=pass smtp.helo=mail.evil.example', 'attacker HELO passes for its own host: not aligned')
  hold('mx.google.com; spf=softfail smtp.helo=mx.example.com', 'softfail is not pass')
  hold('mx.google.com; spf=neutral smtp.helo=mx.example.com', 'neutral is not pass')
  hold('mx.google.com; spf=none smtp.helo=mx.example.com', 'none is not pass')
  hold('mx.google.com; spf=fail (google.com: smtp.helo=mx.example.com) smtp.helo=mail.evil.example', 'a failed check never counts')
  hold('mx.google.com; spf=pass (google.com: domain of postmaster@smtp.helo=mx.example.com designates) smtp.helo=mail.evil.example', 'a property quoted inside a comment is never read')
  hold('mx.google.com; spf=pass (unbalanced smtp.helo=mx.example.com', 'unbalanced comment: nothing is read')
  hold('mx.google.com; spf=pass smtp.helo=[192.0.2.7]', 'an IP-literal HELO never aligns')
  hold('mx.google.com; spf=pass smtp.helo=', 'empty HELO')
  hold('mx.google.com; spf=pass smtp.helo=example.com.evil.example', 'suffix trick: alignment is on the right-most labels')
  hold('mx.google.com; spf=passed smtp.helo=mx.example.com', 'only the exact result keyword pass')
  hold('mail.evil.example; spf=pass smtp.helo=mx.example.com', 'untrusted authserv-id')
  hold('mx.google.com; spf=pass smtp.helo=\u00ff\ufffd.example', 'non-ASCII junk host')
  // a HELO pass in a deeper (second) header travelled with the message and is injectable
  const deeper = fixture({ auth: 'mx.google.com; spf=none' })
  deeper.headers!.splice(2, 0, { name: 'Authentication-Results', value: HELO_AR })
  assert.equal(decideDsn(deeper, 'mailer-daemon@mx.example.com', known, TRUST).kind, 'hold', 'second header is never trusted')
  // no caller-supplied expected origins: held, whatever the header says
  assert.deepEqual(dsnProvenance(fixture({ auth: HELO_AR }), { trustedAuthservIds: ['mx.google.com'], expectedBounceDomains: [] }), { ok: false, reason: 'no_expected_origins' })
  // huge / pathologically nested header: bounded, never throws, never a false pass
  const nested = 'mx.google.com; spf=pass ' + '('.repeat(5000) + 'x' + ')'.repeat(5000) + ' smtp.helo=mx.example.com'
  assert.equal(decideDsn(fixture({ auth: nested }), 'mailer-daemon@mx.example.com', known, TRUST).kind, 'hold', 'over-nested comments fail closed')
  hold('mx.google.com; ' + 'x'.repeat(200_000) + ' spf=pass smtp.helo=mail.evil.example', 'huge header, unaligned')
  // a soft status stays soft even with a perfect HELO pass
  assert.equal(decideDsn(fixture({ auth: HELO_AR, status: '4.2.2' }), 'mailer-daemon@mx.example.com', known, TRUST).kind, 'soft')
})
