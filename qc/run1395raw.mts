const L = process.argv[2]
const { planPrompt, parsePlan, PLAN_MAX_TOKENS } = await import(`${L}/lib/scan/request-plan.ts`)
const { anthropicModel } = await import(`${L}/lib/llm/provider.ts`)
const { HAIKU } = await import(`${L}/lib/research/scan-job.ts`)
const { runWithoutAccountSpend } = await import(`${L}/lib/scan/spend-cap.ts`)
const q = 'Dental clinics in London, Ontario hiring front desk staff in the last 90 days'
const p = anthropicModel(HAIKU)
const r: any = await runWithoutAccountSpend('offline_eval', () => p.completeDetailed!(process.env.QK!, planPrompt(q), undefined, PLAN_MAX_TOKENS))
console.log('MODEL', HAIKU, 'STOP', r.stopReason ?? r.stop_reason ?? '?', 'LEN', r.text.length)
console.log('RAW_REPLY_JSON_STRING=' + JSON.stringify(r.text))
console.log('PARSEPLAN=' + JSON.stringify(parsePlan(r.text)))
