import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmedSendResult, gmailSend, GmailSendError, GmailUnconfirmedSend } from '../lib/gmail/oauth.ts'

// A 2xx from Gmail is only a confirmed handoff when the body carries a usable message id. Synthetic responses only; no network.
const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
const send = (body: string, status?: number) => gmailSend('synthetic-token', 'synthetic-mime', reply(body, status))

test('invalid success bodies are an unconfirmed outcome (not sent, not a definite refusal)', async () => {
  for (const [why, body] of [
    ['empty object', '{}'], ['invalid JSON', 'not json at all'], ['empty body', ''], ['array', '[]'], ['null', 'null'], ['string', '"ok"'],
    ['blank id', '{"id":""}'], ['whitespace id', '{"id":"   "}'], ['numeric id', '{"id":12345}'], ['null id', '{"id":null}'], ['object id', '{"id":{"a":1}}'],
    ['id with spaces', '{"id":"abc def"}'], ['id that is a url', '{"id":"https://evil.example/x"}'], ['oversized id', `{"id":"${'a'.repeat(200)}"}`],
  ] as const) {
    await assert.rejects(send(body), (e: unknown) => e instanceof GmailUnconfirmedSend && !(e instanceof GmailSendError), why)
  }
})

test('a valid id is confirmed; an unusable threadId is dropped, never guessed', async () => {
  assert.deepEqual(await send('{"id":"18c0ffee00112233","threadId":"18c0ffee00112233"}'), { id: '18c0ffee00112233', threadId: '18c0ffee00112233' })
  assert.deepEqual(await send('{"id":"18c0ffee00112233"}'), { id: '18c0ffee00112233' })
  assert.deepEqual(await send('{"id":"18c0ffee00112233","threadId":42}'), { id: '18c0ffee00112233' })
  assert.deepEqual(await send('{"id":" 18c0ffee00112233 ","threadId":""}'), { id: '18c0ffee00112233' })
})

test('refusal statuses stay definite GmailSendErrors, unchanged', async () => {
  for (const s of [400, 401, 403, 404, 429, 500, 503]) await assert.rejects(send('{"id":"18c0ffee00112233"}', s), (e: unknown) => e instanceof GmailSendError && e.status === s)
})

test('confirmedSendResult guards injected transports too', () => {
  for (const bad of [undefined, null, 'x', 7, [], {}, { id: '' }, { id: 1 }, { id: ' ' }, { threadId: 'abc' }]) assert.throws(() => confirmedSendResult(bad), GmailUnconfirmedSend)
  assert.deepEqual(confirmedSendResult({ id: 'gm1', threadId: 'th1' }), { id: 'gm1', threadId: 'th1' })
})
