// Regenerate: node test/fixtures/evals/traces/scan-toronto-office-traps.gen.mjs test/fixtures/evals/traces/scan-toronto-office-traps.trace.json
// then re-derive the World (test/evals.test.ts asserts the committed World equals worldFromTrace of this trace).
// Generates the SYNTHETIC scan trace fixture. Every company, page, person and address is invented.
import { writeFileSync } from 'node:fs'
const AS_OF = '2026-10-20T12:00:00.000Z'
const filler = (s) => ` ${s}`.repeat(18)
const P = {
  maple: { url: 'https://news.example/toronto/maple-leaf-office', title: 'Maple Leaf Marketing opens second office', text: `2026-10-08. Maple Leaf Marketing, a Toronto agency, opened a second office at 100 King Street West, Toronto, ON this month. New business: hello@mapleleaf.example.${filler('The agency serves retail and hospitality clients across Ontario.')}` },
  // An OLD event on a page whose metadata says it was published last week: the text never dates the opening.
  northern: { url: 'https://news.example/toronto/northern-lights-profile', title: 'Northern Lights Agency profile', published: '2026-10-15', text: `Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city. Archive profile, first written for our agency directory.${filler('The agency builds brand campaigns for Toronto restaurants.')}` },
  // A genuine, dated event whose only listed contact is the recruiting inbox.
  lakeshore: { url: 'https://news.example/toronto/lakeshore-creative', title: 'Lakeshore Creative opens Liberty Village studio', text: `2026-10-12. Lakeshore Creative, a Toronto marketing agency, opened a new office in Liberty Village, Toronto, ON this month and is hiring designers. Apply: careers@lakeshore.example.${filler('Lakeshore Creative works with consumer brands in Canada.')}` },
}
const icp = { summary: 'Toronto marketing agencies that opened a new office in the past 90 days', who: ['Founder', 'Managing Director'], industries: ['marketing agency'], sizes: [], where: ['Toronto, Canada'], signals: ['opened a new office'], exclude: [], country: 'CA', language: 'en', window_days: 90 }
const request = 'Find marketing agencies in Toronto, Canada that opened a new office within the past 90 days.'
const hits = Object.values(P).map(p => ({ url: p.url, title: p.title, snippet: p.text.slice(0, 140), date: p.published ?? (p.text.match(/^\d{4}-\d{2}-\d{2}/) ?? [null])[0] }))
const cands = [
  { name: '', company: 'Maple Leaf Marketing', contact: 'hello@mapleleaf.example', signal: 'Opened a second office this month', source_url: P.maple.url, score: 80, excerpt: 'Maple Leaf Marketing, a Toronto agency, opened a second office at 100 King Street West, Toronto, ON this month', event_date: '2026-10-08' },
  { name: '', company: 'Northern Lights Agency', contact: null, signal: 'Opened a new office', source_url: P.northern.url, score: 70, excerpt: 'Northern Lights Agency opened a new office on Queen Street West in Toronto, ON, its third in the city', event_date: '2026-10-15' },
  { name: '', company: 'Lakeshore Creative', contact: 'careers@lakeshore.example', signal: 'Opened a new office this month', source_url: P.lakeshore.url, score: 75, excerpt: 'Lakeshore Creative, a Toronto marketing agency, opened a new office in Liberty Village, Toronto, ON this month', event_date: '2026-10-12' },
]
let seq = 0, t = 0
const span = (kind, name, input, output) => { const s = { id: `s${seq}`, seq: seq++, kind, name, start_ms: t, duration_ms: 40, input, output }; t += 50; return s }
const tfSearch = (q) => `https://api.search.tinyfish.ai/?query=${encodeURIComponent(q)}`
const spans = [
  span('model', 'anthropic.completeDetailed', { stage: 'search_queries', method: 'completeDetailed', prompt: 'Write up to 6 web search queries that would find companies or people matching this request (SYNTHETIC trace: prompt abbreviated)', max_tokens: 300 }, { text: JSON.stringify(['toronto marketing agency new office']), model: 'stub-model-served', usage: { input_tokens: 400, output_tokens: 20 } }),
  span('http', 'tinyfish.search', { method: 'GET', url: tfSearch('toronto marketing agency new office Toronto, Canada'), body: null }, { status: 200, body: JSON.stringify({ results: hits }) }),
  span('http', 'tinyfish.fetch', { method: 'POST', url: 'https://api.fetch.tinyfish.ai', body: JSON.stringify({ urls: Object.values(P).map(p => p.url), format: 'markdown' }) }, { status: 200, body: JSON.stringify({ results: Object.values(P).map(p => ({ url: p.url, title: p.title, text: p.text })) }) }),
  span('model', 'anthropic.completeDetailed', { stage: 'extraction', method: 'completeDetailed', prompt: 'You turn pre-collected public items into sales leads. (SYNTHETIC trace: prompt abbreviated)', max_tokens: 4000 }, { text: JSON.stringify(cands), model: 'stub-model-served', usage: { input_tokens: 1000, output_tokens: 100 } }),
  ...Object.values(P).map(p => span('page', 'verifier.fetch', { url: p.url }, { text: p.text, title: p.title, retrievedAt: Math.floor(Date.parse(AS_OF) / 1000), ...(p.published ? { published: p.published } : {}) })),
]
const trace = { v: 1, kind: 'dazl.trace', id: 'synthetic-scan-toronto-office-traps', path: 'scan.discovery', synthetic: true, redacted: false, started_at: AS_OF,
  agent: { commit: null, label: 'SYNTHETIC: hand-written trace, no real run; every company, page and address is invented' },
  input: { request, icp, as_of: AS_OF }, spans,
  synthetic_defaults: { http: { status: 404, body: '' } } }
writeFileSync(process.argv[2], JSON.stringify(trace, null, 1) + '\n')
