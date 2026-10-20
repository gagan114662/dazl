import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { meteredComplete, QuotaExceededError } from '../lib/llm/metered.ts'
import { getUsage, migrateUsage, setPlan } from '../lib/llm/usage.ts'
import type { LlmProvider } from '../lib/llm/types.ts'

function setup() {
  const db = new Database(':memory:')
  migrateUsage(db)
  return db
}
const fake = (out = 100, inn = 50): LlmProvider => ({ name: 'fake', complete: async () => ({ text: 'ok', inputTokens: inn, outputTokens: out, model: 'default' }) })

test('usage is recorded per tenant and does not leak across tenants', async () => {
  const db = setup()
  await meteredComplete(db, fake(), 'a', { prompt: 'hi', maxOutputTokens: 500 })
  assert.equal(getUsage(db, 'a').tokens_used, 150)
  assert.equal(getUsage(db, 'a').calls, 1)
  assert.equal(getUsage(db, 'b').tokens_used, 0)
})

test('quota blocks calls once the plan limit would be exceeded', async () => {
  const db = setup()
  let blocked = false
  for (let i = 0; i < 80; i++) {
    try {
      await meteredComplete(db, fake(1900, 100), 'a', { prompt: 'x'.repeat(30), maxOutputTokens: 5000 })
    } catch (e) {
      assert.ok(e instanceof QuotaExceededError)
      blocked = true
      break
    }
  }
  assert.ok(blocked)
  assert.ok(getUsage(db, 'a').tokens_used <= 100_000)
  await meteredComplete(db, fake(), 'b', { prompt: 'hi', maxOutputTokens: 100 }) // other tenant unaffected
})

test('pro plan has a higher limit', () => {
  const db = setup()
  setPlan(db, 'a', 'pro')
  assert.equal(getUsage(db, 'a').token_limit, 5_000_000)
})

test('failed provider call releases its reservation and is not billed', async () => {
  const db = setup()
  const boom: LlmProvider = { name: 'boom', complete: async () => { throw new Error('vendor down') } }
  await assert.rejects(meteredComplete(db, boom, 'a', { prompt: 'hi', maxOutputTokens: 500 }), /vendor down/)
  const u = db.prepare('SELECT reserved_tokens, calls FROM llm_usage WHERE tenant_id = ?').get('a') as { reserved_tokens: number; calls: number }
  assert.equal(u.reserved_tokens, 0)
  assert.equal(u.calls, 0)
})

test('concurrent calls cannot overshoot the quota', async () => {
  const db = setup()
  const slow: LlmProvider = { name: 's', complete: async () => { await new Promise(r => setTimeout(r, 20)); return { text: '', inputTokens: 10, outputTokens: 1900, model: 'default' } } }
  const results = await Promise.allSettled(Array.from({ length: 80 }, () => meteredComplete(db, slow, 'a', { prompt: 'x', maxOutputTokens: 2000 })))
  const ok = results.filter(r => r.status === 'fulfilled').length
  assert.ok(ok < 80 && ok >= 20)
  assert.ok(getUsage(db, 'a').tokens_used <= 100_000)
})
