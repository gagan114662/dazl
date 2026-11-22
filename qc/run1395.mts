// Quest live check #1395 slice (test input, not through the UI). Deployed request-plan + board place vs the regex reader.
const L = process.argv[2]
const { readRequestPlan } = await import(`${L}/lib/scan/request-plan.ts`)
const { anthropicModel } = await import(`${L}/lib/llm/provider.ts`)
const { HAIKU } = await import(`${L}/lib/research/scan-job.ts`)
const { boardPlaceOf, placeIn } = await import(`${L}/lib/sources/jobboards.ts`)
const key = process.env.QK ?? ''
const reqs = [
  'Dental clinics in London, Ontario hiring front desk staff in the last 90 days',
  'Companies in Fintech, California hiring account executives',
  'Cliniques dentaires à Montréal, Québec qui recrutent une réceptionniste',
]
const out: unknown[] = []
for (const q of reqs) {
  const legacy = placeIn(q)
  let r: any
  try { r = await readRequestPlan(anthropicModel(HAIKU), key, q, 'quest-qc-1395') } catch (e) { r = { ok: false, reason: `THREW ${(e as Error).message.slice(0, 120)}` } }
  const b = r.ok ? boardPlaceOf(r.plan.places, {}) : null
  out.push({ request: q, regex_reader_place: legacy?.name ?? null, plan_ok: r.ok, plan_places: r.ok ? r.plan.places : r.reason, plan_language: r.ok ? r.plan.language : null, board_place: b ? ('place' in b ? b.place.name : b.reason) : null })
}
console.log(JSON.stringify(out, null, 1))
