import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRunReport, type JudgeReplyClass, type JudgeReplyCounts } from '../lib/scan/run-report.ts'
import { makeJudge, verifyLeads, type LeadDraft } from '../lib/scan/runner.ts'

const excerpt = 'Northside Builders announced layoffs affecting forty roofing crew members this month'
const c: LeadDraft = { name: '', company: 'Northside Builders', contact: null, signal: 'Laying off roofers',
  source_url: 'https://northsidebuilders.example/a', score: 70, excerpt, event_date: null }
const now = new Date('2026-10-20T12:00:00Z')
const page = (text: string) => async () => ({ text, title: c.company, retrievedAt: 1_800_000_000 })
const good = page(excerpt + '. The company said this was the first phase of restructuring.')

const provider = (reply: string | null) => ({
  research: async () => ({ text: '', citedUrls: [] }),
  complete: async () => {
    if (reply === null) throw Error('private-transport-sentinel')
    return reply
  },
})

test('exact judge behavior preserved while closed diagnostics distinguish reply shapes; no private response in report', async () => {
  const counts: JudgeReplyCounts = {}
  const note = (x: JudgeReplyClass) => { counts[x] = (counts[x] ?? 0) + 1 }
  for (const [reply, diagnostic, dropped, confidence] of [
    ['Unclear.', 'explicit_unclear', 'claim_unclear', null],
    ['Unclear because of private-reply-sentinel', 'prefixed_unclear', 'claim_unclear', null],
    ['  ', 'blank', 'claim_unclear', null],
    ['Format: private-reply-sentinel', 'unrecognized', 'claim_unclear', null],
    ['Supports. Details remain unchanged', 'supports', null, 60],
    ['Contradicts. Details remain unchanged', 'contradicts', 'contradicted', null],
    [null, 'unavailable', null, 55],
  ] as const) {
    const judged = await verifyLeads([c], good, now, makeJudge(provider(reply), 'offline-fixture', undefined, note))
    assert.equal(counts[diagnostic], 1)
    assert.equal(judged.leads[0]?.confidence ?? null, confidence)
    if (dropped) assert.equal(judged.dropped[dropped], 1)
  }
  let missedJudgeCalls = 0
  const miss = await verifyLeads([{ ...c, excerpt: 'The quoted sentence is nowhere on this page.' }], good, now,
    makeJudge(provider('unclear'), 'offline-fixture', undefined, () => { missedJudgeCalls++ }))
  assert.equal(miss.review[0]?.review_reason, 'quote_unconfirmed')
  assert.equal(missedJudgeCalls, 0)
  const report = buildRunReport({ judge_replies: counts }, [], [], 1)
  assert.deepEqual(report.judge_replies, { explicit_unclear: 1, prefixed_unclear: 1, blank: 1, unrecognized: 1, supports: 1, contradicts: 1, unavailable: 1 })
  assert.doesNotMatch(JSON.stringify(report), /private-(?:transport|reply)-sentinel/)
  assert.equal('judge_replies' in buildRunReport({}, [], [], 1), false)
})

test('diagnostic callback failure cannot change the verifier verdict', async () => {
  const judge = makeJudge(provider('unclear'), 'offline-fixture', undefined, () => { throw Error('sink unavailable') })
  const result = await verifyLeads([c], good, now, judge)
  assert.equal(result.dropped.claim_unclear, 1)
})
