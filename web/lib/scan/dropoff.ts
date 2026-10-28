// A scan's funnel from its run report: how many survive each stage, and why the rest do not. Pure and read-only; absent fields stay "not recorded", never a fabricated zero.
export interface Stage { stage: string; in: number | null; out: number | null; lost: number | null; reasons: Record<string, number> }
export interface Dropoff { stages: Stage[]; biggest: { stage: string; lost: number; top_reason: string | null } | null; final: { verified: number | null; needs_review: number | null; actionable: number | null; resolved: number | null } }
type R = Record<string, any>   // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const top = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

export function dropoffOf(report: R | null | undefined): Dropoff {
  const rep: R = report ?? {}
  const urls: R[] = Array.isArray(rep.urls) ? rep.urls : []
  const search: R = rep.search ?? {}
  const fates: R[] = Array.isArray(rep.candidates) ? rep.candidates : Array.isArray(rep.fates) ? rep.fates : []
  const stages: Stage[] = []
  const add = (stage: string, inn: number | null, out: number | null, reasons: Record<string, number> = {}) => stages.push({ stage, in: inn, out, lost: inn !== null && out !== null ? Math.max(0, inn - out) : null, reasons })
  const hits = num(search.hits_unique_urls)
  add('search -> urls selected for reading', hits, urls.length ? urls.filter(u => u.selected).length : null)
  const selected = urls.filter(u => u.selected)
  const fetchReasons: Record<string, number> = {}
  for (const u of selected) if (u.own_fetch && u.own_fetch !== 'ok') fetchReasons[`own fetch ${u.own_fetch}`] = (fetchReasons[`own fetch ${u.own_fetch}`] ?? 0) + 1
  add('urls read -> own page fetched', urls.length ? selected.length : null, urls.length ? selected.filter(u => !u.own_fetch || u.own_fetch === 'ok').length : null, fetchReasons)
  const extracted = num(rep.extracted_candidates)
  add('pages -> candidates extracted', urls.length ? selected.length : null, extracted)
  const funnel: R = rep.funnel ?? {}
  const verified = num(funnel.verified), review = num(funnel.needs_review), dropped = num(funnel.dropped)
  const gateReasons: Record<string, number> = {}
  for (const [k, v] of Object.entries<number>(funnel.review_reasons ?? {})) gateReasons[`held: ${k}`] = v
  for (const [k, v] of Object.entries<number>(funnel.drop_reasons ?? {})) gateReasons[`dropped: ${k}`] = v
  add('candidates -> verified (identity / quote / date / sales-hiring gates)', num(funnel.candidates) ?? extracted, verified, gateReasons)
  const y: R = rep.yield ?? {}, res: R = rep.resolution ?? {}
  const miss: Record<string, number> = {}
  for (const [k, v] of Object.entries<number>(y.missing ?? {})) miss[`not actionable: ${k}`] = v
  add('verified -> actionable (domain, person, published contact)', verified, num(y.actionable), miss)
  const rr: Record<string, number> = res.by_reason ?? {}
  add('candidates -> resolved (date + identity + contact)', num(res.candidates), num(res.resolved), rr)
  const real = stages.filter(s => s.lost !== null && s.lost > 0).sort((a, b) => b.lost! - a.lost!)[0]
  void dropped; void review
  return { stages, biggest: real ? { stage: real.stage, lost: real.lost!, top_reason: top(real.reasons) } : null, final: { verified, needs_review: review, actionable: num(y.actionable), resolved: num(res.resolved) } }
}
export function formatDropoff(d: Dropoff): string {
  const n = (v: number | null) => (v === null ? 'n/r' : String(v))   // n/r = not recorded
  const lines = d.stages.map(s => `${s.stage.padEnd(66)} ${n(s.in).padStart(4)} -> ${n(s.out).padStart(4)}   lost ${n(s.lost).padStart(3)}${Object.keys(s.reasons).length ? '   ' + Object.entries(s.reasons).map(([k, v]) => `${k} x${v}`).join('; ') : ''}`)
  lines.push(d.biggest ? `\nBIGGEST DROP-OFF: ${d.biggest.stage} (lost ${d.biggest.lost}${d.biggest.top_reason ? `, mostly: ${d.biggest.top_reason}` : ''})` : '\nno drop-off recorded')
  lines.push(`final: verified ${n(d.final.verified)}, needs review ${n(d.final.needs_review)}, actionable ${n(d.final.actionable)}, resolved ${n(d.final.resolved)}`)
  return lines.join('\n')
}
