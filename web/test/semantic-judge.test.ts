// #782: the separate semantic judge (lib/evals/semantic-judge.ts): blinded, unknown on timeout or disagreement, retried within bounds, own budget and log,
// and syndicated copies are one confirmation. Injected stub judges only: no model, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeClaim, provenanceGroups, independentSources, type Judge, type JudgeOptions, type JudgeLogEntry, type Source } from '../lib/evals/semantic-judge.ts'

const ITEM = { company: 'Northwind Labs', domain: 'northwind.io', contact: 'jane@northwind.io', event_date: '2026-11-01', evidence_urls: ['https://news.example.com/a'], text: 'Northwind Labs is hiring a VP of Sales, found by dazl using claude-sonnet.' }
const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions & { log: JudgeLogEntry[] } => ({ timeout_ms: 30, max_attempts: 2, budget: { max_calls: 10, used: 0 }, log: [], ...over }) as never
const says = (v: 'pass' | 'fail' | 'unknown'): Judge => async () => v
const hang: Judge = () => new Promise(() => {})
const Q = 'Is this company hiring a VP of Sales?'
const run = (judges: Record<string, Judge>, o = opts()) => judgeClaim(ITEM, ['dazl', 'claude-sonnet'], Q, judges, o)

test('two judges that agree give that verdict', async () => {
  assert.equal((await run({ a: says('pass'), b: says('pass') })).verdict, 'pass')
  assert.equal((await run({ a: says('fail'), b: says('fail') })).verdict, 'fail')
})

test('disagreement is unknown, and so is any judge that cannot tell', async () => {
  const d = await run({ a: says('pass'), b: says('fail') }); assert.equal(d.verdict, 'unknown'); assert.match(d.reason, /disagree/)
  assert.equal((await run({ a: says('pass'), b: says('unknown') })).verdict, 'unknown')
  assert.equal((await run({ a: says('pass'), b: (async () => 'yes' as never) })).verdict, 'unknown', 'anything but pass or fail is unknown')
})

test('one judge alone is never enough: it cannot be checked against another', async () => {
  const r = await run({ a: says('pass') }); assert.equal(r.verdict, 'unknown'); assert.match(r.reason, /at least 2/)
})

test('a timeout is retried within the bound, then held as unknown; a retry that works is accepted', async () => {
  const o = opts(); const r = await run({ a: says('pass'), b: hang }, o)
  assert.equal(r.verdict, 'unknown'); assert.equal(o.log.filter(l => l.judge === 'b').length, 2); assert.ok(o.log.filter(l => l.judge === 'b').every(l => l.outcome === 'timeout'))
  let n = 0; const flaky: Judge = async () => { if (n++ === 0) return new Promise(() => {}); return 'pass' }
  const o2 = opts(); assert.equal((await run({ a: says('pass'), b: flaky }, o2)).verdict, 'pass'); assert.deepEqual(o2.log.filter(l => l.judge === 'b').map(l => l.outcome), ['timeout', 'pass'])
})

test('a throwing judge is held as unknown after its retries, and the abort signal is raised on timeout', async () => {
  const o = opts(); const boom: Judge = async () => { throw new Error('rate limited') }
  assert.equal((await run({ a: says('pass'), b: boom }, o)).verdict, 'unknown'); assert.ok(o.log.some(l => l.judge === 'b' && l.outcome === 'error'))
  let aborted = false; const watch: Judge = (_c, _q, sig) => new Promise(() => { sig.addEventListener('abort', () => { aborted = true }) })
  await run({ a: says('pass'), b: watch }, opts({ max_attempts: 1 })); assert.equal(aborted, true)
})

test('the judge has its own budget: when it is spent the claim is unknown and nothing more is called', async () => {
  const o = opts({ budget: { max_calls: 3, used: 0 } }); let calls = 0; const count: Judge = async () => { calls++; return 'pass' }
  await run({ a: count, b: count }, o); const r = await run({ a: count, b: count }, o)
  assert.equal(calls, 3); assert.equal(o.budget.used, 3); assert.equal(r.verdict, 'unknown'); assert.ok(o.log.some(l => l.outcome === 'budget'))
})

test('every call is logged on the judge\'s own log with its attempt, outcome and elapsed time', async () => {
  let t = 0; const o = opts({ now: () => (t += 5) }); await run({ a: says('pass'), b: says('pass') }, o)
  assert.deepEqual(o.log.map(l => [l.judge, l.attempt, l.outcome, l.ms]), [['a', 1, 'pass', 5], ['b', 1, 'pass', 5]])
})

test('the judge reads a blinded claim: identity tokens are scrubbed and it cannot change the claim for the next judge', async () => {
  const seen: string[] = []; const spy: Judge = async c => { seen.push(c.text ?? ''); (c as { text: string }).text = 'tampered'; return 'pass' }
  await run({ a: spy, b: spy })
  assert.equal(seen.length, 2); for (const s of seen) { assert.doesNotMatch(s, /dazl|claude-sonnet/i); assert.match(s, /Northwind Labs is hiring/) }
})

const S = (url: string, text?: string, syndicated_from?: string): Source => ({ url, text, syndicated_from })
const WIRE = 'Northwind Labs announced today that it is hiring a VP of Sales to lead its expansion into the Canadian market, the company said in a statement on Monday.'

test('syndicated copies are one confirmation: a declared origin or the same text joins the group of the original', () => {
  const copies = [S('https://wire.example.com/n1', WIRE), S('https://paper-a.example.org/x', WIRE), S('https://paper-b.example.net/y', WIRE)]
  assert.equal(provenanceGroups(copies).length, 1); assert.equal(independentSources(copies).count, 1)
  const declared = [S('https://wire.example.com/n1', 'Original report text about the hire.'), S('https://paper-a.example.org/x', 'Different words entirely.', 'https://www.wire.example.com/n1/')]
  assert.equal(provenanceGroups(declared).length, 1); assert.equal(independentSources(declared).count, 1)
  const shared = [S('https://a.example.org/1', 'Alpha says it.', 'https://wire.example.com/orig'), S('https://b.example.net/2', 'Beta says it.', 'https://wire.example.com/orig')]
  assert.equal(provenanceGroups(shared).length, 1, 'two copies of an origin we never fetched are still one')
})

test('genuinely separate sources on separate domains are separate confirmations; two groups on one domain are still one', () => {
  const sep = [S('https://a.example.org/1', 'Alpha reported the hire from its own interview.'), S('https://b.example.net/2', 'Beta found it in a filing.')]
  assert.deepEqual(independentSources(sep), { count: 2, domains: ['example.net', 'example.org'], groups: 2 })
  const sameDomain = [S('https://a.example.org/1', 'One report.'), S('https://blog.a.example.org/2', 'Another report.')]
  assert.equal(independentSources(sameDomain).count, 1)
  const gh = [S('https://acme.github.io/1', 'One.'), S('https://other.github.io/2', 'Two.')]; assert.equal(independentSources(gh).count, 2)
})

test('short or empty text never groups sources by itself', () => {
  assert.equal(provenanceGroups([S('https://a.example.org/1', 'Hiring.'), S('https://b.example.net/2', 'Hiring.'), S('https://c.example.com/3')]).length, 3)
})
