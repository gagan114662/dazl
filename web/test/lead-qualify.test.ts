import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQualifyPrompt, estimateCost, parseQualification, qualifyLead, DEFAULT_LIMITS } from '../lib/scan/lead-qualify.ts'

const input = { seller_offer: 'Sales prospecting software for B2B sales teams', seller_icp: 'B2B companies hiring sales roles', company: 'Acme', signal: 'Posted a role titled "SDR"',
  pages: [{ url: 'https://acme.test/about', text: 'Acme sells payroll software to retailers. Our outbound team of 5 SDRs books demos.' }] }
function stub(text: string) { let calls = 0; return { calls: () => calls, p: { research: async () => ({ text: '', citedUrls: [] }), completeDetailed: async () => { calls++; return { text, model: 'stub-model' } } } as never } }

test('dry run: reports an estimate that is flagged as not a cap, makes no request', async () => {
  const s = stub('{}')
  const r = await qualifyLead(s.p, 'k', input)
  assert.equal(r.status, 'dry_run')
  if (r.status === 'dry_run') { assert.equal(r.cost.is_guaranteed_cap, false); assert.equal(r.cost.output_tokens_max, DEFAULT_LIMITS.max_output_tokens) }
  assert.equal(s.calls(), 0)
})
test('no approval object, over-estimate, and empty pages never reach the provider', async () => {
  const s = stub('{}')
  assert.equal((await qualifyLead(s.p, 'k', input, { approval: { approved_by_user: false as never, max_usd_estimate: 1 } })).status, 'blocked')
  const over = await qualifyLead(s.p, 'k', input, { approval: { approved_by_user: true, max_usd_estimate: 0.000001 } })
  assert.deepEqual([over.status, (over as { reason: string }).reason], ['blocked', 'over_estimate'])
  const none = await qualifyLead(s.p, 'k', { ...input, pages: [{ url: 'u', text: '  ' }] }, { approval: { approved_by_user: true, max_usd_estimate: 1 } })
  assert.deepEqual([none.status, (none as { reason: string }).reason], ['blocked', 'no_pages'])
  assert.equal(s.calls(), 0)
})
test('approved call makes exactly one request, parses, and keeps only quotes found in the supplied text', async () => {
  const s = stub(JSON.stringify({ company_fit: { verdict: 'yes', quote: 'Our outbound team of 5 SDRs books demos', note: 'has outbound' }, use_case: { verdict: 'yes', quote: 'invented sentence not on the page', note: '' }, buying_evidence: { verdict: 'none_seen', quote: '', note: '' } }))
  const r = await qualifyLead(s.p, 'k', input, { approval: { approved_by_user: true, max_usd_estimate: 1 } })
  assert.equal(s.calls(), 1)
  assert.equal(r.status, 'done')
  if (r.status === 'done') {
    assert.equal(r.qualification.company_fit.verdict, 'yes')
    assert.equal(r.qualification.use_case.verdict, 'unknown')
    assert.match(r.qualification.use_case.note, /not found/)
    assert.equal(r.qualification.buying_evidence.verdict, 'none_seen')
  }
})
test('unreadable or invalid model output becomes unknown, never a guess', () => {
  const q = parseQualification('sorry', input.pages)
  assert.deepEqual([q.company_fit.verdict, q.use_case.verdict, q.buying_evidence.verdict], ['unknown', 'unknown', 'unknown'])
  const q2 = parseQualification('{"company_fit":{"verdict":"definitely","quote":"x"}}', input.pages)
  assert.equal(q2.company_fit.verdict, 'unknown')
})
test('prompt states a job posting is not buying evidence and truncates to the input limit', () => {
  const big = { ...input, pages: [{ url: 'u', text: 'a'.repeat(50000) }] }
  const p = buildQualifyPrompt(big, { max_input_chars: 1000, max_output_tokens: 100 })
  assert.match(p, /job posting does not count/)
  assert.ok(p.length < 3000)
  assert.ok(estimateCost(p).bytes === Buffer.byteLength(p, 'utf8'))
})
