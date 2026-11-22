import assert from 'node:assert/strict'
import test from 'node:test'
import { CLAUDE_SEARCH_MODEL, claudeSearchEstimate, parseClaudeSearchUsage, runClaudeWebSearch } from '../lib/llm/claude-web-search.ts'
import { asStreaming } from './helpers/claude-sse.ts'
// #1157: the search call streams; each fixture's final Message is served as the documented SSE event sequence.
const runStreaming = (...[k, p, reserve, f, policy]: Parameters<typeof runClaudeWebSearch>) => runClaudeWebSearch(k, p, reserve, f ? asStreaming(f) : f, policy)

const usage = {
  input_tokens: 55_000, output_tokens: 2_500, cache_read_input_tokens: 500, cache_creation_input_tokens: 1500,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 500 },
  server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
}
const response = (stop = 'end_turn') => ({
  model: CLAUDE_SEARCH_MODEL, stop_reason: stop, usage,
  content: [{ type: 'web_search_tool_result', content: [
    { type: 'web_search_result', url: 'https://court.example/proof/' },
    { type: 'web_search_result', url: 'https://court.example/proof/' },
    { type: 'web_search_result', url: 'https://person@court.example/private' },
    { type: 'web_search_result', url: 'http://plain.invalid' },
  ] }, { type: 'text', text: 'do not trust invented https://invented.invalid/' }],
})
const counted = 1_500
const key = 'not-an-api-key'
const prompt = 'Fixture request about roofing services in an arbitrary place'
const hold = (record: string[]) => ({
  settle: async (amount: number) => { record.push('settle:' + amount.toFixed(6)) },
  uncertain: () => { record.push('uncertain') },
  rejected: async (status: number) => { record.push('rejected:' + status) },
})
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected

test('soft estimate known model, verified count input, assumptions transparently separate', () => {
  assert.deepEqual(claudeSearchEstimate(counted), {
    model: CLAUDE_SEARCH_MODEL, countedInputTokens: 1500, assumedSearchInputTokens: 50_000, assumedToolOverheadTokens: 1000,
    maxOutputTokens: 3000, maxSearches: 2, estimatedUsd: 0.2234, hard: false,
  })
  assert.throws(() => claudeSearchEstimate(1.1), code('count_failed'))
})

test('usage settlement prices aggregate input, output, cache TTLs and the actual search count, not a result-only token guess', () => {
  assert.deepEqual(parseClaudeSearchUsage(response()), {
    inputTokens: 55000, outputTokens: 2500, cacheReadTokens: 500, cacheWrite5mTokens: 1000, cacheWrite1hTokens: 500,
    searches: 2, usd: 0.2294,
  })
  for (const bad of [
    { ...response(), model: 'claude-sonnet-4-5' },
    { ...response(), usage: { ...usage, cache_creation: undefined } },
    { ...response(), usage: { ...usage, cache_creation_input_tokens: 2000 } },
    { ...response(), usage: { ...usage, cache_read_input_tokens: undefined } },
    { ...response(), usage: { ...usage, server_tool_use: {} } },
    { ...response(), usage: { ...usage, server_tool_use: { ...usage.server_tool_use, web_fetch_requests: 1 } } },
    { ...response(), usage: { ...usage, inference_geo: 'not_available' } },
  ]) assert.equal(parseClaudeSearchUsage(bad), null)
})

test('count request includes the fixed prompt, not server tools; reserve before one paid send, no pause/max_tokens continuation, no post-estimate clamping actual', async () => {
  for (const stop of ['end_turn', 'pause_turn', 'max_tokens']) {
    const log: string[] = []
    const calls: { url: string; body: unknown }[] = []
    const result = await runStreaming(key, prompt, e => {
      log.push('reserve:' + e.estimatedUsd)
      return hold(log)
    }, async (url, init) => {
      const u = String(url)
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init.headers).get('anthropic-beta'), null)
      calls.push({ url: u, body: JSON.parse(String(init.body)) })
      log.push(u.endsWith('/count_tokens') ? 'count' : 'send')
      return Response.json(u.endsWith('/count_tokens') ? { input_tokens: counted } : response(stop))
    })
    assert.deepEqual(log, ['count', 'reserve:0.2234', 'send', 'settle:0.229400'])
    assert.deepEqual(calls.map(c => c.url), ['https://api.anthropic.com/v1/messages/count_tokens', 'https://api.anthropic.com/v1/messages'])
    const sizing = calls[0].body as object
    assert.deepEqual(calls[1].body, { ...sizing, max_tokens: 3000, service_tier: 'standard_only', stream: true, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }] })
    assert.deepEqual(sizing, { model: CLAUDE_SEARCH_MODEL, messages: [{ role: 'user', content: prompt }] })
    assert.deepEqual(result.citedUrls, ['https://court.example/proof/'])
    assert.equal(result.outcome, stop === 'end_turn' ? 'ok' : 'partial')
  }
})

test('invalid count and smaller caller budget stop before paid transport; no reserve if count failed', async () => {
  let n = 0
  const rejected = Error('owner_pool_limit')
  await assert.rejects(runStreaming(key, prompt, () => { throw rejected }, async () => { n++; return Response.json({ input_tokens: counted }) }), e => e === rejected)
  assert.equal(n, 1)
  await assert.rejects(runStreaming(key, prompt, () => assert.fail('must not reserve'), async () => {
    n++; return Response.json({ input_tokens: '100' })
  }), code('count_failed'))
  assert.equal(n, 2)
})

test('network/status/usage uncertainty retains reservation, no retry or candidate, known limit violation is honestly settled', async () => {
  for (const [scenario, error, mark] of [
    ['network', 'request_uncertain', 'uncertain'],
    ['status', 'key_rejected', 'rejected:401'],
    ['usage', 'usage_uncertain', 'uncertain'],
    ['over', 'provider_limit_violation', 'settle:0.239400'],
  ]) {
    let n = 0
    const log: string[] = []
    await assert.rejects(runStreaming(key, prompt, () => hold(log), async () => {
      if (++n === 1) return Response.json({ input_tokens: counted })
      if (scenario === 'network') throw Error('timeout')
      if (scenario === 'status') return new Response(null, { status: 401 })
      if (scenario === 'usage') return Response.json({ ...response(), usage: undefined })
      return Response.json({ ...response(), usage: { ...usage, server_tool_use: { web_search_requests: 3 } } })
    }), code(error))
    assert.deepEqual(log, [mark])
    assert.equal(n, 2)
  }
})

test('an Anthropic request-limit rejection releases via the typed 429 callback; ambiguous 429s retain the hold, no retries', async () => {
  for (const [body, requestId, expected] of [
    [{ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' }, request_id: 'req_fixture' }, 'req_fixture', 'rejected:429'],
    [{ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit exceeded' }, request_id: 'req_fixture' }, '', 'uncertain'],
    [{ type: 'error', error: { type: 'api_error', message: 'Other' }, request_id: 'req_fixture' }, 'req_fixture', 'uncertain'],
    ['gateway rate limiting', 'req_fixture', 'uncertain'],
  ] as const) {
    const log: string[] = []
    let n = 0
    await assert.rejects(runStreaming(key, prompt, () => hold(log), async () => {
      if (++n === 1) return Response.json({ input_tokens: counted })
      return Response.json(body, { status: 429, headers: { 'request-id': requestId } })
    }), code(expected === 'uncertain' ? 'request_uncertain' : 'rate_limited'))
    assert.equal(n, 2)
    assert.deepEqual(log, [expected])
  }
})

// Synthetic identifiers/urls and numbers; built from the Anthropic Messages + Web Search response schemas.
const fullStandardResponse = {
  id: 'msg_fixture', type: 'message', role: 'assistant', model: CLAUDE_SEARCH_MODEL, stop_reason: 'end_turn',
  stop_sequence: null, stop_details: null, container: null, diagnostics: null,
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: { query: 'roofing' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [
      { type: 'web_search_result', title: 'Company news', url: 'https://roof.example/news', page_age: null, encrypted_content: 'fixture' },
    ] },
    { type: 'text', text: 'Published company news.', citations: [
      { type: 'web_search_result_location', url: 'https://roof.example/news', title: 'Company news', encrypted_index: 'fixture', cited_text: 'Published company news.' },
    ] },
  ],
  usage: {
    input_tokens: 8_000, output_tokens: 200, output_tokens_details: { thinking_tokens: 0 },
    cache_read_input_tokens: 500, cache_creation_input_tokens: 1500,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 500 },
    server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    service_tier: 'standard', speed: 'standard', inference_geo: 'global',
  },
}

test('supported standard-only request settles a full documented-shape web-search response', async () => {
  const marks: string[] = []
  let calls = 0
  const result = await runStreaming(key, prompt, () => hold(marks), async (url, init) => {
    const body = JSON.parse(String(init?.body))
    calls++
    if (String(url).endsWith('/count_tokens')) {
      assert.equal('service_tier' in body, false)
      return Response.json({ input_tokens: counted })
    }
    // Mirrors vendor auto-tier behavior for an eligible existing Priority Tier customer.
    const service_tier = body.service_tier === 'standard_only' ? 'standard' : 'priority'
    return Response.json({ ...fullStandardResponse, usage: { ...fullStandardResponse.usage, service_tier } })
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.citedUrls, ['https://roof.example/news'])
  assert.deepEqual(marks, ['settle:0.043900'])
})

test('unexpected returned model, tier or nullable critical counters stay held despite a complete tool result', async () => {
  for (const body of [
    { ...fullStandardResponse, model: 'claude-sonnet-4-6' },
    { ...fullStandardResponse, usage: { ...fullStandardResponse.usage, service_tier: 'priority' } },
    { ...fullStandardResponse, usage: { ...fullStandardResponse.usage, cache_read_input_tokens: null } },
    { ...fullStandardResponse, usage: { ...fullStandardResponse.usage, server_tool_use: null } },
  ]) {
    let calls = 0
    const marks: string[] = []
    await assert.rejects(runStreaming(key, prompt, () => hold(marks), async () => {
      return Response.json(++calls === 1 ? { input_tokens: counted } : body)
    }), code('usage_uncertain'))
    assert.equal(calls, 2)
    assert.deepEqual(marks, ['uncertain'])
  }
})

test('native paid transport abort leaves the reservation held and does not retry', async t => {
  const deadlines: number[] = []
  const timedOut = new AbortController()
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms)
    return timedOut.signal
  })
  const marks: string[] = []
  let calls = 0
  await assert.rejects(runStreaming(key, prompt, () => hold(marks), async (_url, init) => {
    if (++calls === 1) return Response.json({ input_tokens: counted })
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      assert.ok(signal)
      // #1157: the call's signal combines the per-call deadline with the stall timer; the deadline still aborts it
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      timedOut.abort(new DOMException('offline timeout', 'TimeoutError'))
    })
  }), e => (e as { code?: string; diagnostic?: string }).code === 'request_uncertain' &&
    (e as { diagnostic?: string }).diagnostic === 'timeout')
  assert.equal(calls, 2)
  assert.equal(deadlines[0], 20_000)
  assert.ok(deadlines[1] > 0 && deadlines[1] <= 150_000)
  assert.equal(deadlines.length, 2, 'one count deadline and one per-call deadline, no retry')
  assert.deepEqual(marks, ['uncertain'])
})

test('fixed no-cache Messages request settles the official sparse Web Search usage shape', async () => {
  const response = { ...fullStandardResponse, type: 'message', role: 'assistant',
    usage: { input_tokens: 6039, output_tokens: 931, server_tool_use: { web_search_requests: 1 } },
  }
  assert.equal(parseClaudeSearchUsage(response), null, 'the general parser cannot assume what the request sent')
  const marks: string[] = []
  let calls = 0
  const result = await runStreaming(key, prompt, () => hold(marks), async (_url, init) => {
    if (++calls === 1) return Response.json({ input_tokens: counted })
    const sent = JSON.parse(String(init?.body))
    assert.equal('cache_control' in sent, false)
    assert.equal('thinking' in sent, false)
    assert.deepEqual(sent.messages, [{ role: 'user', content: prompt }])
    assert.ok(sent.tools.every((tool: object) => !Object.hasOwn(tool, 'cache_control')))
    return Response.json(response)
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.citedUrls, ['https://roof.example/news'])
  assert.deepEqual(marks, ['settle:0.042082'])
})

test('unsafe 2xx usage retains the full hold and exposes only the exact closed diagnostic, never response values', async () => {
  const sparse = { input_tokens: 6039, output_tokens: 931, server_tool_use: { web_search_requests: 1 } }
  const message = { ...fullStandardResponse, type: 'message', role: 'assistant', usage: sparse }
  for (const [body, diagnostic] of [
    [{ ...message, usage: null }, 'usage_envelope'],
    [{ ...message, model: 'private-provider-data' }, 'usage_model'],
    [{ ...message, usage: { ...sparse, inference_geo: { value: 'private-provider-data' } } }, 'usage_geo'],
    [{ ...message, usage: { ...sparse, speed: 'fast' } }, 'usage_speed'],
    [{ ...message, usage: { ...sparse, service_tier: 'priority' } }, 'usage_tier'],
    [{ ...message, usage: { ...sparse, input_tokens: null } }, 'usage_input_count'],
    [{ ...message, usage: { ...sparse, output_tokens: null } }, 'usage_output_count'],
    [{ ...message, usage: { ...sparse, server_tool_use: null } }, 'usage_search_count'],
    [{ ...message, usage: { ...sparse, server_tool_use: { web_fetch_requests: 0 } } }, 'usage_search_count'],
    [{ ...message, usage: { ...sparse, server_tool_use: { web_search_requests: 1, private_counter: null } } }, 'usage_other_tool'],
    [{ ...message, usage: { ...sparse, cache_read_input_tokens: 1 } }, 'usage_cache_totals'],
    [{ ...message, usage: { ...sparse, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: { ephemeral_5m_input_tokens: 1 } } }, 'usage_cache_totals'],
    [{ ...message, usage: { ...sparse, cache_creation: { ephemeral_1h_input_tokens: 20 } } }, 'usage_cache_totals'],
    [{ ...message, role: 'private-provider-data' }, 'usage_cache_totals'],
    [{ ...message, usage: { ...sparse, cache_read_input_tokens: 0, cache_creation_input_tokens: 1 } }, 'usage_cache_split'],
  ] as const) {
    let requests = 0
    const marks: string[] = []
    await assert.rejects(runStreaming(key, prompt, () => hold(marks), async () =>
      Response.json(++requests === 1 ? { input_tokens: counted } : body)
    ), e => {
      const err = e as { code?: string; diagnostic?: string; message?: string }
      assert.equal(err.code, 'usage_uncertain')
      assert.equal(err.diagnostic, diagnostic)
      assert.equal(err.message, 'usage_uncertain')
      return true
    })
    assert.equal(requests, 2)
    assert.deepEqual(marks, ['uncertain'])
  }
})


test('the pinned pre-4.6 uncached Messages request prices documented nullable/zero cache fields and us/global geo at standard rates', async () => {
  const usage = { input_tokens: 8_000, output_tokens: 200, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }
  for (const cache of [
    { cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null },
    { cache_read_input_tokens: 0, cache_creation_input_tokens: null, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
    { cache_creation_input_tokens: 0 },
  ]) {
    for (const geo of ['us', 'global']) {
      const marks: string[] = []
      let sent = 0
      const result = await runStreaming(key, prompt, () => hold(marks), async (_url, init) => {
        if (++sent === 1) return Response.json({ input_tokens: counted })
        assert.equal('inference_geo' in JSON.parse(String(init?.body)), false)
        return Response.json({ ...fullStandardResponse, type: 'message', role: 'assistant', usage: { ...usage, ...cache, inference_geo: geo } })
      })
      assert.equal(result.usage.usd, 0.037)
      assert.deepEqual(marks, ['settle:0.037000'])
      assert.equal(sent, 2)
    }
  }
})

test('explicitly zero searches with nullable cache counters settles only tokens and produces no sources', async () => {
  const marks: string[] = []
  let sent = 0
  const result = await runStreaming(key, prompt, () => hold(marks), async () => {
    if (++sent === 1) return Response.json({ input_tokens: counted })
    return Response.json({ ...fullStandardResponse, type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'No search was needed.' }],
      usage: { input_tokens: 8_000, output_tokens: 200, cache_read_input_tokens: null,
        cache_creation_input_tokens: null, cache_creation: null, server_tool_use: { web_search_requests: 0 } } })
  })
  assert.equal(result.usage.searches, 0)
  assert.deepEqual(marks, ['settle:0.027000'])
  assert.deepEqual(result.citedUrls, [])
  assert.equal(result.outcome, 'unavailable')
})

test('pinned pre-4.6 request settles Toronto-shaped counters despite an unrecognized geo string', async () => {
  const marks: string[] = []
  let sent = 0
  const result = await runStreaming(key, prompt, () => hold(marks), async (_url, init) => {
    assert.equal(Object.hasOwn(JSON.parse(String(init?.body)), 'inference_geo'), false)
    if (++sent === 1) return Response.json({ input_tokens: counted })
    return Response.json({ ...fullStandardResponse, type: 'message', role: 'assistant',
      content: [{ type: 'text', text: 'No cited sources in this billing fixture.' }],
      usage: { inference_geo: 'synthetic_unrecognized_label', service_tier: 'standard', speed: 'standard',
        input_tokens: 22_129, output_tokens: 748, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } })
  })
  assert.equal(sent, 2)
  assert.equal(result.usage.searches, 2)
  assert.deepEqual(marks, ['settle:0.097607'])
  assert.deepEqual(result.citedUrls, [])
})

test('optional company-first buyer designation reuses one reserved search and must be an admitted exact tool result', async () => {
  const actual = 'https://business.example/company/our-story'
  const neverReturned = 'https://business.example/team'
  const marks: string[] = []
  let sends = 0
  const r = await runStreaming(key, prompt, () => hold(marks), async (url, init) => {
    if (String(url).endsWith('/count_tokens')) return Response.json({ input_tokens: counted })
    sends++
    assert.equal(JSON.parse(String(init?.body)).tools.length, 1)
    return Response.json({ ...fullStandardResponse, content: [
      ...fullStandardResponse.content,
      {type:'web_search_tool_result',content:[{type:'web_search_result',url:actual}]},
      {type:'text',text:`BUYER_SOURCE: ${actual}\nBUYER_SOURCE: ${neverReturned}\nBUYER_SOURCE: ${actual}/`},
    ] })
  }, 'company_first')
  assert.equal(sends,1)
  assert.equal(marks.length,1,'the original native reservation settles once')
  assert.deepEqual(r.buyerSourceUrls,[actual])
  assert.ok(r.citedUrls.includes('https://roof.example/news'),'event discovery is preserved')
})
