// The funding stage a request names, and whether a sentence states that stage. Pure (no store, no network), so the discovery lane's
// proof check (lib/discover/qualifiers.ts) reads the same rule as the older engine's gate (lib/scan/sales-hiring-gate.ts, which
// re-exports these).
export type Stage = 'seed' | `series ${string}` | null
// #1201 (Refs #1095): the stage and the funding ask are REQUIREMENTS, so they are read from the user's own words only. The model's profile
// signals are matching / scoring vocabulary: a model "Series A" never overrides a user "Series B", and a seed signal the user never asked for
// adds no funding gate. `icp` stays in the signature so callers keep compiling; it is deliberately not read here.
export function requestedStage(query: string | null | undefined, _icp?: string | null): Stage {
  void _icp
  const t = query ?? ''
  const series = /\bseries\s+([a-e])\b/i.exec(t)
  if (/\bseed\b/i.test(t) && !series) return 'seed'
  return series ? `series ${series[1].toLowerCase()}` : /\bseed\b/i.test(t) ? 'seed' : null
}
export function stageOk(clause: string, stage: Stage): boolean {
  if (!stage) return true
  const series = /\bseries\s+([a-z])\b|\b(?:growth|bridge)\s+(?:round|equity)\b/i.exec(clause)
  if (stage === 'seed') return /\b(?:pre-?)?seed\b/i.test(clause) && !series
  const letter = stage.slice(7)
  return new RegExp(`\\bseries\\s+${letter}\\b`, 'i').test(clause) && !/\bseed\b/i.test(clause)
}
