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
