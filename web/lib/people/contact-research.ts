// #1102 named-contact fallback (benchmark stage): for ONE company, find the decision-maker's name, title and public
// linkedin.com/in URL from web search results, with the source required.
//
// The approach follows buildingopen/opengtm research.py (MIT): ask a model for the decision-maker and keep a LinkedIn URL only
// when it is verified. No code is copied, and two things differ on purpose:
//   - dazl never requests LinkedIn (opengtm sends an HTTP HEAD to the profile). Here a profile URL is kept only when a SEARCH
//     RESULT returned that exact URL and that result's own title names the same person at this company.
//   - nothing may come from the model's memory. The model only POINTS at numbered sources it was shown; every field it returns
//     is then checked in code against the text of those sources (groundPerson). A field that is not there is dropped.
//
// Existing vendors only: the operator's TinyFish search (lib/search/tinyfish.ts: per-tenant daily and global caps, at most
// MAX_SEARCHES searches and MAX_READS page read per lookup) and the account's own model key, called through the owner guard
// (lib/llm/owner-guard.ts: the account's day and month spend limits). Nothing is stored here; the caller decides what to do
// with the result. A spend refusal (SpendRefused) or an unsaved cost (SpendAccountingFailed) is thrown to the caller.
import type { DbLike } from '../db/client.ts'
import type { Provider } from '../llm/provider.ts'
import { ownerGuarded } from '../llm/owner-guard.ts'
import { tfSearch, tfFetch, markdownToText, type SearchHit } from '../search/tinyfish.ts'
import { companyKey } from '../scan/evidence.ts'
import { placeAgreement } from '../scan/place-agreement.ts'
import { parseProfileHit, peopleQuery } from './people-search.ts'
import { roleContradicted, titleMatches } from './rank.ts'

export const MAX_SEARCHES = 2
export const MAX_READS = 1
export const MAX_OUTPUT_TOKENS = 2000   // the answer is a few lines of JSON; the rest is room for the model's own thinking
const PAGE_TEXT = 6000
const PROMPT_BYTES = 60_000             // far below the 100K-token tier of the cheapest model
// Decision-maker titles accepted when the scan asked for no role, and always searched for next to the scan's roles.
export const DECISION_MAKERS = ['Founder', 'Co-founder', 'Owner', 'CEO', 'Chief Executive Officer', 'Managing Director', 'President', 'Principal', 'Partner', 'Director']
const PROFILE = /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/
const NOT_SHOWN = 'S?'   // never a real source id
const NAME = /^(?:(?:Dr|Mr|Ms|Mrs)\.?\s+)?[\p{Lu}][\p{L}'’-]{1,24}(?:\s+[\p{Lu}]\.?)?(?:\s+[\p{Lu}][\p{L}'’-]{1,24}){1,2}$/u

export interface ResearchInput { company: string; domain?: string | null; roles?: string[]; where?: string[] }
export interface Source { id: string; url: string; title: string; text: string; kind: 'search' | 'page' }
export interface ResearchPerson { name: string; title: string; linkedin: string | null; source_url: string; quote: string; place: 'agrees' | 'no_geography' | 'unconfirmed' }
export type ResearchStatus = 'found' | 'none' | 'not_grounded' | 'search_failed' | 'model_failed' | 'bad_input'
export interface ResearchResult {
  status: ResearchStatus
  person: ResearchPerson | null
  refused: string | null            // why the model's candidate was not kept (groundPerson), or why nothing ran
  linkedin_refused: string | null   // why a pointed-at profile was not kept (the person may still be kept without it)
  queries: string[]
  sources: { id: string; url: string; title: string; kind: 'search' | 'page' }[]
  usage: { searches: number; reads: number; model: string | null; input_tokens: number | null; output_tokens: number | null }
}
export interface ResearchDeps { db: DbLike; tenantId: string; provider: Provider; apiKey: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; signal?: AbortSignal }

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => tidy(s).toLowerCase().replace(/[’`]/g, "'")
const clean = (s: string, max: number) => tidy(s.replace(/["()]/g, ' ')).slice(0, max)
const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' } }
// The company's name is in the text as THAT company: its key (legal suffix removed) as whole words, and not as the start of a
// longer name ("Acme Dental" is not named by "Acme Dental Supplies": a capitalised word right after it makes it another business).
const LEGAL = /^(?:inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|gmbh|plc|pty|ag|sa|bv)\b/i
function namesCompany(text: string, company: string): boolean {
  const words = companyKey(company).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.join('').length < 3) return false
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]{1,3}')}(?![\\p{L}\\p{N}])`, 'giu')
  for (const m of text.matchAll(re)) {
    const after = text.slice(m.index + m[0].length).replace(/^[\s,.]*/, m2 => (/[,.]/.test(m2) ? '\u0000' : ' ')).trimStart()
    const next = /^([\p{L}][\p{L}'’-]*)/u.exec(after)?.[1] ?? ''
    if (!next || LEGAL.test(next) || !/^\p{Lu}/u.test(next)) return true
  }
  return false
}

// The two searches: public profiles for the company and its buyer roles (the existing people query), then the open web
// (a team / about page, a news story, a directory) for the company and who runs it.
export function researchQueries(input: ResearchInput): string[] {
  const company = clean(input.company, 80)
  if (company.length < 2) return []
  const roles = [...(input.roles ?? []).map(r => clean(r, 40)).filter(r => r.length >= 2), ...DECISION_MAKERS].filter((r, i, a) => a.findIndex(x => x.toLowerCase() === r.toLowerCase()) === i)
  const place = clean((input.where ?? [])[0] ?? '', 60)
  const out: string[] = []
  const q1 = peopleQuery(company, roles.slice(0, 3)); if (q1) out.push(q1)
  out.push(tidy(`"${company}" ${place} (${roles.slice(0, 4).map(r => `"${r}"`).join(' OR ')})`).slice(0, 300))
  return out.slice(0, MAX_SEARCHES)
}

export function researchPrompt(input: ResearchInput, sources: Source[]): string {
  const roles = (input.roles ?? []).filter(r => typeof r === 'string' && r.trim()).slice(0, 6)
  const head = [
    `Company: ${clean(input.company, 80)}${input.domain ? ` (website ${clean(input.domain, 80)})` : ''}${(input.where ?? []).length ? `, in ${clean((input.where ?? []).join('; '), 120)}` : ''}`,
    `We want the one person to contact there: ${roles.length ? `someone holding one of these roles now: ${roles.map(r => clean(r, 40)).join(', ')}. If none is shown, ` : ''}the owner, founder, CEO or managing director.`,
    'Below are numbered sources: web search results (title and snippet) and possibly one page. Use ONLY these sources. Do not use anything you remember about this company or person. If the sources do not name such a person at THIS company, answer {"person": null}.',
    'Rules: the name and the title must both appear in the source you cite, written as they appear there. Do not cite a source about a different company with a similar name. Do not cite a past role (former, ex-, previously). Give a LinkedIn source only if one of the sources IS that person\'s linkedin.com/in profile result; never write a URL yourself.',
    'Answer with ONLY this JSON, no other text:',
    '{"person": {"name": "<full name as written>", "title": "<title as written>", "source": "<source id, e.g. S3>", "quote": "<the exact words from that source that give the name and the title>", "linkedin_source": "<source id of their profile result, or null>"}}',
    '',
  ].join('\n')
  let body = ''
  for (const s of sources) {
    const block = `[${s.id}] ${s.kind === 'page' ? 'PAGE' : 'RESULT'} ${s.url}\n${s.title}\n${s.text}\n\n`
    if (Buffer.byteLength(head) + Buffer.byteLength(body) + Buffer.byteLength(block) > PROMPT_BYTES) break
    body += block
  }
  return head + body
}

// The model's answer, read strictly: one JSON object with a person object or null. Anything else is null.
export function readAnswer(text: string): { name: string; title: string; source: string; quote: string; linkedin_source: string | null } | null | 'unreadable' {
  const m = /\{[\s\S]*\}/.exec(text ?? '')
  if (!m) return 'unreadable'
  let j: unknown
  try { j = JSON.parse(m[0]) } catch { return 'unreadable' }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !('person' in j)) return 'unreadable'
  const p = (j as { person: unknown }).person
  if (p === null) return null
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'unreadable'
  const o = p as Record<string, unknown>
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? tidy(v) : null)
  const name = str(o.name, 80), title = str(o.title, 120), source = str(o.source, 8), quote = str(o.quote, 600)
  if (!name || !title || !source || !quote) return 'unreadable'
  // A profile pointer is a source id or nothing. Anything else (a URL the model wrote) is kept only as "pointed at something not shown".
  const ls = o.linkedin_source === null || o.linkedin_source === undefined || o.linkedin_source === '' || o.linkedin_source === 'null' ? null : typeof o.linkedin_source === 'string' && /^S\d{1,2}$/.test(o.linkedin_source.trim()) ? o.linkedin_source.trim() : NOT_SHOWN
  return { name, title, source, quote, linkedin_source: ls }
}

// Every field the model returned is checked against the sources it was shown. Returns the person, or the first check that failed.
export function groundPerson(answer: { name: string; title: string; source: string; quote: string; linkedin_source: string | null }, sources: Source[], input: ResearchInput): { person: ResearchPerson; linkedin_refused: string | null } | { refused: string } {
  const src = sources.find(s => s.id === answer.source)
  if (!src) return { refused: 'source_not_shown' }
  const text = `${src.title} ${src.text}`
  const hay = norm(text)
  if (!NAME.test(answer.name)) return { refused: 'not_a_full_name' }
  if (!hay.includes(norm(answer.quote))) return { refused: 'quote_not_in_source' }
  if (!hay.includes(norm(answer.name))) return { refused: 'name_not_in_source' }
  if (!hay.includes(norm(answer.title))) return { refused: 'title_not_in_source' }
  if (!norm(answer.quote).includes(norm(answer.name))) return { refused: 'quote_does_not_name_person' }
  if (answer.title.length < 2 || answer.title.length > 80) return { refused: 'title_unusable' }
  const roleText = [...(input.roles ?? []), ...DECISION_MAKERS].join('; ')
  if (roleContradicted(answer.title, roleText) || /\b(?:former|formerly|ex|previous|previously|past|retired)\b|\bex-/i.test(answer.quote)) return { refused: 'past_role' }
  if (titleMatches(answer.title, roleText).length === 0) return { refused: 'not_a_buyer_role' }
  // The source is about THIS company: its own site, a profile result whose employer is the company, or text naming the company.
  const domain = (input.domain ?? '').toLowerCase().replace(/^www\./, '')
  const onOwnSite = !!domain && (hostOf(src.url) === domain || hostOf(src.url).endsWith(`.${domain}`))
  const isProfile = PROFILE.test(src.url.split('?')[0])
  if (isProfile) { if (!parseProfileHit({ url: src.url, title: src.title, snippet: src.text, date: null }, input.company) && !namesCompany(text, input.company)) return { refused: 'profile_of_another_employer' } }
  else if (!onOwnSite && !namesCompany(text, input.company)) return { refused: 'source_does_not_name_company' }
  const where = (input.where ?? []).filter(w => typeof w === 'string' && w.trim())
  const place = onOwnSite ? 'no_geography' as const : placeAgreement(text, where, input.company)
  if (place === 'mismatch') return { refused: 'another_place' }
  // LinkedIn: only a URL a search returned, whose own result line names this person at this company.
  let linkedin: string | null = null, linkedin_refused: string | null = null
  const lsrc = answer.linkedin_source ? sources.find(s => s.id === answer.linkedin_source) : isProfile ? src : null
  if (answer.linkedin_source && !lsrc) linkedin_refused = 'profile_source_not_shown'
  else if (lsrc) {
    const url = lsrc.url.split('?')[0]
    const first = norm(lsrc.title.split(/\s+[-–—|]\s+/)[0] ?? '')
    if (lsrc.kind !== 'search' || !PROFILE.test(url)) linkedin_refused = 'not_a_profile_result'
    else if (first !== norm(answer.name)) linkedin_refused = 'profile_names_someone_else'
    else if (!namesCompany(`${lsrc.title} ${lsrc.text}`, input.company)) linkedin_refused = 'profile_does_not_name_company'
    else linkedin = url
  }
  return { person: { name: answer.name, title: answer.title, linkedin, source_url: src.url, quote: answer.quote, place }, linkedin_refused }
}

export async function researchContact(input: ResearchInput, deps: ResearchDeps): Promise<ResearchResult> {
  const usage: ResearchResult['usage'] = { searches: 0, reads: 0, model: null, input_tokens: null, output_tokens: null }
  const base = (status: ResearchStatus, refused: string | null, extra: Partial<ResearchResult> = {}): ResearchResult => ({ status, person: null, refused, linkedin_refused: null, queries: [], sources: [], usage, ...extra })
  const queries = researchQueries(input)
  if (queries.length === 0) return base('bad_input', 'no_company')
  // Every model call here is on the account's spend limits; the provider handed in is the raw one.
  const provider = ownerGuarded(deps.db, deps.tenantId, deps.provider, deps.env)
  if (!provider.completeDetailed) return base('model_failed', 'no_model', { queries })
  const env = { ...(deps.env ?? process.env), TINYFISH_SEARCHES_PER_SCAN: String(MAX_SEARCHES), TINYFISH_FETCHES_PER_SCAN: String(MAX_READS) }
  const tf = { env, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.signal ? { signal: deps.signal } : {}) }
  const spent = { searches: 0, fetches: 0 }
  const hits: SearchHit[] = []; const seen = new Set<string>(); let failed: string | null = null
  for (const q of queries) {
    const r = await tfSearch(deps.db, deps.tenantId, q, {}, spent, tf)
    usage.searches++
    if (!r.ok) { failed = r.reason; if (r.reason === 'cap' || r.reason === 'quota' || r.reason === 'auth' || r.reason === 'disabled') break; continue }
    for (const h of r.hits) { const u = h.url.split('#')[0]; if (!seen.has(u)) { seen.add(u); hits.push(h) } }
  }
  if (hits.length === 0) return base(failed ? 'search_failed' : 'none', failed ?? 'no_results', { queries })
  const sources: Source[] = hits.slice(0, 20).map((h, i) => ({ id: `S${i + 1}`, url: h.url, title: tidy(h.title).slice(0, 200), text: tidy(h.snippet ?? '').slice(0, 400), kind: 'search' as const }))
  // One page read, only of the company's own site when a result is on its confirmed domain (a team / about page beats a snippet).
  const domain = (input.domain ?? '').toLowerCase().replace(/^www\./, '')
  const own = domain ? sources.find(s => { const h = hostOf(s.url); return h === domain || h.endsWith(`.${domain}`) }) : undefined
  if (own) {
    const r = await tfFetch(deps.db, deps.tenantId, [own.url], spent, tf)
    usage.reads++
    if (r.ok && r.pages[0]) { const text = tidy(markdownToText(r.pages[0].text ?? '')).slice(0, PAGE_TEXT); if (text.length >= 80) sources.push({ id: `S${sources.length + 1}`, url: own.url, title: tidy(r.pages[0].title ?? own.title).slice(0, 200), text, kind: 'page' }) }
  }
  const listed = sources.map(s => ({ id: s.id, url: s.url, title: s.title, kind: s.kind }))
  // One model call, no retry (a retried paid call could be billed twice). A spend refusal propagates to the caller.
  const det = await provider.completeDetailed(deps.apiKey, researchPrompt(input, sources), deps.fetchImpl, MAX_OUTPUT_TOKENS)
  usage.model = det.model ?? provider.configuredModel?.() ?? null
  usage.input_tokens = det.usage?.input_tokens ?? null; usage.output_tokens = det.usage?.output_tokens ?? null
  const answer = readAnswer(det.text)
  if (answer === 'unreadable') return base('model_failed', det.stop === 'max_tokens' ? 'answer_cut_off' : 'answer_unreadable', { queries, sources: listed })
  if (answer === null) return base('none', 'model_found_nobody', { queries, sources: listed })
  const g = groundPerson(answer, sources, input)
  if ('refused' in g) return base('not_grounded', g.refused, { queries, sources: listed })
  return { status: 'found', person: g.person, refused: null, linkedin_refused: g.linkedin_refused, queries, sources: listed, usage }
}

// The model the lookup asks for first. The deployment's own model is the fallback when it finds nobody.
export const CONTACT_RESEARCH_MODEL = 'claude-haiku-5-5'
// What the model call cost at the vendor's LISTED price (USD per 1M tokens, for prompts under 100K tokens), for reporting a
// benchmark in cents. The spend guards price Haiku higher on purpose (lib/llm/spend-guard.ts); this is not what they reserve.
const LISTED_USD_PER_M: Record<string, { in: number; out: number }> = { 'claude-haiku-5-5': { in: 0.1, out: 0.5 }, 'claude-sonnet-4-5': { in: 3, out: 15 } }
export function listedCostUsd(usage: ResearchResult['usage']): number | null {
  const m = typeof usage?.model === 'string' ? usage.model.replace(/-\d{8}$/, '') : ''
  const p = Object.hasOwn(LISTED_USD_PER_M, m) ? LISTED_USD_PER_M[m] : null
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!p || !ok(usage.input_tokens) || !ok(usage.output_tokens)) return null
  return (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6
}

// A request body for one lookup, read strictly: anything malformed is null (nothing runs).
export function readResearchInput(body: unknown): { input: ResearchInput; model: 'haiku' | 'default' } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  const company = typeof o.company === 'string' ? tidy(o.company) : ''
  if (company.length < 2 || company.length > 80) return null
  const list = (v: unknown, n: number, max: number): string[] | null => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.length > n) return null
    const out: string[] = []
    for (const x of v) { if (typeof x !== 'string') return null; const t = tidy(x); if (t.length < 2 || t.length > max) return null; out.push(t) }
    return out
  }
  const roles = list(o.roles, 6, 40), where = list(o.where, 3, 60)
  if (!roles || !where) return null
  let domain: string | null = null
  if (o.domain !== undefined && o.domain !== null) {
    if (typeof o.domain !== 'string' || !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(o.domain.toLowerCase())) return null
    domain = o.domain.toLowerCase()
  }
  if (o.model !== undefined && o.model !== 'haiku' && o.model !== 'default') return null
  return { input: { company, domain, roles, where }, model: o.model === 'default' ? 'default' : 'haiku' }
}
