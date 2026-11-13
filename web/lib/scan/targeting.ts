// #380: the request compiled into an explicit, typed targeting plan (AND / OR / NOT over named conditions, each with its own
// clock), instead of flat signal/criteria arrays. Deterministic: read from the user's OWN request text, never from model output,
// so a model can neither widen nor drop a condition. Pure (no db, no network): held-state.ts reaches this from the browser bundle.
//
// Rules the compiler keeps:
//   - Only words the request states become conditions. Nothing is added, nothing is relaxed into a preference.
//   - An ambiguous request is never read broadly: mixed and/or without grouping, "and/or", a negation whose scope is unclear and
//     two different windows for an undated condition all take the NARROWEST reading, and the ambiguity is recorded on the plan
//     (both readings and the one chosen) so the person can see it and rephrase.
//   - Exclusions the request states (excluding competitors, except Acme, other than franchises) are HARD NOT conditions.
//   - Each condition keeps its own window ("seed within 90 days AND first VP hired within 30 days" are two clocks), or a window
//     relative to another condition's event ("within 30 days of the raise"). Every window the request binds to a condition counts
//     (#878): a second, narrower one ("within 90 days, specifically within 30 days") is never dropped, whichever comes first.
// Place, industry, size and buyer role stay with the gates that already enforce them (the verifier's place check, the ICP grade);
// they are listed on the plan as filters with the gate that owns them, not re-judged here.

import { TECH_WORDS, techNameOf } from '../connectors/techstack.ts'
import { NOUN_FIRST_OPEN_SRC, nounFirstOk } from '../search/page-class.ts'

export type Truth = 'pass' | 'fail' | 'unknown'
export type CondKind = 'funding' | 'hiring' | 'hire_made' | 'event' | 'competitor' | 'company_named' | 'category' | 'tech'
export interface Condition {
  id: string
  kind: CondKind
  text: string                       // the request's own words for this condition
  stage?: string                     // funding: 'pre-seed' | 'seed' | 'series a' ...
  role?: string                      // hiring / hire_made: the role words ('' = any role)
  first?: boolean                    // hire_made: the request says first / founding
  event?: string                     // event: family (open, launch, expand, acquire, relocate, contract, permit, partner, rebrand)
  object?: string                    // event: the object the request names (location, office, website ...), '' = any
  names?: string[]                   // company_named: the names to exclude; category: the category word
  tech?: string                      // tech (#389): the canonical name of a technology the site crawl can detect
  change?: 'uses' | 'adopted' | 'removed'   // tech: a current state, or a dated change between comparable observations
  within_days: number | null         // this condition's own clock; null = no window stated
  window_source: 'clause' | 'request' | 'narrowest' | 'default' | null
  relative_to?: string               // the window counts from this condition's event date (event relationship), not from now
  since_days?: number                // relative_to only: the clock counted back from NOW (default within_days); a stated "in the last N days" can only narrow it
  clock_conflict?: string            // the request states clocks for this condition that one condition cannot hold (two different anchor events): never provable
}
export type PlanNode = { op: 'cond'; cond: Condition } | { op: 'and' | 'or'; of: PlanNode[] } | { op: 'not'; of: PlanNode }
export interface Ambiguity { text: string; readings: string[]; chosen: string }
export interface PlanFilter { kind: 'where' | 'industry' | 'size' | 'who'; values: string[]; semantics: string; enforced_by: string }
export interface QueryPlan {
  v: 1
  root: PlanNode | null              // null: the request states no trigger or exclusion this compiler can read
  filters: PlanFilter[]
  ambiguities: Ambiguity[]
  explicit: boolean                  // the plan says more than one flat signal: two or more conditions, a NOT, an exclusion, a completed hire or separate clocks
}

const UNIT: Record<string, number> = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30 }
const WINDOW_RE = /\b(?:(?:within|in|over|during)\s+)?(?:the\s+)?(?:past|last|previous)\s+(\d{1,3})\s+(days?|weeks?|months?)\b|\bwithin\s+(?:the\s+)?(\d{1,3})\s+(days?|weeks?|months?)(?:\s+(?:of|after|since|following)\s+(?:the|its|their|a|an)?\s*([a-z-]+))?|\b(\d{1,3})\s+(days?|weeks?|months?)\s+ago\b/gi
const FUNDING_CUE = /\b(?:fund(?:ing|ed|s)?|rais(?:e|ed|es|ing)|round|invest(?:ed|ment|ors?)|backed|venture|vc|startups?)\b/i
const STAGE = '(?:pre-?seed|seed|series\\s+[a-e])'
const RAISE = '(?:raised|closed|secured|announced|landed|completed|received)'

interface Atom { kind: Exclude<CondKind, 'competitor' | 'company_named' | 'category'>; start: number; end: number; stage?: string; role?: string; first?: boolean; event?: string; object?: string; tech?: string; change?: 'uses' | 'adopted' | 'removed'; neg?: boolean }

// #389: technology conditions, only for technologies the site crawl can detect (techstack.ts). A technology word becomes a condition only
// after a technology cue ("using", "built on", "migrated from", "switched to" ...) or before a platform noun ("Shopify stores"); words
// that are also plain English (Ghost, Segment, Bootstrap, Stripe, Framer) need a strong cue, never a bare "on"/"with" or a noun after them.
const TECH = `(?:${TECH_WORDS.map(w => w.re).join('|')})`
const AMBIGUOUS_TECH = new Set(['Ghost', 'Segment', 'Bootstrap', 'Stripe', 'Framer'])
function techAtoms(q: string, add: (a: Atom) => void): void {
  const name = (w: string) => techNameOf(w)
  // Removal, optionally with the adoption it was a move to: "migrated from WordPress to Webflow", "moved off HubSpot".
  for (const m of q.matchAll(new RegExp(`\\b(?:migrat\\w*|mov(?:e|ed|es|ing)|switch\\w*|transition\\w*|chang\\w*)\\s+(?:away\\s+)?(?:from|off(?:\\s+of)?)\\s+(${TECH})\\b(?:\\s+(?:to|onto|for)\\s+(${TECH})\\b)?`, 'gi'))) {
    const from = name(m[1]); if (!from) continue
    const s = m.index ?? 0, e1 = s + m[0].indexOf(m[1]) + m[1].length
    add({ kind: 'tech', start: s, end: e1, tech: from, change: 'removed' })
    const to = m[2] ? name(m[2]) : null
    const tail = m[0].slice(e1 - s), at = e1 + tail.length - tail.trimStart().length
    if (to && m[2]) add({ kind: 'tech', start: at, end: s + m[0].length, tech: to, change: 'adopted' })
  }
  for (const m of q.matchAll(new RegExp(`\\b(?:dropp\\w*|remov\\w*|ditch\\w*|abandon\\w*|stopp?\\w*\\s+using|churn\\w*\\s+(?:from|off))\\s+(${TECH})\\b`, 'gi'))) {
    const t = name(m[1]); if (t) add({ kind: 'tech', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, tech: t, change: 'removed' })
  }
  // Adoption: "switched to Webflow", "adopted Intercom", "started using HubSpot".
  for (const m of q.matchAll(new RegExp(`\\b(?:(?:migrat\\w*|mov(?:e|ed|es|ing)|switch\\w*|transition\\w*)\\s+(?:over\\s+)?(?:to|onto)|adopt\\w*|install\\w*|implement\\w*|(?:start(?:ed|s|ing)?|began|begun)\\s+using|roll\\w*\\s+out)\\s+(${TECH})\\b`, 'gi'))) {
    const t = name(m[1]); if (t) add({ kind: 'tech', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, tech: t, change: 'adopted' })
  }
  // Current use. "without X" / "don't use X" carry their own negation (the shared negation reader looks only BEFORE a condition).
  for (const m of q.matchAll(new RegExp(`\\b(?:(without|(?:don'?t|doesn'?t|do\\s+not|does\\s+not)\\s+use)|using|uses|use|built\\s+(?:on|with)|running(?:\\s+on)?|runs\\s+on|run\\s+on|powered\\s+by|hosted\\s+on|(on|with))\\s+(${TECH})\\b`, 'gi'))) {
    const t = name(m[3]); if (!t || (m[2] && AMBIGUOUS_TECH.has(t))) continue
    // A self-negated phrase keeps only the technology as its text, so the plan reads "NOT C1 HubSpot", never a double negative.
    const end = (m.index ?? 0) + m[0].length
    add({ kind: 'tech', start: m[1] ? end - m[3].length : m.index ?? 0, end, tech: t, change: 'uses', ...(m[1] ? { neg: true } : {}) })
  }
  for (const m of q.matchAll(new RegExp(`\\b(${TECH})\\s+(?:stores?|shops?|sites?|websites?|merchants?|brands?|sellers?|customers?|users?)\\b`, 'gi'))) {
    const t = name(m[1]); if (t && !AMBIGUOUS_TECH.has(t)) add({ kind: 'tech', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, tech: t, change: 'uses' })
  }
}

// object: the capture group(s) naming the event's object; with several, the first one the match filled.
// #878 (staging, 2026-11-12): openings are as often worded noun-first, as social posts and local press write them
// ("New dental clinic now open in Parkdale", "our 5th location is officially open", "Grand opening of our new clinic"),
// as verb-first ("opened a new location"). The noun-first forms are the strict shared pattern in page-class.ts
// (NOUN_FIRST_OPEN_SRC: never hours, availability, a future or someone else's opening).
// ok: an extra check a match must pass (the noun-first opening's allow-list, page-class.ts nounFirstOk); a verb-first
// match (group 1) is not subject to it.
const EVENTS: { event: string; re: RegExp; object?: number | number[]; ok?: (text: string, m: RegExpMatchArray, company?: string | null) => boolean }[] = [
  { event: 'open', re: new RegExp(String.raw`\b(?:opened|opening|opens|open)\s+(?:(?:a|an|its|their|new|second|third|fourth|fifth|\d+(?:st|nd|rd|th)|another|additional)\s+)+(locations?|offices?|clinics?|stores?|branch(?:es)?|sites?|restaurants?|studios?|practices?|warehouses?|factor(?:y|ies)|hq|headquarters|showrooms?|shops?|gyms?|salons?)\b` + '|' + NOUN_FIRST_OPEN_SRC, 'gi'), object: [1, 2, 3], ok: (text, m, company) => !!m[1] || nounFirstOk(text, m, company) },
  { event: 'launch', re: /\b(?:launched|launching|launches|released|unveiled)\s+(?:(?:a|an|its|their|new|first)\s+)*([a-z][\w-]*)/gi, object: 1 },
  { event: 'expand', re: /\b(?:expanded|expanding|expands|expansion)(?:\s+(?:into|to|in)\s+([a-z][\w-]*))?/gi, object: 1 },
  { event: 'acquire', re: /\b(?:acquired|acquires|acquisitions?|merged|merger)\b/gi },
  { event: 'relocate', re: /\b(?:moved|relocated|relocating)\s+(?:to|into|its|their)\b/gi },
  { event: 'contract', re: /\b(?:won|awarded|secured)\s+(?:a\s+|an\s+)?(?:[a-z-]+\s+)?(contracts?|tenders?|grants?)\b/gi, object: 1 },
  { event: 'permit', re: /\b(?:filed|got|received|obtained|applied\s+for)\s+(?:a\s+|an\s+)?(?:[a-z-]+\s+)?(permits?|licen[cs]es?)\b/gi, object: 1 },
  { event: 'partner', re: /\b(?:partnered|partnership)\b/gi },
  { event: 'rebrand', re: /\brebrand(?:ed|ing)?\b/gi },
]
const ROLE_WORD = /\b(?:vp|vice\s+president|head|director|chief|c[a-z]o|manager|lead|executive|officer|president|engineer|reps?|representatives?|aes?|sdrs?|bdrs?|staff|team|marketer|seller|salespeople|salesperson|account\s+executives?)\b/i
const STOP = /\s+(?:within|in\s+the|in|over|during|this|last|recently|and|or|but|while|who|that|which|excluding|except|other\s+than|with|at|from|to)\b|[,.;:!?()]/i
// #876: "made their first sales hire" / "has made a founding engineering hire": a completed hire, in the request's own words.
const MADE_HIRE = /\bmade\s+(?:(?:a|an|its|their|the|our)\s+)?((?:first|founding|inaugural|new)\s+)?([a-z][a-z-]*)\s+hires?\b/gi
const HIRE_QUALIFIER = /^(?:first|founding|inaugural|new)$/i
const FIRST_WORD = /^(?:first|founding|inaugural)$/i
// #876: a modal in front of the completed verb ("may have made", "will have hired", "might have just made") says the hire may not have happened.
// That is no completed-hire condition: the span is left unread (no hire_made, no open role) and compileTargeting records the ambiguity.
const MODAL_HAVE = /\b(?:will|would|could|can|may|might|should|must)\s+(?:not\s+)?have\s+(?:(?:already|just|recently|probably|possibly|likely)\s+)*$/i
const MODAL_WORD = /\b(?:will|would|could|can|may|might|should|must)\b/i
const cleanRole = (s: string) => s.split(STOP)[0].replace(/^(?:(?:a|an|the|its|their|our|first|new|founding|inaugural|for)\s+)+/i, '').trim()

function findAtoms(q: string): Atom[] {
  const atoms: Atom[] = []
  const add = (a: Atom) => { if (!atoms.some(b => a.start < b.end && b.start < a.end)) atoms.push(a) }   // first (higher-priority) reading of a span wins
  // 0. Technologies (#389) first: a technology phrase wins its span over a looser event reading ("launched on Shopify").
  techAtoms(q, add)
  // 1. A completed hire ("hired their first VP of Sales", "first VP hired"): a fact in the past, never an open role.
  for (const m of q.matchAll(/\b(?:hired|appointed|named|brought\s+on|onboarded|welcomed)\s+((?:(?:a|an|its|their|the)\s+)?((?:first|founding|inaugural|new)\s+)?[a-z][a-z&\s-]{1,60})/gi)) {
    const role = cleanRole(m[1]); if (!ROLE_WORD.test(role) || MODAL_HAVE.test(q.slice(0, m.index ?? 0))) continue
    const end = (m.index ?? 0) + m[0].indexOf(m[1]) + m[1].indexOf(role) + role.length
    add({ kind: 'hire_made', start: m.index ?? 0, end, role, first: /\b(?:first|founding|inaugural)\b/i.test(m[1].slice(0, m[1].indexOf(role) + 1)) })
  }
  for (const m of q.matchAll(/\b(first|founding|new)\s+([a-z][a-z&\s-]{1,40}?)\s+(?:(?:was|were|has\s+been|have\s+been|recently|just)\s+)?(?:hired|appointed|joined|named|brought\s+on)\b/gi)) {
    if (!ROLE_WORD.test(m[2]) || MODAL_WORD.test(m[0])) continue
    add({ kind: 'hire_made', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, role: m[2].trim(), first: /first|founding/i.test(m[1]) })
  }
  // #876: "made their first sales hire" states the same completed fact in other words - a hire in the past, never an open role. Only the past
  // tense "made" reads so: "making / make / makes their first sales hire" states no completed hire and stays an open-role condition (step 3).
  // A qualifier the role slot catches by itself ("made a new hire") is no role: any role, with `first` only when the request says first.
  for (const m of q.matchAll(MADE_HIRE)) {
    if (MODAL_HAVE.test(q.slice(0, m.index ?? 0))) continue
    const q1 = (m[1] ?? '').trim(), word = m[2]
    const role = HIRE_QUALIFIER.test(word) ? '' : word
    add({ kind: 'hire_made', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, role, first: FIRST_WORD.test(q1) || (!role && FIRST_WORD.test(word)) })
  }
  // 2. Funding. A bare "seed" is a stage only in a funding context ("seed oil producers" is not).
  const fundingContext = FUNDING_CUE.test(q) || /\bseries\s+[a-e]\b|\bpre-?seed\b/i.test(q)
  const fundingRes = [new RegExp(`\\b${RAISE}\\b(?:\\s+[^\\s,.;]+){0,5}?\\s+(?:${STAGE}(?:[-\\s]+(?:funding|round|financing))?|funding|round|financing|investment)\\b`, 'gi'),
    new RegExp(`\\b${STAGE}(?:[-\\s]+(?:funded|funding|round|rounds|stage|backed))?\\b`, 'gi'), /\b(?:recently\s+)?(?:vc-?|venture-?)?(?:funded|backed)\b|\bfund(?:ing|raising)\b|\braised\s+money\b/gi]
  for (const re of fundingRes) for (const m of q.matchAll(re)) {
    if (!fundingContext) break
    const st = new RegExp(STAGE, 'i').exec(m[0])
    const start = m.index ?? 0, end = start + m[0].length
    const near = atoms.find(b => b.kind === 'funding' && start <= b.end + 2 && b.start <= end + 2)
    if (near) { near.start = Math.min(near.start, start); near.end = Math.max(near.end, end); if (st && !near.stage) near.stage = st[0].toLowerCase().replace(/\s+/g, ' ').replace('preseed', 'pre-seed'); continue }
    add({ kind: 'funding', start, end, ...(st ? { stage: st[0].toLowerCase().replace(/\s+/g, ' ').replace('preseed', 'pre-seed') } : {}) })
  }
  // 3. Open roles ("hiring account executives", "posted a job for a receptionist").
  for (const m of q.matchAll(/\b(?:hiring|recruiting)(?:\s+for)?\b([^.;!?]*)/gi)) {
    const role = cleanRole(m[1])
    add({ kind: 'hiring', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length - m[1].length + (role ? m[1].indexOf(role) + role.length : 0), role })
  }
  for (const m of q.matchAll(/\b(?:posted|posting|advertis\w+|open)\s+(?:a\s+|an\s+|new\s+)?(?:jobs?|roles?|positions?|vacanc(?:y|ies)|openings?)(?:\s+for\s+([^,.;]+))?/gi)) {
    const role = m[1] ? cleanRole(m[1]) : ''
    add({ kind: 'hiring', start: m.index ?? 0, end: (m.index ?? 0) + (m[1] ? m[0].length - m[1].length + m[1].indexOf(role) + role.length : m[0].length), role })
  }
  // "making / make / makes their first sales hire": the request states no completed hire, so it is the open-role condition its role names (proven
  // like any open role: a dated posting or a source naming it). The past tense ("made their first sales hire") is a completed hire: step 1 (#876).
  for (const m of q.matchAll(/\b(?:making|makes|make)\s+(?:(?:a|an|its|their|the|our)\s+)?(?:(?:first|founding|new)\s+)?([a-z][a-z-]*)\s+hires?\b/gi)) {
    add({ kind: 'hiring', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, role: HIRE_QUALIFIER.test(m[1]) ? '' : m[1] })
  }
  // 4. Other events.
  for (const e of EVENTS) for (const m of q.matchAll(e.re)) if (!e.ok || e.ok(q, m)) add({ kind: 'event', start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, event: e.event, object: objectOf(e, m) })
  return atoms.sort((a, b) => a.start - b.start)
}

// Words before a condition that negate it. A stated exclusion cue counts too ("excluding companies that raised a Series B").
const NEG_BEFORE = /\b(?:not|never|no|without|haven'?t|hasn'?t|have\s+not|has\s+not|didn'?t|did\s+not|yet\s+to|no\s+longer|excluding|exclude|except|other\s+than|but\s+not|neither|nor)\b(?:\s+(?:been|be|yet|that|which|who|have|has|had|are|is|any|a|an|the|companies|startups|firms|businesses|currently|recently|actively))*\s*$/i
const EXCL_CUE = /\b(?:excluding|exclude|excludes|except(?:\s+for)?|other\s+than|not\s+including|but\s+not|apart\s+from)\s+/gi
const COMPETITOR = /\b(?:competitors?|rivals?|competing\s+(?:companies|vendors|products|firms))\b/i
const CATEGORY_WORDS = /\b(?:franchis\w*|agenc(?:y|ies)|consultanc(?:y|ies)|consultants?|resellers?|marketplaces?|directories|directory|recruiters?|staffing|non-?profits?|charit(?:y|ies)|government|public\s+sector|enterprises?|chains?|startups?|universit(?:y|ies)|schools?|hospitals?)\b/i

export function compileTargeting(query: string | null | undefined, icp?: string | null): QueryPlan {
  const q = (query ?? '').replace(/\s+/g, ' ').trim()
  const ambiguities: Ambiguity[] = []
  const atoms = findAtoms(q)
  // #876: a modal completed hire ("may have made their first sales hire") compiles to no condition (findAtoms); the plan says why.
  for (const m of q.matchAll(/\b(?:will|would|could|can|may|might|should|must)\s+(?:not\s+)?have\s+(?:(?:already|just|recently|probably|possibly|likely)\s+)*(?:made\s+(?:(?:a|an|its|their|the|our)\s+)?(?:[a-z][a-z-]*\s+){0,2}hires?|hired|appointed|named|brought\s+on|onboarded|welcomed)\b/gi))
    ambiguities.push({ text: m[0], readings: ['a completed hire', 'a hire that may not have happened'], chosen: 'no completed-hire condition: the request does not say the hire happened, so nothing is proven by it' })
  // Windows, each bound to the condition it follows in the text (or to every condition when it comes first).
  const windows: { at: number; end: number; days: number; text: string; anchorWord?: string }[] = []
  for (const m of q.matchAll(WINDOW_RE)) {
    const n = Number(m[1] ?? m[3] ?? m[6]), u = (m[2] ?? m[4] ?? m[7]).toLowerCase()
    windows.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, days: Math.min(365, Math.max(1, n * UNIT[u])), text: m[0].trim(), ...(m[5] ? { anchorWord: m[5].toLowerCase() } : {}) })
  }
  const owner = (w: { at: number }) => { let k = -1; for (let i = 0; i < atoms.length; i++) if (atoms[i].start < w.at) k = i; return k }
  const conds: Condition[] = atoms.map((a, i) => ({ id: `C${i + 1}`, kind: a.kind, text: q.slice(a.start, a.end), within_days: null, window_source: null,
    ...(a.stage ? { stage: a.stage } : {}), ...(a.kind === 'hiring' || a.kind === 'hire_made' ? { role: a.role ?? '' } : {}), ...(a.kind === 'hire_made' ? { first: !!a.first } : {}), ...(a.kind === 'event' ? { event: a.event, object: a.object ?? '' } : {}), ...(a.kind === 'tech' ? { tech: a.tech, change: a.change } : {}) }))
  const requestLevel: number[] = []
  // #878: EVERY window bound to a condition counts, not only the first. A clock counted from now and one counted from another condition's
  // event are different clocks and both hold; two different windows of the same kind take the NARROWEST and the ambiguity is recorded.
  const bound = conds.map(() => ({ now: [] as number[], rel: [] as { days: number; anchor: string }[], end: -1 }))
  for (const w of windows) {
    const k = owner(w)
    if (k < 0) { requestLevel.push(w.days); continue }
    const b = bound[k]
    b.end = Math.max(b.end, w.end)
    let anchor: Condition | undefined
    if (w.anchorWord) {
      anchor = conds.find((x, j) => j !== k && (x.kind === 'funding' && /^(?:raise|round|funding|seed|financing|investment)$/.test(w.anchorWord!) || x.kind === 'event' && x.event && w.anchorWord!.startsWith(x.event.slice(0, 4))))
      if (!anchor) ambiguities.push({ text: w.text, readings: [`${w.days} days after an event the request does not name as a condition`, `within the last ${w.days} days`], chosen: `within the last ${w.days} days` })
    }
    if (anchor) b.rel.push({ days: w.days, anchor: anchor.id }); else b.now.push(w.days)
  }
  const narrowest = (c: Condition, days: number[], what: string): number => {
    const d = [...new Set(days)]
    if (d.length > 1) {
      c.window_source = 'narrowest'
      ambiguities.push({ text: c.text, readings: d.map(x => `within ${x} days${what}`), chosen: `within ${Math.min(...d)} days${what} (the narrowest window the request states for this condition)` })
    }
    return Math.min(...d)
  }
  for (const [k, c] of conds.entries()) {
    const b = bound[k]
    if (b.end < 0) continue
    c.text = q.slice(atoms[k].start, Math.max(atoms[k].end, b.end)); c.window_source = 'clause'
    // A request-level window ("In the last 30 days, ...") also bounds a condition that states its own: the narrower one holds.
    const now = b.now.length ? [...b.now, ...requestLevel] : []
    const anchors = [...new Set(b.rel.map(r => r.anchor))]
    if (anchors.length > 1) {
      c.within_days = Math.min(...b.rel.map(r => r.days)); c.window_source = 'narrowest'
      c.clock_conflict = `the request counts this condition's clock from ${anchors.join(' and from ')}; one condition cannot be checked against two anchor events`
      ambiguities.push({ text: c.text, readings: anchors.map(a => `within ${Math.min(...b.rel.filter(r => r.anchor === a).map(r => r.days))} days of ${a}`), chosen: 'neither: the condition stays unproven until the request names one anchor' })
    } else if (anchors.length === 1) {
      c.relative_to = anchors[0]
      c.within_days = narrowest(c, b.rel.map(r => r.days), ` of ${anchors[0]}`)
      // Counted back from now, a relative condition keeps its own window as before (never wider); a stated now-window can only narrow it.
      // A request-level window bounds it too, as it bounds every other condition.
      const back = b.now.length ? narrowest(c, now, '') : requestLevel.length ? narrowest(c, requestLevel, '') : null
      if (back !== null && back < c.within_days) c.since_days = back
    } else c.within_days = narrowest(c, now, '')
  }
  const distinct = [...new Set([...requestLevel, ...conds.filter((c, i) => bound[i].now.length > 0 && !c.relative_to && !c.clock_conflict).map(c => c.within_days!)])]
  for (const c of conds) {
    if (c.within_days !== null) continue
    if (distinct.length === 1) { c.within_days = distinct[0]; c.window_source = 'request' }
    else if (distinct.length > 1) {
      c.within_days = Math.min(...distinct); c.window_source = 'narrowest'
      ambiguities.push({ text: c.text, readings: distinct.map(d => `within ${d} days`), chosen: `within ${c.within_days} days (the narrowest window the request states)` })
    } else if (c.kind === 'hiring' || c.kind === 'hire_made') { c.within_days = 90; c.window_source = 'default' }   // the same 90-day default the sales-hiring gate applies
  }
  // Negation, then the connective between each pair of neighbouring conditions.
  const negated = atoms.map((a, i) => !!a.neg || NEG_BEFORE.test(q.slice(i === 0 ? Math.max(0, a.start - 40) : Math.max(atoms[i - 1].end, a.start - 40), a.start)))
  const gaps = atoms.slice(1).map((a, i) => q.slice(atoms[i].end, a.start))
  const conn: ('and' | 'or')[] = gaps.map((g, i) => {
    const t = g.replace(WINDOW_RE, ' ')
    if (/\band\s*\/\s*or\b/i.test(t)) { ambiguities.push({ text: `${conds[i].text} and/or ${conds[i + 1].text}`, readings: ['either condition', 'both conditions'], chosen: 'both conditions (and)' }); return 'and' }
    if (/\bnor\b/i.test(t)) return 'and'
    return /\bor\b|\beither\b/i.test(t) ? 'or' : 'and'
  })
  // "not funded or hiring": (not A) or B, or neither? The narrower reading is neither.
  for (let i = 0; i < conn.length; i++) if (negated[i] && !negated[i + 1] && conn[i] === 'or') {
    ambiguities.push({ text: q.slice(atoms[i].start, atoms[i + 1].end), readings: [`(not ${conds[i].text}) or ${conds[i + 1].text}`, `neither ${conds[i].text} nor ${conds[i + 1].text}`], chosen: `neither ${conds[i].text} nor ${conds[i + 1].text}` })
    negated[i + 1] = true; conn[i] = 'and'
  }
  for (let i = 0; i < conn.length; i++) if (negated[i] && /\bneither\b/i.test(q.slice(Math.max(0, atoms[i].start - 40), atoms[i].start))) { negated[i + 1] = true; conn[i] = 'and' }
  const leaf = (i: number): PlanNode => negated[i] ? { op: 'not', of: { op: 'cond', cond: conds[i] } } : { op: 'cond', cond: conds[i] }
  let trigger: PlanNode | null = null
  if (conds.length === 1) trigger = leaf(0)
  else if (conds.length > 1) {
    const all = (op: 'and' | 'or'): PlanNode => ({ op, of: conds.map((_, i) => leaf(i)) })
    if (conn.every(c => c === 'and')) trigger = all('and')
    else if (conn.every(c => c === 'or')) {
      trigger = all('or')
      if (/\bbut\s+not\s+both\b/i.test(q) && conds.length === 2) trigger = { op: 'and', of: [trigger, { op: 'not', of: { op: 'and', of: [leaf(0), leaf(1)] } }] }
    } else {
      // Mixed: grouped only when the request says so ("either A or B, and C"); otherwise every condition is required.
      const k = conds.findIndex((_, i) => /\beither\s*$/i.test(q.slice(i === 0 ? 0 : atoms[i - 1].end, atoms[i].start)))
      let r = k; while (r >= 0 && r < conn.length && conn[r] === 'or') r++
      const rest = conn.filter((_, i) => i < k || i >= r)
      if (k >= 0 && r > k && rest.every(c => c === 'and')) {
        const group: PlanNode = { op: 'or', of: conds.slice(k, r + 1).map((_, j) => leaf(k + j)) }
        trigger = { op: 'and', of: [...conds.slice(0, k).map((_, j) => leaf(j)), group, ...conds.slice(r + 1).map((_, j) => leaf(r + 1 + j))] }
      } else {
        ambiguities.push({ text: q.slice(atoms[0].start, atoms[atoms.length - 1].end), readings: ['(A or B) and C', 'A or (B and C)'], chosen: 'every condition required (and): the request mixes and/or without saying how they group' })
        trigger = all('and')
      }
    }
  }
  // Stated exclusions that are not trigger conditions: competitors, named companies, categories. Always hard NOTs.
  const exclusions: PlanNode[] = []
  let x = 0
  for (const m of q.matchAll(EXCL_CUE)) {
    const from = (m.index ?? 0) + m[0].length
    const tail = q.slice(from).split(/[.;!?]/)[0]
    for (const raw of tail.split(/,|\bor\b|\band\b|\bnor\b/i)) {
      const item = raw.trim().replace(/^(?:any|all|the|our|my|their|its)\s+/i, '')
      if (!item) continue
      const at = from + tail.indexOf(raw)
      if (atoms.some(a => a.start < at + raw.length && at < a.end)) continue   // a trigger condition: negated above
      const id = `X${++x}`
      if (COMPETITOR.test(item)) exclusions.push({ op: 'not', of: { op: 'cond', cond: { id, kind: 'competitor', text: item, within_days: null, window_source: null } } })
      else if (CATEGORY_WORDS.test(item) || /^[a-z]/.test(item)) { const w = (CATEGORY_WORDS.exec(item)?.[0] ?? item.split(/\s+/).pop() ?? item).toLowerCase(); exclusions.push({ op: 'not', of: { op: 'cond', cond: { id, kind: 'category', text: item, names: [w], within_days: null, window_source: null } } }) }
      else exclusions.push({ op: 'not', of: { op: 'cond', cond: { id, kind: 'company_named', text: item, names: [item], within_days: null, window_source: null } } })
    }
  }
  const parts = [...(trigger ? [trigger] : []), ...exclusions]
  const root: PlanNode | null = parts.length === 0 ? null : parts.length === 1 ? parts[0] : trigger?.op === 'and' ? { op: 'and', of: [...trigger.of, ...exclusions] } : { op: 'and', of: parts }
  // A technology condition (#389) is always an explicit filter: no other gate checks it.
  // #878: a condition whose clock the request states more than once ("within 90 days, specifically within 30 days") is a separate clock the
  // plan must hold: other gates read only the first window of the request.
  const explicit = conds.length >= 2 || exclusions.length > 0 || negated.some(Boolean) || conds.some(c => c.kind === 'hire_made' || c.kind === 'tech' || !!c.relative_to || c.window_source === 'narrowest' || c.since_days !== undefined || !!c.clock_conflict)
  return { v: 1, root, filters: filtersOf(icp), ambiguities, explicit }
}

function filtersOf(icp: string | null | undefined): PlanFilter[] {
  let j: Record<string, unknown> = {}
  try { j = icp ? JSON.parse(icp) as Record<string, unknown> : {} } catch { j = {} }
  const arr = (k: string) => Array.isArray(j[k]) ? (j[k] as unknown[]).filter((v): v is string => typeof v === 'string' && !!v.trim()) : []
  const out: PlanFilter[] = []
  const where = arr('where')
  if (where.length) out.push({ kind: 'where', values: where, semantics: `the company is in ${where.length > 1 ? 'any one of these places' : 'this place'}${typeof j.country === 'string' ? ` (search market ${j.country})` : ''}; the event quote must agree on the place`, enforced_by: 'source verifier place check and the event-place check (location_unconfirmed / location_mismatch)' })
  if (arr('industries').length) out.push({ kind: 'industry', values: arr('industries'), semantics: 'any one of these industries', enforced_by: 'ICP grade (a mismatch hides the lead; unknown never passes as a match)' })
  if (arr('sizes').length) out.push({ kind: 'size', values: arr('sizes'), semantics: 'any one of these sizes', enforced_by: 'ICP grade' })
  if (arr('who').length) out.push({ kind: 'who', values: arr('who'), semantics: 'the person to reach', enforced_by: 'ICP grade and contact role matching' })
  return out
}

// Every condition in the plan, in order, with whether it sits under a NOT (the direction it must hold in).
export function planConditions(root: PlanNode | null): { cond: Condition; negated: boolean }[] {
  const out: { cond: Condition; negated: boolean }[] = []
  const seen = new Set<string>()
  const walk = (n: PlanNode, neg: boolean) => {
    if (n.op === 'cond') { if (!seen.has(n.cond.id)) { seen.add(n.cond.id); out.push({ cond: n.cond, negated: neg }) } }
    else if (n.op === 'not') walk(n.of, !neg)
    else n.of.forEach(c => walk(c, neg))
  }
  if (root) walk(root, false)
  return out
}

// The clock a condition is checked on, when its own words do not already say it exactly (#878: a narrowed, relative or conflicting clock).
function clockText(c: Condition): string {
  if (c.clock_conflict) return ' (clock unresolved: two anchor events)'
  if (!c.within_days) return ''
  const since = c.since_days !== undefined ? `, and within the last ${c.since_days} days` : ''
  if (c.window_source === 'clause' && !since) return ''
  return c.relative_to ? ` (within ${c.within_days} days of ${c.relative_to}${since})` : ` (within ${c.within_days} days)`
}
// One line per condition for a card or a log: "C1 seed funding (within 90 days) AND C2 ...".
export function describePlan(n: PlanNode | null): string {
  if (!n) return '(no targeting conditions)'
  if (n.op === 'cond') return `${n.cond.id} ${n.cond.text}${clockText(n.cond)}`
  if (n.op === 'not') return `NOT ${describePlan(n.of)}`
  return `(${n.of.map(describePlan).join(n.op === 'and' ? ' AND ' : ' OR ')})`
}

// ---- Evaluation: three-valued, clause by clause. ----
// Each condition gets its own proof: 'pass' (a verified source shows it, inside its own clock), 'fail' (a verified fact rules it out) or 'unknown'
// (nothing proves either way). Unknown is never read as false: NOT unknown is unknown, and only a plan that evaluates to 'pass' qualifies a lead.
export interface ClauseProof { id: string; text: string; truth: Truth; negated: boolean; reason: string; source_url?: string; date?: string }
export function combine(op: 'and' | 'or', xs: Truth[]): Truth {
  if (op === 'and') return xs.includes('fail') ? 'fail' : xs.every(x => x === 'pass') ? 'pass' : 'unknown'
  return xs.includes('pass') ? 'pass' : xs.every(x => x === 'fail') ? 'fail' : 'unknown'
}
export const negate = (t: Truth): Truth => t === 'pass' ? 'fail' : t === 'fail' ? 'pass' : 'unknown'
export function evaluateNode(n: PlanNode | null, facts: Readonly<Record<string, Truth>>): Truth {
  if (!n) return 'pass'   // no conditions: nothing for this gate to hold; the other gates still apply
  if (n.op === 'cond') return facts[n.cond.id] ?? 'unknown'
  if (n.op === 'not') return negate(evaluateNode(n.of, facts))
  return combine(n.op, n.of.map(c => evaluateNode(c, facts)))
}
// The whole plan against per-condition proofs. `missing` lists, in order, every clause that is not yet in the direction the plan needs
// (a positive condition that is not 'pass', a negated one that is not 'fail'), so a held lead says exactly what is missing.
export function evaluatePlan(plan: QueryPlan, proofs: Readonly<Record<string, Omit<ClauseProof, 'id' | 'text' | 'negated'>>>): { truth: Truth; clauses: ClauseProof[]; missing: ClauseProof[] } {
  const facts: Record<string, Truth> = {}
  const clauses = planConditions(plan.root).map(({ cond, negated }) => {
    const p = proofs[cond.id] ?? { truth: 'unknown' as Truth, reason: 'no verified source checked for this condition' }
    facts[cond.id] = p.truth
    return { id: cond.id, text: cond.text, negated, ...p }
  })
  const truth = evaluateNode(plan.root, facts)
  return { truth, clauses, missing: truth === 'pass' ? [] : clauses.filter(c => c.truth !== (c.negated ? 'fail' : 'pass')) }
}

// Whether a text shows the event family (and object, when the request names one) a condition asks for: the same patterns the compiler reads.
export function eventMatches(event: string | undefined, object: string | undefined, text: string): boolean { return eventMatchIndex(event, object, text) >= 0 }
// The object an event match names (lower case, singular), from the first of the event's object groups that matched.
function objectOf(e: { event: string; object?: number | number[] }, m: RegExpMatchArray): string {
  const groups = e.object === undefined ? [] : Array.isArray(e.object) ? e.object : [e.object]
  const g = groups.map(i => m[i]).find(x => typeof x === 'string' && x !== '')
  if (!g) return ''
  // an opening's premises noun, singular: "offices" -> office, "branches" -> branch (only ch/sh/x/ss + es loses the e).
  // Every other event keeps main's stem exactly (review on #1130 at 89e021f3): "tomatoes" -> tomato, "services" -> servic.
  return e.event === 'open' ? g.toLowerCase().replace(/(?:(?<=ch|sh|x|ss)es|s)$/, '') : g.toLowerCase().replace(/(?:es|s)$/, '')
}
// The verb-first opening exactly as main read it before #878 (no ordinals, no noun-first forms, and a request for a new
// "location" met only by "location"): a match here keeps main's reading unchanged (review on #1130 at 77e509ac).
const MAIN_OPEN = /\b(?:opened|opening|opens|open)\s+(?:(?:a|an|its|their|new|second|third|another|additional)\s+)+(locations?|offices?|clinics?|stores?|branch(?:es)?|sites?|restaurants?|studios?|practices?|warehouses?|factor(?:y|ies)|hq|headquarters|showrooms?|shops?|gyms?|salons?)\b/gi
export function mainOpenMatches(object: string | undefined, text: string): boolean {
  for (const m of text.matchAll(new RegExp(MAIN_OPEN.source, 'gi'))) if (!object || (m[1] ?? '').toLowerCase().replace(/(?:es|s)$/, '') === object) return true
  return false
}
// Where in the text the event (and object) first shows ([start, end]), or null.
// company: the lead, so a noun-first opening is read with the same company-aware allow-list as the sales-hiring gate.
export function eventMatchSpan(event: string | undefined, object: string | undefined, text: string, company?: string | null): [number, number] | null {
  const e = EVENTS.find(x => x.event === event)
  if (!e) return null
  for (const m of text.matchAll(new RegExp(e.re.source, 'gi'))) {
    if (e.ok && !e.ok(text, m, company)) continue
    const span: [number, number] = [m.index ?? 0, (m.index ?? 0) + m[0].length]
    if (!object || !e.object) return span
    const got = objectOf(e, m)
    // a request for a new "location" is met by any new premises (a clinic, an office, a store ...); a named kind needs that kind
    if (got === object || (object === 'location' && e.event === 'open' && got !== '')) return span
  }
  return null
}
// Where in the text the event (and object) first shows, or -1.
export function eventMatchIndex(event: string | undefined, object: string | undefined, text: string): number { return eventMatchSpan(event, object, text)?.[0] ?? -1 }

// ---- The plan as the person sees it, BEFORE the search (#876 / #752) ----
// A serialisable, human-worded view of the compiled plan: the same tree the gates evaluate, with each condition said in plain words (a completed hire is
// never worded as an open role), its own clock, how the conditions combine, what is filtered elsewhere and every ambiguity with the reading chosen.
// Pure: no database, no provider, no model call.
export type PlanViewNode =
  | { op: 'cond'; id: string; text: string; means: string; window: string | null; kind: CondKind }
  | { op: 'and' | 'or'; of: PlanViewNode[] }
  | { op: 'not'; of: PlanViewNode }
export interface PlanView { explicit: boolean; empty: boolean; summary: string; root: PlanViewNode | null; filters: { kind: PlanFilter['kind']; values: string[]; semantics: string }[]; ambiguities: Ambiguity[] }
function meansOf(c: Condition): string {
  switch (c.kind) {
    case 'funding': return `a completed ${c.stage ? `${c.stage} ` : ''}funding round`
    case 'hiring': return `an open role${c.role ? ` (${c.role})` : ''}: a job posting or a statement that it is hiring`
    case 'hire_made': return `a completed ${c.first ? 'first ' : ''}hire${c.role ? ` (${c.role})` : ''}: a source saying the hire was made, not a vacancy`
    case 'event': return `${c.event ?? 'an'} event${c.object ? ` (${c.object})` : ''}`
    case 'competitor': return 'a company on your saved competitor list'
    case 'company_named': return `the named ${(c.names ?? []).length === 1 ? 'company' : 'companies'}: ${(c.names ?? []).join(', ')}`
    case 'category': return `a ${(c.names ?? [])[0] ?? 'category'} business`
    case 'tech': return `${c.change === 'adopted' ? 'adopted' : c.change === 'removed' ? 'removed' : 'uses'} ${c.tech ?? 'a technology'}`
  }
}
const windowOf = (c: Condition): string | null => c.relative_to ? `within ${c.within_days ?? '?'} days after ${c.relative_to}` : c.within_days ? `within ${c.within_days} days${c.window_source === 'narrowest' || c.window_source === 'default' ? ' (assumed)' : ''}` : null
function viewNode(n: PlanNode): PlanViewNode {
  if (n.op === 'cond') return { op: 'cond', id: n.cond.id, text: n.cond.text, means: meansOf(n.cond), window: windowOf(n.cond), kind: n.cond.kind }
  if (n.op === 'not') return { op: 'not', of: viewNode(n.of) }
  return { op: n.op, of: n.of.map(viewNode) }
}
export function planView(plan: QueryPlan): PlanView {
  return {
    explicit: plan.explicit, empty: plan.root === null && plan.filters.length === 0,
    summary: describePlan(plan.root), root: plan.root ? viewNode(plan.root) : null,
    filters: plan.filters.map(f => ({ kind: f.kind, values: f.values, semantics: f.semantics })),
    ambiguities: plan.ambiguities,
  }
}
