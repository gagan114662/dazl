import test from 'node:test'
import assert from 'node:assert/strict'
import { preparePrompt, estimateCost, parseQualification, qualifyLead, DEFAULT_LIMITS, FIELD_CAPS } from '../lib/scan/lead-qualify.ts'

const A = 'https://acme.test/about', B = 'https://weworkremotely.com/remote-jobs/acme-sdr'
const input = { seller_offer: 'Sales prospecting software for B2B sales teams', seller_icp: 'B2B companies hiring sales roles', company: 'Acme', signal: 'Posted a role titled "SDR"',
  pages: [{ url: A, text: 'Acme sells payroll software to retailers. Our outbound team of 5 SDRs books demos.' }, { url: B, text: 'We are hiring an SDR to grow pipeline.' }] }
const MODEL = 'claude-sonnet-4-5'
function stub(text: string, model: string | null = MODEL) { let calls = 0; return { calls: () => calls, p: { research: async () => ({ text: '', citedUrls: [] }), configuredModel: model !== null ? () => model : undefined, completeDetailed: async () => { calls++; return { text, model: 'stub-served' } } } as never } }
const V = 'anthropic'
const approval = (over: Record<string, unknown> = {}) => ({ approved_by_user: true as const, vendor: V, model: MODEL, max_usd_estimate: 1, prompt_sha256: preparePrompt(input).prompt_sha256, limits: DEFAULT_LIMITS, ...over })

test('dry run reports an estimate flagged as not a cap, names the model and limits, makes no request', async () => {
  const s = stub('{}')
  const r = await qualifyLead(s.p, 'k', input, { vendor: V })
  assert.equal(r.status, 'dry_run')
  if (r.status === 'dry_run') { assert.equal(r.cost.is_guaranteed_cap, false); assert.equal(r.cost.model, MODEL); assert.equal(r.cost.priced, true); assert.deepEqual(r.cost.field_caps, FIELD_CAPS); assert.equal(r.scope.pages_included.length, 2) }
  assert.equal(s.calls(), 0)
})
test('an unknown or unpriced model gets no dollar estimate and cannot be approved', async () => {
  const s = stub('{}', 'some-override-model')
  const d = await qualifyLead(s.p, 'k', input, { vendor: V })
  assert.equal(d.status === 'dry_run' && d.cost.usd_estimate_max, null)
  const r = await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ model: 'some-override-model' }) })
  assert.deepEqual([r.status, (r as { reason: string }).reason], ['blocked', 'unpriced_model'])
  const none = stub('{}', null)
  assert.equal(((await qualifyLead(none.p, 'k', input, { vendor: V, approval: approval() })) as { reason: string }).reason, 'unpriced_model')
  assert.equal(s.calls() + none.calls(), 0)
})
test('approval must match the model, the pages actually sent and the estimate', async () => {
  const s = stub('{}')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ model: 'other' }) })) as { reason: string }).reason, 'model_mismatch')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ prompt_sha256: 'deadbeef' }) })) as { reason: string }).reason, 'content_mismatch')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ limits: { ...DEFAULT_LIMITS, max_output_tokens: 9999 } }) })) as { reason: string }).reason, 'limits_mismatch')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: 'openai', approval: approval({ vendor: 'openai' }) })) as { reason: string }).reason, 'unpriced_model')
  const changed = { ...input, pages: [{ ...input.pages[0], text: input.pages[0].text + ' (page changed)' }, input.pages[1]] }
  assert.equal(((await qualifyLead(s.p, 'k', changed, { vendor: V, approval: approval() })) as { reason: string }).reason, 'content_mismatch')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ max_usd_estimate: 0.000001 }) })) as { reason: string }).reason, 'over_estimate')
  for (const bad of [NaN, -1, Infinity]) assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ max_usd_estimate: bad }) })) as { reason: string }).reason, 'over_estimate')
  assert.equal(((await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval({ approved_by_user: false }) })) as { reason: string }).reason, 'no_approval')
  assert.equal(((await qualifyLead(s.p, 'k', { ...input, pages: [{ url: A, text: ' ' }] }, { vendor: V, approval: approval() })) as { reason: string }).reason, 'no_pages')
  assert.equal(s.calls(), 0)
})
test('approved call: one request; quotes must be on the page they name and among pages sent; scope is reported', async () => {
  const out = JSON.stringify({
    company_fit: { verdict: 'yes', quote: 'Our outbound team of 5 SDRs books demos', quote_url: A, note: 'has outbound' },
    use_case: { verdict: 'yes', quote: 'Our outbound team of 5 SDRs books demos', quote_url: B, note: 'wrong page named' },
    buying_evidence: { verdict: 'none_seen', quote: '', quote_url: '', note: '' } })
  const s = stub(out)
  const r = await qualifyLead(s.p, 'k', input, { vendor: V, approval: approval() })
  assert.equal(s.calls(), 1)
  assert.equal(r.status, 'done')
  if (r.status === 'done') {
    const q = r.qualification
    assert.deepEqual([q.company_fit.verdict, q.company_fit.quote_url], ['yes', A])
    assert.equal(q.use_case.verdict, 'unknown')
    assert.match(q.use_case.note, /not found on the page it named/)
    assert.equal(q.buying_evidence.verdict, 'none_seen')
    assert.match(q.buying_evidence.note, /only the 2 page\(s\) sent/)
    assert.equal(q.evidence_scope.pages_included.length, 2)
    assert.match(q.caveat, /may be about another company/)
  }
})
test('a quote from a page omitted by the budget cannot pass', () => {
  const lim = { max_input_chars: 82, max_page_chars: 90, max_output_tokens: 100 }
  const prep = preparePrompt(input, lim)
  assert.deepEqual(prep.scope.pages_omitted, [B])
  assert.equal(prep.scope.any_truncated, true)
  const q = parseQualification(JSON.stringify({ company_fit: { verdict: 'yes', quote: 'We are hiring an SDR to grow pipeline.', quote_url: B } }), prep.included, prep.scope)
  assert.equal(q.company_fit.verdict, 'unknown')
  assert.match(preparePrompt(input, lim).prompt, /some text was cut off or left out/)
})
test('per-page truncation is disclosed and the quote must lie inside the sent slice', () => {
  const long = { ...input, pages: [{ url: A, text: 'x'.repeat(30) + ' tail quote that was cut off here' }] }
  const prep = preparePrompt(long, { max_input_chars: 500, max_page_chars: 30, max_output_tokens: 100 })
  assert.equal(prep.scope.pages_included[0].truncated, true)
  assert.equal(prep.scope.pages_included[0].chars_sent, 30)
  const q = parseQualification(JSON.stringify({ use_case: { verdict: 'yes', quote: 'tail quote that was cut off here', quote_url: A } }), prep.included, prep.scope)
  assert.equal(q.use_case.verdict, 'unknown')
})
test('all prompt fields are capped and unreadable output becomes unknown', () => {
  const fat = { ...input, seller_offer: 's'.repeat(5000), seller_icp: 'i'.repeat(5000), company: 'c'.repeat(5000), signal: 'g'.repeat(5000) }
  const p = preparePrompt(fat, DEFAULT_LIMITS).prompt
  assert.ok(p.length < 5000 + 2500 + DEFAULT_LIMITS.max_input_chars)
  assert.ok(!p.includes('s'.repeat(FIELD_CAPS.seller_offer + 1)))
  assert.equal(estimateCost(p, V, MODEL).bytes, Buffer.byteLength(p, 'utf8'))
  const prep = preparePrompt(input)
  const q = parseQualification('sorry', prep.included, prep.scope)
  assert.deepEqual([q.company_fit.verdict, q.use_case.verdict, q.buying_evidence.verdict], ['unknown', 'unknown', 'unknown'])
  assert.match(q.caveat, /Literal match only/)
})
test('each dropped verdict records which guard condition fired, without storing the quote', () => {
  const prep = preparePrompt(input)
  const sentText = input.pages[0].text
  const run = (j: object) => parseQualification(JSON.stringify({ company_fit: j }), prep.included, prep.scope).company_fit
  const good = run({ verdict: 'yes', quote: 'x'.repeat(20), quote_url: A, note: 'n'.repeat(900) })
  assert.equal(good.verdict, 'unknown')
  assert.equal(good.rejected?.reason, 'not_on_page')
  assert.equal(good.rejected?.quote_chars, 20)
  assert.equal(good.rejected?.model_verdict, 'yes')
  assert.equal(good.rejected?.named_page_truncated, false)
  assert.ok((good.rejected?.model_note.length ?? 0) <= 300)
  assert.equal(good.quote, null)
  assert.ok(!JSON.stringify(good).includes('x'.repeat(20)))
  assert.equal(run({ verdict: 'yes', quote: 'short', quote_url: A }).rejected?.reason, 'too_short')
  assert.equal(run({ verdict: 'yes', quote: '   ', quote_url: A }).rejected?.reason, 'quote_missing')
  const nu = run({ verdict: 'no', quote: sentText.slice(0, 20), quote_url: 'https://elsewhere.test/' })
  assert.equal(nu.rejected?.reason, 'url_not_sent')
  assert.equal(nu.rejected?.named_page_truncated, null)
  assert.equal(nu.verdict, 'unknown')
})
test('near-misses stay rejected: guard is not loosened', () => {
  const prep = preparePrompt({ ...input, pages: [{ url: A, text: 'We said "grow pipeline" fast - really… and more text here' }] })
  const run = (quote: string, url = A) => parseQualification(JSON.stringify({ company_fit: { verdict: 'yes', quote, quote_url: url } }), prep.included, prep.scope).company_fit
  assert.equal(run('We said “grow pipeline” fast').rejected?.reason, 'not_on_page')   // curly quotes
  assert.equal(run('We said "grow pipeline" fast - really...').rejected?.reason, 'not_on_page') // ellipsis form
  assert.equal(run('WE SAID "grow pipeline" fast').rejected?.reason, 'not_on_page')    // case
  assert.equal(run('We said "grow pipeline" fast', A + '/').rejected?.reason, 'url_not_sent') // trailing slash
  assert.equal(run('We said  "grow\n pipeline"  fast').verdict, 'yes')                  // whitespace only is normalised
  assert.equal(run('We said "grow pipeline" fast').rejected, undefined)
})
test('none_seen and unknown verdicts carry no rejection record', () => {
  const prep = preparePrompt(input)
  const q = parseQualification(JSON.stringify({ buying_evidence: { verdict: 'none_seen', note: 'x' }, use_case: { verdict: 'unknown' } }), prep.included, prep.scope)
  assert.equal(q.buying_evidence.rejected, undefined)
  assert.equal(q.use_case.rejected, undefined)
})
