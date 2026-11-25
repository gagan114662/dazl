import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRIVACY } from '../lib/legal/policy.ts'

// #1818: /privacy is read by customers, not by whoever runs the servers. The "Service providers" section described
// where error reports go as an "operator alert channel (for example a Telegram bot the operator owns)", which a
// reader cannot follow. It now says where they go in plain words; the disclosure itself must not change.
const privacyText = PRIVACY.flatMap((section) => section.paragraphs).join('\n')

test('#1818 the privacy text says error alerts go to the dazl team, in plain words', () => {
  assert.match(privacyText, /error alerts sent to the dazl team/i)
})

test('#1818 the privacy text keeps the disclosure of what an error report carries', () => {
  assert.match(privacyText, /carry only the error type, code locations and a request id/)
  assert.match(privacyText, /never messages, account identifiers, request bodies or personal data/)
  assert.match(privacyText, /The server's own error log keeps the fuller scrubbed record/)
})

test('#1818 the operator jargon is gone from the privacy text', () => {
  assert.doesNotMatch(privacyText, /operator alert channel/i)
  assert.doesNotMatch(privacyText, /Telegram bot/i)
  assert.doesNotMatch(privacyText, /\bthe operator\b/i)
})

// The jargon went, the provider stayed: lib/legal/policy.ts lists api.telegram.org in API_HOSTS, and
// legal-policy.test.ts fails if the policy does not name a host the code calls. Hiding it here would hide a provider.
test('#1818 the alert provider is still named, in plain words', () => {
  assert.match(privacyText, /through Telegram/)
})
