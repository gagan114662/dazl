// #1088: OPS_ALERT_WEBHOOK_URL can be a Telegram bot URL. Telegram accepts { chat_id, text } only, so every sender builds its
// request through lib/ops/alert-destination.ts. Pure tests plus the app's own error hook with a stand-in fetch. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alertDestinationProblem, alertRequest } from '../lib/ops/alert-destination.ts'
import { alertText, makeAlertHook, outboundRecord, toRecord } from '../lib/ops/errors.ts'

const TG = 'https://api.telegram.org/bot123456:AAExampleTokenNotReal/sendMessage?chat_id=-1001234567890'

test('a Telegram bot URL gets { chat_id, text } on the URL without its query; nothing else is sent', () => {
  const r = alertRequest(TG, { level: 'error', problems: ['newest backup is 9000s old'], host: 'box' }, 'dazl backup problem on box:\n- newest backup is 9000s old')!
  assert.equal(r.url, 'https://api.telegram.org/bot123456:AAExampleTokenNotReal/sendMessage')
  assert.deepEqual(JSON.parse(r.body), { chat_id: -1001234567890, text: 'dazl backup problem on box:\n- newest backup is 9000s old', disable_web_page_preview: true })
  assert.deepEqual(JSON.parse(alertRequest('https://api.telegram.org/botX:Y/sendMessage?chat_id=@dazl_ops', {}, 'hi')!.body).chat_id, '@dazl_ops')
  // Telegram's limit is 4096 characters: a long alert is cut, never rejected
  const long = JSON.parse(alertRequest(TG, {}, 'x'.repeat(10_000))!.body).text as string
  assert.ok(long.length <= 4096); assert.match(long, /\(cut\)$/)
})

test('any other https URL gets the structured JSON plus a Slack-compatible text', () => {
  const r = alertRequest('https://hooks.slack.example/services/T/B/x', { type: 'backup_check', ok: false, problems: ['p'] }, 'summary')!
  assert.equal(r.url, 'https://hooks.slack.example/services/T/B/x')
  assert.deepEqual(JSON.parse(r.body), { text: 'summary', type: 'backup_check', ok: false, problems: ['p'] })
})

test('an unusable destination is null, with a reason that never holds the URL or the token', () => {
  for (const [u, why] of [[undefined, /not set/], ['http://plain.example/x', /not an https URL/], ['https://', /not a URL/],
    ['https://api.telegram.org/bot123:TOKENVALUE/sendMessage', /no valid chat_id/], ['https://api.telegram.org/bot123:TOKENVALUE/sendMessage?chat_id=', /no valid chat_id/],
    ['https://api.telegram.org/bot123:TOKENVALUE/sendMessage?chat_id=not a chat', /no valid chat_id/], ['https://api.telegram.org/bot123:TOKENVALUE/getUpdates?chat_id=5', /must be https:\/\/api\.telegram\.org\/bot<token>\/sendMessage/]] as const) {
    const p = alertDestinationProblem(u); assert.match(p ?? '', why, String(u)); assert.ok(!(p ?? '').includes('TOKENVALUE'))
    assert.equal(alertRequest(u, {}, 'x'), null, String(u))
  }
  // a stray slash or a trailing-dot host is still Telegram: refused or shaped, never sent the generic JSON
  assert.equal(alertRequest('https://api.telegram.org/bot1:T/sendMessage/?chat_id=1', {}, 'x'), null)
  assert.deepEqual(Object.keys(JSON.parse(alertRequest('https://api.telegram.org./bot1:T/sendMessage?chat_id=1', {}, 'x')!.body)).sort(), ['chat_id', 'disable_web_page_preview', 'text'])
  // a chat id too long for a JSON number stays exact, as a string
  assert.equal(JSON.parse(alertRequest('https://api.telegram.org/bot1:T/sendMessage?chat_id=12345678901234567890', {}, 'x')!.body).chat_id, '12345678901234567890')
  assert.equal(alertDestinationProblem(TG), null); assert.equal(alertDestinationProblem('https://hooks.example/x'), null)
})

const record = () => toRecord(new TypeError('boom at user@example.com'), { source: 'route', where: '/api/leads', method: 'GET' })
test("the app's error hook: Telegram gets a readable text built from the allowlisted record; a webhook gets the record plus that text", async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const f = (async (u: string, init: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(String(init.body)) }); return new Response('ok') }) as unknown as typeof fetch
  const dep = { environment: 'production', release: '7a1d2b310764f249c174b6d8d92897cf99799264' }
  makeAlertHook({ url: TG, fetchImpl: f, deployment: dep })(record())
  makeAlertHook({ url: 'https://hooks.example.test/x', fetchImpl: f, deployment: dep })(record())
  await new Promise(r => setTimeout(r, 20))
  assert.equal(calls.length, 2)
  const [tg, hook] = calls
  assert.equal(tg.url, 'https://api.telegram.org/bot123456:AAExampleTokenNotReal/sendMessage')
  assert.deepEqual(Object.keys(tg.body).sort(), ['chat_id', 'disable_web_page_preview', 'text'])
  const text = tg.body.text as string
  assert.match(text, /^dazl production error: TypeError in route \/api\/leads \(GET\)\n/); assert.match(text, /release 7a1d2b31/); assert.match(text, /fingerprint [0-9a-f]+/)
  assert.ok(!/boom|example\.com/.test(text), 'the message text is never sent, as before')
  for (const c of calls) assert.ok(!/boom|user@example\.com/.test(JSON.stringify(c.body)), 'nothing from the error message reaches either destination')
  assert.equal(hook.url, 'https://hooks.example.test/x'); assert.equal(String(hook.body.text).split('\n').slice(0, -1).join('\n'), text.split('\n').slice(0, -1).join('\n'), 'the same text (the last line is each record\'s own time)'); assert.equal(hook.body.environment, 'production'); assert.equal((hook.body.error as { type: string }).type, 'TypeError')
  assert.equal(alertText(outboundRecord(record(), dep)).split('\n')[0], 'dazl production error: TypeError in route /api/leads (GET)')
})

test('a Telegram URL with no chat_id sends nothing (it would be rejected every time)', async () => {
  let n = 0
  makeAlertHook({ url: 'https://api.telegram.org/bot1:T/sendMessage', fetchImpl: (async () => { n++; return new Response('ok') }) as unknown as typeof fetch })(record())
  await new Promise(r => setTimeout(r, 20)); assert.equal(n, 0)
})
