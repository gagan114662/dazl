// Local test process only. The standard fence disables real providers and
// removes inherited credentials before this process installs synthetic values.
import '../web/test/helpers/net-fence.ts'
import { appendFileSync } from 'node:fs'

const url = process.env.LOAD_PG_SCENARIO_URL
const trace = process.env.LOAD_PG_SCENARIO_TRACE
if (!url || !trace || !process.env.LOAD_PG_SCENARIO_MASTER) throw new Error('Missing isolated load database or synthetic master key')
const pg = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(pg.hostname) || !/^\/dazl_load_[a-z0-9_]+$/.test(pg.pathname)) {
  throw new Error('Only a loopback load database may be used')
}
Object.assign(process.env, {
  DATABASE_URL: url, DAZL_MASTER_KEY: process.env.LOAD_PG_SCENARIO_MASTER,
  DAZL_DISCOVER_LANE: '1', DAZL_SCAN_SHARED_QUEUE: '1', TINYFISH_ENABLED: '0', SITECRAWL_ENABLED: '0', NEWS_SEARCH_ENABLED: '0',
  STRIPE_SECRET_KEY: 'sk_test_load', STRIPE_PRICE_PRO: 'price_load', STRIPE_WEBHOOK_SECRET: 'whsec_load',
})
delete process.env.LOAD_PG_SCENARIO_URL
delete process.env.LOAD_PG_SCENARIO_MASTER
delete process.env.LOAD_PG_SCENARIO_TRACE

const fenced = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input))
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (target.origin !== 'https://api.anthropic.com' || method.toUpperCase() !== 'POST') return fenced(input, init)
  if (target.pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 100 })
  if (target.pathname !== '/v1/messages') return fenced(input, init)
  const request = new Request(input, init)
  const payload = await request.json()
  if (Array.isArray(payload.tools) && payload.tools.some((tool: { name?: string }) => tool.name === 'web_search')) {
    appendFileSync(trace, 'search\n')
  }
  const text = JSON.stringify({ leads: [], note: 'Synthetic provider completed the search' })
  const usage = { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } }
  const message = { id: 'msg_load', type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage }
  if (!payload.stream) return Response.json({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' })
  const events = [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}
