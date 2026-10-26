// Model usage tracking for the ordinary app route (live acceptance run, Oct 26: "no recorded scan model/token totals,
// actual served model or API-request count can be reconstructed"). Every model request made through the job's provider
// is recorded: stage, method, requested vs SERVED model, and the token counts the provider REPORTED.
//
// Honesty rules (the reason this exists):
//   - Unknown stays NULL, never 0. Web-search research calls report no usage at all; they are counted as requests with
//     NULL tokens, and totals say whether they are complete.
//   - A request is recorded when it is SENT to the provider. A call the spend guard refuses never reaches this wrapper's
//     inner provider and is not recorded as a request.
//   - Requests are counted at this boundary. Retries inside the provider or the platform are not visible here, cache
//     token counts are not stored, and the real invoice cannot be derived from these rows; no price is computed or stored
//     (see MODEL_USAGE_UNKNOWN, returned with every read).
//   - Prompt text and responses are NOT stored (only prompt length and a fixed-template stage label).
// ON by default; DAZL_MODEL_USAGE=0 turns recording off. Never throws into the scan.
import type Database from 'better-sqlite3'
import type { Provider } from '../llm/provider.ts'

export const modelUsageEnabled = (env: Record<string, string | undefined> = process.env) => env.DAZL_MODEL_USAGE !== '0'

export interface ModelCall {
  stage: string; method: 'complete' | 'completeDetailed' | 'research'
  model_requested: string | null; model_served: string | null
  input_tokens: number | null; output_tokens: number | null
  outcome: 'ok' | 'error'; max_tokens: number | null; prompt_chars: number
}

// Stage from the fixed opening of each prompt template (never from user text). Best effort; 'other' when unknown.
const STAGES: [RegExp, string][] = [
  [/^A user of a lead-finding tool/, 'profile'],
  [/^You write web search queries|search queries/i, 'search_queries'],
  [/ground|verify the quote|supports? the claim/i, 'grounding'],
  [/buyer-fit|fits? (?:the )?(?:buyer|ideal customer)|home page/i, 'buyer_fit'],
  [/Grade each|grading|score each lead/i, 'scoring'],
  [/contradict/i, 'judge'],
  [/Reply with ONLY a JSON array/i, 'extraction'],
]
export const stageOfPrompt = (prompt: string): string => { const head = prompt.slice(0, 400); return STAGES.find(([re]) => re.test(head))?.[1] ?? 'other' }

export function meterProvider(p: Provider, record: (c: ModelCall) => void): Provider {
  const model = () => { try { return p.configuredModel?.() ?? null } catch { return null } }
  const note = (c: ModelCall) => { try { record(c) } catch { /* never affects the scan */ } }
  const out: Provider = {
    research: async (k, prompt, f) => {
      const base = { stage: 'research', method: 'research' as const, model_requested: model(), model_served: null, input_tokens: null, output_tokens: null, max_tokens: null, prompt_chars: prompt.length }
      try { const r = await p.research(k, prompt, f); note({ ...base, outcome: 'ok' }); return r } catch (e) { note({ ...base, outcome: 'error' }); throw e }
    },
    ...(p.configuredModel ? { configuredModel: () => p.configuredModel!() } : {}),
  }
  if (p.completeDetailed) {
    out.completeDetailed = async (k, prompt, f, max) => {
      const base = { stage: stageOfPrompt(prompt), method: 'completeDetailed' as const, model_requested: model(), max_tokens: max ?? null, prompt_chars: prompt.length }
      try {
        const d = await p.completeDetailed!(k, prompt, f, max)
        note({ ...base, model_served: d.model, input_tokens: typeof d.usage?.input_tokens === 'number' ? d.usage.input_tokens : null, output_tokens: typeof d.usage?.output_tokens === 'number' ? d.usage.output_tokens : null, outcome: 'ok' })
        return d
      } catch (e) { note({ ...base, model_served: null, input_tokens: null, output_tokens: null, outcome: 'error' }); throw e }
    }
    // complete() is completeDetailed().text in the real providers; going through it keeps the served model and usage.
    out.complete = async (k, prompt, f, max) => (await out.completeDetailed!(k, prompt, f, max)).text
  } else if (p.complete) {
    out.complete = async (k, prompt, f, max) => {
      const base = { stage: stageOfPrompt(prompt), method: 'complete' as const, model_requested: model(), model_served: null, input_tokens: null, output_tokens: null, max_tokens: max ?? null, prompt_chars: prompt.length }
      try { const t = await p.complete!(k, prompt, f, max); note({ ...base, outcome: 'ok' }); return t } catch (e) { note({ ...base, outcome: 'error' }); throw e }
    }
  }
  return out
}

export function migrateModelUsage(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scan_model_calls (
    tenant_id TEXT NOT NULL,
    job_id TEXT REFERENCES scan_jobs(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    stage TEXT NOT NULL CHECK (length(stage) <= 40),
    method TEXT NOT NULL,
    model_requested TEXT CHECK (model_requested IS NULL OR length(model_requested) <= 100),
    model_served TEXT CHECK (model_served IS NULL OR length(model_served) <= 100),
    input_tokens INTEGER,
    output_tokens INTEGER,
    outcome TEXT NOT NULL,
    max_tokens INTEGER,
    prompt_chars INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
  )`)
  // One row per (job, attempt, seq): a second flush of the same call can never insert a duplicate. (job_id NULL rows - profile
  // generation before a job - are distinct under SQLite's NULL rule and are written once, at the call.)
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS scan_model_calls_job ON scan_model_calls(job_id, attempt, seq)')
}

// Called from the job's finish transaction (done, failed or retry), so a failed scan still leaves its usage behind.
// job_id null = a call made before any job exists (profile generation from the form); linked by tenant only.
export function writeModelCalls(db: Database.Database, tenantId: string, jobId: string | null, attempt: number, calls: ModelCall[], env: Record<string, string | undefined> = process.env, startSeq = 0): boolean {
  if (!modelUsageEnabled(env) || calls.length === 0) return false
  try {
    migrateModelUsage(db)
    const ins = db.prepare('INSERT OR IGNORE INTO scan_model_calls (tenant_id,job_id,attempt,seq,stage,method,model_requested,model_served,input_tokens,output_tokens,outcome,max_tokens,prompt_chars) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    calls.forEach((c, i) => ins.run(tenantId, jobId, attempt, startSeq + i, c.stage, c.method, c.model_requested, c.model_served, c.input_tokens, c.output_tokens, c.outcome, c.max_tokens, c.prompt_chars))
    return true
  } catch { return false }
}

export interface ModelUsage {
  recorded: boolean
  // Requests dazl SENT through the job's provider (counted at that boundary). Not provider-side requests and not invoices.
  requests_recorded: number
  requests_with_reported_tokens: number
  requests_without_reported_tokens: number
  by_stage: Record<string, number>
  // Sums over the requests that REPORTED the number; tokens_complete is false when any recorded request did not
  // (web-search research calls never report usage). A sum with tokens_complete:false is a LOWER BOUND.
  input_tokens: number | null; output_tokens: number | null; tokens_complete: boolean
  served_models: string[]; requested_models: string[]
  errors: number
  // Things this record does NOT contain. Fixed list, not derived from data, so absence is never read as zero.
  unknown: string[]
  note: string
}
export const MODEL_USAGE_UNKNOWN = [
  'provider_or_platform_retries (requests retried below dazl are not visible)',
  'actual_charges (no price is computed; this is not an invoice)',
  'cache_read_and_cache_creation_tokens (reported by the provider, not stored)',
  'web_search_research_usage_and_served_model (research calls report none)',
  'profile_generation_before_run (stored per tenant with no job, not in these totals)',
]
// null table / no rows => recorded:false with null totals, never zeros.
export function modelUsage(db: Database.Database, tenantId: string, jobId: string): ModelUsage {
  const none: ModelUsage = { recorded: false, requests_recorded: 0, requests_with_reported_tokens: 0, requests_without_reported_tokens: 0, by_stage: {}, input_tokens: null, output_tokens: null, tokens_complete: false, served_models: [], requested_models: [], errors: 0, unknown: MODEL_USAGE_UNKNOWN, note: 'No model usage was recorded for this scan (older scan, recording off, or no model request was made). This is not a zero.' }
  try {
    const rows = db.prepare('SELECT c.* FROM scan_model_calls c JOIN scan_jobs j ON j.id=c.job_id WHERE j.user_id=? AND j.id=? ORDER BY c.attempt,c.seq').all(tenantId, jobId) as (ModelCall & Record<string, unknown>)[]
    if (rows.length === 0) return none
    const sum = (k: 'input_tokens' | 'output_tokens') => rows.some(r => r[k] != null) ? rows.reduce((a, r) => a + (r[k] ?? 0), 0) : null
    const by_stage: Record<string, number> = {}; for (const r of rows) by_stage[r.stage] = (by_stage[r.stage] ?? 0) + 1
    const withTokens = rows.filter(r => r.input_tokens != null && r.output_tokens != null).length
    return {
      recorded: true, requests_recorded: rows.length, requests_with_reported_tokens: withTokens, requests_without_reported_tokens: rows.length - withTokens,
      by_stage, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), tokens_complete: withTokens === rows.length,
      served_models: [...new Set(rows.map(r => r.model_served).filter((x): x is string => !!x))], requested_models: [...new Set(rows.map(r => r.model_requested).filter((x): x is string => !!x))],
      errors: rows.filter(r => r.outcome === 'error').length, unknown: MODEL_USAGE_UNKNOWN,
      note: 'Recorded requests and the tokens the provider reported for them. Totals are a lower bound whenever tokens_complete is false. Not an invoice.',
    }
  } catch { return none }
}
