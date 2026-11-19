import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { FIRST5_CLAUDE_ONLY_MODE, PINNED_FIRST5_CLAUDE_ONLY_MODE, QA_CLAUDE_ONLY, isFirst5RequestMode, qaClaudeOnlyBudget, qaClaudeOnlyJob, qaClaudeOnlyTransport, strictLocalTopologySupported } from '../lib/scan/qa-provider-policy.ts'

test('first-play request recognizes only the ordinary and exact versioned narrowing modes', () => {
  assert.equal(isFirst5RequestMode('first5'), true)
  assert.equal(isFirst5RequestMode(FIRST5_CLAUDE_ONLY_MODE), true)
  assert.equal(isFirst5RequestMode(PINNED_FIRST5_CLAUDE_ONLY_MODE), true)
  for (const mode of [undefined, null, false, '', '*', 'first5_claude_only_v2', QA_CLAUDE_ONLY, { provider_policy: QA_CLAUDE_ONLY }]) {
    assert.equal(isFirst5RequestMode(mode), false)
  }
})

test('persisted job keeps QA policy and narrower existing caps across retries', () => {
  const raw = qaClaudeOnlyBudget(JSON.stringify({ first5: true, credit_enrichment: false, max_usd: 0.25 }))
  assert.deepEqual(JSON.parse(raw), { first5: true, credit_enrichment: false, max_usd: 0.25, provider_policy: QA_CLAUDE_ONLY, paid_fallback: false })
  assert.equal(qaClaudeOnlyJob(raw), true)
  assert.equal(JSON.parse(qaClaudeOnlyBudget(null)).max_usd, 5)
  assert.equal(JSON.parse(qaClaudeOnlyBudget('{"max_usd":16}')).max_usd, 5)
  for (const invalid of [null, '{', '{"provider_policy":true}', '{"provider_policy":"claude_only"}']) assert.equal(qaClaudeOnlyJob(invalid), false)
})

test('only Claude transport is approved; zero-rated accounting does not approve other vendors', () => {
  assert.equal(qaClaudeOnlyTransport('llm.anthropic'), true)
  for (const kind of ['llm.openai', 'tinyfish.search', 'tinyfish.fetch', 'render', 'apollo.org', 'apollo.people', 'pdl.people', 'zerobounce', 'unknown']) assert.equal(qaClaudeOnlyTransport(kind), false)
})

test('pinned strict mode refuses PG or a queue-managed topology rather than bypass queue accounting', () => {
  assert.equal(strictLocalTopologySupported('sqlite', {}), true)
  assert.equal(strictLocalTopologySupported('pg', {}), false)
  assert.equal(strictLocalTopologySupported('sqlite', { DAZL_SCAN_SHARED_QUEUE: '1' }), false)
  assert.equal(strictLocalTopologySupported('sqlite', { DAZL_QUEUE_TENANTS: 'a-tenant' }), false)
})

test('native search requires exact new mode and a strict pinned first-play budget', async () => {
  const { NATIVE_SEARCH_FIRST5_CLAUDE_ONLY_MODE: v3, QA_NATIVE_WEB_SEARCH_POLICY: marker, QA_LOCAL_EXECUTION: execution, qaClaudeOnlyNativeSearchJob } = await import('../lib/scan/qa-provider-policy.ts')
  assert.equal(isFirst5RequestMode(v3), true)
  const forged = JSON.stringify({ first5: true, web_search_policy: marker })
  for (const mode of [undefined, FIRST5_CLAUDE_ONLY_MODE, PINNED_FIRST5_CLAUDE_ONLY_MODE, 'first5']) assert.equal(JSON.parse(qaClaudeOnlyBudget(forged, mode)).web_search_policy, undefined)
  const raw = qaClaudeOnlyBudget(forged, v3)
  const b = JSON.parse(raw)
  assert.equal(b.web_search_policy, marker)
  assert.equal(qaClaudeOnlyNativeSearchJob(raw), false)
  assert.equal(qaClaudeOnlyNativeSearchJob(JSON.stringify({ ...b, execution })), true)
  for (const tampered of [{ web_search_policy: true }, { first5: false }, { paid_fallback: true }, { credit_enrichment: true }, { execution: '' }]) {
    assert.equal(qaClaudeOnlyNativeSearchJob(JSON.stringify({ ...b, execution, ...tampered })), false)
  }
})
