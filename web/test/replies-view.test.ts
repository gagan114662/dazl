import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSyncResult, performReplyAction, SYNC_NOT_CONFIRMED, ACTION_UNCONFIRMED, actionMessage, replyReadingState } from '../lib/outreach/replies-view.ts'

const base = { gmail_status: 'active' as const, gmail_connected: true, read_granted: true, consent: { accepted: true } }

test('#931 on only for active account + read scope + accepted current consent (positive control)', () => {
  assert.equal(replyReadingState(base), 'on')
})

test('#931 revoked consent with read scope still granted is not "on" and needs consent, not reconnect', () => {
  assert.equal(replyReadingState({ ...base, consent: { accepted: false } }), 'consent_needed')
})

test('#931 read scope missing, disconnected, and needs_reconnect are distinct states', () => {
  assert.equal(replyReadingState({ ...base, read_granted: false }), 'read_scope_missing')
  assert.equal(replyReadingState({ ...base, gmail_status: 'none', gmail_connected: false }), 'disconnected')
  assert.equal(replyReadingState({ ...base, gmail_status: 'needs_reconnect' }), 'needs_reconnect')
  // needs_reconnect wins even with consent + scope recorded
  assert.equal(replyReadingState({ ...base, gmail_status: 'needs_reconnect', consent: { accepted: true } }), 'needs_reconnect')
})

test('#931 sync refusal is never reported as Checked replies', () => {
  assert.equal(actionMessage('sync', true, { ok: true, sync: { error: 'reading_not_enabled' } }), 'Replies were not checked: reply reading is off.')
  assert.match(actionMessage('sync', true, { ok: true, sync: { error: 'gmail_unavailable' } }), /not checked/)
  assert.match(actionMessage('sync', true, { ok: true, sync: { error: 'other' } }), /not checked/)
  assert.equal(actionMessage('sync', true, { ok: true, sync: {} }), SYNC_NOT_CONFIRMED, 'an empty sync object is not an observed result (the old test asserted this false success)')
  assert.equal(actionMessage('sync', false, { error: 'Too many requests' }), 'Too many requests')
  assert.equal(actionMessage('consent', true, { ok: true }), '')
})

// PR #959 review: a 2xx whose body is not a valid sync result must never claim "Checked replies".
const ZERO = { threads: 0, replies: 0, optOuts: 0, bounces: 0, consents: 0, reviews: 0 }
test('#931 malformed successful sync responses are not "Checked replies" (the component maps unreadable JSON to {})', () => {
  for (const body of [{}, null, undefined, 'ok', [], { ok: false }, { ok: true }, { ok: true, sync: null }, { ok: true, sync: {} }, { ok: true, sync: [] },
    { ok: true, sync: { ...ZERO, threads: '2' } }, { ok: true, sync: { ...ZERO, replies: -1 } }, { ok: true, sync: { ...ZERO, reviews: 1.5 } }, { ok: true, sync: { ...ZERO, threads: null } },
    { ok: true, sync: { ...ZERO, remaining: 'x' } }, { ok: true, sync: { ...ZERO, error: 5 } }, { ok: false, sync: ZERO }]) {
    assert.equal(actionMessage('sync', true, body), SYNC_NOT_CONFIRMED, JSON.stringify(body))
    assert.doesNotMatch(actionMessage('sync', true, body), /^Checked replies/)
  }
})
test('#931 positive control: a valid zero-thread successful sync is "Checked replies." and refusals keep their own message', () => {
  assert.equal(actionMessage('sync', true, { ok: true, sync: ZERO }), 'Checked replies.')
  assert.equal(actionMessage('sync', true, { ok: true, sync: { ...ZERO, threads: 3, replies: 1, remaining: 0, neverRead: 0, freshAsOf: 1760000000 }, followups: null }), 'Checked replies.')
  assert.equal(actionMessage('sync', true, { ok: true, sync: { ...ZERO, error: 'reading_not_enabled' } }), 'Replies were not checked: reply reading is off.')
  assert.equal(actionMessage('sync', true, { ok: true, sync: { ...ZERO, error: 'gmail_unavailable' } }), 'Replies were not checked: Gmail could not be reached. Try again, or reconnect Gmail.')
  assert.equal(actionMessage('sync', true, { ok: true, sync: { ...ZERO, error: 'x' } }), 'Replies were not checked. Try again later.')
  assert.equal(actionMessage('sync', false, { error: 'Too many requests' }), 'Too many requests')
  assert.equal(actionMessage('sync', false, null), 'Something went wrong')
  assert.equal(isSyncResult(ZERO), true); assert.equal(isSyncResult({ ...ZERO, error: undefined }), true)
})

// The panel's action runner: one POST per click, no retry, no unhandled rejection, a visible message for every failure.
function recordingFetch(plan: (n: number) => Response | Error) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const f = (async (u: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(String(init?.body)) }); const r = plan(calls.length); if (r instanceof Error) throw r; return r }) as typeof fetch
  return { f, calls }
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
test('#931 panel actions: network rejection becomes a visible not-confirmed message, sent once, never retried', async () => {
  for (const [action, want] of [['sync', SYNC_NOT_CONFIRMED], ['revoke', ACTION_UNCONFIRMED], ['consent', ACTION_UNCONFIRMED]] as const) {
    const { f, calls } = recordingFetch(() => new TypeError('Failed to fetch'))
    const r = await performReplyAction(f, action, 'v1')
    assert.deepEqual([r.message, r.reached, calls.length], [want, false, 1], action)
    assert.deepEqual(calls[0].body, { action, accept: true, version: 'v1' }); assert.equal(calls[0].url, '/api/outreach/replies')
  }
})
test('#931 panel actions: server refusal, malformed 2xx and the valid zero-thread success each say what actually happened', async () => {
  const run = async (res: Response, action = 'sync') => { const { f, calls } = recordingFetch(() => res); const r = await performReplyAction(f, action); assert.equal(calls.length, 1, 'one POST, no automatic retry'); return r }
  assert.equal((await run(json({ error: 'Consent not recorded' }, 400), 'consent')).message, 'Consent not recorded')
  assert.equal((await run(json({ error: 'Too many requests' }, 429))).message, 'Too many requests')
  assert.equal((await run(new Response('<html>502</html>', { status: 502 }))).message, 'Something went wrong')
  assert.equal((await run(new Response('not json', { status: 200 }))).message, SYNC_NOT_CONFIRMED, 'unreadable 2xx body')
  assert.equal((await run(json({ ok: true, sync: null }))).message, SYNC_NOT_CONFIRMED)
  assert.equal((await run(json({ ok: true, sync: ZERO }))).message, 'Checked replies.')
  assert.equal((await run(json({ ok: true }), 'revoke')).message, '', 'a mutation succeeds quietly; the panel reloads the real state')
})
