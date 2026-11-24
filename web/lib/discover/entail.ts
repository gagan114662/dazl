// One yes/no question to Claude's small model, asked only when a lead's quoted evidence is on its proof page and the word rule could not
// settle whether that text states the signal (lib/discover/check.ts settle). About 300 tokens a lead. Claude only: no other provider.
// A second question, at most once a lead and to the same model (askQualifiers): does the page support what the REQUEST asks for
// beyond the event (the role, a first hire), where the words alone left that open (lib/discover/qualifiers.ts). The two are kept
// apart on purpose: the first asks whether an event is stated and forgives added detail; the second is about exactly that detail.
import Anthropic from '@anthropic-ai/sdk'
import type { AskQualifiers, AskSignal } from './check.ts'

export const ENTAIL_MODEL = process.env.DAZL_DISCOVER_ENRICH_MODEL?.trim() || 'claude-haiku-5-5'
const PRICE = { input: 0.1, output: 0.5 }   // US$ per million tokens, as the people pass prices the same model
const SYSTEM = `You check evidence for a sales lead. You are given TEXT copied from one web page, a COMPANY and a CLAIM about that company.
Answer YES only when the TEXT itself states the event in the CLAIM: for example that the company is hiring that role, is opening that location, raised that round, or appointed that person.
Details the CLAIM adds that the TEXT lacks do not matter: a street address, a count, a salary, how long ago something was posted, where it was read.
Answer NO when the TEXT is only routine information (contact details, an address, opening hours, a description of the company, reviews) or is about something else, even if it shares words with the CLAIM.
Reply with one word: YES or NO.`
export const saysYes = (text: string): boolean => /^\s*yes\b/i.test(text)
const QUALIFIER_SYSTEM = `You check evidence for a sales lead. You are given TEXT copied from one web page, a COMPANY and a numbered list of REQUIREMENTS.
For each requirement answer YES only when the TEXT itself supports it. What is likely, usual for such a company, or known from elsewhere does not count.
Answer NO when the TEXT does not say it, says something else, or leaves it unclear.
Reply with one line and nothing else: YES or NO for each requirement, in order, separated by spaces.`
// The reply as one answer per requirement. Anything but exactly that many YES / NO words is no answer, and no answer is NO for each.
export const yesNoList = (text: string, n: number): boolean[] => {
  const words = text.match(/\b(?:yes|no)\b/gi) ?? []
  return words.length === n ? words.map(w => /^yes$/i.test(w)) : new Array<boolean>(n).fill(false)
}
// askQualifiers is optional so a judge that only answers the signal question (a test's stub) is still a judge.
export interface SignalJudge { ask: AskSignal; askQualifiers?: AskQualifiers; usage: { requests: number; usd: number } }
export function signalJudge(deps: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): SignalJudge {
  const client = new Anthropic({ apiKey: deps.apiKey, fetch: deps.fetch, maxRetries: 1, timeout: 15_000 })
  const usage = { requests: 0, usd: 0 }
  const ask: AskSignal = async (signal, company, statements) => {
    if (statements.length === 0) return false
    // thinking off: this model thinks by default, and thinking spent the whole answer budget, so no word came back and every lead read as NO
    // (staging, 2026-11-23: 'X is looking for SDRs' refused for the claim that X is looking for SDRs)
    const res = await client.messages.create({ model: ENTAIL_MODEL, max_tokens: 8, thinking: { type: 'disabled' }, system: SYSTEM,
      messages: [{ role: 'user', content: `COMPANY: ${company.slice(0, 150)}\nCLAIM: ${signal.slice(0, 600)}\nTEXT:\n${statements.map(s => `- ${s}`).join('\n')}` }] }, { signal: deps.signal })
    usage.requests++
    usage.usd = Math.round((usage.usd + ((res.usage.input_tokens ?? 0) * PRICE.input + (res.usage.output_tokens ?? 0) * PRICE.output) / 1e6) * 10000) / 10000
    return saysYes(res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(''))
  }
  const askQualifiers: AskQualifiers = async (company, requirements, statements) => {
    if (requirements.length === 0) return []
    if (statements.length === 0) return requirements.map(() => false)
    const res = await client.messages.create({ model: ENTAIL_MODEL, max_tokens: 16, thinking: { type: 'disabled' }, system: QUALIFIER_SYSTEM,
      messages: [{ role: 'user', content: `COMPANY: ${company.slice(0, 150)}\nREQUIREMENTS:\n${requirements.map((r, i) => `${i + 1}. ${r.slice(0, 400)}`).join('\n')}\nTEXT:\n${statements.map(s => `- ${s}`).join('\n')}` }] }, { signal: deps.signal })
    usage.requests++
    usage.usd = Math.round((usage.usd + ((res.usage.input_tokens ?? 0) * PRICE.input + (res.usage.output_tokens ?? 0) * PRICE.output) / 1e6) * 10000) / 10000
    return yesNoList(res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join(''), requirements.length)
  }
  return { ask, askQualifiers, usage }
}
