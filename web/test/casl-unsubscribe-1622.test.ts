// #1622 (CASL hardening): every outreach message must carry a working one-click unsubscribe. lib/legal/policy.ts:278
// promises exactly that, but buildMime happily emitted `List-Unsubscribe: <>` for an empty URL - a header no client
// can use, on a send dazl thought was compliant.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMime, type MimeInput } from '../lib/gmail/mime.ts'

const message = (o: Partial<MimeInput> = {}): MimeInput => ({ fromName: 'Dana Ruiz', fromEmail: 'dana@dazl.example', to: 'buyer@example.invalid', subject: 'Hello', body: 'Hi there', messageId: 'dazl.1@dazl.example', unsubscribeUrl: 'https://dazl.ai/u/abc123', ...o })

test('#1622 a message with no usable unsubscribe URL is refused, never sent with an empty List-Unsubscribe', () => {
  for (const bad of ['', '   ', 'dazl.ai/u/abc123', '/u/abc123', 'mailto:unsub@dazl.ai']) {
    assert.throws(() => buildMime(message({ unsubscribeUrl: bad })), /missing_unsubscribe/, `refused: ${JSON.stringify(bad)}`)
  }
})

test('#1622 a valid unsubscribe URL still carries both one-click headers', () => {
  const raw = buildMime(message())
  assert.match(raw, /^List-Unsubscribe: <https:\/\/dazl\.ai\/u\/abc123>$/m)
  assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m)
})

test('#1622 the unsubscribe URL cannot inject a header: CR/LF in it is refused, not flattened', () => {
  for (const bad of ['https://dazl.ai/u/abc\r\nBcc: attacker@example.invalid', 'https://dazl.ai/u/abc \nX-Evil: 1']) {
    assert.throws(() => buildMime(message({ unsubscribeUrl: bad })), /missing_unsubscribe/)
  }
  const raw = buildMime(message())
  assert.doesNotMatch(raw, /^Bcc:/m)
})
