import test from 'node:test'
import assert from 'node:assert/strict'
import { recordingFetcher, summarizeProvenance, type FetchOutcome } from '../lib/scan/verify-provenance.ts'

// Diagnostic for Instinct's question: did TinyFish have text for the pages the verifier could not read?
test('the recording fetcher passes results through unchanged and records each outcome by canonical URL', async () => {
  const seen = new Map<string, FetchOutcome>()
  const page = { text: 't', title: 'x', retrievedAt: 1 }
  const f = recordingFetcher(async u => (u.includes('blocked') ? { fail: 'blocked' as const } : u.includes('gone') ? null : page), seen)
  assert.equal(await f('https://a.example/ok?utm_source=x'), page)
  assert.deepEqual(await f('https://b.example/blocked'), { fail: 'blocked' })
  assert.equal(await f('https://c.example/gone'), null)
  assert.deepEqual(Object.fromEntries(seen), { 'https://a.example/ok': 'ok', 'https://b.example/blocked': 'blocked', 'https://c.example/gone': 'null' })
})

test('summary separates the reuse-would-help case from the source-selection case', () => {
  const seen = new Map<string, FetchOutcome>([
    ['https://a.example/1', 'blocked'], ['https://b.example/2', 'blocked'], ['https://c.example/3', 'js_required'],
    ['https://d.example/4', 'ok'], ['https://e.example/5', 'ok'],
  ])
  const tf = new Set(['https://a.example/1/', 'https://c.example/3', 'https://d.example/4'])
  const s = summarizeProvenance(['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4', 'https://e.example/5', 'https://f.example/6', 'https://a.example/1'], tf, seen)
  assert.deepEqual(s, {
    candidates: 6, verifier: { blocked: 2, js_required: 1, ok: 2 },
    verifier_failed_tinyfish_had_text: 2, verifier_failed_no_tinyfish_text: 1, verifier_ok_tinyfish_had_text: 1, verifier_not_fetched: 1,
  })
})
