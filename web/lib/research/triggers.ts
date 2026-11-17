// Stage 1 of the research engine (LEAD_ENGINE=research): understand the buyer. Port of ~/work/proto/ai-research/pipeline.py understand():
// one model call per scan writes the persona, the decision-maker titles and ~10 seller-specific triggers, each with 4 web-search queries,
// plus 6 "people asking" queries. 80% of the prototype's ready leads came from triggers the seller never typed, so the seller's own words are
// one trigger among ten, never the only one. No Sonar prompts: Perplexity Sonar is a paid service dazl does not use.
// Pure apart from the injected `complete` call; the plan is validated here so a malformed answer never reaches the hunt.
import type { ResearchCase, ResearchPlan, Trigger } from './types.ts'

export const MAX_TRIGGERS = 12
export const QUERIES_PER_TRIGGER = 4
export const MAX_ASKING_QUERIES = 6

export function triggerPrompt(c: ResearchCase): string {
  return `You are the head of research for a sales team. Seller: ${c.seller || 'the seller'} sells: ${c.offer}.
The seller's own words for who they want: "${c.query}". Market: ${c.where}; buyers: ${c.category}.
Today is ${c.today}. Think like the best human SDR + researcher for THIS seller.
Return ONLY JSON:
{"persona": "2 sentences: who buys and what pain makes them buy",
 "decision_maker_titles": ["5-8 titles that sign off on this purchase at such a company"],
 "triggers": [{"id":"t1","name":"short name","why_it_matters":"why this event makes them need the seller NOW","how_it_shows_publicly":"where/how it appears on the open web","queries":["4 web-search queries"]}],
 "asking_queries": ["6 queries that find these buyers publicly asking for such a solution, complaining about a competitor or about the pain (forums, reviews, blog posts, local press)"]}
Rules: 10 triggers, specific to this seller (include the one in the seller's own words, plus others they did not think of: expansions, new hires in key roles, ownership changes, funding, new sites, complaints, regulation, seasonal/local events). Awards alone are not a buying trigger.
Queries: plain search-engine queries, 4-9 words, include the city/region, in the local language where that is not English, written to surface company websites, local/trade news, press releases and career pages. Vary them. Do not use site: operators for linkedin/indeed/facebook (they cannot be opened). Include the year ${c.today.slice(0, 4)} or a recent month in about a third of them.`
}

// the first JSON object in a model answer (it may wrap it in prose or a code fence)
export function firstJsonObject(text: string): unknown {
  const s = text.indexOf('{')
  if (s < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = s; i < text.length; i++) {
    const ch = text[i]
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(s, i + 1)) } catch { return null } }
  }
  return null
}

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '')
// LinkedIn, Indeed and Facebook cannot be opened, so a site: query on them only yields unreadable results
const UNOPENABLE_SITE = /\bsite:\s*(?:[\w.-]*\.)?(?:linkedin|indeed|facebook|glassdoor|instagram|x|twitter)\.com\b/i
export function cleanQuery(q: unknown): string | null {
  const s = str(q, 200).replace(/^["']|["']$/g, '')
  if (!s || UNOPENABLE_SITE.test(s)) return null
  const words = s.split(' ').length
  return words >= 2 && words <= 14 ? s : null
}
const uniq = (xs: (string | null)[]): string[] => { const seen = new Set<string>(); const out: string[] = []; for (const x of xs) { if (!x) continue; const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x) } } return out }

// The model's answer -> a plan, or null when it has no usable trigger. Ids are rewritten t1..tN so a trigger id is always unique and stable.
export function parsePlan(text: string): Omit<ResearchPlan, 'source'> | null {
  const j = firstJsonObject(text) as Record<string, unknown> | null
  if (!j || typeof j !== 'object') return null
  const triggers: Trigger[] = []
  for (const t of Array.isArray(j.triggers) ? j.triggers : []) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const name = str(o.name, 80), queries = uniq((Array.isArray(o.queries) ? o.queries : []).map(cleanQuery)).slice(0, QUERIES_PER_TRIGGER)
    if (!name || queries.length === 0) continue
    triggers.push({ id: `t${triggers.length + 1}`, name, why: str(o.why_it_matters), footprint: str(o.how_it_shows_publicly), queries, weight: 1, enabled: true })
    if (triggers.length === MAX_TRIGGERS) break
  }
  if (triggers.length === 0) return null
  const titles = uniq((Array.isArray(j.decision_maker_titles) ? j.decision_maker_titles : []).map(x => str(x, 60) || null)).slice(0, 8)
  return { persona: str(j.persona, 600), decisionMakerTitles: titles.length ? titles : ['Owner', 'Founder', 'CEO', 'Managing Director'],
    triggers, askingQueries: uniq((Array.isArray(j.asking_queries) ? j.asking_queries : []).map(cleanQuery)).slice(0, MAX_ASKING_QUERIES) }
}

// No usable model answer: the seller's own words, in the place, are the one trigger. A thin plan, said as such (source 'fallback').
export function fallbackPlan(c: ResearchCase): ResearchPlan {
  const place = c.where.split(',')[0].trim()
  const own = c.query.toLowerCase().includes(place.toLowerCase()) ? c.query : `${c.query} ${place}`
  return { persona: '', decisionMakerTitles: ['Owner', 'Founder', 'CEO', 'Managing Director'], askingQueries: [], source: 'fallback',
    triggers: [{ id: 't1', name: 'the seller\'s own trigger', why: '', footprint: '', weight: 1, enabled: true, queries: uniq([cleanQuery(own.slice(0, 200)), cleanQuery(`${c.category} ${place} ${c.today.slice(0, 4)}`)]) }] }
}

// One model call (a second only when the first answer is unusable); the fallback plan when both fail. `complete` throws on a refused or
// failed paid call: a spend refusal propagates (the scan's own budget stops it), anything else falls back.
export async function planResearch(c: ResearchCase, complete: (prompt: string, maxTokens: number) => Promise<string>, isRefusal: (e: unknown) => boolean = () => false): Promise<ResearchPlan> {
  const prompt = triggerPrompt(c)
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string
    try { text = await complete(prompt, 4000) } catch (e) { if (isRefusal(e)) throw e; break }
    const p = parsePlan(text)
    if (p) return { ...p, source: 'model' }
  }
  return fallbackPlan(c)
}
