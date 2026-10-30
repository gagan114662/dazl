// Regenerate: node test/fixtures/evals/traces/scan-london-seed-traps.gen.mjs test/fixtures/evals/traces/scan-london-seed-traps.trace.json
// then re-derive the World (test/evals.test.ts asserts the committed World equals worldFromTrace of this trace).
// Generates the SYNTHETIC scan trace fixture. Every company, page, person and address is invented.
import { writeFileSync } from 'node:fs'
const AS_OF = '2026-10-20T12:00:00.000Z'
const filler = (s) => ` ${s}`.repeat(18)
const P = {
  querix: { url: 'https://news.example/london/querix-seed', title: 'Querix raises seed round', text: `2026-10-10. Querix, a London B2B SaaS startup, raised a 3m GBP seed round this month to grow its sales team. Press contact: hello@querix.example.${filler('The company sells workflow software to finance teams in London.')}` },
  northwind: { url: 'https://news.example/london/northwind-profile', title: 'Northwind Analytics profile', text: `Northwind Analytics opened its London office in 2019 and raised a seed round from local angels.${filler('The firm builds dashboards for retailers in London, UK.')}` },
  lumen: { url: 'https://news.example/paris/lumen-ledger', title: 'Lumen Ledger raises seed in Paris', text: `2026-10-05. Lumen Ledger, a Paris B2B SaaS startup, raised a seed round this month. The team works from its office in Paris, France.${filler('Lumen Ledger sells accounting software across France.')}` },
  brightpath: { url: 'https://news.example/london/startup-roundup', title: 'London startup roundup', text: `2026-10-12. A roundup of London startup news this week, covering events and meetups across the city.${filler('Founders met at a London meetup to talk about hiring.')}` },
  // Review of #446: a lower-case, company-bound Paris location beside an incidental London mention.
  seine: { url: 'https://news.example/london/seine-systems', title: 'seine systems raises seed', text: `2026-10-09. seine systems is based in paris, france and raised a seed round this month. Market news: London startups raised more this year.${filler('seine systems sells billing software to European retailers.')}` },
  orbit: { url: 'https://news.example/london/orbit-labs', title: 'Orbit Labs to announce seed', text: `Orbit Labs, a London B2B SaaS startup, will announce its seed round at a launch event on 2026-11-15.${filler('Orbit Labs builds scheduling tools for clinics in London.')}` },
}
const icp = { summary: 'London B2B SaaS startups that raised seed funding in the past 90 days', who: ['Founder', 'Head of Sales'], industries: ['B2B SaaS'], sizes: [], where: ['London, UK'], signals: ['raised a seed round'], exclude: [], country: 'GB', language: 'en', window_days: 90 }
const request = 'Find London UK B2B SaaS startups that announced seed funding within the past 90 days.'
const hits = Object.values(P).map(p => ({ url: p.url, title: p.title, snippet: p.text.slice(0, 140), date: (p.text.match(/^\d{4}-\d{2}-\d{2}/) ?? [null])[0] }))
const cands = [
  { name: '', company: 'Querix', contact: 'hello@querix.example', signal: 'Raised a 3m GBP seed round this month', source_url: P.querix.url, score: 80, excerpt: 'Querix, a London B2B SaaS startup, raised a 3m GBP seed round this month to grow its sales team', event_date: '2026-10-10' },
  { name: '', company: 'Northwind Analytics', contact: null, signal: 'Raised a seed round', source_url: P.northwind.url, score: 60, excerpt: 'Northwind Analytics opened its London office in 2019 and raised a seed round from local angels', event_date: null },
  { name: '', company: 'Lumen Ledger', contact: null, signal: 'Raised a seed round', source_url: P.lumen.url, score: 70, excerpt: 'Lumen Ledger, a Paris B2B SaaS startup, raised a seed round this month', event_date: '2026-10-05' },
  { name: 'Dana Example', company: 'Brightpath AI', contact: null, signal: 'Raised a seed round led by a London fund', source_url: P.brightpath.url, score: 75, excerpt: 'Brightpath AI closed a 2m GBP seed round led by a London fund', event_date: '2026-10-12' },
  { name: '', company: 'Seine Systems', contact: null, signal: 'Raised a seed round', source_url: P.seine.url, score: 70, excerpt: 'seine systems is based in paris, france and raised a seed round this month', event_date: '2026-10-09' },
  { name: '', company: 'Orbit Labs', contact: null, signal: 'Announcing a seed round', source_url: P.orbit.url, score: 65, excerpt: 'Orbit Labs, a London B2B SaaS startup, will announce its seed round at a launch event on 2026-11-15', event_date: '2026-11-15' },
]
let seq = 0, t = 0
const span = (kind, name, input, output) => { const s = { id: `s${seq}`, seq: seq++, kind, name, start_ms: t, duration_ms: 40, input, output }; t += 50; return s }
const tfSearch = (q) => `https://api.search.tinyfish.ai/?query=${encodeURIComponent(q)}`
const spans = [
  span('model', 'anthropic.completeDetailed', { stage: 'search_queries', method: 'completeDetailed', prompt: 'Write up to 6 web search queries that would find companies or people matching this request (SYNTHETIC trace: prompt abbreviated)', max_tokens: 300 }, { text: JSON.stringify(['london saas seed']), model: 'stub-model-served', usage: { input_tokens: 400, output_tokens: 20 } }),
  span('http', 'tinyfish.search', { method: 'GET', url: tfSearch('london saas seed London, UK'), body: null }, { status: 200, body: JSON.stringify({ results: hits }) }),
  span('http', 'tinyfish.fetch', { method: 'POST', url: 'https://api.fetch.tinyfish.ai', body: JSON.stringify({ urls: Object.values(P).map(p => p.url), format: 'markdown' }) }, { status: 200, body: JSON.stringify({ results: Object.values(P).map(p => ({ url: p.url, title: p.title, text: p.text })) }) }),
  span('model', 'anthropic.completeDetailed', { stage: 'extraction', method: 'completeDetailed', prompt: 'You turn pre-collected public items into sales leads. (SYNTHETIC trace: prompt abbreviated)', max_tokens: 4000 }, { text: JSON.stringify(cands), model: 'stub-model-served', usage: { input_tokens: 1000, output_tokens: 100 } }),
  ...Object.values(P).map(p => span('page', 'verifier.fetch', { url: p.url }, { text: p.text, title: p.title, retrievedAt: Math.floor(Date.parse(AS_OF) / 1000) })),
]
const trace = { v: 1, kind: 'dazl.trace', id: 'synthetic-scan-london-seed-traps', path: 'scan.discovery', synthetic: true, redacted: false, started_at: AS_OF,
  agent: { commit: null, label: 'SYNTHETIC: hand-written trace, no real run; every company, page and address is invented' },
  input: { request, icp, as_of: AS_OF }, spans,
  synthetic_defaults: { http: { status: 404, body: '' } } }
writeFileSync(process.argv[2], JSON.stringify(trace, null, 1) + '\n')
