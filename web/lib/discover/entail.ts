// One yes/no question to Claude's small model about a claim's cited on-page proof.
import Anthropic from '@anthropic-ai/sdk'
import type { AskSignal } from './check.ts'
import { SpendRefused } from '../llm/spend-guard.ts'

export const ENTAIL_MODEL = process.env.DAZL_DISCOVER_ENRICH_MODEL?.trim() || 'claude-haiku-5-5'
const PRICE = { input: 0.1, output: 0.5 }   // US$ per million tokens, as the people pass prices the same model
const SYSTEM = `You check evidence for a sales lead. You are given TEXT copied from one web page, a COMPANY and a CLAIM about that company.
Answer YES only when the TEXT itself states the event in the CLAIM: for example that the company is hiring that role, is opening that location, raised that round, or appointed that person.
Details the CLAIM adds that the TEXT lacks do not matter: a street address, a count, a salary, how long ago something was posted, where it was read.
Answer NO when the TEXT is only routine information (contact details, an address, opening hours, a description of the company, reviews) or is about something else, even if it shares words with the CLAIM.
Reply with one word: YES or NO.`
export const saysYes = (text: string): boolean => /^\s*yes\b/i.test(text)
export interface SignalJudge { ask: AskSignal; usage: { requests: number; usd: number; accountingUncertain?: boolean } }
export function signalJudge(deps: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): SignalJudge {
  const client = new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 0, timeout: 15_000 })
  const usage: SignalJudge['usage'] = { requests: 0, usd: 0 }
  const ask: AskSignal = async (signal, company, statements) => {
    if (statements.length === 0) return false
    if (usage.accountingUncertain) throw new Error('Evidence accounting is uncertain; no further request was sent')
    // thinking off: this model thinks by default, and thinking spent the whole answer budget, so no word came back and every lead read as NO
    // (staging, 2026-11-23: 'X is looking for SDRs' refused for the claim that X is looking for SDRs)
    usage.requests++
    try {
    if (ENTAIL_MODEL !== 'claude-haiku-5-5') throw new Error('Evidence judge requires the supported small-model cost policy')
    const res = await client.messages.create({ model: ENTAIL_MODEL, max_tokens: 8, service_tier: 'standard_only', thinking: { type: 'disabled' }, system: SYSTEM,
      messages: [{ role: 'user', content: `COMPANY: ${company.slice(0, 150)}\nCLAIM: ${signal.slice(0, 600)}\nTEXT:\n${statements.map(s => `- ${s}`).join('\n')}` }] }, { signal: deps.signal })
    if (res.model !== ENTAIL_MODEL || ![res.usage.input_tokens, res.usage.output_tokens]
      .every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw new Error('Evidence judge usage is unavailable')
    usage.usd = Math.round((usage.usd + ((res.usage.input_tokens ?? 0) * PRICE.input + (res.usage.output_tokens ?? 0) * PRICE.output) / 1e6) * 10000) / 10000
    if (res.stop_reason === 'refusal') return 'unavailable'
    return saysYes(res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(''))
    } catch (e) { if (!(e instanceof SpendRefused)) usage.accountingUncertain = true; throw e } // #2124: a refusal sent nothing
  }
  return { ask, usage }
}


// The request has at most 2,400 source characters, a 600-character claim,
// a 150-character company and the fixed system prompt. Reserve conservatively
// for UTF-8 input and the eight-token answer, at the supported model's rates.
const JUDGE_RESERVE_USD = 0.002

export function meterSignalJudge(judge: SignalJudge, remaining: () => number): SignalJudge {
  const cached = new Map<string, ReturnType<AskSignal>>()
  let reserved = 0
  const ask: AskSignal = (signal, company, statements, page) => {
    const key = JSON.stringify([page ?? statements, company, signal])
    const existing = cached.get(key)
    if (existing) return existing
    if (remaining() + 1e-9 < reserved + JUDGE_RESERVE_USD) return Promise.resolve('spend_cap')
    reserved += JUDGE_RESERVE_USD
    const result = Promise.resolve().then(() => judge.ask(signal, company, statements, page))
      .finally(() => { reserved -= JUDGE_RESERVE_USD })
    cached.set(key, result)
    return result
  }
  return { ask, usage: judge.usage }
}
