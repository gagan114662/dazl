import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { isPublicIp, fetchPublicHtml, pinnedLookup, type Lookup } from '../lib/net/public-fetch.ts'
import { extractSiteText, icpFromWebsite } from '../lib/scan/icp-from-site.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import type { Provider } from '../lib/llm/provider.ts'

const master = randomBytes(32)
const KEY = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// ---------- isPublicIp ----------
test('isPublicIp: private, loopback, link-local and metadata ranges are rejected', () => {
  for (const bad of ['127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '64:ff9b::1', '2001:db8::1', '[::1]'])
    assert.equal(isPublicIp(bad), false, bad)
  for (const good of ['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isPublicIp(good), true, good)
})

// ---------- fetchPublicHtml ----------
const pubLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const privLookup: Lookup = async () => [{ address: '192.168.1.1', family: 4 }]
const mixedLookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]
const htmlResponse = (body: string, status = 200, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } })
const HTML = '<html><head><title>Acme</title></head><body>' + 'we sell crm tools to sales teams '.repeat(30) + '</body></html>'

test('fetchPublicHtml: non-http(s) schemes and credentialed URLs are invalid', async () => {
  for (const u of ['ftp://example.com', 'file:///etc/passwd', 'https://user:pass@example.com/', 'not a url'])
    assert.deepEqual(await fetchPublicHtml(u, { lookup: pubLookup, fetchImpl: (async () => htmlResponse(HTML)) as typeof fetch }), { error: 'invalid' }, u)
})

test('fetchPublicHtml: private or mixed DNS answers are refused before any request', async () => {
  let called = 0
  const f = (async () => { called++; return htmlResponse(HTML) }) as unknown as typeof fetch
  assert.deepEqual(await fetchPublicHtml('https://internal.example', { lookup: privLookup, fetchImpl: f }), { error: 'not_public' })
  assert.deepEqual(await fetchPublicHtml('https://rebind.example', { lookup: mixedLookup, fetchImpl: f }), { error: 'not_public' })
  assert.deepEqual(await fetchPublicHtml('http://169.254.169.254/latest/meta-data', { lookup: pubLookup, fetchImpl: f }), { error: 'not_public' })
  assert.equal(called, 0, 'no request may leave for a non-public host')
})

test('fetchPublicHtml: a redirect to a private host is refused at the hop', async () => {
  const f = (async (url: unknown) => String(url).includes('step0')
    ? htmlResponse('', 302, 'text/html', { location: 'http://169.254.169.254/' })
    : htmlResponse(HTML)) as unknown as typeof fetch
  const out = await fetchPublicHtml('https://step0.example', { lookup: pubLookup, fetchImpl: f })
  assert.deepEqual(out, { error: 'not_public' })
})

test('fetchPublicHtml: redirect loop, http errors and non-html are typed', async () => {
  const loop = (async () => htmlResponse('', 301, 'text/html', { location: 'https://loop.example/again' })) as unknown as typeof fetch
  assert.deepEqual(await fetchPublicHtml('https://loop.example', { lookup: pubLookup, fetchImpl: loop }), { error: 'blocked' })
  const denied = (async () => htmlResponse('nope', 403)) as unknown as typeof fetch
  assert.deepEqual(await fetchPublicHtml('https://x.example', { lookup: pubLookup, fetchImpl: denied }), { error: 'blocked', status: 403 }) // HTTP errors carry the status so callers can show it
  const pdf = (async () => htmlResponse('%PDF-1.4', 200, 'application/pdf')) as unknown as typeof fetch
  assert.deepEqual(await fetchPublicHtml('https://x.example', { lookup: pubLookup, fetchImpl: pdf }), { error: 'not_html', status: 200 })
})

test('fetchPublicHtml: happy path returns html and the final url, oversized pages are capped', async () => {
  const f = (async () => htmlResponse(HTML)) as unknown as typeof fetch
  const ok = await fetchPublicHtml('https://acme.example', { lookup: pubLookup, fetchImpl: f })
  assert.ok('html' in ok && ok.finalUrl === 'https://acme.example/' && ok.html.includes('Acme'))
  const big = (async () => htmlResponse('x'.repeat(700 * 1024))) as unknown as typeof fetch
  const capped = await fetchPublicHtml('https://big.example', { lookup: pubLookup, fetchImpl: big })
  assert.ok('html' in capped && capped.html.length <= 512 * 1024 + 8, 'size cap holds')
})

// ---------- extractSiteText ----------
test('extractSiteText: scripts and styles are dropped, title and visible text kept', () => {
  const { title, text } = extractSiteText('<html><head><title>Acme CRM</title><meta name="description" content="Tools for sales ops"><style>body{color:red}</style></head><body><script>var x=1</script><h1>We help sales ops teams</h1><p>Book more meetings &amp; close faster</p></body></html>')
  assert.ok(title.includes('Acme CRM') && title.includes('Tools for sales ops'))
  assert.ok(text.includes('We help sales ops teams') && text.includes('close faster'))
  assert.ok(!text.includes('var x=1') && !text.includes('color:red'))
})

// ---------- icpFromWebsite ----------
function setup(corrupt = false) {
  const db = new Database(':memory:')
  migrateKeys(db)
  saveKey(db, 'A', 'anthropic', KEY, master)
  if (corrupt) db.prepare("UPDATE tenant_llm_keys SET ciphertext = 'not-json' WHERE tenant_id = 'A'").run()
  return db
}
const goodProvider: Provider = {
  research: async () => { throw new Error('unused') },
  complete: async () => JSON.stringify({ sells: '  CRM cleanup\n for sales teams ', summary: 'Sales ops teams at B2B SaaS companies that need CRM cleanup.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: ['Hiring a CRM admin'], exclude: [] }),
}
const f = (async () => htmlResponse(HTML)) as unknown as typeof fetch

test('icpFromWebsite: returns a normalized draft ICP with the final source url', async () => {
  const out = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: goodProvider } })
  assert.ok('icp' in out, JSON.stringify(out))
  if ('icp' in out) {
    assert.match(out.icp.summary, /Sales ops/)
    assert.deepEqual(out.icp.who, ['Sales ops managers'])
    assert.equal(out.source, 'https://acme.example/')
    assert.equal(out.sells, 'CRM cleanup for sales teams')
  }
})

test('icpFromWebsite: a keyless account gets the free read - extracted facts with sources, never a model call (#409)', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  let calls = 0
  const counting: Provider = { research: async () => { calls++; throw new Error('unused') }, complete: async () => { calls++; return '{}' } }
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: counting } })
  assert.equal(calls, 0, 'no model call without a tenant key')
  assert.deepEqual(out, {
    free: true, site: 'acme.example', source: 'https://acme.example/',
    facts: [{ kind: 'title', text: 'Acme', source: 'https://acme.example/' }],
  })
  assert.ok(!('icp' in out) && !('sells' in out) && !('research' in out), 'the free read carries no inferred draft')
  assert.deepEqual(await icpFromWebsite(setup(true), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: goodProvider } }), { error: 'key_unreadable' })
  const tiny = (async () => htmlResponse('<html><body><script>app()</script></body></html>')) as unknown as typeof fetch
  assert.deepEqual(await icpFromWebsite(setup(), 'A', 'https://spa.example', { master, lookup: pubLookup, fetchImpl: tiny, providers: { anthropic: goodProvider } }), { error: 'js_only' })
  const junk: Provider = { research: async () => { throw new Error('unused') }, complete: async () => 'sorry, cannot help' }
  assert.deepEqual(await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: junk } }), { error: 'draft_unreadable', reason: 'not_json' })
})

test('icpFromWebsite: the free read labels title and description with their source; a fetch failure stays a typed error (#409)', async () => {
  const empty = () => { const d = new Database(':memory:'); migrateKeys(d); return d }
  const withMeta = (async () => htmlResponse('<html><head><title>Acme Inc</title><meta name="description" content="CRM cleanup for sales teams."></head><body>' + 'we sell crm tools '.repeat(30) + '</body></html>')) as unknown as typeof fetch
  const out = await icpFromWebsite(empty(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: withMeta, providers: { anthropic: goodProvider } })
  assert.deepEqual(out, {
    free: true, site: 'acme.example', source: 'https://acme.example/',
    facts: [
      { kind: 'title', text: 'Acme Inc', source: 'https://acme.example/' },
      { kind: 'description', text: 'CRM cleanup for sales teams.', source: 'https://acme.example/' },
    ],
  })
  // No inference leaked in: the body copy about selling to sales teams appears only as the stated description.
  assert.deepEqual(await icpFromWebsite(empty(), 'A', 'https://internal.example', { master, lookup: privLookup, fetchImpl: withMeta, providers: { anthropic: goodProvider } }), { error: 'not_public' })
})

test('icpFromWebsite: keyless fetches the public page but never reaches a model (trial or operator keys never pay)', async () => {
  let fetched = 0
  const counting = (async () => { fetched++; return htmlResponse(HTML) }) as unknown as typeof fetch
  let calls = 0
  const countingProvider: Provider = { research: async () => { calls++; throw new Error('unused') }, complete: async () => { calls++; return '{}' } }
  const empty = new Database(':memory:'); migrateKeys(empty)
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: counting, providers: { anthropic: countingProvider } })
  assert.equal(fetched, 1, 'the free path reads the one public page')
  assert.equal(calls, 0, 'no model call without a tenant key')
  assert.ok('free' in out, JSON.stringify(out))
})



// ---------- #409: the trial-funded read (port of #444 onto the free-read floor) ----------
const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const ICP_JSON = JSON.stringify({ sells: 'CRM cleanup', summary: 'Sales ops teams at B2B SaaS companies that need CRM cleanup.', who: ['Sales ops managers'], industries: ['B2B SaaS'], sizes: [], where: [], signals: ['Hiring a CRM admin'], exclude: [] })
// Records the key, the output cap and the prompt size of every detailed call; fails or reports usage as asked.
const trialProvider = (seen: { keys: string[]; max: number[]; bytes: number[] }, o: { model?: string; fail?: boolean; usage?: { input_tokens: number; output_tokens: number } | null } = {}): Provider => ({
  research: async () => { throw new Error('unused') },
  configuredModel: () => o.model ?? 'claude-sonnet-4-5',
  completeDetailed: async (k, prompt, _f, max = 10) => {
    seen.keys.push(k); seen.max.push(max); seen.bytes.push(Buffer.byteLength(prompt))
    if (o.fail) throw new Error('provider 500')
    return { text: ICP_JSON, model: o.model ?? 'claude-sonnet-4-5', ...(o.usage === null ? {} : { usage: o.usage ?? { input_tokens: 2000, output_tokens: 300 } }) }
  },
})
// A trial admission that records how often it was asked and what the read settled or released into the wallet.
const admitted = (calls: { n: number }, settled: (number | null)[] = [], released = { n: 0 }) => async () => { calls.n++; return { ok: true as const, key: { vendor: 'anthropic' as const, key: OP }, settle: async (usd: number | null) => { settled.push(usd) }, release: async () => { released.n++ } } }
const COST = (2000 * 3 + 300 * 15) / 1e6

test('#409 port: the worst-case bound is enforced, not arithmetic - only a priced model can run, and only under the reserve', async () => {
  const { PRICES_USD_PER_M, callCostUsd, SpendGuard } = await import('../lib/llm/spend-guard.ts')
  const { TRIAL_SITE_READ_PROMPT_MAX_BYTES, TRIAL_SITE_READ_MAX_OUTPUT_TOKENS, TRIAL_SITE_READ_MAX_USD } = await import('../lib/scan/icp-from-site.ts')
  const { TRIAL_SITE_READ_RESERVE_USD } = await import('../lib/billing/trial-budget.ts')
  // Exactly one model carries a price; the guard refuses every other (unpriced) model before any call, so an operator
  // override of DAZL_ANTHROPIC_MODEL can never run an unbounded or mis-priced trial read.
  assert.deepEqual(Object.keys(PRICES_USD_PER_M), ['claude-sonnet-4-5'], 'one priced model: the only one a trial read can ever run on')
  // The guard's own pricing of the largest possible call (prompt priced in BYTES, never fewer than tokens; output
  // capped by the API at max_tokens) is under the read's reserve - and the SpendGuard would refuse anything over.
  const worst = callCostUsd('claude-sonnet-4-5', TRIAL_SITE_READ_PROMPT_MAX_BYTES, TRIAL_SITE_READ_MAX_OUTPUT_TOKENS)
  assert.ok(worst < TRIAL_SITE_READ_RESERVE_USD, `worst-case $${worst} under the $${TRIAL_SITE_READ_RESERVE_USD} reserve`)
  assert.equal(TRIAL_SITE_READ_MAX_USD, TRIAL_SITE_READ_RESERVE_USD, 'the per-read ceiling IS the reserve')
  assert.throws(() => new SpendGuard(TRIAL_SITE_READ_MAX_USD).check('claude-sonnet-4-5', TRIAL_SITE_READ_PROMPT_MAX_BYTES + 2000, TRIAL_SITE_READ_MAX_OUTPUT_TOKENS), /spend_refused:over_limit/, 'anything past the bound is refused before a call')
})

test('#409 port: a keyless account reads on the trial key, admitted only after a readable page, one bounded call', async () => {
  const { TRIAL_SITE_READ_MAX_OUTPUT_TOKENS, TRIAL_SITE_READ_PROMPT_MAX_BYTES } = await import('../lib/scan/icp-from-site.ts')
  const empty = new Database(':memory:'); migrateKeys(empty)
  const seen = { keys: [] as string[], max: [] as number[], bytes: [] as number[] }, calls = { n: 0 }, settled: (number | null)[] = []
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls, settled) })
  assert.ok('icp' in out && out.funded === 'trial', JSON.stringify(out))
  if ('icp' in out) assert.match(out.icp.summary, /Sales ops/)
  assert.deepEqual([calls.n, seen.keys, seen.max], [1, [OP], [TRIAL_SITE_READ_MAX_OUTPUT_TOKENS]], 'one admission, one bounded call on the admission\'s key')
  assert.ok(seen.bytes[0] <= TRIAL_SITE_READ_PROMPT_MAX_BYTES, `prompt under the byte bound: ${seen.bytes[0]}`)
  assert.deepEqual(settled, [COST], 'settled to the reported usage at the listed price')
})

test('#409 port: with its own key the read never touches the trial, even when a trial path is offered', async () => {
  const calls = { n: 0 }
  const out = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: goodProvider }, trial: admitted(calls) })
  assert.ok('icp' in out && out.funded === 'own')
  assert.equal(calls.n, 0, 'no admission asked for an own-key read')
})

test('#409 port: a refused trial never hides the free read - it answers with the reason, and the model is never called', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const seen = { keys: [] as string[], max: [] as number[], bytes: [] as number[] }
  for (const reason of ['not_configured', 'attempts_cap', 'global_daily_cap', 'site_reads_used', 'workspace_not_eligible'] as const) {
    const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen) }, trial: async () => ({ ok: false as const, reason }) })
    assert.ok('free' in out && out.trial === reason, `${reason}: ${JSON.stringify(out)}`)
    assert.equal(out.facts.length > 0, true, 'the page\'s own facts still answer')
  }
  // A JS-only page or a fetch failure never asks for (or uses up) a trial read.
  const calls = { n: 0 }
  const tiny = (async () => htmlResponse('<html><body><script>app()</script></body></html>')) as unknown as typeof fetch
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://spa.example', { master, lookup: pubLookup, fetchImpl: tiny, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls) }), { error: 'js_only' })
  const down = (async () => htmlResponse('nope', 503)) as unknown as typeof fetch
  const failed = await icpFromWebsite(empty, 'A', 'https://down.example', { master, lookup: pubLookup, fetchImpl: down, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls) })
  assert.ok('error' in failed, JSON.stringify(failed))
  assert.equal(calls.n, 0, 'no admission for an unreadable page')
  assert.deepEqual(seen.keys, [], 'no paid call in any of these')
})

test('#409 port: guard refusal before any call releases (free read + spend_unavailable); a failed call settles null (free read + read_failed)', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const seen = { keys: [] as string[], max: [] as number[], bytes: [] as number[] }
  // An operator model the guard cannot price: admitted, but refused before any call - released, never settled.
  const released = { n: 0 }, settled: (number | null)[] = []
  const refused = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen, { model: 'some-new-model' }) }, trial: admitted({ n: 0 }, settled, released) })
  assert.ok('free' in refused && refused.trial === 'spend_unavailable', JSON.stringify(refused))
  assert.deepEqual([seen.keys.length, settled.length, released.n], [0, 0, 1], 'no call, nothing settled, the admission released')
  // A provider error after the call: the reservation ends at the full reserve (settle null) and the read counted.
  const failed = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen, { fail: true }) }, trial: admitted({ n: 0 }, settled) })
  assert.ok('free' in failed && failed.trial === 'read_failed', JSON.stringify(failed))
  assert.deepEqual(settled, [null], 'failed call: ends at the full reserve, never left pending')
  // No usage reported: the same - the read ends at its reserve (settle null), never left pending.
  const settled2: (number | null)[] = []
  const noUsage = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen, { usage: null }) }, trial: admitted({ n: 0 }, settled2) })
  assert.ok('icp' in noUsage, JSON.stringify(noUsage))
  assert.deepEqual(settled2, [null])
})

test('#409 port: a provider without the detailed call cannot run a trial read (refused before any call, released)', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const released = { n: 0 }, settled: (number | null)[] = []
  const plain: Provider = { research: async () => { throw new Error('unused') }, configuredModel: () => 'claude-sonnet-4-5', complete: async () => ICP_JSON }
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: plain }, trial: admitted({ n: 0 }, settled, released) })
  assert.ok('free' in out && out.trial === 'spend_unavailable', JSON.stringify(out))
  assert.deepEqual([settled.length, released.n], [0, 1])
})

test('#409 port: a CJK page at the character cap reads on the trial under the per-read ceiling (the prompt is byte-capped)', async () => {
  const { TRIAL_SITE_READ_PROMPT_MAX_BYTES } = await import('../lib/scan/icp-from-site.ts')
  const empty = new Database(':memory:'); migrateKeys(empty)
  const cjk = (async () => htmlResponse('<html><head><title>客户关系</title></head><body>' + '我们为销售团队提供客户关系管理工具。'.repeat(400) + '</body></html>')) as unknown as typeof fetch
  const seen = { keys: [] as string[], max: [] as number[], bytes: [] as number[] }, settled: (number | null)[] = []
  const out = await icpFromWebsite(empty, 'A', 'https://cjk.example', { master, lookup: pubLookup, fetchImpl: cjk, providers: { anthropic: trialProvider(seen) }, trial: admitted({ n: 0 }, settled) })
  assert.ok('icp' in out && out.funded === 'trial', JSON.stringify(out))
  assert.equal(seen.keys.length, 1, 'one call')
  assert.ok(seen.bytes[0] <= TRIAL_SITE_READ_PROMPT_MAX_BYTES, `CJK prompt byte-capped: ${seen.bytes[0]}`)
  assert.deepEqual(settled, [COST])
})

test('pinned lookup never asks DNS again when the transport connects', async () => {
  const lookup = pinnedLookup({ address: '93.184.216.34', family: 4 })
  const address = await new Promise<string>((resolve, reject) => lookup('rebind.example', {}, (err, address) => err ? reject(err) : resolve(typeof address === 'string' ? address : address[0].address)))
  assert.equal(address, '93.184.216.34')
})

test('IPv6 transitions, mapped hex loopback, multicast and invalid literals are not public', () => {
  for (const ip of ['::ffff:7f00:1', 'ff02::1', '2002:7f00:1::', '2001:0000::1', '2001:db8::5', '::', 'not:an:ip']) assert.equal(isPublicIp(ip), false, ip)
})

test('redirects cannot introduce credentials or a nonstandard port', async () => {
  for (const location of ['https://u:p@acme.example/', 'https://acme.example:8080/']) {
    let calls = 0
    const f = (async () => { calls++; return htmlResponse('', 302, 'text/html', { location }) }) as unknown as typeof fetch
    assert.deepEqual(await fetchPublicHtml('https://acme.example', { lookup: pubLookup, fetchImpl: f }), { error: 'invalid' })
    assert.equal(calls, 1)
  }
})

// ---------- #379: multi-page seller research through icpFromWebsite ----------
const SITE2: Record<string, string> = {
  'https://multi.example/': `<html><title>Multi</title><body><h1>${'Multi builds practice software. '.repeat(20)}</h1><a href="/pricing">Pricing</a><a href="/customers">Customers</a></body></html>`,
  'https://multi.example/pricing': `<html><body>${'Booking starts at $49 per location per month. Payroll is priced per employee for clinics with 10 to 50 staff. '.repeat(5)}</body></html>`,
  'https://multi.example/customers': `<html><body>${'Case study: Harbor Dental, a four-chair dental practice, cut no-shows with Multi Booking. '.repeat(5)}</body></html>`,
}
const multiFetch = (async (url: unknown) => htmlResponse(SITE2[String(url)] ?? SITE2['https://multi.example/'])) as unknown as typeof fetch
const COMBINED = JSON.stringify({
  sells: 'Practice software for clinics',
  draft: { summary: 'Clinic operators who run bookings and payroll.', who: ['practice managers'], industries: ['dental practices'], sizes: [], where: [], signals: ['hiring front-desk staff'], exclude: [] },
  offers: [{ id: 'o1', name: 'Multi Booking' }, { id: 'o2', name: 'Multi Payroll' }],
  items: [
    { offer: 'o1', kind: 'persona', text: 'practice managers', url: 'https://multi.example/customers', quote: 'Harbor Dental, a four-chair dental practice', inferred: false },
    { offer: 'o2', kind: 'size', text: '10 to 50 staff', url: 'https://multi.example/pricing', quote: 'clinics with 10 to 50 staff', inferred: false },
    { offer: 'o2', kind: 'location', text: 'Texas', url: 'https://multi.example/pricing', quote: 'available across Texas', inferred: false },
  ],
})
const combinedProvider: Provider = { research: async () => { throw new Error('unused') }, complete: async () => COMBINED }

test('icpFromWebsite: a multiproduct site whose homepage omits the buyer yields a draft plus per-offer source-backed hypotheses', async () => {
  const out = await icpFromWebsite(setup(), 'A', 'https://multi.example', { master, lookup: pubLookup, fetchImpl: multiFetch, providers: { anthropic: combinedProvider } })
  assert.ok('icp' in out, JSON.stringify(out))
  if (!('icp' in out)) return
  assert.match(out.icp.summary, /Clinic operators/)
  const r = out.icp.research!
  assert.ok(r, 'research block attached')
  assert.deepEqual(r.offers.map(o => o.i), ['multi-booking', 'multi-payroll'])
  const persona = r.hyps.find(h => h.k === 'persona')!
  assert.deepEqual([persona.s, persona.o, persona.u], ['sourced', 'multi-booking', 'https://multi.example/customers'])
  assert.ok(persona.q && SITE2['https://multi.example/customers'].includes(persona.q), 'verbatim quote retained')
  const size = r.hyps.find(h => h.k === 'size')!
  assert.equal(size.s, 'sourced', 'a quoted size is sourced')
  assert.ok(!r.hyps.some(h => h.k === 'location'), 'an unquoted place is unknown and unknowns are never persisted or shown as fact')
  assert.ok(!r.hyps.some(h => h.s === ('unknown' as never)), 'unknowns are not persisted')
})

test('icpFromWebsite: a sub-page blocked at a guarded redirect is skipped; the draft and the other pages still land', async () => {
  const redirecting = (async (url: unknown) => String(url).endsWith('/pricing')
    ? htmlResponse('', 302, 'text/html', { location: 'https://127.0.0.1/internal' })
    : htmlResponse(SITE2[String(url)] ?? SITE2['https://multi.example/'])) as unknown as typeof fetch
  const out = await icpFromWebsite(setup(), 'A', 'https://multi.example', { master, lookup: pubLookup, fetchImpl: redirecting, providers: { anthropic: combinedProvider } })
  assert.ok('icp' in out, JSON.stringify(out))
  if (!('icp' in out)) return
  assert.match(out.icp.summary, /Clinic operators/, 'the draft never fails on a skipped page')
  assert.ok(out.icp.research, 'research still built from the readable pages')
})

test('icpFromWebsite: the multi-page read stays inside its latency budget; budget exhausted means homepage-only evidence', async () => {
  const out = await icpFromWebsite(setup(), 'A', 'https://multi.example', { master, lookup: pubLookup, fetchImpl: multiFetch, providers: { anthropic: combinedProvider }, researchTimeMs: 0 })
  assert.ok('icp' in out, JSON.stringify(out))
  if (!('icp' in out)) return
  assert.match(out.icp.summary, /Clinic operators/, 'the draft still returns from the homepage alone')
})

test('icpFromWebsite: garbage research output costs the draft nothing - it just has no provenance block', async () => {
  const noResearch: Provider = { research: async () => { throw new Error('unused') }, complete: async () => JSON.stringify({ sells: 'x', draft: { summary: 'Sales ops.', who: [], industries: [], sizes: [], where: [], signals: [], exclude: [] }, offers: 'not-an-array', items: 42 }) }
  const out = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: noResearch } })
  assert.ok('icp' in out, JSON.stringify(out))
  if (!('icp' in out)) return
  assert.equal(out.icp.summary, 'Sales ops.')
  assert.equal(out.icp.research, undefined)
})

test('hard byte bound: CJK-heavy 6-page prompt fits RESEARCH_PROMPT_MAX_BYTES and keeps the homepage', async () => {
  const { fitPromptBytes, RESEARCH_PROMPT_MAX_BYTES } = await import('../lib/scan/icp-from-site.ts')
  const pages = [{ url: 'https://a.example/', kind: 'home', title: 't', text: '歯'.repeat(3500) }]
  for (let i = 0; i < 5; i++) pages.push({ url: `https://a.example/p${i}`, kind: 'pricing', title: 't', text: '科'.repeat(3500) })
  const out = fitPromptBytes('a.example', pages)
  assert.ok(Buffer.byteLength(out) <= RESEARCH_PROMPT_MAX_BYTES)
  assert.ok(out.includes('https://a.example/'))
})

test('hard byte bound: ordinary English 6-page prompt is kept verbatim', async () => {
  const { fitPromptBytes, RESEARCH_PROMPT_MAX_BYTES, } = await import('../lib/scan/icp-from-site.ts')
  const pages = [{ url: 'https://a.example/', kind: 'home', title: 'Home', text: 'we sell booking software to dental practices '.repeat(40) }]
  for (let i = 0; i < 5; i++) pages.push({ url: `https://a.example/p${i}`, kind: 'product', title: 'P', text: 'booking for clinics '.repeat(40) })
  const out = fitPromptBytes('a.example', pages)
  assert.ok(Buffer.byteLength(out) <= RESEARCH_PROMPT_MAX_BYTES)
  for (const p of pages) assert.ok(out.includes(p.url))
})

test('icpFromWebsite: SpendAccountingFailed surfaces as accounting_pending, never key_rejected', async () => {
  const { SpendAccountingFailed } = await import('../lib/llm/spend-guard.ts')
  const failing: Provider = { research: async () => { throw new Error('unused') }, complete: async () => { throw new SpendAccountingFailed('settle_not_saved') } }
  const out = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: failing } })
  assert.ok('error' in out)
  if ('error' in out) assert.equal(out.error, 'accounting_pending', 'a possibly-billed call must not invite key re-entry')
})

test('icpFromWebsite: model_unpriced refusal is distinct from spend_limit; genuine limit stays spend_limit', async () => {
  const { SpendRefused } = await import('../lib/llm/spend-guard.ts')
  const unpriced: Provider = { research: async () => { throw new Error('unused') }, complete: async () => { throw new SpendRefused('model_unpriced') } }
  const out1 = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: unpriced } })
  assert.ok('error' in out1)
  if ('error' in out1) assert.equal(out1.error, 'model_unpriced', 'an unpriced model is not a reached spend limit')
  const limited: Provider = { research: async () => { throw new Error('unused') }, complete: async () => { throw new SpendRefused('over_limit') } }
  const out2 = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: limited } })
  assert.ok('error' in out2)
  if ('error' in out2) assert.equal(out2.error, 'spend_limit', 'the genuine limit keeps its accurate surface')
})
