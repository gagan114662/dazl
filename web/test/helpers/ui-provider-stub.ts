// UI-smoke-only preload, loaded AFTER test/helpers/net-fence.ts (never by the app or `npm test`). It gives the fenced
// server a synthetic master key and a recording fake of the model provider, so the paths that decrypt a tenant key and
// call the model run for real up to the provider boundary:
//  - DAZL_MASTER_KEY is set from DAZL_UI_SYNTHETIC_MASTER (a random 32 bytes the smoke generated for this run; the
//    fence already deleted any inherited key, and this name carries none of KEY/SECRET/TOKEN/PASSWORD).
//  - a request to api.anthropic.com or api.openai.com never leaves the process: it is appended to
//    DAZL_UI_PROVIDER_LOG (one JSON line: host, path, prompt) and answered with a canned synthetic reply.
//  - everything else still goes through the fence, so any other non-loopback request throws.
import { appendFileSync } from 'node:fs'

const log = process.env.DAZL_UI_PROVIDER_LOG
const master = process.env.DAZL_UI_SYNTHETIC_MASTER
if (!log || !master) throw new Error('ui-provider-stub: DAZL_UI_PROVIDER_LOG and DAZL_UI_SYNTHETIC_MASTER are required')
if (Buffer.from(master, 'base64').length !== 32) throw new Error('ui-provider-stub: the synthetic master must be base64 of 32 bytes')
process.env.DAZL_MASTER_KEY = master

const PROVIDERS = new Set(['api.anthropic.com', 'api.openai.com'])
// research answers (a web_search tool request) name one synthetic candidate; the URL is cited so the runner may keep it
const RESEARCH_URL = process.env.DAZL_UI_RESEARCH_URL ?? 'https://news.example/synthetic-london-saas-hiring'
const RESEARCH = JSON.stringify([{ name: 'Alex Example', company: 'Synthetic SaaS Ltd', contact: 'hello@syntheticsaas.example', signal: 'Hiring its first account executive in London',
  source_url: RESEARCH_URL, excerpt: 'Synthetic SaaS Ltd is hiring its first account executive in London.', event_date: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10), score: 80 }])
const REWRITE = 'Subject: A quick question\n\nHi Pat,\n\nI saw the role you are hiring for and wondered whether a short call would help.\n\nThanks,'

const fenced = globalThis.fetch
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!PROVIDERS.has(url.hostname)) return fenced(input, init)
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { messages?: { content?: unknown }[]; input?: unknown; tools?: unknown[] } : {}
  const prompt = typeof body.input === 'string' ? body.input : body.messages?.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n') ?? ''
  appendFileSync(log, JSON.stringify({ host: url.hostname, path: url.pathname, research: !!body.tools?.length, prompt }) + '\n')
  if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 500 })
  // the claim check reads only the synthetic page the smoke serves for RESEARCH_URL, which states the claim
  const text = body.tools?.length ? RESEARCH : prompt.includes('first line "Subject:') ? REWRITE : prompt.startsWith('You check one claim') ? 'supports'
    : prompt.startsWith('You are grading sales leads') ? 'LEAD 1 | fit 4 | intent 4 | action 4 | match ?y?y | signals none | why Synthetic SaaS Ltd is hiring its first account executive in London.' : '[]'
  return Response.json({ id: 'msg_synthetic', model: 'synthetic-model', content: [{ type: 'text', text, ...(body.tools?.length ? { citations: [{ url: RESEARCH_URL }] } : {}) }],
    usage: { input_tokens: 500, output_tokens: 100 } })
}
