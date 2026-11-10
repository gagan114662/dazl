// The benchmark's independent evaluator (#397, over the #780/#781 deterministic verifier). It judges every blind item
// (runner.ts BlindItem: no system, product, model or config) against the frozen brief, using ONLY page snapshots the
// verifier captured itself, never the producer's own copy of a page, its rationale or its score. Pure: no network, no
// model, no store, no clock. The same snapshots and items always give the same verdicts.
//
// What "validated" (all four scorecard fields pass) means here, so a lead counts as high-intent only on independently
// corroborated evidence and never on a firmographic guess:
//   identity     the company is named on the event source, and that source is on the company's domain or names the
//                domain next to the company (lib/verifier/checks.ts company_on_source + domain_bound).
//   constraints  every hard constraint of the brief is shown on the sources: the brief's place next to the company
//                (place_on_source; the place comes from the BRIEF, not from the producer), each requested event kind
//                (and its roles / funding round) worded in the very sentence that dates the event, and a required name.
//                A constraint no deterministic check can show (segment, headcount, exclusions) is unknown, never pass.
//   event_date   the event's day is stated next to the company on the verifier's own read of the source, inside the
//                brief's window, not in the future, not announced-only, not only the page's publication stamp, no cited
//                source dates it differently, every quote is verbatim on its source, AND at least
//                min_independent_origins distinct origins state it. Pages on one registrable domain are one origin, and
//                so are syndicated copies (the same event sentence, or a rel=canonical to the other page).
//   contact      a published email route on the company's own domain, printed on the cited page, not a hiring inbox;
//                and, when a person is named, that person is current at the company on the cited page.
// Anything the checks cannot show is unknown; unknown is never pass. A lead with no dated event (a list of companies
// that merely fit the segment) can never be validated.
import { blindClaim, httpUrl } from '../verifier/claim.ts'
import { CHECK_VERSIONS, decide, type CheckResult, type Snapshot } from '../verifier/checks.ts'
import { canonicalOf, datesIn, fold, htmlToText, isStamp, linkedDomains, metadataDays, normalizeUrl, registrable, sentenceAt, tokenPositions } from '../verifier/text.ts'
import { CONTRACT_VERSION, scorecardVerdicts, type FieldVerdict } from '../evals/contract.ts'
import type { BlindEvaluator, BlindItem, Brief, Judgement } from './runner.ts'
import type { Field } from './scorecard.ts'
import { createHash } from 'node:crypto'

export const SNAPSHOT_FORMAT = 'dazl-verifier-snapshots'
export const SNAPSHOT_LIMITS = { snapshots: 5000, text: 200_000, html: 3_000_000, url: 2000, meta_days: 20, linked_domains: 200 }
export const EVALUATOR_NAME = 'dazl-verifier-deterministic'
export const EVALUATOR_VERSION = '1'

export interface SnapshotSet {
  captured_by: string | null; captured_at: string | null
  sha256: string                                                   // of the bounded, parsed content (never of the raw input)
  attributed: boolean                                              // a v1 file with captured_by and captured_at: a recorded batch refuses anything else
  byUrl: Map<string, Snapshot>; canonical: Map<string, string>   // url -> its declared canonical page (normalizeUrl form)
  // Pages the verifier found ITSELF for a company (by its registrable domain), never pages a producer cited: they can
  // corroborate an event a producer cited a source for, the same way for every system that names that company.
  found: Map<string, string[]>
  problems: string[]                                               // every entry that was not taken, and why
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const days = (v: unknown) => Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, SNAPSHOT_LIMITS.meta_days) : []

// The verifier's own captures. Untrusted JSON: a malformed entry is skipped with its reason (its page then reads as
// "not fetched", so the checks that need it are unknown), and two different captures of one url are both dropped (a
// conflict is unknown, never resolved by picking one). Nothing here throws.
export function parseSnapshots(raw: unknown): SnapshotSet {
  const out = parseSnapshotsUnhashed(raw)
  // Hashed after every bound is applied: an oversized ignored tail is never traversed or allocated.
  out.sha256 = sha(JSON.stringify({ by: out.captured_by, at: out.captured_at, pages: [...out.byUrl.values()], canonical: [...out.canonical], found: [...out.found] }))
  return out
}
function parseSnapshotsUnhashed(raw: unknown): SnapshotSet {
  const out: SnapshotSet = { captured_by: null, captured_at: null, sha256: '', attributed: false, byUrl: new Map(), canonical: new Map(), found: new Map(), problems: [] }
  if (!isRec(raw) || raw.format !== SNAPSHOT_FORMAT || raw.version !== 1) { out.problems.push(`not a ${SNAPSHOT_FORMAT} v1 file: every page reads as not fetched`); return out }
  out.captured_by = typeof raw.captured_by === 'string' && raw.captured_by.trim() ? raw.captured_by.trim().slice(0, 100) : null
  out.captured_at = typeof raw.captured_at === 'string' && Number.isFinite(Date.parse(raw.captured_at)) ? raw.captured_at : null
  if (!out.captured_by) out.problems.push('captured_by is missing: the capture is not attributed to the verifier')
  if (!out.captured_at) out.problems.push('captured_at is missing or not a time')
  out.attributed = !!out.captured_by && !!out.captured_at
  if (raw.found_by_verifier !== undefined) {
    if (!isRec(raw.found_by_verifier)) out.problems.push('found_by_verifier is not an object keyed by company domain')
    else for (const [d, v] of Object.entries(raw.found_by_verifier).slice(0, SNAPSHOT_LIMITS.snapshots)) {
      const key = registrable(d)
      const urls = Array.isArray(v) ? [...new Set(v.map(u => typeof u === 'string' && u.length <= SNAPSHOT_LIMITS.url ? httpUrl(u) : null).filter((u): u is string => u !== null))].slice(0, 5) : null
      if (!key || !urls) { out.problems.push(`found_by_verifier[${JSON.stringify(d).slice(0, 60)}] is not a domain with a list of urls`); continue }
      out.found.set(key, urls)
    }
  }
  const list = Array.isArray(raw.snapshots) ? raw.snapshots : null
  if (!list) { out.problems.push('snapshots is not a list'); return out }
  if (list.length > SNAPSHOT_LIMITS.snapshots) out.problems.push(`${list.length} snapshots: only the first ${SNAPSHOT_LIMITS.snapshots} are read`)
  const seen = new Map<string, string>(), conflicted = new Set<string>()
  list.slice(0, SNAPSHOT_LIMITS.snapshots).forEach((e, i) => {
    const at = `snapshots[${i}]`
    if (!isRec(e)) { out.problems.push(`${at} is not an object`); return }
    const url = typeof e.url === 'string' && e.url.length <= SNAPSHOT_LIMITS.url ? httpUrl(e.url) : null
    if (!url) { out.problems.push(`${at} has no http(s) url`); return }
    if (e.outcome !== 'ok' && e.outcome !== 'error') { out.problems.push(`${at} outcome ${JSON.stringify(e.outcome) ?? 'missing'} is not ok | error`); return }
    let text = '', truncated = e.truncated === true, meta: string[] = days(e.meta_days), linked: string[] = [], canonical: string | null = null
    if (e.outcome === 'ok') {
      if (typeof e.html === 'string') {
        const html = e.html.slice(0, SNAPSHOT_LIMITS.html)
        if (e.html.length > SNAPSHOT_LIMITS.html) truncated = true
        text = htmlToText(html); meta = [...new Set([...meta, ...metadataDays(html)])].sort(); linked = [...linkedDomains(html)].slice(0, SNAPSHOT_LIMITS.linked_domains); canonical = canonicalOf(html)
      } else if (typeof e.text === 'string') text = e.text
      else { out.problems.push(`${at} (${url}) is ok but has neither text nor html`); return }
      if (text.length > SNAPSHOT_LIMITS.text) { text = text.slice(0, SNAPSHOT_LIMITS.text); truncated = true }
      if (Array.isArray(e.linked_domains)) linked = [...new Set([...linked, ...e.linked_domains.filter((d): d is string => typeof d === 'string').slice(0, SNAPSHOT_LIMITS.linked_domains)])]
    }
    const final_url = typeof e.final_url === 'string' ? httpUrl(e.final_url) : null
    const snap: Snapshot = { url, outcome: e.outcome, final_url, text, truncated, meta_days: meta, linked_domains: linked }
    const key = JSON.stringify(snap)
    if (seen.has(url) && seen.get(url) !== key) { conflicted.add(url); return }
    seen.set(url, key); out.byUrl.set(url, snap)
    if (canonical) out.canonical.set(url, canonical)
  })
  for (const u of conflicted) { out.byUrl.delete(u); out.canonical.delete(u); out.problems.push(`${u} was captured twice with different content: both dropped (unknown)`) }
  return out
}

// --- the brief's constraints -----------------------------------------------------------------------------------

// Country names a page uses; a country code with no entry here makes the place unknown (a two-letter code is never
// matched as a word: "CA" or "IS" would match ordinary text).
export const COUNTRY_NAMES: Record<string, string[]> = {
  US: ['United States', 'USA', 'U.S.', 'America'], CA: ['Canada'], GB: ['United Kingdom', 'UK', 'England', 'Scotland', 'Wales', 'Britain'],
  PT: ['Portugal'], IN: ['India'], AE: ['United Arab Emirates', 'UAE'], DE: ['Germany', 'Deutschland'], NG: ['Nigeria'], IS: ['Iceland'],
  FR: ['France'], ES: ['Spain', 'España'], NL: ['Netherlands'], IE: ['Ireland'], AU: ['Australia'], SG: ['Singapore'],
}
// Other names of a city a brief names; the first one found next to the company is the one checked.
export const CITY_NAMES: Record<string, string[]> = {
  'new york city': ['New York City', 'New York', 'NYC', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'],
  'munich': ['Munich', 'München'], 'münchen': ['München', 'Munich'], 'lisbon': ['Lisbon', 'Lisboa'], 'gurugram': ['Gurugram', 'Gurgaon'],
}
// Wording of each event kind a brief can ask for (folded, whole words). A kind not listed is unknown, never pass.
const W = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`, 'u')
const OPENING = 'opened|opens|opening|open(?:ed)? (?:a|its|their) new|new (?:office|offices|location|locations|clinic|branch|site|facility|plant|hall|headquarters|hq|store|studio|campus)|moved into|eröffnet\\w*|neue[nrs]? (?:standort|niederlassung|halle|produktionshalle|werk|büro)|inaugur\\w*|abriu|nova (?:loja|sede|clínica)'
export const EVENT_WORDING: Record<string, RegExp> = {
  job_posting: W('hiring|hires|is hiring|are hiring|job|jobs|job opening|vacanc\\w*|position|recruiting|looking for|seeking|apply|stellen\\w*|wir suchen|vaga\\w*|contrata\\w*'),
  hire: W('hired|hires|appointed|appoints|named|joins|joined|welcomes|has hired'),
  funding: W('raised|raises|raising|funding|financing|investment|round|seed|series [a-f]|investors?|backed|finanzierung\\w*|investimento|ronda'),
  new_location: W(OPENING), new_office: W(OPENING), office_opening: W(OPENING), new_facility: W(OPENING), facility_opening: W(OPENING),
  regional_hq: W('regional (?:headquarters|hq|head office|hub)|(?:middle east|mena|gcc|emea|apac|asia-pacific|latin america|latam) (?:headquarters|hq|head office|hub)|headquarters for the (?:region|middle east|gcc|emea|apac)'),
  expansion: W(`expan\\w+|${OPENING}`),
  product_launch: W('launch\\w*|released|releases|unveil\\w*|introduc\\w*|rolled out|rolls out'),
  headcount_growth: W('grew|grown|growing|doubled|tripled|headcount|employees|staff of|team (?:of|to)'),
  technology_change: W('migrat\\w*|switched|switches|adopt\\w*|implemented|implements|moved to|replac\\w*|rolled out|deployed'),
  ipo: W('ipo|initial public offering|went public|listed|listing|debut\\w*'),
}
// Hedged or negated wording: the sentence does not state that the event happened. ("may" is not listed: it is a month.)
const HEDGED = W('not|no longer|never|denied|denies|rumou?r\\w*|reportedly|might|could|considering|in talks')
const ROUND_WORDS: Record<string, string> = { seed: 'seed', pre_seed: 'pre-seed', series_a: 'series a', series_b: 'series b', series_c: 'series c' }

type V = 'pass' | 'fail' | 'unknown'
interface Part { verdict: V; why: string }
const worst = (vs: V[]): V => vs.includes('fail') ? 'fail' : vs.length === 0 || vs.includes('unknown') ? 'unknown' : 'pass'

interface Place { cities: string[]; countries: string[] | null; problem: string | null; geo: string }
// The place the brief asks for: "City, CC", "CC" (a whole country), or a name ("Antarctica"). From the brief only.
export function placeOf(geo: string): Place {
  const parts = geo.split(',').map(s => s.trim()).filter(Boolean)
  const cc = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : /^[A-Z]{2}$/.test(parts[0] ?? '') ? parts[0] : null
  const countries = cc ? COUNTRY_NAMES[cc] ?? null : null
  const problem = cc && !countries ? `country code ${cc} has no country-name table: the place cannot be shown` : !parts.length ? 'the brief names an empty place' : null
  if (parts.length === 1 && cc) return { cities: countries ?? [], countries: null, problem, geo }   // a whole country: its name is the place
  const city = (parts[0] ?? '').replace(/\s+(?:region|area|metro(?:politan)? area|metro)$/i, '')
  return { cities: CITY_NAMES[city.toLowerCase()] ?? [city], countries, problem, geo }
}

const geoOf = (c: unknown): string | null => {
  let g: string | null = null
  const walk = (v: unknown) => { if (g) return; if (Array.isArray(v)) v.forEach(walk); else if (isRec(v)) { if (typeof v.geo === 'string') g = v.geo; else Object.values(v).forEach(walk) } }
  walk(c); return g
}

// --- the evaluator -----------------------------------------------------------------------------------------------

export interface VerifierOptions { snapshots: SnapshotSet; min_independent_origins?: number }

// origins: each independent origin (one per group of merged pages) with the dated sentences its pages give the event.
interface Ctx { claimCompany: string; origins: { root: number; sentences: string[] }[]; min: number }
// A frozen brief is committed and reviewed, but its constraints are still read defensively: deeper or wider than this is
// not read (unknown), so a pathological brief can neither overflow the stack nor pass by an unread branch.
export const MAX_CONSTRAINT_DEPTH = 8, MAX_CONSTRAINT_BRANCHES = 50

function constraintVerdict(c: unknown, place: Part | null, cx: Ctx): Part[] {
  const out: Part[] = []
  const leaf = (n: Record<string, unknown>): Part => {
    if (typeof n.geo === 'string') return place ?? { verdict: 'unknown', why: `place ${n.geo} could not be checked` }
    if (typeof n.name === 'string') return tokenPositions(cx.claimCompany, n.name).length ? { verdict: 'pass', why: `the company name contains "${n.name}"` } : { verdict: 'fail', why: `the brief asks for "${n.name}"; the lead is ${cx.claimCompany}` }
    if (typeof n.event === 'string') {
      const re = EVENT_WORDING[n.event]
      if (!re) return { verdict: 'unknown', why: `event kind ${n.event} has no deterministic wording check` }
      const roles = Array.isArray(n.roles) ? n.roles.filter((r): r is string => typeof r === 'string') : []
      const rounds = [...(Array.isArray(n.rounds) ? n.rounds : []), ...(typeof n.stage === 'string' ? [n.stage] : [])].filter((r): r is string => typeof r === 'string').map(r => ROUND_WORDS[r] ?? r.replace(/_/g, ' '))
      // One sentence must state it whole: the event wording, unhedged, AND a requested role / round, in the same sentence
      // that dates the event next to the company. Each origin that has such a sentence counts once.
      const states = (s: string) => re.test(s) && !HEDGED.test(s) && (!roles.length || roles.some(r => tokenPositions(s, r).length > 0)) && (!rounds.length || rounds.some(r => tokenPositions(s, r).length > 0))
      const hits = cx.origins.filter(o => o.sentences.some(states))
      const what = `${n.event}${roles.length ? ` (${roles.join(' / ')})` : ''}${rounds.length ? ` (${rounds.join(' / ')})` : ''}`
      if (!hits.length) return { verdict: 'unknown', why: cx.origins.length ? `no sentence that dates the event states ${what} whole and unhedged` : `no source the verifier read dates the event, so ${what} is not shown` }
      if (hits.length < cx.min) return { verdict: 'unknown', why: `${what} is stated on ${hits.length} independent origin(s); ${cx.min} are required` }
      return { verdict: 'pass', why: `${what} is stated on ${hits.length} independent origin(s): "${hits[0].sentences.find(states)!.slice(0, 120)}"` }
    }
    const keys = Object.keys(n).filter(k => k !== 'within_days')
    return { verdict: 'unknown', why: `${keys.join(', ') || 'an empty constraint'} is not shown by a deterministic check (needs the semantic judge, #782)` }
  }
  const node = (n: unknown, depth = 0): Part => {
    if (depth > MAX_CONSTRAINT_DEPTH) return { verdict: 'unknown', why: `constraints nested deeper than ${MAX_CONSTRAINT_DEPTH} levels are not read` }
    if (!isRec(n)) return { verdict: 'unknown', why: 'a malformed constraint' }
    if (Array.isArray(n.any_of)) {
      const ps = n.any_of.slice(0, MAX_CONSTRAINT_BRANCHES).map(x => node(x, depth + 1))
      const pass = ps.find(p => p.verdict === 'pass')
      return pass ?? (ps.length && ps.every(p => p.verdict === 'fail') ? { verdict: 'fail', why: ps.map(p => p.why).join('; ') } : { verdict: 'unknown', why: `none of ${ps.length} alternatives shown: ${ps.map(p => p.why).join('; ')}` })
    }
    if (Array.isArray(n.all_of) || Array.isArray(n.none_of)) {
      const ps = (Array.isArray(n.all_of) ? n.all_of : []).slice(0, MAX_CONSTRAINT_BRANCHES).map(x => node(x, depth + 1))
      if (Array.isArray(n.none_of) && n.none_of.length) ps.push({ verdict: 'unknown', why: `the exclusion ${JSON.stringify(n.none_of).slice(0, 120)} is not shown by a deterministic check` })
      const other = Object.keys(n).filter(k => !['all_of', 'any_of', 'none_of', 'within_days'].includes(k))
      if (other.length) ps.push({ verdict: 'unknown', why: `unknown constraint key(s) ${other.join(', ')}` })
      const v = worst(ps.map(p => p.verdict))
      return { verdict: v, why: ps.filter(p => p.verdict === v).map(p => p.why).join('; ') || 'no constraint' }
    }
    return leaf(n)
  }
  if (c === null || c === undefined) out.push({ verdict: 'unknown', why: 'the brief states no constraints: nothing can be shown to hold' })
  else out.push(node(c))
  return out
}

export function verifierEvaluator(o: VerifierOptions): BlindEvaluator {
  const min = o.min_independent_origins ?? 2
  if (!(Number.isSafeInteger(min) && min >= 1 && min <= 5)) throw new TypeError(`min_independent_origins must be an integer 1..5, got ${JSON.stringify(min)}`)
  const snaps = o.snapshots
  const config = {
    min_independent_origins: min, check_versions: CHECK_VERSIONS, snapshots_sha256: snaps.sha256, snapshots_captured_by: snaps.captured_by,
    snapshots_captured_at: snaps.captured_at, snapshot_count: snaps.byUrl.size, snapshot_problems: snaps.problems.slice(0, 50), snapshot_problem_count: snaps.problems.length,
  }
  const judgeOne = (item: BlindItem, brief: Brief): Judgement => {
    const readable = (u: string | null) => u ? snaps.byUrl.get(u) ?? null : null
    const urls = [...new Set(item.evidence_urls.map(u => httpUrl(u)).filter((u): u is string => u !== null))]
    const primary = httpUrl(item.event_source_url) ?? urls[0] ?? null
    const reg = item.domain ? registrable(item.domain) : null
    const found = (reg ? snaps.found.get(reg) ?? [] : []).filter(u => u !== primary && !urls.includes(u))
    const corroborating = [...urls.filter(u => u !== primary), ...found].slice(0, 5)   // the producer's own citations first
    const eventUrls = primary ? [primary, ...corroborating] : []
    const folded = (u: string) => { const s = readable(u); return s && s.outcome === 'ok' ? fold(s.text) : null }
    const near = (f: string, term: string) => { const co = tokenPositions(f, item.company); return tokenPositions(f, term).some(x => co.some(y => Math.abs(x - y) <= 250)) }

    // The place from the brief; the first of its names that a cited source puts next to the company.
    const geo = geoOf(brief.constraints)
    const place = geo ? placeOf(geo) : null
    let claimPlace: { city: string; country: string | null } | null = null
    if (place && place.cities.length) {
      const texts = eventUrls.map(folded).filter((f): f is string => f !== null)
      const city = place.cities.find(c => texts.some(f => near(f, c))) ?? place.cities[0]
      const country = place.countries ? place.countries.find(c => texts.some(f => tokenPositions(f, c).length > 0)) ?? place.countries[0] : null
      claimPlace = { city, country }
    }
    const email = item.contact && /@/.test(item.contact) ? item.contact : null
    const { claim, problems, dropped } = blindClaim({
      company: item.company, domain: item.domain, place: claimPlace,
      event: { date: item.event_date, source_url: primary, corroborating_urls: corroborating },
      quotes: item.quotes, person: item.person,
      contact: email && item.contact_source_url ? { email, source_url: item.contact_source_url } : null,
    })
    const sources = [...new Set([...eventUrls, ...claim.quotes.map(q => q.source_url), claim.person?.source_url, claim.contact?.source_url].filter((u): u is string => !!u))].map(readable).filter((s): s is Snapshot => s !== null)
    const asOf = `${brief.as_of}T23:59:59Z`, windowDays = brief.window_days ?? Number.MAX_SAFE_INTEGER
    const ignoredProblems = place ? [] : ['place is missing']
    const relevant = problems.filter(p => !ignoredProblems.includes(p))
    const checks = decide({ claim, problems: relevant, sources, asOf, windowDays })

    // Independent corroboration: each cited event source that, read on its own, names the company and dates the event
    // next to it. Origins: one per registrable domain, merged when two pages share the event sentence or a canonical.
    const corro: { url: string; domain: string | null; sentences: string[] }[] = []
    // The same sentence typeset with or without its final stop, quote or bracket compares equal.
    const norm = (s: string) => s.replace(/[\s.!?;:,"'”’)\]]+$/u, '').replace(/^[\s"'“‘(\[]+/u, '').replace(/\s+/g, ' ').trim()
    for (const u of claim.event.source_url ? [claim.event.source_url, ...claim.event.corroborating_urls] : []) {
      const sub = decide({ claim: { ...claim, event: { date: claim.event.date, source_url: u, corroborating_urls: [] }, quotes: [], person: null, contact: null }, problems: [], sources, asOf, windowDays })
      const ok = sub.some(c => c.check === 'company_on_source' && c.status === 'pass') && sub.some(c => c.check === 'event_date_on_source' && c.status === 'pass')
      if (!ok) continue
      const s = readable(u)!, f = fold(s.text)
      const sentences = [...new Set(datesIn(f).filter(d => d.iso === claim.event.date && !isStamp(f, d)).map(d => sentenceAt(f, d.index, d.end)).filter(x => tokenPositions(x, claim.company).length > 0).map(norm))]
      corro.push({ url: u, domain: registrable(s.final_url ?? s.url), sentences })
    }
    const parent = corro.map((_, i) => i)
    const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
    const canon = (u: string) => snaps.canonical.get(u) ?? normalizeUrl(u)
    for (let i = 0; i < corro.length; i++) for (let j = i + 1; j < corro.length; j++) {
      const a = corro[i], b = corro[j]
      if ((a.domain && a.domain === b.domain) || a.sentences.some(x => b.sentences.includes(x)) || canon(a.url) === canon(b.url) || canon(a.url) === normalizeUrl(b.url) || canon(b.url) === normalizeUrl(a.url)) parent[find(i)] = find(j)
    }
    const groups = new Map<number, string[]>()
    corro.forEach((c, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), ...c.sentences]) })
    const origins = groups.size

    const by = (ids: string[]) => checks.filter(c => ids.includes(c.check))
    const fromProblems = (prefixes: string[]): Part[] => relevant.filter(p => prefixes.some(x => p.startsWith(x))).map(p => ({ verdict: 'unknown' as V, why: p }))
    const asParts = (cs: CheckResult[]): Part[] => cs.map(c => ({ verdict: c.status, why: `${c.check}: ${c.reason}` }))
    const wf = checks.find(c => c.check === 'claim_well_formed')
    const field = (parts: Part[], empty: string): { verdict: V; why: string[] } => {
      if (!parts.length) return { verdict: 'unknown', why: [empty] }
      const v = worst(parts.map(p => p.verdict)); return { verdict: v, why: parts.filter(p => p.verdict !== 'pass' || v === 'pass').map(p => p.why) }
    }
    const primaryCompany = checks.filter(c => c.check === 'company_on_source' && c.subject === `source:${claim.event.source_url}`)
    const identity = field([...asParts(primaryCompany), ...asParts(by(['domain_bound'])), ...fromProblems(['company', 'domain'])], 'no event source was cited, so the company could not be identified on one')

    const placeCheck = by(['place_on_source'])[0]
    const placePart: Part | null = place ? (place.problem ? { verdict: 'unknown', why: place.problem } : placeCheck ? { verdict: placeCheck.status, why: `place_on_source: ${placeCheck.reason}` } : { verdict: 'unknown', why: `${place.geo} could not be checked (no readable event source)` }) : null
    const constraints = field(constraintVerdict(brief.constraints, placePart, { claimCompany: claim.company || item.company, origins: [...groups].map(([root, sentences]) => ({ root, sentences })), min }), 'no constraint')

    const datePart = [...asParts(by(['event_date_on_source', 'sources_agree', 'quote_on_source'])), ...fromProblems(['event', 'quotes'])]
    if (wf?.status === 'fail') datePart.push({ verdict: 'fail', why: `claim_well_formed: ${wf.reason}` })
    const dateBase = field(datePart, 'no dated event was claimed: a list of companies that fit is not an intent signal')
    const event_date = dateBase.verdict === 'pass' && origins < min
      ? { verdict: 'unknown' as V, why: [`the event is stated on ${origins} independent origin(s); ${min} are required for an independently corroborated signal (pages on one domain, and syndicated copies, are one origin)`] }
      : dateBase

    const contactParts = [...asParts(by(['person_current', 'contact_not_recruiting', 'contact_domain', 'contact_on_source'])), ...fromProblems(['person', 'contact'])]
    const contact = claim.contact ? field(contactParts, '') : { verdict: 'unknown' as V, why: ['no published email route with the page it is printed on was given', ...contactParts.filter(p => p.verdict !== 'pass').map(p => p.why)] }

    const fields: Record<Field, { verdict: V; why: string[] }> = { identity, constraints, event_date, contact }
    // The verdicts are stated in the evaluation contract's field vocabulary (#394, lib/evals/contract.ts) and folded into the
    // four scorecard fields by the contract's own scorecardVerdicts(), so the benchmark and the contract cannot disagree on
    // what a field means or on what unknown is.
    const fv = (fieldId: string, f: { verdict: V; why: string[] }, evidence: string[]): FieldVerdict => ({ field: fieldId, status: f.verdict, rationale: f.why.slice(0, 4).join('; ').slice(0, 500), evidence })
    const evidence = corro.map(c => c.url)
    const contract_verdicts: FieldVerdict[] = [
      fv('identity.entity', identity, claim.event.source_url ? [claim.event.source_url] : []),
      ...(placePart ? [fv('place.matches', { verdict: placePart.verdict, why: [placePart.why] }, evidence)] : []),
      fv('event.predicate', constraints, evidence),
      fv('event.date_real', dateBase, evidence),
      fv('event.date_in_window', event_date, evidence),
      fv('contact.usable', contact, [claim.contact?.source_url, claim.person?.source_url].filter((u): u is string => !!u)),
    ]
    const v = scorecardVerdicts(contract_verdicts)
    return {
      identity: v.identity, constraints: v.constraints, event_date: v.event_date, contact: v.contact,
      record: {
        contract: CONTRACT_VERSION, contract_verdicts,
        evaluator: `${EVALUATOR_NAME}@${EVALUATOR_VERSION}`, signal_tier: origins >= 2 && event_date.verdict === 'pass' ? 'corroborated' : origins >= 1 ? 'source-checked' : 'unverified',   // corroborated always means two or more origins, whatever the batch's minimum
        independent_origins: origins, corroborating_sources: corro.map(c => c.url), verifier_found_sources: found.filter(u => corroborating.includes(u)),
        why: Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.why.slice(0, 8).map(w => w.slice(0, 300))])),
        checks, claim_problems: problems, claim_fields_dropped: dropped,
      },
    }
  }
  return {
    name: EVALUATOR_NAME, version: EVALUATOR_VERSION, independent: true, config,
    judge: async (items, brief) => Object.fromEntries(items.map((it): [string, Judgement] => {
      try { return [it.blind_id, judgeOne(it, brief)] } catch (e) { return [it.blind_id, { record: { error: `verifier failed on this item: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` } }] }   // unknown, recorded
    })),
  }
}
