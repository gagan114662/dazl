// One yes/no question to Claude's small model, asked only when a lead's quoted evidence is on its proof page and the word rule could not
// settle whether that text states the signal (lib/discover/check.ts settle). About 300 tokens a lead. Claude only: no other provider.
import Anthropic from '@anthropic-ai/sdk'
import { anthropicPostHogOptions, createAnthropicClient } from '../posthog-ai.ts'
import type { AskSignal } from './check.ts'

export const ENTAIL_MODEL = process.env.DAZL_DISCOVER_ENRICH_MODEL?.trim() || 'claude-haiku-5-5'
const PRICE = { input: 0.1, output: 0.5 }   // US$ per million tokens, as the people pass prices the same model
const SYSTEM = `You check evidence for a sales lead. You are given TEXT copied from one web page, a COMPANY and a CLAIM about that company.
Answer YES only when the TEXT itself states the event in the CLAIM: for example that the company is hiring that role, is opening that location, raised that round, or appointed that person.
Details the CLAIM adds that the TEXT lacks do not matter: a street address, a count, a salary, how long ago something was posted, where it was read.
Answer NO when the TEXT is only routine information (contact details, an address, opening hours, a description of the company, reviews) or is about something else, even if it shares words with the CLAIM.
Reply with one word: YES or NO.`
export const saysYes = (text: string): boolean => /^\s*yes\b/i.test(text)
export interface SignalJudge { ask: AskSignal; usage: { requests: number; usd: number } }
export function signalJudge(deps: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): SignalJudge {
  const client = createAnthropicClient({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 1, timeout: 15_000 })
  const usage = { requests: 0, usd: 0 }
  const ask: AskSignal = async (signal, company, statements) => {
    if (statements.length === 0) return false
    // thinking off: this model thinks by default, and thinking spent the whole answer budget, so no word came back and every lead read as NO
    // (staging, 2026-11-23: 'X is looking for SDRs' refused for the claim that X is looking for SDRs)
    const res = await client.messages.create({ model: ENTAIL_MODEL, max_tokens: 8, thinking: { type: 'disabled' }, system: SYSTEM,
      messages: [{ role: 'user', content: `COMPANY: ${company.slice(0, 150)}\nCLAIM: ${signal.slice(0, 600)}\nTEXT:\n${statements.map(s => `- ${s}`).join('\n')}` }], ...anthropicPostHogOptions() }, { signal: deps.signal })
    usage.requests++
    usage.usd = Math.round((usage.usd + ((res.usage.input_tokens ?? 0) * PRICE.input + (res.usage.output_tokens ?? 0) * PRICE.output) / 1e6) * 10000) / 10000
    return saysYes(res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(''))
  }
  return { ask, usage }
}
