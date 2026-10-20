import type Database from 'better-sqlite3'
import { estimateCostMicroUsd } from './plans.ts'
import { getPlan, reserve, settle } from './usage.ts'
import type { LlmProvider, LlmRequest, LlmResult } from './types.ts'

export class QuotaExceededError extends Error {
  constructor() {
    super('quota_exceeded')
  }
}

const approxTokens = (s: string) => Math.ceil(s.length / 3) // conservative for English

// All LLM calls for a tenant go through here: quota check, timeout, usage
// accounting. The tenant id comes from the session, never from a request body.
export async function meteredComplete(
  db: Database.Database,
  provider: LlmProvider,
  tenantId: string,
  req: LlmRequest,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<LlmResult> {
  const plan = getPlan(db, tenantId)
  const maxOut = Math.min(req.maxOutputTokens, plan.maxOutputTokensPerCall)
  const inEst = approxTokens((req.system ?? '') + req.prompt)
  const model = opts.model ?? 'default'
  const reserved = { tokens: inEst + maxOut, costMicroUsd: estimateCostMicroUsd(model, inEst, maxOut) }
  if (!reserve(db, tenantId, reserved.tokens, reserved.costMicroUsd)) throw new QuotaExceededError()

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  try {
    const res = await provider.complete({ ...req, maxOutputTokens: maxOut }, ctrl.signal)
    settle(db, tenantId, reserved, {
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costMicroUsd: estimateCostMicroUsd(res.model || model, res.inputTokens, res.outputTokens),
    })
    return res
  } catch (e) {
    settle(db, tenantId, reserved, null) // release the reservation; failed calls are not billed to the tenant
    throw e
  } finally {
    clearTimeout(timer)
  }
}
