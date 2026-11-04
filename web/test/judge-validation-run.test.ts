// The real-model judge validation runner (lib/evals/judge-validation-run.ts, #396), tested offline only: every "model" here
// is a counted stub transport built on test/helpers/judge-stubs.ts, the key is a dummy, and the net fence blocks anything
// that is not loopback. Covers the request in #396: both judges x both splits in one run, thresholds fixed in code, explicit
// model/run id/cap/key, a worst-case reservation persisted before every request, requested and served model recorded,
// unpriced or mismatched models refused, no retries, and every failure (timeout, unknown billing, failed accounting,
// malformed response, cap exhaustion, concurrent attempt) stopping the run as failed with the attempt still recorded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_THRESHOLDS, type JudgeCorpus } from '../lib/evals/judge.ts'
import {
  anthropicTransport, checkInputs, createMeter, fileLedger, hostClaimPath, parseMessageEnvelope, parseValidationArgs, planRun, readKeyFromEnv, readRunRecord, reservationMicro, runRecordPath, runValidation,
  scanJudgeTemplate, servedMatches, APPROVAL, FIXED, KEY_ENV, MAX_OUTPUT_TOKENS, MAX_REFUSALS, MAX_RESPONSE_BYTES, MAX_RETRIES, RUN_RECORD_CONTRACT, RunStopped, VALIDATION_MODELS,
  type Ledger, type RunDeps, type TransportRequest, type TransportResponse,
} from '../lib/evals/judge-validation-run.ts'
import { claimCall, scanCall, scanJudgeTemplate as stubScanTemplate, STUB_MODELS } from './helpers/judge-stubs.ts'

const WEB = new URL('../', import.meta.url)
const CORPUS = JSON.parse(readFileSync(new URL('test/fixtures/evals/judges/corpus.synthetic.json', WEB), 'utf8')) as JudgeCorpus
const MODEL = 'claude-sonnet-4-5'
const KEY = `sk-ant-dummy-not-a-secret-${'k'.repeat(24)}`
const NOW = new Date('2026-11-04T12:00:00Z')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const enc = (s: string) => new TextEncoder().encode(s)
const tmp = () => mkdtempSync(join(tmpdir(), 'dazl-jv-'))
const FX_URL = 'https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/'
const FEE_BASIS = 'Anthropic console invoice: 13% HST, card FX fee 0'
const inputs = (stateDir: string, over: Record<string, unknown> = {}) => ({ runId: 'val-1', model: MODEL, capUsd: 3, fxCadPerUsd: 1.4, fxDate: '2026-11-03', fxSource: FX_URL, feeRate: 0.13, feeBasis: FEE_BASIS, stateDir, ...over })
type Env = Record<string, unknown>
const envelope = (text: string, over: Env = {}): Env => ({ id: 'msg_stub', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 5 }, ...over })
const R = (o: unknown, status = 200): TransportResponse => ({ status, body: enc(JSON.stringify(o)) })
type Override = (n: number, req: TransportRequest, text: string) => TransportResponse | Promise<TransportResponse> | undefined

// A counted stub transport: replies as a stub model would, in the Messages API envelope, and checks that the ledger's last
// line is this request's reservation (persisted before the request).
function stub(o: { model?: keyof typeof STUB_MODELS; override?: Override; ledgerDir?: string } = {}) {
  const m = o.model ?? 'truthful'
  const claim = claimCall(CORPUS, STUB_MODELS[m]()), scan = scanCall(CORPUS, STUB_MODELS[m]())
  const t = {
    requests: 0, reservedFirst: 0, seen: [] as TransportRequest[],
    transport: async (req: TransportRequest): Promise<TransportResponse> => {
      t.requests++; t.seen.push(req)
      if (o.ledgerDir) {
        const f = readdirSync(join(o.ledgerDir, 'runs')).find(x => x.endsWith('.ledger.jsonl'))!
        const last = JSON.parse(readFileSync(join(o.ledgerDir, 'runs', f), 'utf8').trim().split('\n').at(-1)!)
        assert.equal(last.event, 'reserve'); assert.equal(last.prompt_sha256, sha(req.prompt)); assert.ok(last.reserve_micro > 0)
        t.reservedFirst++
      }
      const text = req.prompt.startsWith('You check whether public sources') ? await claim(req.prompt) : await scan(req.prompt)
      const custom = await o.override?.(t.requests, req, text)
      if (custom !== undefined) return custom
      return R(envelope(text, { usage: { input_tokens: Math.ceil(Buffer.byteLength(req.prompt) / 4), output_tokens: Math.min(req.maxTokens, Math.max(1, Math.ceil(text.length / 4))) } }))
    },
  }
  return t
}
const deps = (t: { transport: RunDeps['transport'] }, over: Partial<RunDeps> = {}): RunDeps => ({ transport: t.transport, secrets: [KEY], corpus: CORPUS, now: () => NOW, hostClaim: join(tmp(), 'host-claim'), ...over })
const fileOf = (dir: string, ext: string) => { const f = readdirSync(join(dir, 'runs')).find(x => x.endsWith(ext)); return f ? readFileSync(join(dir, 'runs', f), 'utf8') : null }
const PLAN = planRun(CORPUS, MODEL)
const EXPECTED_CALLS = 2 * CORPUS.items.reduce((n, it) => n + 2 + (it.sources.length > 1 ? 1 : 0), 0)

test('the offline harness stays stub-only and separate: scripts/judges.mts never loads the paid runner, a provider or fetch', () => {
  const src = readFileSync(new URL('scripts/judges.mts', WEB), 'utf8')
  assert.doesNotMatch(src, /judge-validation-run|llm\/provider|fetch\(|_KEY/)
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort()
  assert.deepEqual(imports, ['../lib/evals/judge.ts', '../test/helpers/judge-stubs.ts', 'node:fs'])
  assert.doesNotMatch(readFileSync(new URL('lib/evals/judge.ts', WEB), 'utf8'), /judge-validation-run/)
})

test('the plan covers both judges and both splits of the whole 44-item corpus, with explicit output limits and real prompt sizes', () => {
  assert.equal(CORPUS.items.length, 44)
  assert.equal(PLAN.calls.length, EXPECTED_CALLS); assert.equal(EXPECTED_CALLS, 188)
  for (const judge of ['claim_support', 'scan_verification_judge'] as const) for (const split of ['calibration', 'holdout'] as const) {
    const ids = new Set(PLAN.calls.filter(c => c.judge === judge && c.split === split).map(c => c.item))
    assert.deepEqual([...ids].sort(), CORPUS.items.filter(i => i.split === split).map(i => i.id).sort(), `${judge}/${split}`)
  }
  for (const c of PLAN.calls) {
    assert.equal(c.max_output_tokens, MAX_OUTPUT_TOKENS[c.judge])
    assert.equal(c.reserve_micro, reservationMicro(MODEL, c.prompt_bytes, c.max_output_tokens))
  }
  assert.equal(PLAN.worst_case_micro, PLAN.calls.reduce((s, c) => s + c.reserve_micro, 0))
  assert.deepEqual(FIXED.thresholds, DEFAULT_THRESHOLDS); assert.ok(Object.isFrozen(FIXED) && Object.isFrozen(FIXED.thresholds))
  assert.equal(MAX_RETRIES, 0)
  assert.equal(scanJudgeTemplate(), stubScanTemplate(), 'the scan judge is validated with the same template the lock registers')
  console.log(`plan: ${PLAN.calls.length} calls, worst case ${PLAN.worst_case_micro / 1e6} USD`)
})

test('one stubbed run: every planned call reserved and persisted first, both judges x both splits reported separately, redacted artifact with hashes', async () => {
  const dir = tmp(), t = stub({ ledgerDir: dir })
  const r = await runValidation(inputs(dir), deps(t))
  assert.equal(String(r.status), 'completed', JSON.stringify(r.problems))
  if (r.status === 'refused') return
  assert.equal(t.requests, EXPECTED_CALLS); assert.equal(t.reservedFirst, EXPECTED_CALLS)
  const a = r.artifact
  assert.equal(a.results_valid, true); assert.equal(a.stop, null)
  assert.equal(a.totals.requests, EXPECTED_CALLS); assert.equal(a.attempts.length, EXPECTED_CALLS); assert.equal(a.totals.unknown_billing_attempts, 0)
  a.attempts.forEach((x, k) => {
    const p = PLAN.calls[k]
    assert.deepEqual([x.judge, x.split, x.item], [p.judge, p.split, p.item], `attempt ${k + 1} follows the plan`)
    assert.ok(x.reserved_micro <= p.reserve_micro && x.reserved_micro > 0)
    assert.equal(x.outcome, 'ok'); assert.equal(x.billing, 'settled'); assert.equal(x.request_sent, true)
    assert.equal(x.requested_model, MODEL); assert.equal(x.served_model, MODEL)
    assert.ok(x.settled_micro! <= x.reserved_micro)
    assert.equal(x.stop_reason, 'end_turn')
  })
  assert.deepEqual([a.totals.refusals, a.totals.max_tokens], [0, 0])
  // Item 1: the approval is the owner's own messages, never a comment URL. Item 5: the dated BoC rate and fee basis.
  assert.equal(a.approval, APPROVAL); assert.match(a.approval, /Gagan, WhatsApp messages 2026-11-03 19:52 and 19:53 ET: ONE .* hard CAD 5/)
  assert.doesNotMatch(a.approval, /https?:|github|issuecomment|#\d/)
  assert.equal('approved_rerun' in a, false)
  assert.deepEqual(a.cap.fx, { source: 'Bank of Canada', cad_per_usd: 1.4, date: '2026-11-03', url: FX_URL })
  assert.deepEqual(a.cap.fee, { rate: 0.13, basis: FEE_BASIS })
  assert.equal(a.run_guard.state_dir, dir); assert.equal(a.run_guard.committed_record, 'lib/evals/judge-validation-runs.json'); assert.equal(a.run_guard.max_refusals, MAX_REFUSALS)
  assert.ok(a.limits.some(l => /refused item .* counts as unknown \(abstain/.test(l)), 'refusals count as unknown/abstain')
  assert.ok(a.totals.committed_usd <= a.cap.usd && a.totals.committed_usd === a.totals.settled_usd)
  for (const judge of ['claim_support', 'scan_verification_judge'] as const) {
    assert.equal(a.results[judge].calibration.report!.split, 'calibration'); assert.equal(a.results[judge].holdout.report!.split, 'holdout')
    assert.equal(a.results[judge].calibration.report!.ok, true, `${judge}: the truthful stub passes calibration`)
    assert.match(a.results[judge].holdout.note!, /reported separately/)
  }
  assert.equal(a.corpus.hash, a.results.claim_support.calibration.report!.corpus.hash); assert.equal(a.corpus.origin, 'synthetic')
  assert.deepEqual(Object.keys(a.code).sort(), ['lib/evals/judge-validation-run.ts', 'lib/evals/judge-validation-runs.json', 'lib/evals/judge.ts', 'lib/llm/spend-guard.ts', 'lib/scan/runner.ts', 'scripts/judge-validation-run.mts', 'test/fixtures/evals/judges/corpus.synthetic.json'])
  assert.ok(Object.values(a.code).every(h => /^[0-9a-f]{64}$/.test(h)))
  assert.equal(a.fixed_before_run.thresholds_sha256, sha(JSON.stringify(DEFAULT_THRESHOLDS)))
  assert.ok(a.limits.some(l => /no live-web accuracy claim/.test(l)))
  const onDisk = readFileSync(r.artifact_path, 'utf8'), ledger = fileOf(dir, '.ledger.jsonl')!
  assert.deepEqual(JSON.parse(onDisk), a)
  for (const text of [onDisk, ledger, fileOf(dir, '.run.json')!]) assert.ok(!text.includes(KEY), 'the key is never written')
  const events = ledger.trim().split('\n').map(l => JSON.parse(l).event)
  assert.equal(events.filter(e => e === 'reserve').length, EXPECTED_CALLS); assert.equal(events.filter(e => e === 'settle').length, EXPECTED_CALLS)
  assert.deepEqual([events[0], events.at(-1)], ['start', 'end'])
  assert.equal(JSON.parse(fileOf(dir, '.run.json')!).status, 'completed')
  assert.equal(existsSync(process.env.DB_PATH!), false, 'no database was opened')
})

test('negative control: an adversarial stub completes the run but fails calibration; the result is reported, not hidden', async () => {
  const dir = tmp(), t = stub({ model: 'gullible_action' })
  const r = await runValidation(inputs(dir), deps(t))
  assert.equal(String(r.status), 'completed')
  if (r.status === 'refused') return
  assert.equal(r.artifact.results.claim_support.calibration.report!.ok, false)
  assert.ok(r.artifact.results.claim_support.calibration.report!.problems.length > 0)
})

test('inputs are explicit and fail closed: no default cap, model, run id, FX or fee; wrong types refused with nothing sent', async () => {
  const dir = tmp()
  const bad: [string, Record<string, unknown>][] = [
    ['no cap', { capUsd: undefined }], ['cap string', { capUsd: '3' }], ['cap NaN', { capUsd: NaN }], ['cap Infinity', { capUsd: Infinity }], ['cap negative', { capUsd: -1 }],
    ['cap zero', { capUsd: 0 }], ['cap null', { capUsd: null }], ['cap bool', { capUsd: true }], ['cap list', { capUsd: [3] }],
    ['no model', { model: undefined }], ['empty model', { model: '' }], ['model number', { model: 4 }], ['unpriced model', { model: 'gpt-4.1' }], ['look-alike model', { model: 'claude-sonnet-4-5-evil' }],
    ['model null', { model: null }], ['model list', { model: [MODEL] }], ['model snapshot id (not the reviewed alias)', { model: `${MODEL}-20250929` }], ['other priced-looking model', { model: 'claude-opus-4-1' }],
    ['no run id', { runId: undefined }], ['path run id', { runId: '../x' }], ['short run id', { runId: 'a' }], ['long run id', { runId: 'x'.repeat(65) }], ['run id number', { runId: 5 }],
    ['no fx', { fxCadPerUsd: undefined }], ['fx string', { fxCadPerUsd: '1.4' }], ['fx implausible low', { fxCadPerUsd: 0.7 }], ['fx implausible high', { fxCadPerUsd: 3 }],
    ['no fx date', { fxDate: undefined }], ['bad fx date', { fxDate: '2026-13-01' }], ['impossible fx date', { fxDate: '2026-02-30' }], ['future fx date', { fxDate: '2026-12-01' }], ['stale fx date', { fxDate: '2026-10-01' }], ['fx date number', { fxDate: 20261103 }],
    ['no fee', { feeRate: undefined }], ['fee negative', { feeRate: -0.1 }], ['fee huge', { feeRate: 0.6 }], ['fee string', { feeRate: '0.13' }],
    ['no fx source', { fxSource: undefined }], ['fx source empty', { fxSource: '' }], ['fx source not the Bank of Canada', { fxSource: 'https://www.xe.com/currencyconverter/' }],
    ['fx source look-alike host', { fxSource: 'https://www.bankofcanada.ca.evil.example/x' }], ['fx source http', { fxSource: 'http://www.bankofcanada.ca/rates/' }],
    ['fx source with whitespace', { fxSource: `${FX_URL} x` }], ['fx source number', { fxSource: 1.4 }], ['fx source list', { fxSource: [FX_URL] }], ['fx source huge', { fxSource: `${FX_URL}${'x'.repeat(400)}` }],
    ['no fee basis', { feeBasis: undefined }], ['fee basis empty', { feeBasis: '' }], ['fee basis control chars', { feeBasis: 'HST\n13%' }], ['fee basis non-ASCII', { feeBasis: 'HST 13 % \u202e' }],
    ['fee basis object', { feeBasis: { hst: 0.13 } }], ['fee basis null', { feeBasis: null }], ['fee basis huge', { feeBasis: 'x'.repeat(301) }],
    ['tuning input', { thresholds: { ...DEFAULT_THRESHOLDS, max_fp_rate: 1 } }], ['repeats input', { repeats: 1 }],
    ['rerun approval input (no rerun path)', { approvedRerun: 'https://github.com/gagan114662/dazl/issues/396#issuecomment-123456' }], ['rerun input', { rerun: true }], ['force input', { force: true }],
    ['no state dir', { stateDir: '' }], ['state dir missing', { stateDir: undefined }], ['relative state dir', { stateDir: 'state' }], ['state dir number', { stateDir: 7 }], ['state dir with NUL', { stateDir: '/tmp/a\0b' }],
    ['over the CAD approval', { capUsd: 3.2 }], // 3.2 x 1.4 x 1.13 = 5.06 CAD
  ]
  for (const [name, over] of bad) {
    const host = join(tmp(), 'host-claim')
    const t = stub(), r = await runValidation({ ...inputs(dir), ...over }, deps(t, { hostClaim: host }))
    assert.equal(r.status, 'refused', name); assert.equal(t.requests, 0, name)
    assert.equal(existsSync(host), false, `${name}: a refused input claims nothing`)
  }
  assert.equal(existsSync(join(dir, 'runs')), false, 'a refused run claims nothing')
  assert.deepEqual(VALIDATION_MODELS, ['claude-sonnet-4-5'])
  assert.deepEqual(checkInputs(inputs(dir, { capUsd: 4, fxCadPerUsd: 1.25, feeRate: 0 }), NOW), [], 'exactly CAD 5 is within the approval')
  assert.equal((await runValidation(inputs(dir), deps(stub(), { secrets: [] }))).status, 'refused', 'no key, no run')
  assert.equal((await runValidation(null, deps(stub()))).status, 'refused')
})

test('the key comes from the environment only, is removed from it, and malformed keys are refused', () => {
  const env: Record<string, string | undefined> = { [KEY_ENV]: KEY }
  assert.deepEqual(readKeyFromEnv(env), { key: KEY }); assert.equal(KEY_ENV in env, false)
  for (const v of [undefined, '', 'short', `${KEY} x`, `${KEY}\n`]) assert.ok('problem' in readKeyFromEnv({ [KEY_ENV]: v }), String(v))
  const p = parseValidationArgs(['--key', KEY]); assert.ok(p.problems.some(x => /unknown argument/.test(x)), 'no key flag')
})

test('the cap: a cap below the planned worst case refuses up front; a cap of exactly the worst case runs to completion', async () => {
  const exact = PLAN.worst_case_micro / 1e6
  const under = await runValidation(inputs(tmp(), { capUsd: exact - 0.000001 }), deps(stub()))
  assert.equal(under.status, 'refused'); assert.match(under.problems.join(), /below the planned worst case/)
  const t = stub(), r = await runValidation(inputs(tmp(), { capUsd: exact }), deps(t))
  assert.equal(String(r.status), 'completed'); assert.equal(t.requests, EXPECTED_CALLS)
})

const memLedger = (fail?: (ev: Record<string, unknown>) => unknown): Ledger & { lines: string[] } => {
  const l = { lines: [] as string[], write(line: string) { const ev = JSON.parse(line); if (fail) { const x = fail(ev); if (x !== undefined) throw x } l.lines.push(line) }, close() {} }
  return l
}
const meterFor = (capMicro: number, transport: RunDeps['transport'], ledger: Ledger = memLedger(), timeoutMs?: number) => createMeter({ model: MODEL, capMicro, transport, ledger, secrets: [KEY], timeoutMs, now: () => NOW })
const fullBill = (req: TransportRequest) => R(envelope('supports', { usage: { input_tokens: Buffer.byteLength(req.prompt) + 1000, output_tokens: req.maxTokens } }))

test('cap exactly hit is allowed; the next reservation over the cap stops the run before sending, and is recorded', async () => {
  const prompt = 'You check one claim against a passage. '.repeat(10), max = 10
  const one = reservationMicro(MODEL, Buffer.byteLength(prompt), max)
  let sent = 0
  const m = meterFor(one, async req => { sent++; return fullBill(req) })
  assert.equal(await m.call(prompt, 'scan_verification_judge', max), 'supports')
  assert.equal(m.state.committed_micro, one, 'settled at exactly the cap')
  await assert.rejects(m.call(prompt, 'scan_verification_judge', max), (e: unknown) => e instanceof RunStopped && e.reason === 'cap_exhausted')
  assert.equal(sent, 1)
  assert.deepEqual(m.state.attempts.map(a => [a.outcome, a.request_sent, a.billing]), [['ok', true, 'settled'], ['cap_exhausted', false, 'none']])
  await assert.rejects(m.call(prompt, 'scan_verification_judge', max), RunStopped)
  assert.equal(sent, 1); assert.equal(m.state.refused_after_stop, 1)
  const m2 = meterFor(one - 1, async req => { sent++; return fullBill(req) })
  await assert.rejects(m2.call(prompt, 'scan_verification_judge', max), (e: unknown) => e instanceof RunStopped && e.reason === 'cap_exhausted')
  assert.equal(sent, 1, 'one micro-dollar short: nothing sent')
})

test('concurrent attempts: a second attempt while one is in flight stops the run and is never sent', async () => {
  let sent = 0
  const m = meterFor(10_000_000, async req => { sent++; await new Promise(r => setTimeout(r, 20)); return fullBill(req) })
  const [a, b] = await Promise.allSettled([m.call('prompt one', 'scan_verification_judge', 10), m.call('prompt two', 'scan_verification_judge', 10)])
  assert.equal(a.status, 'fulfilled'); assert.equal(b.status, 'rejected')
  assert.equal(sent, 1)
  assert.equal(m.state.stop!.reason, 'concurrent_attempt')
  assert.deepEqual(m.state.attempts.map(x => [x.outcome, x.request_sent]), [['ok', true], ['concurrent_attempt', false]])
})

test('the scan judge validated is the scan\'s own judge: one-word replies parsed by the scan\'s parser, max_tokens as the scan sends', async () => {
  const t = stub()
  const r = await runValidation(inputs(tmp()), deps(t))
  assert.equal(String(r.status), 'completed')
  const scanReqs = t.seen.filter(s => !s.prompt.startsWith('You check whether public sources'))
  assert.equal(scanReqs.length, EXPECTED_CALLS / 2)
  assert.ok(scanReqs.every(s => s.maxTokens === 10 && s.model === MODEL))
  assert.ok(t.seen.filter(s => s.prompt.startsWith('You check whether public sources')).every(s => s.maxTokens === 400))
})

// Each malformed or failed response: the run stops as FAILED on that attempt, exactly one request is made (no retry),
// the attempt is recorded with its reservation counted as spent, nothing after it is sent, and the artifact is written.
const raw = (s: string): TransportResponse => ({ status: 200, body: enc(s) })
const withUsage = (t: string, usage: Env) => R(envelope(t, { usage }))
const ADVERSARIAL: [string, Override, string][] = [
  ['top level is a list', () => R([1]), 'invalid_response'],
  ['top level is null', () => R(null), 'invalid_response'],
  ['top level is a string', () => R('supports'), 'invalid_response'],
  ['content is a string', (_n, _r, t) => R(envelope(t, { content: t })), 'invalid_response'],
  ['content is empty', (_n, _r, t) => R(envelope(t, { content: [] })), 'invalid_response'],
  ['content block is null', (_n, _r, t) => R(envelope(t, { content: [null] })), 'invalid_response'],
  ['text is a number', (_n, _r, t) => R(envelope(t, { content: [{ type: 'text', text: 1 }] })), 'invalid_response'],
  ['model is a number', (_n, _r, t) => R(envelope(t, { model: 4 })), 'invalid_response'],
  ['model is missing', (_n, _r, t) => R(envelope(t, { model: undefined })), 'invalid_response'],
  ['type is error', (_n, _r, t) => R(envelope(t, { type: 'error' })), 'invalid_response'],
  ['role is user', (_n, _r, t) => R(envelope(t, { role: 'user' })), 'invalid_response'],
  ['id is missing', (_n, _r, t) => R(envelope(t, { id: undefined })), 'invalid_response'],
  ['stop_reason is unknown', (_n, _r, t) => R(envelope(t, { stop_reason: 'tool_use' })), 'invalid_response'],
  ['stop_reason is missing', (_n, _r, t) => R(envelope(t, { stop_reason: undefined })), 'invalid_response'],
  ['stop_reason is null', (_n, _r, t) => R(envelope(t, { stop_reason: null })), 'invalid_response'],
  ['stop_reason is empty', (_n, _r, t) => R(envelope(t, { stop_reason: '' })), 'invalid_response'],
  ['stop_reason is a number', (_n, _r, t) => R(envelope(t, { stop_reason: 1 })), 'invalid_response'],
  ['stop_reason is a list', (_n, _r, t) => R(envelope(t, { stop_reason: ['refusal'] })), 'invalid_response'],
  ['stop_reason is an object', (_n, _r, t) => R(envelope(t, { stop_reason: { reason: 'refusal' } })), 'invalid_response'],
  ['stop_reason is upper case', (_n, _r, t) => R(envelope(t, { stop_reason: 'REFUSAL' })), 'invalid_response'],
  ['stop_reason is pause_turn', (_n, _r, t) => R(envelope(t, { stop_reason: 'pause_turn' })), 'invalid_response'],
  ['extra top-level key (an action)', (_n, _r, t) => R(envelope(t, { send_email: 'founders@x.example' })), 'invalid_response'],
  ['extra key named like the key', (_n, _r, t) => R(envelope(t, { [KEY]: 1 })), 'invalid_response'],
  ['extra content-block key', (_n, _r, t) => R(envelope(t, { content: [{ type: 'text', text: t, tool: 'send' }] })), 'invalid_response'],
  ['tool_use content block', (_n, _r, t) => R(envelope(t, { content: [{ type: 'tool_use', id: 'x', name: 'send_email', input: {} }] })), 'invalid_response'],
  ['citations on a block', (_n, _r, t) => R(envelope(t, { content: [{ type: 'text', text: t, citations: [{}] }] })), 'invalid_response'],
  ['empty body', () => ({ status: 200, body: new Uint8Array(0) }), 'invalid_response'],
  ['huge body', () => raw(`{"pad":"${'x'.repeat(MAX_RESPONSE_BYTES)}"}`), 'invalid_response'],
  ['huge reply text', (_n, r) => R(envelope('supports '.repeat(r.maxTokens * 10))), 'invalid_response'],
  ['empty reply text', () => R(envelope('')), 'invalid_response'],
  ['whitespace reply text', () => R(envelope(' \n ')), 'invalid_response'],
  ['non-UTF8 body', () => ({ status: 200, body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]) }), 'invalid_response'],
  ['body is a string, not bytes', () => ({ status: 200, body: 'x' as unknown as Uint8Array }), 'invalid_response'],
  ['body is not JSON', () => raw('supports'), 'invalid_response'],
  ['NaN literal in usage', (_n, _r, t) => raw(JSON.stringify(envelope(t)).replace('"input_tokens":100', '"input_tokens":NaN')), 'invalid_response'],
  ['deeply nested body', () => raw(`${'['.repeat(5000)}${']'.repeat(5000)}`), 'invalid_response'],
  ['usage missing', (_n, _r, t) => R(envelope(t, { usage: undefined })), 'invalid_usage'],
  ['usage is a list', (_n, _r, t) => R(envelope(t, { usage: [100, 5] })), 'invalid_usage'],
  ['usage input_tokens missing', (_n, _r, t) => withUsage(t, { output_tokens: 5 }), 'invalid_usage'],
  ['usage output_tokens null', (_n, _r, t) => withUsage(t, { input_tokens: 100, output_tokens: null }), 'invalid_usage'],
  ['usage input_tokens a string', (_n, _r, t) => withUsage(t, { input_tokens: '100', output_tokens: 5 }), 'invalid_usage'],
  ['usage input_tokens negative', (_n, _r, t) => withUsage(t, { input_tokens: -1, output_tokens: 5 }), 'invalid_usage'],
  ['usage input_tokens fractional', (_n, _r, t) => withUsage(t, { input_tokens: 1.5, output_tokens: 5 }), 'invalid_usage'],
  ['usage input_tokens 1e400 (Infinity)', (_n, _r, t) => raw(JSON.stringify(envelope(t)).replace('"input_tokens":100', '"input_tokens":1e400')), 'invalid_usage'],
  ['usage cache tokens negative', (_n, _r, t) => withUsage(t, { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: -3 }), 'invalid_usage'],
  ['usage extra key', (_n, _r, t) => withUsage(t, { input_tokens: 100, output_tokens: 5, bonus_tokens: 1 }), 'invalid_usage'],
  ['usage reports server tool use', (_n, _r, t) => withUsage(t, { input_tokens: 100, output_tokens: 5, server_tool_use: { web_search_requests: 1 } }), 'invalid_usage'],
  ['usage output over max_tokens', (_n, r, t) => withUsage(t, { input_tokens: 100, output_tokens: r.maxTokens + 1 }), 'invalid_usage'],
  ['served model is another model', (_n, _r, t) => R(envelope(t, { model: 'claude-opus-4-1' })), 'model_mismatch'],
  ['served model is an unpriced look-alike', (_n, _r, t) => R(envelope(t, { model: 'claude-sonnet-4-5-evil' })), 'model_mismatch'],
  ['served model is a snapshot of another alias', (_n, _r, t) => R(envelope(t, { model: 'claude-sonnet-4-50-20250929' })), 'model_mismatch'],
  ['HTTP 500', () => R({ type: 'error' }, 500), 'http_error'],
  ['HTTP 429', () => R({ type: 'error' }, 429), 'http_error'],
  ['HTTP 401', () => R({ type: 'error' }, 401), 'http_error'],
  ['HTTP 529 overloaded', () => R({ type: 'error' }, 529), 'http_error'],
  ['no status', () => ({ body: enc('{}') }) as unknown as TransportResponse, 'invalid_response'],
  ['transport resolves null', () => null as unknown as TransportResponse, 'invalid_response'],
  ['network error', () => { throw new Error('ECONNRESET') }, 'network_error'],
  ['throws a non-Error object without errno', () => { throw {} }, 'network_error'],
  ['throws null', () => { throw null }, 'network_error'],
  ['throws a string carrying the key', () => { throw `upstream echoed ${KEY}` }, 'network_error'],
  ['over the reservation', (_n, _r, t) => withUsage(t, { input_tokens: 9_000_000, output_tokens: 5 }), 'over_reservation'],
]

for (const [name, override, outcome] of ADVERSARIAL) {
  test(`adversarial response stops the run as failed and is recorded: ${name}`, async () => {
    const dir = tmp(), t = stub({ override: (n, r, text) => (n === 1 ? override(n, r, text) : undefined) })
    const r = await runValidation(inputs(dir), deps(t))
    assert.equal(String(r.status), 'failed')
    if (r.status === 'refused') return
    assert.equal(t.requests, 1, 'one request, no retry, nothing after the stop')
    const a = r.artifact, x = a.attempts[0]
    assert.equal(a.stop!.reason, outcome); assert.equal(x.outcome, outcome); assert.equal(a.results_valid, false)
    assert.equal(x.request_sent, true)
    if (outcome === 'invalid_response' || outcome === 'http_error' || outcome === 'network_error') assert.equal(x.stop_reason, null, 'no stop_reason without a well-formed answer')
    assert.deepEqual([a.totals.refusals, a.totals.max_tokens], [0, 0])
    if (outcome === 'over_reservation') { assert.equal(x.billing, 'settled'); assert.ok(x.settled_micro! > x.reserved_micro); assert.equal(a.totals.committed_usd, x.settled_micro! / 1e6) }
    else { assert.equal(x.billing, 'unknown'); assert.equal(a.totals.committed_usd, x.reserved_micro / 1e6, 'unknown billing keeps the whole reservation') }
    assert.equal(a.attempts.length, 1); assert.ok(a.totals.refused_after_stop > 0)
    assert.equal(a.results.scan_verification_judge.calibration.report, null, 'later phases never run')
    assert.ok(a.limits.some(l => /FAILED/.test(l)))
    const onDisk = readFileSync(r.artifact_path, 'utf8'), ledger = fileOf(dir, '.ledger.jsonl')!
    assert.equal(JSON.parse(onDisk).attempts[0].outcome, outcome)
    assert.ok(ledger.includes('"event":"stop"'))
    for (const text of [onDisk, ledger]) assert.ok(!text.includes(KEY), 'the key is redacted')
    assert.equal(JSON.parse(fileOf(dir, '.run.json')!).status, 'failed')
  })
}

test('timeout: a request with no answer stops the run as failed with unknown billing; a late answer changes nothing', async () => {
  const dir = tmp()
  let release: (v: TransportResponse) => void = () => {}
  const t = stub({ override: n => (n === 1 ? new Promise<TransportResponse>(r => { release = r }) as unknown as TransportResponse : undefined) })
  const r = await runValidation(inputs(dir), deps(t, { timeoutMs: 30 }))
  release(R(envelope('supports')))
  assert.equal(String(r.status), 'failed')
  if (r.status === 'refused') return
  assert.equal(t.requests, 1)
  assert.deepEqual([r.artifact.stop!.reason, r.artifact.attempts[0].billing], ['timeout', 'unknown'])
  assert.equal(r.artifact.totals.committed_usd, r.artifact.attempts[0].reserved_usd)
  assert.equal(t.seen[0].signal.aborted, true, 'the request is aborted')
})

test('a failure mid-run stops it there: nothing after is sent and the partial rates are marked as not results', async () => {
  const t = stub({ override: n => (n === 30 ? R({ type: 'error' }, 500) : undefined) })
  const r = await runValidation(inputs(tmp()), deps(t))
  assert.equal(String(r.status), 'failed')
  if (r.status === 'refused') return
  assert.equal(t.requests, 30); assert.equal(r.artifact.attempts.length, 30)
  assert.equal(r.artifact.attempts.filter(a => a.billing === 'unknown').length, 1)
  assert.equal(r.artifact.attempts[29].split, 'calibration')
  assert.match(r.artifact.results.claim_support.calibration.note!, /not results/)
  assert.ok(r.artifact.results.claim_support.calibration.report!.problems.length > 0, 'the cut-short phase does not pass')
  for (const [j, s] of [['claim_support', 'holdout'], ['scan_verification_judge', 'calibration'], ['scan_verification_judge', 'holdout']] as const) assert.equal(r.artifact.results[j][s].report, null)
})

const throwOn = (event: string, value: unknown) => (path: string): Ledger => {
  const inner = fileLedger(path)
  return { write(line) { if (JSON.parse(line).event === event) throw value; inner.write(line) }, close: () => inner.close() }
}
test('persistence failures fail closed: no request without a persisted reservation; a lost settle keeps the reservation', async () => {
  for (const [what, value] of [['Error without errno', new Error('disk full?')], ['plain object', {}], ['string', 'nope'], ['undefined-ish null', null]] as const) {
    const t = stub(), r = await runValidation(inputs(tmp()), deps(t, { ledger: throwOn('reserve', value) }))
    assert.equal(String(r.status), 'failed', what)
    if (r.status === 'refused') continue
    assert.equal(t.requests, 0, `${what}: nothing sent without a persisted reservation`)
    assert.deepEqual([r.artifact.stop!.reason, r.artifact.attempts[0].request_sent, r.artifact.attempts[0].billing], ['persist_failed', false, 'none'], what)
    assert.equal(r.artifact.totals.committed_usd, 0)
  }
  const t = stub(), r = await runValidation(inputs(tmp()), deps(t, { ledger: throwOn('settle', {}) }))
  assert.equal(String(r.status), 'failed')
  if (r.status !== 'refused') {
    assert.equal(t.requests, 1)
    assert.deepEqual([r.artifact.stop!.reason, r.artifact.attempts[0].billing], ['accounting_failed', 'unknown'])
    assert.equal(r.artifact.totals.committed_usd, r.artifact.attempts[0].reserved_usd)
  }
  for (const bad of [throwOn('start', new Error('x')), () => { throw {} }]) {
    const t2 = stub(), r2 = await runValidation(inputs(tmp()), deps(t2, { ledger: bad as RunDeps['ledger'] }))
    assert.equal(String(r2.status), 'failed'); assert.equal(t2.requests, 0)
    if (r2.status !== 'refused') assert.equal(r2.artifact.stop!.reason, 'persist_failed')
  }
  const t3 = stub(), r3 = await runValidation(inputs(tmp()), deps(t3, { writeArtifact: () => { throw {} } }))
  assert.equal(String(r3.status), 'completed'); if (r3.status !== 'refused') assert.match(r3.artifact_error!, /non-Error/)
})

test('one run, ever: no rerun path; the state dir, a host claim outside it and the committed record each refuse a second run', async () => {
  const dir = tmp(), host = join(tmp(), 'host-claim')
  const first = await runValidation(inputs(dir), deps(stub(), { hostClaim: host }))
  assert.equal(String(first.status), 'completed')
  assert.equal(JSON.parse(readFileSync(host, 'utf8')).run_id, 'val-1', 'the host claim records the first run outside the state dir')
  const refusedWith = async (inp: Record<string, unknown>, over: Partial<RunDeps>, re: RegExp, name: string) => {
    const t = stub(), r = await runValidation(inp, deps(t, over))
    assert.equal(r.status, 'refused', name); assert.equal(t.requests, 0, name); assert.match(r.problems.join(), re, name)
  }
  // Same state dir, any id: refused (even with a fresh host claim path).
  for (const runId of ['val-1', 'val-2']) await refusedWith(inputs(dir, { runId }), {}, /earlier validation run exists .*no rerun/, `same dir ${runId}`)
  // State reset: a new, empty state dir on the same host is refused by the host claim.
  await refusedWith(inputs(tmp(), { runId: 'val-2' }), { hostClaim: host }, /host already claimed .*no rerun/, 'fresh state dir')
  // The old rerun approval is now an unknown input: refused like any other, with or without a fresh dir and host.
  await refusedWith(inputs(tmp(), { runId: 'val-2', approvedRerun: 'https://github.com/gagan114662/dazl/issues/396#issuecomment-123456' }), {}, /unknown input\(s\): approvedRerun/, 'approvedRerun')
  // Another machine (fresh dir, fresh host) once the run is committed to the record: refused in every checkout.
  const rec = join(tmp(), 'runs.json')
  writeFileSync(rec, JSON.stringify({ contract: RUN_RECORD_CONTRACT, runs: [{ run_id: 'val-1', started_at: NOW.toISOString(), artifact_sha256: 'a'.repeat(64) }] }))
  const otherHost = join(tmp(), 'host-claim')
  await refusedWith(inputs(tmp(), { runId: 'val-9' }), { runRecord: rec, hostClaim: otherHost }, /committed record .* lists 1 run.*no rerun/, 'committed record')
  assert.equal(existsSync(otherHost), false, 'the committed record is checked before anything is claimed')
  // A missing or malformed committed record fails closed, before anything is claimed.
  for (const [name, text] of [['missing', null], ['not JSON', '{x'], ['null', 'null'], ['list', '[]'], ['wrong contract', JSON.stringify({ contract: 'x', runs: [] })],
    ['runs not a list', JSON.stringify({ contract: RUN_RECORD_CONTRACT, runs: {} })], ['runs null', JSON.stringify({ contract: RUN_RECORD_CONTRACT, runs: null })],
    ['extra key (an override)', JSON.stringify({ contract: RUN_RECORD_CONTRACT, runs: [], allow_rerun: true })]] as const) {
    const f = join(tmp(), 'runs.json'); if (text !== null) writeFileSync(f, text)
    const h = join(tmp(), 'host-claim')
    await refusedWith(inputs(tmp(), { runId: 'val-9' }), { runRecord: f, hostClaim: h }, /committed run record/, `record ${name}`)
    assert.equal(existsSync(h), false, `record ${name}: nothing claimed`)
  }
  // A crashed run (started marker), an unreadable or non-object marker, or a leftover approval claim: refused, nothing sent.
  for (const [name, file, text] of [['crashed', 'old.run.json', JSON.stringify({ run_id: 'old', status: 'started', started_at: 'x' })], ['junk marker', 'junk.run.json', '{not json'],
    ['null marker', 'n.run.json', 'null'], ['number marker', 'k.run.json', '7'], ['approval claim only', 'initial.approval', 'other'], ['a ledger only', 'x.ledger.jsonl', '']] as const) {
    const d = tmp(); mkdirSync(join(d, 'runs'), { recursive: true }); writeFileSync(join(d, 'runs', file), text)
    await refusedWith(inputs(d), {}, /earlier validation run exists|already holds run files/, name)
  }
  // Two runs racing on one host: exactly one gets the claim.
  const raceHost = join(tmp(), 'host-claim'), ta = stub(), tb = stub()
  const [ra, rb] = await Promise.all([runValidation(inputs(tmp(), { runId: 'race-a' }), deps(ta, { hostClaim: raceHost })), runValidation(inputs(tmp(), { runId: 'race-b' }), deps(tb, { hostClaim: raceHost }))])
  assert.deepEqual([ra.status, rb.status].sort(), ['completed', 'refused']); assert.equal(Math.min(ta.requests, tb.requests), 0)
})

test('the committed run record is valid and empty, the host claim is outside any state dir, and nothing else (env, flag, file) is read', () => {
  const rec = readRunRecord(runRecordPath())
  assert.ok(!('problem' in rec), JSON.stringify(rec)); if (!('problem' in rec)) assert.deepEqual(rec.runs, [], 'no run has been made')
  assert.match(hostClaimPath(), /[\\/]\.dazl[\\/]judge-validation\.host-claim$/)
  const lib = readFileSync(new URL('lib/evals/judge-validation-run.ts', WEB), 'utf8'), cliSrc = readFileSync(new URL('scripts/judge-validation-run.mts', WEB), 'utf8')
  assert.doesNotMatch(lib, /process\.env|approved_rerun|RERUN_APPROVAL|defaultStateDir|--approved-rerun/, 'the library reads no env var and has no rerun or default-state-dir path')
  assert.deepEqual([...cliSrc.matchAll(/process\.env/g)].length, 1, 'the CLI hands process.env to readKeyFromEnv only')
  assert.match(cliSrc, /readKeyFromEnv\(process\.env\)/)
  assert.doesNotMatch(cliSrc, /hostClaim|runRecord/, 'the CLI cannot move the run-once records')
})

test('a refusal from the model is a billed, well-formed answer: recorded and settled, read by the judge as unknown, the run goes on', async () => {
  assert.equal(parseMessageEnvelope(enc(JSON.stringify(envelope('', { content: [], stop_reason: 'refusal' }))), 10).ok, true)
  assert.equal(parseMessageEnvelope(enc(JSON.stringify(envelope('', { content: [] }))), 10).ok, false, 'an empty end_turn answer is still invalid')
  const t = stub({ override: n => (n === 1 ? R(envelope('', { content: [], stop_reason: 'refusal' })) : undefined) })
  const r = await runValidation(inputs(tmp()), deps(t))
  assert.equal(String(r.status), 'completed')
  if (r.status === 'refused') return
  assert.deepEqual([r.artifact.attempts[0].outcome, r.artifact.attempts[0].billing, r.artifact.attempts[0].stop_reason], ['ok', 'settled', 'refusal'])
  assert.deepEqual([r.artifact.totals.refusals, r.artifact.totals.max_tokens], [1, 0])
  const first = r.artifact.attempts[0].item!
  assert.equal(r.artifact.results.claim_support.calibration.report!.outcomes[first], 'unknown')
  assert.ok(r.artifact.limits.some(l => /1 refusal\(s\) here/.test(l)))
})

test('refusal limit: up to MAX_REFUSALS refusals complete; the next one stops the run as failed, settled and recorded', async () => {
  assert.equal(MAX_REFUSALS, 9)
  const refuse = () => R(envelope('', { content: [], stop_reason: 'refusal', usage: { input_tokens: 50, output_tokens: 0 } }))
  const ok = await runValidation(inputs(tmp()), deps(stub({ override: n => (n <= MAX_REFUSALS ? refuse() : undefined) })))
  assert.equal(String(ok.status), 'completed')
  if (ok.status !== 'refused') assert.equal(ok.artifact.totals.refusals, MAX_REFUSALS)
  const dir = tmp(), t = stub({ override: n => (n <= MAX_REFUSALS + 1 ? refuse() : undefined) })
  const r = await runValidation(inputs(dir), deps(t))
  assert.equal(String(r.status), 'failed')
  if (r.status === 'refused') return
  assert.equal(t.requests, MAX_REFUSALS + 1, 'nothing is sent after the limit')
  const last = r.artifact.attempts.at(-1)!
  assert.deepEqual([r.artifact.stop!.reason, last.outcome, last.stop_reason, last.billing], ['refusal_limit', 'refusal_limit', 'refusal', 'settled'])
  assert.equal(r.artifact.totals.refusals, MAX_REFUSALS + 1); assert.equal(r.artifact.results_valid, false)
  assert.equal(r.artifact.totals.committed_usd, r.artifact.totals.settled_usd, 'refusals are billed and settled, not unknown')
  assert.ok(fileOf(dir, '.ledger.jsonl')!.includes('"reason":"refusal_limit"') || fileOf(dir, '.ledger.jsonl')!.includes('"outcome":"refusal_limit"'))
  assert.equal(JSON.parse(fileOf(dir, '.run.json')!).status, 'failed')
})

test('max_tokens stops are recorded per attempt and counted; the cut answer is parsed as given (unknown when no verdict)', async () => {
  const t = stub({ override: (n, _r, text) => (n === 1 ? R(envelope(text.slice(0, 3), { stop_reason: 'max_tokens' })) : undefined) })
  const r = await runValidation(inputs(tmp()), deps(t))
  assert.equal(String(r.status), 'completed')
  if (r.status === 'refused') return
  assert.equal(r.artifact.attempts[0].stop_reason, 'max_tokens'); assert.deepEqual([r.artifact.totals.max_tokens, r.artifact.totals.refusals], [1, 0])
  assert.equal(r.artifact.results.claim_support.calibration.report!.outcomes[r.artifact.attempts[0].item!], 'unknown')
})

test('served-model rules: the dated snapshot of the requested alias is the same model; anything else is a mismatch', () => {
  assert.equal(servedMatches(MODEL, MODEL), true)
  assert.equal(servedMatches(MODEL, `${MODEL}-20250929`), true)
  for (const s of ['claude-sonnet-4', `${MODEL}-2025092`, `${MODEL}-20250929-x`, 'claude-opus-4-1', `${MODEL}x`]) assert.equal(servedMatches(MODEL, s), false, s)
  const ok = parseMessageEnvelope(enc(JSON.stringify(envelope('supports', { model: `${MODEL}-20250929`, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', server_tool_use: null } }))), 10)
  assert.equal(ok.ok, true, 'a well-formed response with today\'s usage fields parses')
})

test('the Anthropic transport: one fetch, the explicit model and max_tokens, the key only in its header, redirects refused, body capped', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(envelope('supports')), { status: 200 }) }) as unknown as typeof fetch
  const tr = anthropicTransport(KEY, fetchImpl)
  const res = await tr({ model: MODEL, maxTokens: 10, prompt: 'p', signal: new AbortController().signal })
  assert.equal(calls.length, 1); assert.equal(res.status, 200)
  const body = JSON.parse(String(calls[0].init.body))
  assert.deepEqual(body, { model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'p' }] })
  assert.equal((calls[0].init.headers as Record<string, string>)['x-api-key'], KEY)
  assert.equal(calls[0].init.redirect, 'error')
  const big = anthropicTransport(KEY, (async () => new Response('x'.repeat(MAX_RESPONSE_BYTES * 3), { status: 200 })) as unknown as typeof fetch)
  const r2 = await big({ model: MODEL, maxTokens: 10, prompt: 'p', signal: new AbortController().signal })
  assert.equal(r2.body.byteLength, MAX_RESPONSE_BYTES + 1)
  assert.equal(parseMessageEnvelope(r2.body, 10).ok, false)
  // Through the meter: a 503 is one fetch and a stopped run, never a retry.
  let n = 0
  const m = meterFor(10_000_000, anthropicTransport(KEY, (async () => { n++; return new Response('{}', { status: 503 }) }) as unknown as typeof fetch))
  await assert.rejects(m.call('prompt', 'scan_verification_judge', 10), RunStopped)
  assert.equal(n, 1)
})

const cli = (args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--import', './test/helpers/net-fence.ts', 'scripts/judge-validation-run.mts', ...args], { cwd: fileURLToPath(WEB), encoding: 'utf8', env: { ...process.env, [KEY_ENV]: KEY }, timeout: 60_000 })
test('the command line: plan-only by default, every input required, the paid path refuses without a key', () => {
  const dir = tmp(), today = new Date().toISOString().slice(0, 10)
  const full = ['--run-id', 'cli-1', '--model', MODEL, '--cap-usd', '3', '--fx-cad-per-usd', '1.4', '--fx-date', today, '--fx-source', FX_URL, '--fee-rate', '0.13', '--fee-basis', FEE_BASIS, '--state-dir', dir]
  const without = (flag: string) => { const k = full.indexOf(flag); return full.filter((_, j) => j !== k && j !== k + 1) }
  const none = cli([]); assert.equal(none.status, 2); assert.match(none.stderr, /REFUSED/)
  const noCap = cli(without('--cap-usd')); assert.equal(noCap.status, 2); assert.match(noCap.stderr, /capUsd is required/)
  for (const [flag, re] of [['--model', /model is required/], ['--state-dir', /stateDir is required/], ['--fx-source', /fxSource is required/], ['--fee-basis', /feeBasis is required/]] as const) {
    const r = cli(without(flag)); assert.equal(r.status, 2, flag); assert.match(r.stderr, re, flag)
  }
  const relDir = cli([...without('--state-dir'), '--state-dir', 'relative/dir']); assert.equal(relDir.status, 2); assert.match(relDir.stderr, /absolute/)
  const rerun = cli([...full, '--approved-rerun', 'https://github.com/gagan114662/dazl/issues/396#issuecomment-1']); assert.equal(rerun.status, 2); assert.match(rerun.stderr, /unknown argument "--approved-rerun"/)
  const badCap = cli(full.map(x => (x === '3' ? '3usd' : x))); assert.equal(badCap.status, 2)
  const tune = cli([...full, '--max-fp-rate', '1']); assert.equal(tune.status, 2); assert.match(tune.stderr, /unknown argument/)
  const plan = cli(full); assert.equal(plan.status, 0, plan.stderr); assert.match(plan.stdout, /188 calls, worst case/); assert.match(plan.stdout, /Bank of Canada/); assert.match(plan.stdout, /plan only: no key read, no request made/)
  assert.equal(existsSync(join(dir, 'runs')), false, 'plan only claims no run')
  // The net fence clears *KEY* variables, so --execute here has no key: it must refuse with nothing sent.
  const exec = cli([...full, '--execute']); assert.equal(exec.status, 2); assert.match(exec.stderr, new RegExp(`${KEY_ENV} is not set`))
  assert.ok(!(none.stdout + none.stderr + plan.stdout + plan.stderr + exec.stdout + exec.stderr).includes(KEY))
})
