// #1157 part 1: the paid search step (Claude web search) ends in seconds when the provider stops answering, not after the full
// 150 s call limit. The call streams, and only a STALL - no bytes for 20 s - ends it; a healthy multi-search call that keeps
// sending events (pings, blocks) runs on, so long searches are not cut into "counted as billed" stops. Owner decision
// (2026-11-22): stall timeout, not a hard cut. A stalled call was sent, so it stays fail-closed: counted as billed (uncertain).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_SEARCH_MODEL, runClaudeWebSearch } from '../lib/llm/claude-web-search.ts'
import { sseEvents, sseResponse } from './helpers/claude-sse.ts'

const usage = {
  input_tokens: 55_000, output_tokens: 2_500, cache_read_input_tokens: 500, cache_creation_input_tokens: 1500,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 500 },
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
}
const message = {
  model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn', usage,
  content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://court.example/proof/' }] }, { type: 'text', text: 'done' }],
}
const hold = (record: string[]) => ({
  settle: async (amount: number) => { record.push('settle:' + amount.toFixed(6)) },
  uncertain: () => { record.push('uncertain') },
  rejected: async (status: number) => { record.push('rejected:' + status) },
})
// A real-time guard: a call that waits for the old 150 s limit fails the test instead of hanging the run.
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => { const t = setInterval(() => { clearInterval(t); rej(new Error(`still running after ${ms} ms real time`)) }, ms) })])

test('#1157 a search call that goes silent after it started ends at the 20 s stall, counted as billed (uncertain), never 150 s', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const log: string[] = []
    const p = runClaudeWebSearch('not-an-api-key', 'Fixture request', () => hold(log), async (url) =>
      String(url).endsWith('/count_tokens') ? Response.json({ input_tokens: 1500 }) : sseResponse(sseEvents(message), { endAfter: 1 }))
    const settled = p.then(() => 'resolved', e => (e as { code?: string; detail?: string }))
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    mock.timers.tick(19_000)
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r))
    assert.deepEqual(log, [], 'still waiting at 19 s: no stall yet')
    mock.timers.tick(1_100)
    const e = await within(settled, 2_000)
    assert.equal((e as { code?: string }).code, 'request_uncertain')
    assert.deepEqual(log, ['uncertain'])
  } finally { mock.timers.reset() }
})

test('#1157 a healthy long search that keeps sending events (15 s apart, ~75 s total) runs to the end and settles its real cost', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const log: string[] = []
    const events = sseEvents(message)
    const bodies: unknown[] = []
    const p = runClaudeWebSearch('not-an-api-key', 'Fixture request', () => hold(log), async (url, init) => {
      if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 1500 })
      bodies.push(JSON.parse(String(init?.body)))
      return sseResponse(events, { gapsMs: events.map(() => 15_000) })
    })
    const settled = p.then(r => r, e => e)
    for (let step = 0; step < events.length + 2; step++) {
      for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r))
      mock.timers.tick(15_000)
    }
    const r = await within(settled, 2_000) as { outcome?: string; citedUrls?: string[] }
    assert.equal(r.outcome, 'ok', JSON.stringify(r))
    assert.deepEqual(r.citedUrls, ['https://court.example/proof/'])
    assert.deepEqual(log, ['settle:0.229400'])
    assert.equal((bodies[0] as { stream?: boolean }).stream, true, 'the search call streams')
  } finally { mock.timers.reset() }
})

test('#1157 an error event mid-stream (overloaded) after the call was sent is counted as billed (uncertain), no second request', async () => {
  const log: string[] = []
  let sends = 0
  const events = sseEvents(message)
  const e = await runClaudeWebSearch('not-an-api-key', 'Fixture request', () => hold(log), async (url) => {
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 1500 })
    sends++
    return sseResponse([events[0], 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'])
  }).then(() => null, err => err as { code?: string })
  assert.equal(e?.code, 'request_uncertain')
  assert.deepEqual(log, ['uncertain']); assert.equal(sends, 1)
})

const run = (body: () => Response, log: string[]) => runClaudeWebSearch('not-an-api-key', 'Fixture request', () => hold(log), async (url) =>
  String(url).endsWith('/count_tokens') ? Response.json({ input_tokens: 1500 }) : body())

test('#1157 a usage field the final message_delta sends as null keeps the count message_start carried (never a reset to unknown)', async () => {
  const log: string[] = []
  const events = sseEvents(message)
  const i = events.findIndex(e => e.startsWith('event: message_delta'))
  const delta = JSON.parse(events[i].split('data: ')[1])
  // the documented delta type allows null for the input-side counts: they were reported at message_start
  delta.usage = { ...delta.usage, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null }
  events[i] = `event: message_delta\ndata: ${JSON.stringify(delta)}\n\n`
  const r = await run(() => sseResponse(events), log) as { outcome?: string }
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(log, ['settle:0.229400'])
})

test('#1157 a stream that closes after a complete message_delta but before message_stop is counted as billed (uncertain)', async () => {
  const log: string[] = []
  const events = sseEvents(message).filter(e => !e.startsWith('event: message_stop'))
  let sends = 0
  const e = await run(() => { sends++; return sseResponse(events) }, log).then(() => null, err => err as { code?: string })
  assert.equal(e?.code, 'request_uncertain')
  assert.deepEqual(log, ['uncertain']); assert.equal(sends, 1)
})

test('#1157 an oversized stream (over 4 MiB) is cut and counted as billed (uncertain), never parsed', async () => {
  const log: string[] = []
  const events = sseEvents(message)
  const filler = `event: ping\ndata: {"type":"ping","pad":"${'x'.repeat(4 * 1024 * 1024)}"}\n\n`
  const e = await run(() => sseResponse([events[0], filler, ...events.slice(1)]), log).then(() => null, err => err as { code?: string })
  assert.equal(e?.code, 'request_uncertain')
  assert.deepEqual(log, ['uncertain'])
})

for (const [name, body] of [
  ['malformed event data mid-stream', () => sseResponse([sseEvents(message)[0], 'event: content_block_start\ndata: {"type":"content_block_start",\n\n'])],
  ['a plain JSON 200 body to a streaming request (no event stream)', () => Response.json(message)],
] as [string, () => Response][]) {
  test(`#1157 ${name} after the call was sent is counted as billed (uncertain), one send, no settle`, async () => {
    const log: string[] = []
    let sends = 0
    const e = await run(() => { sends++; return body() }, log).then(() => null, err => err as { code?: string })
    assert.equal(e?.code, 'request_uncertain')
    assert.deepEqual(log, ['uncertain']); assert.equal(sends, 1)
  })
}

test('#1157 a skipped block index does not leave a hole that breaks the reader after settle', async () => {
  const log: string[] = []
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  const events = sseEvents({ ...message, content: [] }).filter(e => !e.startsWith('event: content_block'))
  const blocks = [ev('content_block_start', { type: 'content_block_start', index: 1, content_block: message.content[0] }), ev('content_block_stop', { type: 'content_block_stop', index: 1 })]
  const r = await run(() => sseResponse([events[0], ...blocks, ...events.slice(1)]), log) as { outcome?: string; citedUrls?: string[] }
  assert.equal(r.outcome, 'ok')
  assert.deepEqual(log, ['settle:0.229400'])
})

for (const [name, response] of [
  ['headers arrive but no byte follows', () => Promise.resolve(sseResponse([], { endAfter: 0 }))],
  ['the response headers never arrive', null],
] as [string, (() => Promise<Response>) | null][]) {
  test(`#1157 ${name}: the call ends at the 20 s stall, counted as billed (uncertain)`, async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const log: string[] = []
      const p = runClaudeWebSearch('not-an-api-key', 'Fixture request', () => hold(log), async (url, init) => {
        if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: 1500 })
        if (response) return response()
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
      })
      const settled = p.then(() => 'resolved', e => e as { code?: string })
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
      mock.timers.tick(20_100)
      const e = await within(settled, 2_000)
      assert.equal((e as { code?: string }).code, 'request_uncertain')
      assert.deepEqual(log, ['uncertain'])
    } finally { mock.timers.reset() }
  })
}
