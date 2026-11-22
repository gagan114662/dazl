// Test helper (#1157): the Claude web-search call streams (`stream: true`), so the real API answers with server-sent events, not
// one JSON body. This turns a recorded/fixture final Message into the event sequence the Messages API documents
// (platform.claude.com/docs/en/build-with-claude/streaming: message_start with empty content, each block's start/deltas/stop -
// server tool results arrive whole - then message_delta with the cumulative usage, then message_stop), so existing fixtures
// keep their exact assertions. Test code only; production parses whatever the API sends.
type Msg = Record<string, unknown>
const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`

export function sseEvents(message: Msg): string[] {
  const { content, usage, stop_reason, stop_sequence, ...rest } = message as Msg & { content?: unknown[]; usage?: Msg }
  const u = usage && typeof usage === 'object' ? usage : undefined
  // message_start carries the request-time usage fields (input side, tier, geo, speed); message_delta the cumulative counts
  const startUsage = u ? Object.fromEntries(Object.entries(u).filter(([k]) => ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'service_tier', 'inference_geo', 'speed'].includes(k))) : undefined
  const out = [ev('message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', ...rest, content: [], stop_reason: null, stop_sequence: null, ...(startUsage ? { usage: startUsage } : {}) } })]
  const blocks = Array.isArray(content) ? content : []
  blocks.forEach((raw, index) => {
    const b = raw as Msg
    if (b.type === 'text') {
      out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
      if (typeof b.text === 'string' && b.text) out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }))
      for (const citation of Array.isArray(b.citations) ? b.citations : []) out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } }))
    } else if (b.type === 'server_tool_use') {
      out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: { ...b, input: {} } }))
      out.push(ev('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } }))
    } else out.push(ev('content_block_start', { type: 'content_block_start', index, content_block: b }))   // arrives whole
    out.push(ev('content_block_stop', { type: 'content_block_stop', index }))
  })
  out.push(ev('ping', { type: 'ping' }))
  out.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop_reason ?? null, stop_sequence: stop_sequence ?? null }, ...(u ? { usage: u } : {}) }))
  out.push(ev('message_stop', { type: 'message_stop' }))
  return out
}

export function sseResponse(chunks: string[], opts: { gapsMs?: number[]; endAfter?: number } = {}): Response {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (opts.endAfter !== undefined && i >= opts.endAfter) return new Promise(() => {})   // the connection stays open and silent
      if (i >= chunks.length) { c.close(); return }
      const gap = opts.gapsMs?.[i] ?? 0
      if (gap) await new Promise(r => setTimeout(r, gap))
      c.enqueue(enc.encode(chunks[i++]))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

// Wraps a fixture fetch: a 200 JSON Message answered to a streaming Messages request becomes its SSE event sequence. Error
// statuses, non-JSON bodies and every other request (count_tokens, non-streaming model calls) pass through unchanged.
export function asStreaming(f: typeof fetch): typeof fetch {
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const res = await f(url, init)
    let streaming = false
    try { streaming = String(url).endsWith('/v1/messages') && JSON.parse(String(init?.body ?? '{}')).stream === true } catch { streaming = false }
    if (!streaming || !res.ok) return res
    const text = await res.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = null }
    // a body that is not a JSON object is passed on as it came (the parser must treat it as unreadable)
    if (!json || typeof json !== 'object' || Array.isArray(json)) return new Response(text, { status: res.status, headers: res.headers })
    return sseResponse(sseEvents(json as Msg))
  }) as typeof fetch
}
