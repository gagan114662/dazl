import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { isPublicIp, fetchPublicHtml, pinnedLookup, type Lookup } from '../lib/net/public-fetch.ts'
import { extractSiteText, icpFromWebsite, trimToBytes, TRIAL_SITE_READ_MAX_USD, TRIAL_SITE_READ_TEXT_BYTES } from '../lib/scan/icp-from-site.ts'
import { callCostUsd } from '../lib/llm/spend-guard.ts'
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

test('icpFromWebsite: no key, unreadable key, js-only page and bad model output are typed errors', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: goodProvider } }), { error: 'no_api_key' })
  assert.deepEqual(await icpFromWebsite(setup(true), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: goodProvider } }), { error: 'key_unreadable' })
  const tiny = (async () => htmlResponse('<html><body><script>app()</script></body></html>')) as unknown as typeof fetch
  assert.deepEqual(await icpFromWebsite(setup(), 'A', 'https://spa.example', { master, lookup: pubLookup, fetchImpl: tiny, providers: { anthropic: goodProvider } }), { error: 'js_only' })
  const junk: Provider = { research: async () => { throw new Error('unused') }, complete: async () => 'sorry, cannot help' }
  assert.deepEqual(await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: junk } }), { error: 'key_rejected' })
})

test('icpFromWebsite: without a key and without a trial path, nothing is fetched and nothing is called', async () => {
  let called = 0
  const counting = (async () => { called++; return htmlResponse(HTML) }) as unknown as typeof fetch
  const empty = new Database(':memory:'); migrateKeys(empty)
  await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: counting, providers: { anthropic: goodProvider } })
  assert.equal(called, 0, 'no outbound fetch without a tenant key')
})

// ---------- #409: the trial-funded read ----------
const OP = 'sk-ant-api03-OPERATOROPERATOROPERATOROPERATOR'
const trialProvider = (seen: { keys: string[]; max: number[] }, model = 'claude-sonnet-4-5'): Provider => ({
  research: async () => { throw new Error('unused') },
  configuredModel: () => model,
  complete: async (k, _p, _f, max = 10) => { seen.keys.push(k); seen.max.push(max); return goodProvider.complete!(k, _p, _f, max) },
})
const admitted = (calls: { n: number }, settled: (number | null)[] = [], released = { n: 0 }) => async () => { calls.n++; return { ok: true as const, key: { vendor: 'anthropic' as const, key: OP }, settle: async (usd: number | null) => { settled.push(usd) }, release: async () => { released.n++ } } }

test('#409: an account without its own key has its site read on the trial key, admitted only after a readable page', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const seen = { keys: [] as string[], max: [] as number[] }, calls = { n: 0 }
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls) })
  assert.ok('icp' in out, JSON.stringify(out))
  if ('icp' in out) { assert.equal(out.funded, 'trial'); assert.match(out.icp.summary, /Sales ops/) }
  assert.deepEqual([calls.n, seen.keys, seen.max], [1, [OP], [700]], 'one admission, one bounded call on the trial key')
})

test('#409: with its own key the read never touches the trial, even when a trial path is offered', async () => {
  const seen = { keys: [] as string[], max: [] as number[] }, calls = { n: 0 }
  const own: Provider = { ...trialProvider(seen) }
  const out = await icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: own }, trial: admitted(calls) })
  assert.ok('icp' in out && out.funded === 'own')
  assert.deepEqual([calls.n, seen.keys], [0, [KEY]])
})

test('#409: trial refused, JS-only page, fetch failure and an unpriced model each stop before any paid call', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const seen = { keys: [] as string[], max: [] as number[] }
  // Refused (e.g. the deployment has no trial): the reason comes back with no_api_key, and the model is never called.
  const refused = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen) }, trial: async () => ({ ok: false, reason: 'not_configured' }) })
  assert.deepEqual(refused, { error: 'no_api_key', trial: 'not_configured' })
  for (const reason of ['attempts_cap', 'global_daily_cap', 'site_reads_used'] as const)
    assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen) }, trial: async () => ({ ok: false, reason }) }), { error: 'no_api_key', trial: reason })
  // A JS-only page or a fetch failure never asks for (or uses up) a trial read.
  const calls = { n: 0 }
  const tiny = (async () => htmlResponse('<html><body><script>app()</script></body></html>')) as unknown as typeof fetch
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://spa.example', { master, lookup: pubLookup, fetchImpl: tiny, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls) }), { error: 'js_only' })
  const down = (async () => htmlResponse('nope', 503)) as unknown as typeof fetch
  const failed = await icpFromWebsite(empty, 'A', 'https://down.example', { master, lookup: pubLookup, fetchImpl: down, providers: { anthropic: trialProvider(seen) }, trial: admitted(calls) })
  assert.ok('error' in failed && failed.error !== 'no_api_key', JSON.stringify(failed))
  assert.equal(calls.n, 0, 'no admission for an unreadable page')
  // The per-read ceiling refuses a model it cannot price: admitted, but no call is made, and it is dazl's failure.
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen, 'some-new-model') }, trial: admitted(calls) }), { error: 'trial_read_failed' })
  assert.deepEqual(seen.keys, [], 'no paid call in any of these')
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

test('#409: a trial read settles its wallet reservation to the cost the provider reported; a failed or unreported call ends it at the full reserve (settle null)', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const detailed = (usage?: { input_tokens: number; output_tokens: number }, fail = false): Provider => ({
    research: async () => { throw new Error('unused') },
    configuredModel: () => 'claude-sonnet-4-5',
    completeDetailed: async () => { if (fail) throw new Error('provider 500'); return { text: await goodProvider.complete!('k', '', undefined, 700), model: 'claude-sonnet-4-5', ...(usage ? { usage } : {}) } },
  })
  const run = async (p: Provider) => { const settled: (number | null)[] = []; const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: p }, trial: admitted({ n: 0 }, settled) }); return { out, settled } }
  const reported = await run(detailed({ input_tokens: 2000, output_tokens: 300 }))
  assert.ok('icp' in reported.out)
  assert.deepEqual(reported.settled, [(2000 * 3 + 300 * 15) / 1e6], 'settled to the reported usage at the listed price')
  assert.deepEqual((await run(detailed())).settled, [null], 'no usage reported: ends at the full reserve (null), never left pending')
  const failed = await run(detailed(undefined, true))
  assert.deepEqual([failed.out, failed.settled], [{ error: 'trial_read_failed' }, [null]], 'failed call: ends at the full reserve (null), never left pending')
  // The per-read ceiling refusing before any call (unpriced model) does not settle: nothing was spent, so the admission is
  // released instead (reservation and the account's read given back; see the release test below).
  const ceiling = await run({ ...detailed({ input_tokens: 1, output_tokens: 1 }), configuredModel: () => 'some-new-model' })
  assert.deepEqual([ceiling.out, ceiling.settled], [{ error: 'trial_read_failed' }, []])
})

test('#409: incomplete usage (one token count missing) is not a cost: the read ends at its full reserve', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const partial: Provider = {
    research: async () => { throw new Error('unused') },
    configuredModel: () => 'claude-sonnet-4-5',
    completeDetailed: async () => ({ text: await goodProvider.complete!('k', '', undefined, 700), model: 'claude-sonnet-4-5', usage: { input_tokens: 2000 } as never }),
  }
  const settled: (number | null)[] = []
  const out = await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: partial }, trial: admitted({ n: 0 }, settled) })
  assert.ok('icp' in out)
  assert.deepEqual(settled, [null])
  // A provider with complete() only (no usage report at all): the same, the read ends at its reserve.
  const plain: Provider = { research: async () => { throw new Error('unused') }, configuredModel: () => 'claude-sonnet-4-5', complete: async () => goodProvider.complete!('k', '', undefined, 700) }
  const settled2: (number | null)[] = []
  assert.ok('icp' in await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: plain }, trial: admitted({ n: 0 }, settled2) }))
  assert.deepEqual(settled2, [null])
})

// Council R1-1 on d6c89bf2: the guard prices the prompt in UTF-8 bytes, so a 5000-character CJK page (about 15000 bytes)
// cost more than the $0.05 ceiling and was refused after the reservation and the account's read were taken. Now the
// trial prompt's page text is capped in bytes, and a refusal before any call releases the admission.
test('#444 R1-1: a CJK page at the character cap reads on the trial under the per-read ceiling (one call); a refusal before any call releases the admission', async () => {
  const empty = new Database(':memory:'); migrateKeys(empty)
  const cjk = (async () => htmlResponse('<html><head><title>客户关系</title></head><body>' + '我们为销售团队提供客户关系管理工具。'.repeat(400) + '</body></html>')) as unknown as typeof fetch
  const seen = { keys: [] as string[], max: [] as number[] }, calls = { n: 0 }, settled: (number | null)[] = [], released = { n: 0 }
  let promptBytes = 0
  const base = trialProvider(seen)
  const p: Provider = { ...base, complete: async (k, prompt, f, max) => { promptBytes = Buffer.byteLength(prompt); return base.complete!(k, prompt, f, max) } }
  const out = await icpFromWebsite(empty, 'A', 'https://cjk.example', { master, lookup: pubLookup, fetchImpl: cjk, providers: { anthropic: p }, trial: admitted(calls, settled, released) })
  assert.ok('icp' in out && out.funded === 'trial', JSON.stringify(out))
  assert.deepEqual([calls.n, seen.keys.length, released.n], [1, 1, 0], 'admitted once, one call on the trial key, nothing released')
  assert.ok(promptBytes > TRIAL_SITE_READ_TEXT_BYTES && promptBytes < TRIAL_SITE_READ_TEXT_BYTES + 1700, `page text capped in bytes: prompt ${promptBytes} bytes`)
  assert.ok(callCostUsd('claude-sonnet-4-5', promptBytes, 700) <= TRIAL_SITE_READ_MAX_USD, 'the largest trial prompt fits the ceiling at the listed price')
  // Probe A2 as written (Japanese homepage with a title and meta description): read in one call, settled.
  const JA = '私たちは営業チーム向けのCRMクリーンアップツールを販売しています。中堅のB2Bソフトウェア企業の営業オペレーション担当者が主なお客様です。'
  const ja = (async () => htmlResponse(`<html><head><title>アクメ株式会社</title><meta name="description" content="営業チーム向けCRMツール"></head><body>${JA.repeat(80)}</body></html>`)) as unknown as typeof fetch
  const a2 = { calls: { n: 0 }, settled: [] as (number | null)[], released: { n: 0 } }
  const outJa = await icpFromWebsite(empty, 'A', 'https://acme.example.jp', { master, lookup: pubLookup, fetchImpl: ja, providers: { anthropic: trialProvider(seen) }, trial: admitted(a2.calls, a2.settled, a2.released) })
  assert.ok('icp' in outJa && outJa.funded === 'trial', JSON.stringify(outJa))
  assert.deepEqual([a2.calls.n, a2.settled, a2.released.n], [1, [null], 0], 'one admission, settled (complete() reports no usage), nothing released')
  // trimToBytes never splits a multi-byte character and leaves one-byte text alone.
  assert.equal(trimToBytes('我们为销售', 7), '我们')
  assert.equal(trimToBytes('abc', 9000), 'abc')
  // An operator model the guard cannot price refuses before any call: released (reservation and read back), not settled.
  const unpriced = { settled: [] as (number | null)[], released: { n: 0 } }
  const seen2 = { keys: [] as string[], max: [] as number[] }
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: trialProvider(seen2, 'some-new-model') }, trial: admitted({ n: 0 }, unpriced.settled, unpriced.released) }), { error: 'trial_read_failed' })
  assert.deepEqual([seen2.keys, unpriced.settled, unpriced.released.n], [[], [], 1])
  // A provider with no completion method at all: no call possible, released too.
  const none: Provider = { research: async () => { throw new Error('unused') } }
  const nothing = { released: { n: 0 } }
  assert.deepEqual(await icpFromWebsite(empty, 'A', 'https://acme.example', { master, lookup: pubLookup, fetchImpl: f, providers: { anthropic: none }, trial: admitted({ n: 0 }, [], nothing.released) }), { error: 'trial_read_failed' })
  assert.equal(nothing.released.n, 1)
})
