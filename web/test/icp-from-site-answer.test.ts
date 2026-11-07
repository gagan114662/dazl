// "Fill my profile from my website" with the model's answer at the real 1,200-token output cap: a valid answer passes; a cut-off,
// malformed or invalid answer gets a truthful error, never "AI key rejected" (only an authentication refusal is that); nothing retries a paid call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Lookup } from '../lib/net/public-fetch.ts'
import { icpFromWebsite, readProfileAnswer, PROFILE_MAX_OUTPUT_TOKENS, RESEARCH_PROMPT_MAX_BYTES } from '../lib/scan/icp-from-site.ts'
import { migrateKeys, saveKey } from '../lib/llm/key-store.ts'
import { anthropicProvider, ProviderError, type DetailedCompletion, type Provider } from '../lib/llm/provider.ts'
import { knownErrorCopy } from '../lib/error-copy.ts'

const master = randomBytes(32), KEY = 'sk-ant...AAAA'
const lookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const PAGE_TEXT = 'We sell verified prospect lists to B2B SaaS sales teams. Our customers are outbound teams at seed-stage startups in the UK and US. '.repeat(12)
const HTML = `<html><head><title>Acme Leads</title><meta name="description" content="Prospect lists for outbound teams"></head><body>${PAGE_TEXT}</body></html>`
const page = (async () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
const setup = () => { const db = new Database(':memory:'); migrateKeys(db); saveKey(db, 'A', 'anthropic', KEY, master); return db }

// The real answer shape (sells, draft first, then offers and quoted items), sized like a model's full answer.
const QUOTE = 'verified prospect lists to B2B SaaS sales teams'
const FULL = {
  sells: 'Verified prospect lists for B2B SaaS outbound teams',
  draft: { summary: 'Outbound sales teams at seed-stage B2B SaaS companies that need verified prospect lists.', who: ['Head of Sales', 'Founder'], industries: ['B2B SaaS'], sizes: ['1-50'], where: ['United Kingdom', 'United States'], signals: ['Hired their first SDR', 'Raised a seed round'], exclude: ['agencies'] },
  offers: [{ id: 'o1', name: 'Prospect lists' }],
  items: Array.from({ length: 14 }, (_, i) => ({ offer: 'o1', kind: i % 2 ? 'persona' : 'industry', text: `Buyer fact number ${i + 1} stated on the page about who the lists are for`, url: 'https://acme.example/', quote: QUOTE, inferred: false })),
}
const FULL_TEXT = JSON.stringify(FULL)
const CHARS_PER_TOKEN = 4   // the model's output at the cap: a conservative upper bound on what 1,200 tokens can hold

interface Seen { calls: number; maxTokens: number[]; prompts: string[] }
function modelAnswering(text: string, opts: { stop?: string; out?: number } = {}, seen: Seen = { calls: 0, maxTokens: [], prompts: [] }): { provider: Provider; seen: Seen } {
  return { seen, provider: {
    research: async () => { throw new Error('unused') },
    completeDetailed: async (_k, prompt, _f, max) => { seen.calls++; seen.maxTokens.push(max ?? -1); seen.prompts.push(prompt); const d: DetailedCompletion = { text, model: 'claude-sonnet-4-5', usage: { input_tokens: 4000, output_tokens: opts.out ?? 700 }, ...(opts.stop ? { stop: opts.stop } : {}) }; return d },
  } }
}
const run = (provider: Provider, extra: Record<string, unknown> = {}) => icpFromWebsite(setup(), 'A', 'https://acme.example', { master, lookup, fetchImpl: page, providers: { anthropic: provider }, researchTimeMs: 0, ...extra })

test('a VALID full answer at the real prompt shape passes: draft, sells and the source-backed offer facts survive; one call, capped at 1,200 tokens', async () => {
  const { provider, seen } = modelAnswering(FULL_TEXT, { stop: 'end_turn' })
  const out = await run(provider)
  assert.ok('icp' in out, JSON.stringify(out)); if (!('icp' in out)) return
  assert.equal(out.sells, 'Verified prospect lists for B2B SaaS outbound teams'); assert.deepEqual(out.icp.who, ['Head of Sales', 'Founder']); assert.equal(out.funded, 'own'); assert.ok(!out.truncated)
  assert.ok(out.icp.research, 'the offer facts with their verbatim quote are kept'); assert.equal(seen.calls, 1); assert.deepEqual(seen.maxTokens, [PROFILE_MAX_OUTPUT_TOKENS]); assert.equal(PROFILE_MAX_OUTPUT_TOKENS, 1200)
  assert.ok(seen.prompts[0].includes('reply with ONLY one JSON object') && Buffer.byteLength(seen.prompts[0]) <= RESEARCH_PROMPT_MAX_BYTES, 'the real prompt, inside its byte bound')
  assert.ok(FULL_TEXT.length > 1200 * 2, 'the fixture is a realistic full answer')
})
test('a fenced JSON answer still passes', async () => {
  const out = await run(modelAnswering('```json\n' + FULL_TEXT + '\n```', { stop: 'end_turn' }).provider); assert.ok('icp' in out)
})
test('an answer CUT OFF at the cap inside the offer facts: the complete leading draft is recovered (no research block), flagged truncated; still ONE call and no retry', async () => {
  const cutAt = FULL_TEXT.indexOf('"items"') + 300; assert.ok(cutAt > FULL_TEXT.indexOf('"offers"'))
  const text = FULL_TEXT.slice(0, Math.min(cutAt, PROFILE_MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN)); assert.throws(() => JSON.parse(text))
  const { provider, seen } = modelAnswering(text, { stop: 'max_tokens', out: PROFILE_MAX_OUTPUT_TOKENS })
  const out = await run(provider)
  assert.ok('icp' in out, JSON.stringify(out)); if (!('icp' in out)) return
  assert.equal(out.truncated, true); assert.equal(out.sells, 'Verified prospect lists for B2B SaaS outbound teams'); assert.deepEqual(out.icp.signals, ['Hired their first SDR', 'Raised a seed round'])
  assert.ok(!out.icp.research, 'no source-backed offer facts are invented from a cut-off block'); assert.equal(seen.calls, 1, 'no automatic paid retry')
})
test('an answer cut off INSIDE the draft is an honest "truncated" error, not a key problem; one call, no retry', async () => {
  const text = FULL_TEXT.slice(0, FULL_TEXT.indexOf('"industries"') + 20)
  const { provider, seen } = modelAnswering(text, { stop: 'max_tokens', out: PROFILE_MAX_OUTPUT_TOKENS })
  assert.deepEqual(await run(provider), { error: 'draft_unreadable', reason: 'truncated' }); assert.equal(seen.calls, 1)
})
test('a cut-off is recognised from the output-token count alone when the vendor gave no stop reason; a short malformed answer is not called truncated', async () => {
  const text = FULL_TEXT.slice(0, 120)
  assert.deepEqual(await run(modelAnswering(text, { out: PROFILE_MAX_OUTPUT_TOKENS }).provider), { error: 'draft_unreadable', reason: 'truncated' })
  assert.deepEqual(await run(modelAnswering(text, { out: 60 }).provider), { error: 'draft_unreadable', reason: 'not_json' })
  assert.deepEqual(await run(modelAnswering(text, { stop: 'end_turn', out: 60 }).provider), { error: 'draft_unreadable', reason: 'not_json' })
})
test('malformed output that FINISHED (not cut off) is "not_json"; prose is too', async () => {
  for (const text of ['sorry, cannot help', '{"sells": "x", "draft": {"summary": "a",}}', '']) assert.deepEqual(await run(modelAnswering(text, { stop: 'end_turn' }).provider), { error: 'draft_unreadable', reason: 'not_json' }, text)
})
test('valid JSON with an invalid profile is "no_profile": no summary, a non-object draft, a malformed lookalike block', async () => {
  const cases = [{ sells: 'x', draft: { who: ['a'] } }, { sells: 'x', draft: 'text' }, { sells: 'x', draft: { ...FULL.draft, lookalike: { accounts: 'not-a-list' } } }, []]
  for (const c of cases) assert.deepEqual(await run(modelAnswering(JSON.stringify(c), { stop: 'end_turn' }).provider), { error: 'draft_unreadable', reason: 'no_profile' }, JSON.stringify(c))
})
test('only an authentication refusal is a bad key; a timeout, 5xx, rate limit or unknown failure is the provider not answering', async () => {
  const failing = (e: unknown): Provider => ({ research: async () => { throw new Error('unused') }, completeDetailed: async () => { throw e } })
  assert.deepEqual(await run(failing(new ProviderError('auth', 'key_rejected', 'rejected', 401))), { error: 'key_rejected' })
  for (const e of [new ProviderError('retry', 'provider_500', 'uncertain', 500), new ProviderError('retry', 'network_or_timeout'), new ProviderError('retry', 'provider_429', 'rejected', 429), new Error('boom')])
    assert.deepEqual(await run(failing(e)), { error: 'provider_failed' }, String(e))
})
test('saved decisions or a prior research block: a cut-off answer is NOT offered as a draft (it could not carry them forward); it stays a truncated error', async () => {
  const text = FULL_TEXT.slice(0, FULL_TEXT.indexOf('"items"') + 300)
  const mk = () => modelAnswering(text, { stop: 'max_tokens', out: PROFILE_MAX_OUTPUT_TOKENS })
  assert.deepEqual(await run(mk().provider, { decisions: { decisions: [{}], trace: {} } as never }), { error: 'draft_unreadable', reason: 'truncated' })
  assert.deepEqual(await run(mk().provider, { prior: { site: 'acme.example', offers: [], items: [] } as never }), { error: 'draft_unreadable', reason: 'truncated' })
})
test('readProfileAnswer: braces and escaped quotes inside strings do not end a recovered draft early; a draft that never closes is not recovered', () => {
  const draft = { summary: 'Teams that say "move fast {and break} things" daily.', who: ['CTO'], industries: [], sizes: [], where: [], signals: [], exclude: [] }
  const text = `{"sells":"A \\"quoted\\" thing","draft":${JSON.stringify(draft)},"offers":[{"id":"o1","na`
  const r = readProfileAnswer(text, 'max_tokens', 1200); assert.ok(r.ok && r.truncated); if (r.ok) { assert.equal(r.icp.summary, draft.summary); assert.equal(r.parsed.sells, 'A "quoted" thing') }
  assert.deepEqual(readProfileAnswer(text.slice(0, text.indexOf('"offers"') - 12), 'max_tokens', 1200), { ok: false, reason: 'truncated' })
  assert.deepEqual(readProfileAnswer(text, 'end_turn', 800), { ok: false, reason: 'not_json' }, 'a finished answer is never "recovered"')
})
test('the Anthropic provider reports why it stopped (stop_reason), without changing the usage or text', async () => {
  const f = (async () => new Response(JSON.stringify({ id: 'msg_1', model: 'claude-sonnet-4-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }], usage: { input_tokens: 10, output_tokens: 1200 } }), { status: 200 })) as unknown as typeof fetch
  const d = await anthropicProvider.completeDetailed!('k', 'p', f, 1200); assert.deepEqual([d.stop, d.text, d.usage?.output_tokens], ['max_tokens', '{"a":', 1200])
})
test('the copy for these errors is truthful: an unreadable answer is not a key problem and a provider failure is not a rejection', () => {
  for (const c of ['draft_unreadable', 'provider_failed']) { const m = knownErrorCopy(c); assert.ok(m, c); assert.doesNotMatch(m!, /was rejected|key is invalid|bad key/i, c) }
  assert.match(knownErrorCopy('draft_unreadable')!, /key worked|key is fine/i); assert.match(knownErrorCopy('provider_failed')!, /not rejected/i)
  assert.equal(knownErrorCopy('key_rejected'), 'Your AI key was rejected. Check it in Settings.')
})
