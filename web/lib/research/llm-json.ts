// MISSION v2 (research engine), part C. Two small helpers the filter and the gate share (they lived in decider.ts, the OpenRouter client, which is gone: the
// research engine uses Claude only).

// A model reply that should be JSON, possibly inside a ```json fence or with prose around it. Null when there is no parseable object.
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const s = text.indexOf('{'), e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try { const v = JSON.parse(text.slice(s, e + 1)); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null } catch { return null }
}

// Bounded concurrency, order kept.
export async function pmap<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i) } }))
  return out
}
