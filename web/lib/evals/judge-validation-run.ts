// The real-model validation run for the judges (#396): ONE capped run of both judges (the strict claim judge and the scan's
// verification judge) over both splits of the committed synthetic corpus, against a paid model. The offline harness
// (scripts/judges.mts) stays stub-only and never imports this module.
//
// What makes the run safe to approve in money and honest in what it reports:
//  - Inputs are explicit, never defaulted: run id, model, USD cap, a dated FX rate and the fee/tax rate. The cap's CAD
//    equivalent (cap x FX x (1 + fee)) must fit the owner's approval (APPROVED_CAD). The key comes from the environment only
//    (KEY_ENV), lives in the transport's closure, and is redacted from every line this module writes.
//  - The plan is fixed before any request: every call the run will make (both judges x both splits x every item x
//    FIXED.repeats, plus one reversed-source call for multi-source items), each priced at its real prompt's UTF-8 bytes
//    (+ INPUT_MARGIN_TOKENS) and its explicit max_tokens. A cap below that worst case refuses the run up front.
//  - Thresholds, repeats and output limits are constants in this file (FIXED, MAX_OUTPUT_TOKENS). Nothing at run time can
//    change them, so nothing can be tuned against the results; the artifact records them with a hash.
//  - Before EVERY request the worst-case cost is reserved against the cap and persisted (fsync'd ledger line). A failed
//    write, a reservation over the cap, or a second attempt while one is in flight stops the run before anything is sent.
//  - One request per attempt, no retries (MAX_RETRIES = 0). A timeout, network error, non-200, malformed or unexpected
//    response, a served model that is not the requested one, invalid usage, a cost over the reservation, or a settle that
//    cannot be persisted stops the run as FAILED. Every such attempt is recorded, and when its bill is unknown its full
//    reservation stays counted as spent. Nothing after a stop is sent.
//  - One run, ever, for this approval. There is no rerun path: no input, flag, env var or file authorizes a second run.
//    A second run needs a code change (RUN_RECORD below) and a new review. The run is recorded in three places, and any
//    one of them refuses a new run: (1) the committed record lib/evals/judge-validation-runs.json, which lists the run
//    once its record is committed and is checked in every checkout; (2) a host claim outside the state directory
//    (~/.dazl/judge-validation.host-claim), so a new or deleted state directory on this machine does not reset the
//    guard; (3) the exclusive approval claim and run marker in the explicit, required state directory.
//  - Model refusals and max_tokens stops are recorded per attempt (stop_reason) and counted. A refused item has no
//    verdict and counts as unknown (an abstain, never a pass). More than MAX_REFUSALS refusals stop the run as FAILED, so
//    systematic refusal cannot spend the budget on a non-result.
//  - The artifact reports calibration and holdout separately, per judge, with corpus and code hashes, every attempt, and
//    reserved/settled costs. It is a synthetic-fixture result: it makes no live-web accuracy claim and updates no lock.
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  calibrate, checkCorpus, claimJudge, corpusHash, judgeFingerprint, judgePrompt, scanJudge, DEFAULT_THRESHOLDS,
  type CalibrationReport, type JudgeAdapter, type JudgeCorpus, type JudgeItem, type JudgeQuestion, type JudgeSource, type JudgeSpec, type Split,
} from './judge.ts'
import { judgePrompt as scanJudgePrompt, makeJudge, parseJudgement } from '../scan/runner.ts'
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, INPUT_MARGIN_TOKENS, priceOf } from '../llm/spend-guard.ts'
import type { Provider } from '../llm/provider.ts'

export const VALIDATION_CONTRACT = 'dazl.judge-validation/1'
// The owner's approval: Gagan's own WhatsApp messages of 2026-11-03, 19:52 and 19:53 ET. ONE paid judge-validation
// run, hard CAD 5 total. A GitHub comment is not the authority and is not cited here.
export const APPROVED_CAD = 5
export const APPROVAL = 'owner approval: Gagan, WhatsApp messages 2026-11-03 19:52 and 19:53 ET: ONE paid judge-validation run, hard CAD 5 total'
// The only model this run may use: the one model with a listed price (lib/llm/spend-guard.ts). The owner names it at run
// time (--model); there is no default. A model added to the price table later is still refused here until reviewed.
export const VALIDATION_MODELS: readonly string[] = Object.freeze(['claude-sonnet-4-5'])
// Refusals: a refused item has no verdict (unknown). The run stops as FAILED on the refusal that takes the count over
// this limit (about 5% of the 188 planned calls), so systematic refusal cannot spend the budget on a non-result.
export const MAX_REFUSALS = 9
export const JUDGE_IDS = ['claim_support', 'scan_verification_judge'] as const
export type JudgeId = typeof JUDGE_IDS[number]
export const SPLITS: readonly Split[] = ['calibration', 'holdout']
// Fixed before the run, in code. No input, flag or env var changes them.
export const FIXED = Object.freeze({ thresholds: Object.freeze({ ...DEFAULT_THRESHOLDS }), repeats: 2, reverseSources: true })
// Explicit output limits sent as max_tokens. The scan judge gets what the scan sends it today (Anthropic complete() default).
export const MAX_OUTPUT_TOKENS: Readonly<Record<JudgeId, number>> = Object.freeze({ claim_support: 400, scan_verification_judge: 10 })
export const REQUEST_TIMEOUT_MS = 60_000
export const MAX_RESPONSE_BYTES = 64 * 1024
export const MAX_RETRIES = 0
export const KEY_ENV = 'DAZL_JUDGE_VALIDATION_ANTHROPIC_KEY'
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
// Sanity fences on the operator's FX and fee inputs (a typo must not widen the approval). Not the cap: the cap is an input.
export const FX_CAD_PER_USD_RANGE = Object.freeze({ min: 1, max: 2 })
export const FX_MAX_AGE_DAYS = 7
export const MAX_FEE_RATE = 0.5
// The FX rate must be the Bank of Canada's dated USD/CAD rate: its source is a bankofcanada.ca URL, recorded in the artifact.
export const FX_SOURCE_RE = /^https:\/\/www\.bankofcanada\.ca\/[\x21-\x7e]{1,300}$/
// The billing account's fee/tax figure: a stated basis (for example "Anthropic console invoice: 13% HST, card FX fee
// 2.5%"), recorded in the artifact next to the rate.
export const FEE_BASIS_RE = /^[\x20-\x7e]{3,300}$/
// Run-once records outside the state directory (see the header). Neither is an input: only a code change moves them.
export const RUN_RECORD_FILE = 'lib/evals/judge-validation-runs.json'
export const RUN_RECORD_CONTRACT = 'dazl.judge-validation-runs/1'
export const hostClaimPath = (): string => join(homedir(), '.dazl', 'judge-validation.host-claim')

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const usd = (micro: number) => micro / 1e6

// --- money ---------------------------------------------------------------------------------------------------------
// Amounts are integer micro-dollars. A price in USD per million tokens is micro-dollars per token.
export function reservationMicro(model: string, promptBytes: number, maxOutputTokens: number): number {
  const p = priceOf(model)
  if (!p) throw new Error('model_unpriced')
  if (!isCount(promptBytes) || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('invalid_request_size')
  return Math.ceil((promptBytes + INPUT_MARGIN_TOKENS) * p.in + maxOutputTokens * p.out)
}
export interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
export function settledMicro(servedModel: string, u: Usage): number {
  const p = priceOf(servedModel)
  if (!p) throw new Error('model_unpriced')
  return Math.ceil(u.input_tokens * p.in + u.output_tokens * p.out + (u.cache_creation_input_tokens ?? 0) * p.in * CACHE_WRITE_FACTOR + (u.cache_read_input_tokens ?? 0) * p.in * CACHE_READ_FACTOR)
}
// The served id must be the requested id, or the dated snapshot of a requested alias (claude-sonnet-4-5 ->
// claude-sonnet-4-5-20250929) at the same listed price. Anything else is a mismatch.
export function servedMatches(requested: string, served: string): boolean {
  if (served === requested) return true
  const p = priceOf(requested), q = priceOf(served)
  return served.startsWith(`${requested}-`) && /^\d{8}$/.test(served.slice(requested.length + 1)) && !!p && !!q && p.in === q.in && p.out === q.out
}

// --- the response envelope -----------------------------------------------------------------------------------------
// Anthropic Messages API response, parsed strictly: any unexpected field, type, size or encoding fails closed.
const TOP_KEYS = new Set(['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage'])
const BLOCK_KEYS = new Set(['type', 'text', 'citations'])
const USAGE_KEYS = new Set(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'service_tier', 'server_tool_use'])
const CACHE_CREATION_KEYS = new Set(['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])
const STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal'])
export const MAX_TEXT_BYTES_PER_TOKEN = 64
export type Envelope =
  | { ok: true; id: string; model: string; text: string; usage: Usage; stop_reason: string }
  | { ok: false; outcome: 'invalid_response' | 'invalid_usage'; why: string; model: string | null }
const keyList = (ks: string[]) => ks.map(k => k.slice(0, 40)).join(',').slice(0, 160)

export function parseMessageEnvelope(body: unknown, maxOutputTokens: number): Envelope {
  const bad = (why: string, model: string | null = null): Envelope => ({ ok: false, outcome: 'invalid_response', why, model })
  if (!(body instanceof Uint8Array)) return bad('body is not bytes')
  if (body.byteLength === 0) return bad('empty body')
  if (body.byteLength > MAX_RESPONSE_BYTES) return bad(`body over ${MAX_RESPONSE_BYTES} bytes`)
  let s: string
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(body) } catch { return bad('body is not valid UTF-8') }
  let o: unknown
  try { o = JSON.parse(s) } catch { return bad('body is not JSON') }
  if (!isObj(o)) return bad('body is not a JSON object')
  const extra = Object.keys(o).filter(k => !TOP_KEYS.has(k))
  if (extra.length) return bad(`unexpected field(s): ${keyList(extra)}`)
  if (o.type !== 'message') return bad('type is not "message"')
  if (o.role !== 'assistant') return bad('role is not "assistant"')
  if (typeof o.id !== 'string' || !o.id || o.id.length > 200) return bad('id missing or not a string')
  if (typeof o.model !== 'string' || !o.model || o.model.length > 200) return bad('model missing or not a string')
  const model = o.model
  if (typeof o.stop_reason !== 'string' || !STOP_REASONS.has(o.stop_reason)) return bad('stop_reason missing or not a known value', model)
  // A refusal is a well-formed, billed answer with no verdict in it: its text may be empty and the judge reads it as unknown.
  const refusal = o.stop_reason === 'refusal'
  if (!Array.isArray(o.content) || (!o.content.length && !refusal)) return bad('content missing, empty or not a list', model)
  let text = ''
  for (const b of o.content as unknown[]) {
    if (!isObj(b)) return bad('content block is not an object', model)
    const bx = Object.keys(b).filter(k => !BLOCK_KEYS.has(k))
    if (bx.length) return bad(`unexpected content block field(s): ${keyList(bx)}`, model)
    if (b.type !== 'text') return bad(`content block type ${JSON.stringify(String(b.type)).slice(0, 40)} is not text`, model)
    if (typeof b.text !== 'string') return bad('content block text is not a string', model)
    if (!(b.citations === undefined || b.citations === null)) return bad('content block carries citations', model)
    text += b.text
  }
  if (!(o.stop_sequence === undefined || o.stop_sequence === null || typeof o.stop_sequence === 'string')) return bad('stop_sequence is not a string', model)
  const badU = (why: string): Envelope => ({ ok: false, outcome: 'invalid_usage', why, model })
  const u = o.usage
  if (!isObj(u)) return badU('usage missing or not an object')
  const ux = Object.keys(u).filter(k => !USAGE_KEYS.has(k))
  if (ux.length) return badU(`unexpected usage field(s): ${keyList(ux)}`)
  for (const k of ['input_tokens', 'output_tokens'] as const) if (!isCount(u[k])) return badU(`usage.${k} missing or not a non-negative integer`)
  for (const k of ['cache_creation_input_tokens', 'cache_read_input_tokens'] as const) if (!(u[k] === undefined || u[k] === null || isCount(u[k]))) return badU(`usage.${k} is not a non-negative integer`)
  if (!(u.cache_creation === undefined || u.cache_creation === null)) {
    const cc = u.cache_creation
    if (!isObj(cc) || Object.keys(cc).some(k => !CACHE_CREATION_KEYS.has(k)) || Object.values(cc).some(v => !isCount(v))) return badU('usage.cache_creation is malformed')
  }
  if (!(u.service_tier === undefined || u.service_tier === null || typeof u.service_tier === 'string')) return badU('usage.service_tier is not a string')
  if (!(u.server_tool_use === undefined || u.server_tool_use === null)) {
    const st = u.server_tool_use
    if (!isObj(st) || Object.values(st).some(v => v !== 0)) return badU('usage reports server tool use, which has no price here')
  }
  const usage: Usage = { input_tokens: u.input_tokens as number, output_tokens: u.output_tokens as number }
  if (isCount(u.cache_creation_input_tokens)) usage.cache_creation_input_tokens = u.cache_creation_input_tokens
  if (isCount(u.cache_read_input_tokens)) usage.cache_read_input_tokens = u.cache_read_input_tokens
  if (usage.output_tokens > maxOutputTokens) return badU(`usage.output_tokens ${usage.output_tokens} over the max_tokens sent (${maxOutputTokens})`)
  if (!text.trim() && !refusal) return bad('empty reply text', model)
  if (Buffer.byteLength(text) > maxOutputTokens * MAX_TEXT_BYTES_PER_TOKEN) return bad('reply text longer than max_tokens allows', model)
  return { ok: true, id: o.id, model, text, usage, stop_reason: o.stop_reason }
}

// --- transport, ledger, redaction ----------------------------------------------------------------------------------
export interface TransportRequest { model: string; maxTokens: number; prompt: string; signal: AbortSignal }
export interface TransportResponse { status: number; body: Uint8Array }
// One HTTP request, no retries. The key is in the closure, never in a request object this module records.
export type Transport = (req: TransportRequest) => Promise<TransportResponse>

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value); n += value.byteLength
    if (n > max) { await reader.cancel().catch(() => {}); break } // over the limit: the parser refuses it
  }
  const out = new Uint8Array(Math.min(n, max + 1)) // one byte past the limit is enough for the parser to refuse it
  let at = 0
  for (const p of parts) { if (at >= out.byteLength) break; const take = p.subarray(0, out.byteLength - at); out.set(take, at); at += take.byteLength }
  return out
}
export function anthropicTransport(key: string, fetchImpl: typeof fetch = fetch): Transport {
  return async ({ model, maxTokens, prompt, signal }) => {
    const res = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    })
    return { status: res.status, body: await readCapped(res, MAX_RESPONSE_BYTES) }
  }
}

// The key: from the environment only, removed from it once read. Never from argv (visible in `ps`) or a file.
export function readKeyFromEnv(env: Record<string, string | undefined>): { key: string } | { problem: string } {
  const k = env[KEY_ENV]
  delete env[KEY_ENV]
  if (typeof k !== 'string' || !k) return { problem: `${KEY_ENV} is not set: the key is read from the environment only` }
  if (k.length < 20 || /\s/.test(k)) return { problem: `${KEY_ENV} does not look like an API key (too short or contains whitespace)` }
  return { key: k }
}

// Persisted, append-only accounting. write() must be durable when it returns, and throws when it is not.
export interface Ledger { write(line: string): void; close(): void }
export function fileLedger(path: string): Ledger {
  const fd = openSync(path, 'a', 0o600)
  return {
    write(line) { writeSync(fd, `${line}\n`); fsyncSync(fd) },
    close() { try { closeSync(fd) } catch { /* already closed */ } },
  }
}
export function redactor(secrets: string[]): (s: string) => string {
  const live = secrets.filter(x => typeof x === 'string' && x.length >= 8)
  return s => live.reduce((t, x) => t.split(x).join('[REDACTED]'), s)
}
function describe(e: unknown): string {
  try {
    if (e instanceof Error) return `${e.name}: ${String(e.message)}`.slice(0, 200)
    if (typeof e === 'string') return e.slice(0, 200)
    return `non-Error thrown (${e === null ? 'null' : typeof e})`
  } catch { return 'unprintable error' }
}

// --- the meter: reserve, persist, send once, settle ----------------------------------------------------------------
export type AttemptOutcome = 'ok' | 'invalid_request' | 'concurrent_attempt' | 'cap_exhausted' | 'persist_failed' | 'timeout' | 'network_error' | 'http_error'
  | 'invalid_response' | 'invalid_usage' | 'model_mismatch' | 'over_reservation' | 'accounting_failed' | 'refusal_limit'
export interface Attempt {
  n: number; judge: JudgeId; split: Split | null; item: string | null
  requested_model: string; served_model: string | null; request_id: string | null
  prompt_bytes: number; prompt_sha256: string; max_output_tokens: number
  reserved_micro: number; settled_micro: number | null
  // none: nothing was sent, so nothing can be billed; settled: the reported usage priced; unknown: sent, bill not known,
  // so its whole reservation counts as spent.
  billing: 'none' | 'settled' | 'unknown'
  request_sent: boolean; http_status: number | null; usage: Usage | null
  // The model's stop_reason from a well-formed response (end_turn, max_tokens, stop_sequence, refusal); null when none was
  // parsed (nothing sent, no answer, or a malformed or missing stop_reason, which stops the run as invalid_response).
  stop_reason: string | null
  outcome: AttemptOutcome; detail: string | null; started_at: string; ended_at: string | null
}
export interface MeterState {
  attempts: Attempt[]; requests: number; committed_micro: number; in_flight: boolean
  stop: { reason: AttemptOutcome; attempt: number; detail: string | null } | null
  refused_after_stop: number; stop_unpersisted: boolean
  refusals: number; max_tokens_stops: number
}
export class RunStopped extends Error {
  reason: string
  constructor(reason: string) { super(`judge_validation_stopped:${reason}`); this.reason = reason }
}
export interface Meter { state: MeterState; ctx: { split: Split | null; item: string | null }; call(prompt: string, judge: JudgeId, maxOutputTokens: number): Promise<string> }
export interface MeterOptions { model: string; capMicro: number; transport: Transport; ledger: Ledger; secrets: string[]; timeoutMs?: number; now?: () => Date }

export function createMeter(o: MeterOptions): Meter {
  const now = o.now ?? (() => new Date())
  const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS
  const redact = redactor(o.secrets)
  const write = (ev: Record<string, unknown>) => o.ledger.write(redact(JSON.stringify({ at: now().toISOString(), ...ev })))
  const state: MeterState = { attempts: [], requests: 0, committed_micro: 0, in_flight: false, stop: null, refused_after_stop: 0, stop_unpersisted: false, refusals: 0, max_tokens_stops: 0 }
  const meter: Meter = {
    state, ctx: { split: null, item: null },
    async call(prompt, judge, maxOutputTokens) {
      if (state.stop) { state.refused_after_stop++; throw new RunStopped(state.stop.reason) }
      const a: Attempt = {
        n: state.attempts.length + 1, judge, split: meter.ctx.split, item: meter.ctx.item,
        requested_model: o.model, served_model: null, request_id: null,
        prompt_bytes: Buffer.byteLength(String(prompt), 'utf8'), prompt_sha256: sha(String(prompt)), max_output_tokens: maxOutputTokens,
        reserved_micro: 0, settled_micro: null, billing: 'none', request_sent: false, http_status: null, usage: null,
        stop_reason: null, outcome: 'ok', detail: null, started_at: now().toISOString(), ended_at: null,
      }
      state.attempts.push(a)
      const stop = (outcome: AttemptOutcome, detail: string | null): never => {
        a.outcome = outcome; a.detail = detail === null ? null : redact(detail).slice(0, 300); a.ended_at = now().toISOString()
        state.stop = { reason: outcome, attempt: a.n, detail: a.detail }
        try { write({ event: 'stop', attempt: a }) } catch { state.stop_unpersisted = true }
        throw new RunStopped(outcome)
      }
      if (state.in_flight) stop('concurrent_attempt', 'another attempt was in flight: attempts are strictly one at a time')
      state.in_flight = true
      try {
        if (typeof prompt !== 'string' || !prompt) stop('invalid_request', 'prompt is not a non-empty string')
        let reserve = 0
        try { reserve = reservationMicro(o.model, a.prompt_bytes, maxOutputTokens) } catch (e) { stop('invalid_request', describe(e)) }
        if (state.committed_micro + reserve > o.capMicro) stop('cap_exhausted', `reserving ${usd(reserve)} USD on ${usd(state.committed_micro)} committed would pass the cap of ${usd(o.capMicro)} USD`)
        try {
          write({ event: 'reserve', attempt: a.n, judge, split: a.split, item: a.item, requested_model: o.model, prompt_bytes: a.prompt_bytes, prompt_sha256: a.prompt_sha256, max_output_tokens: maxOutputTokens, reserve_micro: reserve, committed_before_micro: state.committed_micro })
        } catch (e) { stop('persist_failed', `reservation not persisted, nothing sent: ${describe(e)}`) }
        a.reserved_micro = reserve; state.committed_micro += reserve; a.billing = 'unknown'
        a.request_sent = true; state.requests++
        const ac = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        let res: TransportResponse | 'timeout' | undefined
        try {
          const sent = Promise.resolve().then(() => o.transport({ model: o.model, maxTokens: maxOutputTokens, prompt, signal: ac.signal }))
          sent.catch(() => {}) // a late rejection after a timeout is already accounted as unknown
          res = await Promise.race([sent, new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) })])
        } catch (e) { stop('network_error', describe(e)) } finally { clearTimeout(timer) }
        if (res === 'timeout') { ac.abort(); stop('timeout', `no response within ${timeoutMs} ms; billing unknown`) }
        if (!isObj(res) || !Number.isInteger(res.status)) stop('invalid_response', 'transport returned no HTTP status')
        const r = res as TransportResponse
        a.http_status = r.status
        if (r.status !== 200) stop('http_error', `HTTP ${r.status}; billing unknown`)
        const env = parseMessageEnvelope(r.body, maxOutputTokens)
        if (!env.ok) { a.served_model = env.model; stop(env.outcome, env.why) }
        const ok = env as Extract<Envelope, { ok: true }>
        a.served_model = ok.model; a.request_id = ok.id; a.usage = ok.usage; a.stop_reason = ok.stop_reason
        if (!servedMatches(o.model, ok.model)) stop('model_mismatch', `requested ${o.model}, served ${ok.model}`)
        const settled = settledMicro(ok.model, ok.usage)
        if (settled > reserve) {
          a.settled_micro = settled; a.billing = 'settled'; state.committed_micro += settled - reserve
          stop('over_reservation', `settled ${usd(settled)} USD over the ${usd(reserve)} USD reserved`)
        }
        try {
          write({ event: 'settle', attempt: a.n, served_model: ok.model, request_id: ok.id, stop_reason: ok.stop_reason, usage: ok.usage, reserve_micro: reserve, settled_micro: settled })
        } catch (e) { stop('accounting_failed', `settle not persisted; reservation kept as spent: ${describe(e)}`) }
        a.settled_micro = settled; a.billing = 'settled'; state.committed_micro += settled - reserve
        if (ok.stop_reason === 'max_tokens') state.max_tokens_stops++
        if (ok.stop_reason === 'refusal' && ++state.refusals > MAX_REFUSALS) stop('refusal_limit', `${state.refusals} refusals, over the limit of ${MAX_REFUSALS}: refused items have no verdict, so the run stops as failed`)
        a.ended_at = now().toISOString()
        return ok.text
      } finally { state.in_flight = false }
    },
  }
  return meter
}

// --- the plan ------------------------------------------------------------------------------------------------------
export const scanJudgeTemplate = (): string => `${scanJudgePrompt({ company: '{company}', signal: '{claim}' }, '{passage}')}\n--parser--\n${parseJudgement.toString().replace(/\s+/g, ' ')}`
export const judgeSpec = (judge: JudgeId, model: string): JudgeSpec => ({ id: judge, version: 1, model, prompt_version: 1 })
const NONCE_SHAPE = '0'.repeat(16) // the claim judge's nonce is 16 hex characters; the plan uses one of the same length
export function promptFor(judge: JudgeId, it: JudgeItem, sources: JudgeSource[]): string {
  return judge === 'claim_support' ? judgePrompt(it.claim, sources, NONCE_SHAPE) : scanJudgePrompt({ company: it.company, signal: it.claim }, sources.map(s => s.text).join('\n\n'))
}
export interface PlannedCall { judge: JudgeId; split: Split; item: string; reversed: boolean; prompt_bytes: number; max_output_tokens: number; reserve_micro: number }
export interface Plan { calls: PlannedCall[]; worst_case_micro: number; by_phase: Record<string, number> }
// Every call calibrate() will make, in its order (lib/evals/judge.ts): FIXED.repeats asks per item, then one with the
// sources reversed when the item has more than one source.
export function planRun(corpus: JudgeCorpus, model: string): Plan {
  const calls: PlannedCall[] = []
  for (const judge of JUDGE_IDS) for (const split of SPLITS) for (const it of corpus.items.filter(i => i.split === split)) {
    const n = FIXED.repeats + (FIXED.reverseSources && it.sources.length > 1 ? 1 : 0)
    for (let a = 0; a < n; a++) {
      const reversed = a >= FIXED.repeats
      const bytes = Buffer.byteLength(promptFor(judge, it, reversed ? [...it.sources].reverse() : it.sources), 'utf8')
      calls.push({ judge, split, item: it.id, reversed, prompt_bytes: bytes, max_output_tokens: MAX_OUTPUT_TOKENS[judge], reserve_micro: reservationMicro(model, bytes, MAX_OUTPUT_TOKENS[judge]) })
    }
  }
  const by_phase: Record<string, number> = {}
  for (const c of calls) by_phase[`${c.judge}/${c.split}`] = (by_phase[`${c.judge}/${c.split}`] ?? 0) + 1
  return { calls, worst_case_micro: calls.reduce((s, c) => s + c.reserve_micro, 0), by_phase }
}

// --- inputs --------------------------------------------------------------------------------------------------------
// There is no rerun input: an unknown key (approvedRerun, rerun, force, ...) is refused like any other.
export interface RunInputs { runId: string; model: string; capUsd: number; fxCadPerUsd: number; fxDate: string; fxSource: string; feeRate: number; feeBasis: string; stateDir: string }
const INPUT_KEYS = new Set(['runId', 'model', 'capUsd', 'fxCadPerUsd', 'fxDate', 'fxSource', 'feeRate', 'feeBasis', 'stateDir'])
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/
const finitePos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
export const capMicroOf = (capUsd: number) => Math.floor(capUsd * 1e6 + 1e-6)
export const capCad = (i: Pick<RunInputs, 'capUsd' | 'fxCadPerUsd' | 'feeRate'>) => i.capUsd * i.fxCadPerUsd * (1 + i.feeRate)

// Every problem with the inputs; empty means usable. Nothing is defaulted.
export function checkInputs(i: unknown, now: Date): string[] {
  if (!isObj(i)) return ['inputs are not an object']
  const p: string[] = []
  const extra = Object.keys(i).filter(k => !INPUT_KEYS.has(k))
  if (extra.length) p.push(`unknown input(s): ${keyList(extra)} (thresholds, repeats and output limits are fixed in code)`)
  if (typeof i.runId !== 'string' || !RUN_ID_RE.test(i.runId)) p.push('runId is required: 3-64 characters of letters, digits, . _ -')
  if (typeof i.model !== 'string' || !i.model) p.push('model is required (no default)')
  else if (!VALIDATION_MODELS.includes(i.model) || !priceOf(i.model)) p.push(`model ${JSON.stringify(i.model).slice(0, 80)} is not a priced validation model (${VALIDATION_MODELS.join(', ')}): refused`)
  if (!finitePos(i.capUsd)) p.push('capUsd is required: a positive number of US dollars (no default)')
  if (!finitePos(i.fxCadPerUsd)) p.push('fxCadPerUsd is required: CAD per 1 USD on fxDate')
  else if (i.fxCadPerUsd < FX_CAD_PER_USD_RANGE.min || i.fxCadPerUsd > FX_CAD_PER_USD_RANGE.max) p.push(`fxCadPerUsd ${i.fxCadPerUsd} is outside ${FX_CAD_PER_USD_RANGE.min}-${FX_CAD_PER_USD_RANGE.max}: check the rate`)
  if (typeof i.fxDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(i.fxDate) || Number.isNaN(Date.parse(`${i.fxDate}T00:00:00Z`)) || new Date(`${i.fxDate}T00:00:00Z`).toISOString().slice(0, 10) !== i.fxDate) p.push('fxDate is required: the YYYY-MM-DD date of the FX rate')
  else {
    const age = (now.getTime() - Date.parse(`${i.fxDate}T00:00:00Z`)) / 86_400_000
    if (age < -1) p.push('fxDate is in the future')
    else if (age > FX_MAX_AGE_DAYS) p.push(`fxDate is more than ${FX_MAX_AGE_DAYS} days old: verify a current rate`)
  }
  if (typeof i.fxSource !== 'string' || !FX_SOURCE_RE.test(i.fxSource)) p.push('fxSource is required: the bankofcanada.ca URL of the dated USD/CAD rate used')
  if (typeof i.feeRate !== 'number' || !Number.isFinite(i.feeRate) || i.feeRate < 0 || i.feeRate > MAX_FEE_RATE) p.push(`feeRate is required: billing fees and tax as a fraction between 0 and ${MAX_FEE_RATE}`)
  if (typeof i.feeBasis !== 'string' || !FEE_BASIS_RE.test(i.feeBasis)) p.push('feeBasis is required: the billing account fee/tax figure used (3-300 printable ASCII characters)')
  if (typeof i.stateDir !== 'string' || !i.stateDir || !isAbsolute(i.stateDir) || i.stateDir.includes('\0')) p.push('stateDir is required: an explicit absolute directory (no default)')
  if (!p.length) {
    const cad = capCad(i as unknown as RunInputs)
    if (cad > APPROVED_CAD + 1e-9) p.push(`cap ${i.capUsd} USD x ${i.fxCadPerUsd} CAD/USD x (1 + ${i.feeRate}) = ${cad.toFixed(4)} CAD is over the approved ${APPROVED_CAD} CAD`)
  }
  return p
}

// --- the one-shot guard --------------------------------------------------------------------------------------------
interface RunMarker { run_id: string; status: 'started' | 'completed' | 'failed'; started_at: string; ended_at?: string }
const runsDir = (stateDir: string) => join(stateDir, 'runs')
export function priorRuns(stateDir: string): RunMarker[] {
  let names: string[]
  try { names = readdirSync(runsDir(stateDir)) } catch (e) { if ((e as { code?: unknown })?.code === 'ENOENT') return []; throw e }
  return names.filter(n => n.endsWith('.run.json')).map(n => {
    const unreadable = { run_id: n.slice(0, -'.run.json'.length), status: 'started', started_at: '?' } as RunMarker
    try { const o: unknown = JSON.parse(readFileSync(join(runsDir(stateDir), n), 'utf8')); return isObj(o) ? o as unknown as RunMarker : unreadable } catch { return unreadable }
  })
}
// The committed record of runs made (RUN_RECORD_FILE). Missing, unreadable or malformed refuses (fail closed); any listed
// run refuses. After the owner run, its record (run id, start time, artifact sha256) is committed here.
export interface RunRecord { contract: typeof RUN_RECORD_CONTRACT; runs: { run_id: string; started_at: string; artifact_sha256: string }[] }
export function readRunRecord(path: string): { runs: RunRecord['runs'] } | { problem: string } {
  let o: unknown
  try { o = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { return { problem: `the committed run record ${RUN_RECORD_FILE} is missing or not JSON: ${describe(e)}` } }
  if (!isObj(o) || o.contract !== RUN_RECORD_CONTRACT || !Array.isArray(o.runs) || Object.keys(o).some(k => !['contract', 'note', 'runs'].includes(k))) return { problem: `the committed run record ${RUN_RECORD_FILE} is malformed` }
  return { runs: o.runs as RunRecord['runs'] }
}
export const runRecordPath = (): string => fileURLToPath(new URL(`../../${RUN_RECORD_FILE}`, import.meta.url))
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

// --- code identity -------------------------------------------------------------------------------------------------
export const CODE_FILES = ['lib/evals/judge.ts', 'lib/evals/judge-validation-run.ts', 'lib/scan/runner.ts', 'lib/llm/spend-guard.ts', 'scripts/judge-validation-run.mts', 'test/fixtures/evals/judges/corpus.synthetic.json', RUN_RECORD_FILE] as const
export function codeHashes(): Record<string, string> {
  const root = new URL('../../', import.meta.url)
  return Object.fromEntries(CODE_FILES.map(f => { try { return [f, sha(readFileSync(new URL(f, root)))] } catch { return [f, 'unreadable'] } }))
}

// --- the run -------------------------------------------------------------------------------------------------------
export interface RunDeps {
  transport: Transport; secrets: string[]; corpus: JudgeCorpus
  now?: () => Date; timeoutMs?: number; ledger?: (path: string) => Ledger; code?: Record<string, string>
  writeArtifact?: (path: string, text: string) => void
  // Code-level only (tests): the CLI never sets these, so no flag, env var or file can move the run-once records.
  hostClaim?: string; runRecord?: string
}
export interface PhaseResult { fingerprint: string; report: CalibrationReport | null; note: string | null }
export interface Artifact {
  contract: typeof VALIDATION_CONTRACT; run_id: string; status: 'completed' | 'failed'; results_valid: boolean
  stop: MeterState['stop'] | { reason: string; attempt: null; detail: string }
  approval: string; started_at: string; ended_at: string
  model: { requested: string; served: string[] }
  cap: { usd: number; micro: number; fx_cad_per_usd: number; fx_date: string; fee_rate: number; cad_equivalent: number; approved_cad: number
    fx: { source: 'Bank of Canada'; cad_per_usd: number; date: string; url: string }; fee: { rate: number; basis: string } }
  run_guard: { state_dir: string; host_claim: string; committed_record: string; max_refusals: number }
  plan: { calls: number; worst_case_usd: number; by_phase: Record<string, number> }
  fixed_before_run: { thresholds: typeof FIXED.thresholds; thresholds_sha256: string; repeats: number; reverse_sources: boolean; max_output_tokens: Record<JudgeId, number>; request_timeout_ms: number; max_retries: number; input_margin_tokens: number; temperature: string }
  corpus: { id: string; origin: string; hash: string; items: number; calibration: number; holdout: number }
  code: Record<string, string>
  totals: { requests: number; attempts: number; refused_after_stop: number; reserved_usd: number; settled_usd: number; committed_usd: number; unknown_billing_attempts: number; stop_unpersisted: boolean; refusals: number; max_tokens: number }
  attempts: (Attempt & { reserved_usd: number; settled_usd: number | null })[]
  results: Record<JudgeId, Record<Split, PhaseResult>>
  limits: string[]
}
export type RunResult =
  | { status: 'refused'; problems: string[] }
  | { status: 'completed' | 'failed'; problems: string[]; artifact: Artifact; artifact_path: string; artifact_error: string | null }

export function preflight(inputs: unknown, corpus: JudgeCorpus, now: Date): { problems: string[]; plan: Plan | null } {
  const problems = checkInputs(inputs, now)
  try { checkCorpus(corpus) } catch (e) { problems.push(describe(e)) }
  if (corpus?.origin !== 'synthetic') problems.push('the validation run uses the synthetic corpus only (no live-web accuracy claim)')
  if (problems.length) return { problems, plan: null }
  const i = inputs as RunInputs
  const plan = planRun(corpus, i.model)
  if (plan.worst_case_micro > capMicroOf(i.capUsd)) problems.push(`cap ${i.capUsd} USD is below the planned worst case ${usd(plan.worst_case_micro)} USD for ${plan.calls.length} calls: the run could not finish, so it does not start`)
  return { problems, plan }
}

export async function runValidation(inputs: unknown, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => new Date())
  if (typeof deps?.transport !== 'function') return { status: 'refused', problems: ['no transport'] }
  if (!Array.isArray(deps.secrets) || !deps.secrets.some(s => typeof s === 'string' && s.length >= 8)) return { status: 'refused', problems: ['the key must be supplied (and is redacted from everything written)'] }
  const { problems, plan } = preflight(inputs, deps.corpus, now())
  if (problems.length || !plan) return { status: 'refused', problems }
  const i = inputs as RunInputs
  const NO_RERUN = 'there is no rerun: a second run needs a code change and a new review'

  // One run, ever, for this approval: the committed record, then the host claim, then the state directory.
  const recordPath = deps.runRecord ?? runRecordPath()
  const record = readRunRecord(recordPath)
  if ('problem' in record) return { status: 'refused', problems: [record.problem] }
  if (record.runs.length) return { status: 'refused', problems: [`the committed record ${RUN_RECORD_FILE} lists ${record.runs.length} run(s) already made: ${NO_RERUN}`] }
  const hostClaim = deps.hostClaim ?? hostClaimPath()
  let prior: RunMarker[]
  try { mkdirSync(runsDir(i.stateDir), { recursive: true, mode: 0o700 }); prior = priorRuns(i.stateDir) } catch (e) { return { status: 'refused', problems: [`state directory unusable: ${describe(e)}`] } }
  if (prior.length) return { status: 'refused', problems: [`an earlier validation run exists in the state directory (${prior.map(r => `${String(r.run_id).slice(0, 64)}:${String(r.status).slice(0, 16)}`).join(', ')}): ${NO_RERUN}`] }
  // Any other leftover (an approval claim with no run file, a ledger, a result) also refuses: the directory must be fresh.
  let leftovers: string[]
  try { leftovers = readdirSync(runsDir(i.stateDir)) } catch (e) { return { status: 'refused', problems: [`state directory unusable: ${describe(e)}`] } }
  if (leftovers.length) return { status: 'refused', problems: [`the state directory already holds run files (${leftovers.slice(0, 5).map(n => n.slice(0, 64)).join(', ')}): the approval is already claimed; ${NO_RERUN}`] }
  const base = join(runsDir(i.stateDir), i.runId)
  const marker: RunMarker = { run_id: i.runId, status: 'started', started_at: now().toISOString() }
  // Each claim is exclusive (wx), so two runs started at once cannot both pass, and stays claimed even if the run then
  // fails to start (fail closed). The host claim lives outside the state directory: a new or wiped state dir does not reset it.
  try { mkdirSync(dirname(hostClaim), { recursive: true, mode: 0o700 }); writeFileSync(hostClaim, JSON.stringify({ run_id: i.runId, state_dir: i.stateDir, started_at: marker.started_at }), { flag: 'wx', mode: 0o600 }) } catch (e) { return { status: 'refused', problems: [`this host already claimed the one validation run (${hostClaim}): ${NO_RERUN}; ${describe(e)}`] } }
  try { writeFileSync(join(runsDir(i.stateDir), 'initial.approval'), i.runId, { flag: 'wx', mode: 0o600 }) } catch (e) { return { status: 'refused', problems: [`the approval is already claimed in the state directory: ${describe(e)}`] } }
  try { writeFileSync(`${base}.run.json`, JSON.stringify(marker), { flag: 'wx', mode: 0o600 }) } catch (e) { return { status: 'refused', problems: [`could not claim run ${i.runId}: ${describe(e)}`] } }

  const redact = redactor(deps.secrets)
  const capMicro = capMicroOf(i.capUsd)
  const thresholds_sha256 = sha(JSON.stringify(FIXED.thresholds))
  const code = deps.code ?? codeHashes()
  let ledger: Ledger | null = null
  let openError: string | null = null
  try { ledger = (deps.ledger ?? fileLedger)(`${base}.ledger.jsonl`) } catch (e) { openError = describe(e) }
  const meter = createMeter({ model: i.model, capMicro, transport: deps.transport, ledger: ledger ?? { write() { throw new Error('ledger not open') }, close() {} }, secrets: deps.secrets, timeoutMs: deps.timeoutMs, now })
  let startError = openError
  if (!startError) {
    try { ledger!.write(redact(JSON.stringify({ at: now().toISOString(), event: 'start', run_id: i.runId, model: i.model, cap_micro: capMicro, planned_calls: plan.calls.length, worst_case_micro: plan.worst_case_micro, thresholds_sha256, corpus_hash: corpusHash(deps.corpus), code }))) } catch (e) { startError = describe(e) }
  }

  const results = {} as Record<JudgeId, Record<Split, PhaseResult>>
  let internalError: string | null = null
  const judgeTimeout = (deps.timeoutMs ?? REQUEST_TIMEOUT_MS) + 5_000 // the meter's own timeout always fires first
  const itemOf = (q: JudgeQuestion) => deps.corpus.items.find(it => it.claim === q.claim && it.company === q.company && it.sources.length === q.sources.length && it.sources.every(s => q.sources.some(x => x.text === s.text)))?.id ?? null
  const adapterFor = (judge: JudgeId): JudgeAdapter => {
    const spec = judgeSpec(judge, i.model)
    if (judge === 'claim_support') return claimJudge(spec, prompt => meter.call(prompt, judge, MAX_OUTPUT_TOKENS[judge]), { timeoutMs: judgeTimeout })
    const provider = { research: async () => { throw new Error('research is not part of the judge validation run') }, complete: (_k: string, prompt: string) => meter.call(prompt, judge, MAX_OUTPUT_TOKENS[judge]) } as unknown as Provider
    return scanJudge(spec, makeJudge(provider, 'key-held-by-transport')!, scanJudgeTemplate(), { timeoutMs: judgeTimeout })
  }
  for (const judge of JUDGE_IDS) {
    const adapter = adapterFor(judge)
    const fingerprint = judgeFingerprint(adapter.spec, adapter.template)
    results[judge] = {} as Record<Split, PhaseResult>
    for (const split of SPLITS) {
      if (startError || meter.state.stop) { results[judge][split] = { fingerprint, report: null, note: 'not run: the run had stopped' }; continue }
      const tracked: JudgeAdapter = { ...adapter, ask: q => { meter.ctx = { split, item: itemOf(q) }; return adapter.ask(q) } }
      let report: CalibrationReport | null = null
      try {
        report = await calibrate(tracked, deps.corpus, { split, thresholds: { ...FIXED.thresholds }, repeats: FIXED.repeats, reverseSources: FIXED.reverseSources, maxCalls: plan.by_phase[`${judge}/${split}`] })
      } catch (e) { internalError = internalError ?? `${judge}/${split}: ${describe(e)}` }
      results[judge][split] = { fingerprint, report, note: internalError || meter.state.stop ? 'partial: the run stopped during this phase; these rates are not results' : split === 'holdout' ? 'holdout: the scored benchmark, reported separately; never used to choose thresholds' : 'calibration split' }
      if (internalError) startError = internalError
    }
  }

  const st = meter.state
  let stop: Artifact['stop'] = st.stop
  if (!stop && internalError) stop = { reason: 'internal_error', attempt: null, detail: redact(internalError) }
  if (!stop && startError) stop = { reason: 'persist_failed', attempt: null, detail: redact(`run start not persisted, nothing sent: ${startError}`) }
  if (!stop && st.requests !== plan.calls.length) stop = { reason: 'plan_mismatch', attempt: null, detail: `${st.requests} requests made, ${plan.calls.length} planned` }
  const status: 'completed' | 'failed' = stop ? 'failed' : 'completed'
  const ended = now().toISOString()
  try { ledger?.write(redact(JSON.stringify({ at: ended, event: 'end', status, committed_micro: st.committed_micro, requests: st.requests }))) } catch { st.stop_unpersisted = true }
  ledger?.close()
  const settled = st.attempts.reduce((s, a) => s + (a.settled_micro ?? 0), 0)
  const artifact: Artifact = {
    contract: VALIDATION_CONTRACT, run_id: i.runId, status, results_valid: status === 'completed', stop,
    approval: APPROVAL, started_at: marker.started_at, ended_at: ended,
    model: { requested: i.model, served: [...new Set(st.attempts.map(a => a.served_model).filter((m): m is string => !!m))] },
    cap: {
      usd: i.capUsd, micro: capMicro, fx_cad_per_usd: i.fxCadPerUsd, fx_date: i.fxDate, fee_rate: i.feeRate, cad_equivalent: Number(capCad(i).toFixed(6)), approved_cad: APPROVED_CAD,
      fx: { source: 'Bank of Canada', cad_per_usd: i.fxCadPerUsd, date: i.fxDate, url: i.fxSource }, fee: { rate: i.feeRate, basis: i.feeBasis },
    },
    run_guard: { state_dir: i.stateDir, host_claim: hostClaim, committed_record: RUN_RECORD_FILE, max_refusals: MAX_REFUSALS },
    plan: { calls: plan.calls.length, worst_case_usd: usd(plan.worst_case_micro), by_phase: plan.by_phase },
    fixed_before_run: { thresholds: FIXED.thresholds, thresholds_sha256, repeats: FIXED.repeats, reverse_sources: FIXED.reverseSources, max_output_tokens: { ...MAX_OUTPUT_TOKENS }, request_timeout_ms: deps.timeoutMs ?? REQUEST_TIMEOUT_MS, max_retries: MAX_RETRIES, input_margin_tokens: INPUT_MARGIN_TOKENS, temperature: 'provider default (not sent)' },
    corpus: { id: deps.corpus.id, origin: deps.corpus.origin, hash: corpusHash(deps.corpus), items: deps.corpus.items.length, calibration: deps.corpus.items.filter(x => x.split === 'calibration').length, holdout: deps.corpus.items.filter(x => x.split === 'holdout').length },
    code,
    totals: { requests: st.requests, attempts: st.attempts.length, refused_after_stop: st.refused_after_stop, reserved_usd: usd(st.attempts.reduce((s, a) => s + a.reserved_micro, 0)), settled_usd: usd(settled), committed_usd: usd(st.committed_micro), unknown_billing_attempts: st.attempts.filter(a => a.billing === 'unknown').length, stop_unpersisted: st.stop_unpersisted, refusals: st.refusals, max_tokens: st.max_tokens_stops },
    attempts: st.attempts.map(a => ({ ...a, reserved_usd: usd(a.reserved_micro), settled_usd: a.settled_micro === null ? null : usd(a.settled_micro) })),
    results,
    limits: [
      `synthetic corpus only (${deps.corpus.items.length} developer-labelled items): agreement with these labels is not ground truth, and this run makes no live-web accuracy claim`,
      'thresholds, repeats and output limits were fixed in code before the run; the holdout split is reported separately and was not used to choose them',
      `one run, ever, for this approval: no rerun path and no tuning; the run is recorded in the state directory, in a host claim outside it, and (once committed) in ${RUN_RECORD_FILE}; this artifact does not update the judge lock`,
      `refusals: a refused item (stop_reason refusal) has no verdict and counts as unknown (abstain, never a pass); ${st.refusals} refusal(s) here, and more than ${MAX_REFUSALS} stop the run as failed`,
      `max_tokens: ${st.max_tokens_stops} answer(s) were cut at max_tokens; a cut answer with no parseable verdict counts as unknown`,
      `cost bound: input tokens are assumed to be at most the prompt's UTF-8 bytes + ${INPUT_MARGIN_TOKENS}, priced from lib/llm/spend-guard.ts; an attempt whose bill is unknown counts its whole reservation`,
      ...(status === 'failed' ? ['the run FAILED: partial rates in it are not results'] : []),
    ],
  }
  const artifact_path = `${base}.result.json`
  let artifact_error: string | null = null
  try { (deps.writeArtifact ?? writeAtomic)(artifact_path, redact(JSON.stringify(artifact, null, 1))) } catch (e) { artifact_error = describe(e) }
  try { writeAtomic(`${base}.run.json`, JSON.stringify({ ...marker, status, ended_at: ended })) } catch { /* the 'started' marker stays, which still blocks reruns */ }
  const outProblems = stop ? [`${stop.reason}${stop.detail ? `: ${stop.detail}` : ''}`] : []
  return { status, problems: outProblems, artifact: JSON.parse(redact(JSON.stringify(artifact))) as Artifact, artifact_path, artifact_error }
}

// --- the command line ----------------------------------------------------------------------------------------------
const FLAGS: Record<string, keyof RunInputs | 'execute'> = { '--run-id': 'runId', '--model': 'model', '--cap-usd': 'capUsd', '--fx-cad-per-usd': 'fxCadPerUsd', '--fx-date': 'fxDate', '--fx-source': 'fxSource', '--fee-rate': 'feeRate', '--fee-basis': 'feeBasis', '--state-dir': 'stateDir', '--execute': 'execute' }
const NUMERIC = new Set(['capUsd', 'fxCadPerUsd', 'feeRate'])
export function parseValidationArgs(argv: string[]): { inputs: Record<string, unknown>; execute: boolean; problems: string[] } {
  const inputs: Record<string, unknown> = {}
  const problems: string[] = []
  let execute = false
  for (let k = 0; k < argv.length; k++) {
    const f = argv[k], name = FLAGS[f]
    if (!name) { problems.push(`unknown argument ${JSON.stringify(String(f)).slice(0, 60)}`); continue }
    if (name === 'execute') { execute = true; continue }
    if (name in inputs) { problems.push(`${f} given twice`); k++; continue }
    const v = argv[k + 1]
    if (v === undefined || v.startsWith('--')) { problems.push(`${f} needs a value`); continue }
    k++
    if (NUMERIC.has(name)) {
      if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)) { problems.push(`${f} must be a plain decimal number`); continue }
      inputs[name] = Number(v)
    } else inputs[name] = v
  }
  return { inputs, execute, problems }
}
