import { EventEmitter } from 'node:events'
import https from 'node:https'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fundingRoundFor } from '../lib/signals/funding-round.ts'

// Public-looking address intentionally never contacted. The fake https driver exercises the actual guarded
// HTML parsing/failure decisions instead of injecting a replacement funding reader; fetch traps both paid services.
const article = 'https://93.184.216.34/funding'
const rich = '<html><body><article><p>Acme Robotics raises $5M Seed round.</p><p>' + 'The company confirmed the round in its own announcement. '.repeat(10) + '</p></article></body></html>'
const event = { url: article, title: 'Acme Robotics announces funding', date: '2026-11-16', company: 'Acme Robotics', amount: null, stage: null }
const today = new Date('2026-11-19T00:00:00Z')

async function witness(status: number, html: string, paidVendors = '', overrides: { amount?: string; stage?: string } = {}) {
  const http = https.request
  const fetch = globalThis.fetch
  const fixture = {
    DAZL_PAID_VENDORS: paidVendors,
    SCAN_RENDER_URL: 'https://render.invalid',
    JINA_READER_URL: 'https://reader.invalid',
  }
  const originalEnv = Object.fromEntries(Object.keys(fixture).map(k => [k, process.env[k]]))
  const direct: string[] = [], thirdParty: string[] = []
  Object.assign(process.env, fixture)
  try {
    https.request = ((url: URL, _options: RequestOptions, callback: (res: IncomingMessage) => void) => {
      direct.push(String(url))
      assert.equal(String(url), article)
      const req = new EventEmitter()
      return Object.assign(req, {
        destroy() {},
        end() {
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), { statusCode: status, headers: { 'content-type': 'text/html' }, destroy() {} })
            callback(res as unknown as IncomingMessage)
            res.emit('data', Buffer.from(html))
            res.emit('end')
          })
        },
      }) as unknown as ClientRequest
    }) as typeof https.request
    globalThis.fetch = async (input, init) => {
      thirdParty.push(String(input))
      if (String(input) === 'https://render.invalid/content') {
        assert.equal(init?.method, 'POST')
        return new Response(rich)
      }
      if (String(input) === 'https://reader.invalid/' + article) return new Response('Acme Robotics raises $7M Series A.')
      throw new Error('unexpected synthetic third-party endpoint')
    }
    const result = await fundingRoundFor('Acme Robotics', [{ ...event, ...overrides }], { now: today })
    return { direct, thirdParty, result }
  } finally {
    https.request = http
    globalThis.fetch = fetch
    for (const [key, old] of Object.entries(originalEnv)) { if (old === undefined) delete process.env[key]; else process.env[key] = old }
  }
}

test('funding default reads the directly available publisher evidence and retains its citation', async () => {
  const x = await witness(200, rich)
  assert.deepEqual(x.direct, [article])
  assert.deepEqual(x.thirdParty, [])
  assert.deepEqual(x.result, { date: event.date, url: article, amount: '$5M', stage: 'Seed', daysAgo: 3, matched: event.company })
})

test('funding default never sends a blocked or JavaScript-shell article to a configured renderer or Jina', async () => {
  for (const [status, body] of [[403, 'forbidden'], [200, '<div id="root"></div><script src="/app.js"></script>']] as const) {
    const x = await witness(status, body, 'apollo', { amount: '$2M' })
    assert.deepEqual(x.direct, [article])
    assert.deepEqual(x.thirdParty, [])
    assert.equal(x.result?.url, article)
    assert.equal(x.result?.amount, '$2M')
    assert.equal(x.result?.stage, null)
  }
})

test('funding article reading still honors explicitly named Jina', async () => {
  const x = await witness(403, 'blocked', 'jina')
  assert.deepEqual(x.direct, [])
  assert.deepEqual(x.thirdParty, ['https://reader.invalid/' + article])
  assert.equal(x.result?.amount, '$7M')
  assert.equal(x.result?.stage, 'Series A')
  assert.equal(x.result?.url, article)
})
