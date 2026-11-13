import { requestedHiringRoles, matchedHiringRole, roleNeedsSourceProof } from './hiring-role-match.ts'
// "Seed funding AND hiring sales": a request whose play needs an event beyond hiring plus sales / GTM hiring is not answered by the
// funding quote alone. After the contact crawl has bound each lead to its company domain, a verified lead keeps its place only when
//   (a) its own saved quote already names a sales / GTM hiring (the source says it), or
//   (b) a dated (inside the window, default 90 days) sales / GTM posting sits on a public Greenhouse / Lever / Ashby board bound to the
//       lead's own domain (lib/signals/ats-gtm.ts).
// Otherwise it moves to review with the distinct reason `no_sales_hiring_evidence` and says so on its card. This only ADDS a requirement:
// the quote, date, identity and place gates that put the lead there are not touched, and nothing here promotes a review row.
import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { addEnrichment, audit } from '../connectors/store.ts'
import { atsGtmBoard, isGtmRole, postingEvidence, boardTitleAudit, boardCoverageRow, checkedAuditRows, checkedCoverageRow, fullListingAuditRows, fullListingCoverageRow, withRepostHistory, BOARD_LABEL } from '../signals/ats-gtm.ts'
import { careersSalesVacancy } from '../signals/careers-page.ts'
import { placeAgreement, eventPlaceOk } from './place-agreement.ts'
import { releaseHeld } from './held-state.ts'
import { salesHiringRequired, salesGateOr } from './sales-hiring-required.ts'
export { salesHiringRequired, salesGateOr }
import { norm } from './evidence.ts'
import type { Get } from '../connectors/sitecrawl.ts'
import { domainRelationship } from '../signals/domain-basis.ts'
import { needsEventBeyondHiring, showsEventSignal, mentionsFunding, nounFirstOpenSpan, PREMISES_ADJ, closedBanner, CLAUSE_CLOSED } from '../search/page-class.ts'
import { parseWindowDays } from './window.ts'
import { WHY_MAX } from './score.ts'

export const NO_SALES_HIRING = 'no_sales_hiring_evidence'
export const NO_EVENT = 'no_event_evidence'
export const SALES_GATE_FAILED = 'sales_hiring_check_failed'
const MAX_BOARD_LOOKUPS = 20 // network lookups per run; a lead beyond it is NOT passed, it is held as unchecked

interface JobLike { id: string; user_id: string; query?: string | null; icp?: string | null; attempts?: number }

// The source quote itself says the company is hiring for a sales / GTM role.
// The saved quote / claim itself shows the event half (funding, an opening ...): a job ad alone does not show that a company raised money.
// When the request asks for FUNDING, only a funding mention counts (an office opening is not a raise); otherwise any event beyond hiring does.
// Event half. The sentence must be about THIS company (case-insensitive subject check), must affirm the event (not "did not raise", "plans to raise", "in talks"),
// and, when the request names a funding STAGE, must be that stage ("Series A" never answers a seed request, "seed" never a Series A request).
export type Stage = 'seed' | `series ${string}` | null
export function requestedStage(query: string | null | undefined, icp: string | null | undefined): Stage {
  let sig = ''; try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) sig = j!.signals.filter((x): x is string => typeof x === 'string').join(' . ') } catch { /* none */ }
  const t = `${sig} . ${query ?? ''}`
  const series = /\bseries\s+([a-e])\b/i.exec(t)
  if (/\bseed\b/i.test(t) && !series) return 'seed'
  return series ? `series ${series[1].toLowerCase()}` : /\bseed\b/i.test(t) ? 'seed' : null
}
const RAISE_VERB = /\b(?:rais(?:ed|es)|clos(?:ed|es)|secur(?:ed|es)|announc(?:ed|es)|land(?:ed|s)|complet(?:ed|es)|bagg?(?:ed|s)|receiv(?:ed|es)|won|gets|got|backed|funded|seed-funded|unveil(?:ed|s))\b/i
const FUNDING_NEG = /\b(?:not|no|never|didn'?t|hasn'?t|haven'?t|wasn'?t|without|failed\s+to|unable\s+to|yet\s+to|den(?:y|ies|ied)|reject\w*|refut\w+|cancel\w*|withdr\w+|collaps\w+|fell\s+through|ruled?\s+out|untrue|false)\b/i
const FUNDING_HYPO = /\b(?:(?:plans?|planned|planning|intends?|intending|intentions?|aims?|aiming|proposes?|proposed|considering|exploring|mulling|weighing|preparing|prepares?|prepared)\s+(?:for\s+|to\s+|of\s+|on\s+)?(?:(?:a|an|its|the|new|first|another|additional)\s+)*(?:\S+\s+){0,4}?(?:raise|raising|close|closing|secure|securing|round|seed|series|funding|financing|fundrais\w+|investment)|(?:to|will|shall|would|set\s+to|about\s+to|poised\s+to|slated\s+to|due\s+to|preparing\s+to|expected\s+to|likely\s+to|ready\s+to|going\s+to)\s+(?:raise|close|secure|announce|complete|finali[sz]e|land)|raising|closing|securing|finali[sz]\w+|negotiat\w+|pursuing|targeting|nearing|ongoing|in\s+the\s+process|open\s+round|if|unless|would|could|may|might|plans?\s+to|planning\s+to|hopes?\s+to|aims?\s+to|intends?\s+to|looking\s+to|seeking\s+to|in\s+talks|expects?\s+to|expected\s+to|reportedly|rumou?r\w*|allegedly)\b/i
export function stageOk(clause: string, stage: Stage): boolean {
  if (!stage) return true
  const series = /\bseries\s+([a-z])\b|\b(?:growth|bridge)\s+(?:round|equity)\b/i.exec(clause)
  if (stage === 'seed') return /\b(?:pre-?)?seed\b/i.test(clause) && !series
  const letter = stage.slice(7)
  return new RegExp(`\\bseries\\s+${letter}\\b`, 'i').test(clause) && !/\bseed\b/i.test(clause)
}
// #878 (reviews on #1130, design at 77e509ac and 89e021f3): every event main already read (verb-first openings included) is
// read with main's code unchanged. Only the opening forms this PR adds (noun-first, grand opening, an ordinal, a new
// premises meeting "location") are accepted, and only when the WHOLE quote, before and after the opening, attributes the
// opening to the lead. One of:
//   (i)   the opening's own subject is first-person ("Our new clinic ...", "We opened ...", "Grand opening of our new
//         clinic"): it is the poster's, unless the quote has an @handle / #tag that is not the lead's, or congrats /
//         proud of / happy for / excited for aimed at someone other than the poster;
//   (ii)  the lead (its name, handle or tag) is named, and nothing else name-like, no third-person pronoun (they / their /
//         them / its / his / her, inside the opening too: "Grand opening of their new clinic") and no unnamed party ("our
//         neighbours", "our friends", "the bright smiles team") appears anywhere;
//   (iii) nothing name-like, no handle, no pronoun and no congrats-type language appears anywhere ("New dental clinic now
//         open in Parkdale").
// Name-like: an @handle or #tag; the target of congrats / kudos / shoutout / proud of / happy for / excited for (any case,
// so "so proud of bright smiles" counts); a run of capitalised words, less stop words, months, weekdays and the request's
// own place words. The opening itself and its own place ("in Parkdale", "at 11 Yorkville Ave", ", Toronto") are not read.
// When in doubt the opening is not the lead's (unknown); main gave unknown for all of these forms.
const THIRD_PERSON = /\b(?:they|their|theirs|them|its|his|her)\b/i
const CAP_STOP = new Set(['the', 'a', 'an', 'big', 'news', 'congrats', 'congratulations', 'visit', 'proud', 'thanks', 'thank', 'you', 'welcome', 'hello', 'hi', 'hey', 'looking', 'try', 'our', 'we', 'us', 'it', 'its', 'their', 'they', 'this', 'that', 'these', 'those', 'new', 'now', 'open', 'opened', 'opening', 'today', 'great', 'exciting', 'excited', 'thrilled', 'huge', 'happy', 'grand', 'just', 'also', 'come', 'book', 'call', 'check', 'join', 'meet', 'say', 'stop', 'shoutout', 'introducing', 'announcing', 'update', 'wow', 'love', 'growing', 'finally', 'officially', 'sadly', 'good', 'here', 'there', 'what', 'who', 'why', 'when', 'how', 'is', 'are', 'and', 'or', 'in', 'at', 'on', 'to', 'for', 'of', 'from', 'by', 'with', 'i', 'my', 'me', 'your', 'all', 'everyone', 'brand', 'yes', 'so', 'more', 'best', 'first', 'second', 'third', 'next', 'last', 'one', 'home', 'clinic', 'location', 'office', 'store', 'team', 'did', 'now', 'offered', 'available'])
const PREMISES_WORD = /^(?:clinics?|offices?|locations?|dental|dentistry|health|centre|center|studios?|practices?)$/
const MONTH_DAY = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i
const CONGRATS = /\b(?:congrat\w*|kudos|shout-?outs?|hats\s+off|cheers\s+to|well\s+done|proud\s+(?:of|for)|happy\s+for|excited\s+for|thrilled\s+for)\b[,!]?\s*(?:(?:to|for|of|on|at|with)\s+)?/gi
const UNNAMED = /\b(?:our|my)\s+(?:[\w'’-]+\s+)?(?:neighbou?rs|friends|colleagues|partners|pals|peers)\b/i
// The request's own place words ("Dental clinics in Toronto" -> toronto): a place the request names is no other company.
export function requestPlaces(query: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const m of (query ?? '').matchAll(/\b(?:in|near|around|across)\s+([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)/g)) for (const w of wordsOf(m[1])) out.add(w)
  return out
}
// The end of an opening's own place phrase after `end`: "in Parkdale", "at 11 Yorkville Ave", "on Hwy 27", "in the GTA",
// ", Toronto" (capitalised words or numbers only, so "run by the bright smiles team" is never swallowed).
function placeEnd(text: string, end: number): number {
  // words never run across a sentence end ("in Parkdale. Congrats Bright Smiles" stops at "Parkdale")
  const RUN = String.raw`(?:\d+[\w-]*\s+)?(?:[A-Z][\w'’-]*|\d+)(?:[ \t]+(?:[A-Z][\w'’-]*|\d+))*`
  // a lower-case place: one or two words, never one that brings in someone ("in parkdale", not "in parkdale run by ...")
  const LC = String.raw`(?!(?:by|with|from|for|and|run|hosted|says|said|of|a|an|the|our|their|its)\b)[a-z][\w'’-]*`
  const STEP = new RegExp(String.raw`^(?:[ \t]+(?:[Ii][Nn]|[Aa][Tt]|[Oo][Nn]|[Nn]ear)[ \t]+(?:the[ \t]+|THE[ \t]+)?(?:heart[ \t]+of[ \t]+)?(?:${RUN}|${LC}(?:[ \t]+${LC})?(?=[ \t]*(?:$|[.,;:!?\n)#]|[ \t]-)))|[ \t]*,[ \t]*[A-Z][\w'’-]*(?=[ \t]*(?:$|[.,;:!?\n)])))`)
  for (let m = STEP.exec(text.slice(end)); m && m[0].length; m = STEP.exec(text.slice(end))) end += m[0].length
  return end
}
// The @handles in a text, and the #tags that may be a business name. A #tag that splits wholly into generic words
// (#newclinic, #grandopening, #dentist, #toronto, the request's own places) is no name; any other tag (#brightsmiles)
// is, and fails a new-form opening closed unless it is the lead's.
const TAG_WORDS = ['new', 'grand', 'opening', 'open', 'now', 'official', 'officially', 'clinic', 'clinics', 'dental', 'dentist', 'dentists', 'dentistry', 'office', 'location', 'store', 'shop', 'studio', 'practice', 'local', 'community', 'support', 'small', 'business', 'shoplocal', 'toronto', 'gta', 'canada', 'ontario', 'the', 'and', 'in', 'our', 'my', 'day', 'week', 'ortho', 'orthodontics', 'invisalign', 'hygiene', 'patients', 'hiring', 'jobs', 'growing', 'expansion', 'celebrate', 'celebrating', 'ribbon', 'cutting', 'neighbourhood', 'neighborhood']   // never words practice names are made of (family, care, smile ...)
function genericTag(tag: string, places: ReadonlySet<string>): boolean {
  const t = tag.toLowerCase().replace(/[^a-z]/g, ''), words = [...TAG_WORDS, ...places]
  const ok: boolean[] = [true]   // ok[i]: t.slice(0, i) splits into generic words
  for (let i = 1; i <= t.length; i++) ok[i] = words.some(w => w.length <= i && ok[i - w.length] && t.slice(i - w.length, i) === w)
  return t !== '' && ok[t.length]
}
function handlesIn(text: string, places: ReadonlySet<string>): string[] {
  return [...text.matchAll(/[@#][A-Za-z0-9_.]+/g)].filter(m => m[0][0] === '@' || !genericTag(m[0].slice(1), places)).map(m => '@' + m[0].slice(1).replace(/\.+$/, ''))
}
type Party = { name: string | null }   // null: a party the quote refers to but does not name ("our neighbours", "them")
function congratsTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(CONGRATS)) {
    const x = text.slice((m.index ?? 0) + m[0].length).split(/[!.,;:?\n]|\s[-–—]\s|\s(?:for|on|and|who|which|as|with)\s/i)[0].trim().replace(/["“”'‘’]/g, '').trim()
    out.push(x.replace(/^(?:(?:the|all\s+the)\s+)?(?:whole\s+)?(?:team|folks|crew|staff|everyone|people|gang)\s+(?:over\s+)?at\s+/i, '').replace(/^(?:our|my)\s+(?:good\s+)?friends\s+(?:over\s+)?at\s+/i, ''))
  }
  return out
}
const SELF = /^(?:us|me|ourselves|everyone|all|you(?:\s+all)?|(?:our|the)\s+(?:whole\s+)?team|(?:whole\s+)?team)?$/i
// Every party the text names or refers to, other than through the poster's own "we / our".
function parties(text: string, company: string, places: ReadonlySet<string>): Party[] {
  const out: Party[] = []
  for (const h of handlesIn(text, places)) out.push({ name: h })
  for (const t of congratsTargets(text)) {
    const bare = t.replace(/[@#][A-Za-z0-9_.]+/g, '').trim()
    if (SELF.test(bare)) continue
    if (UNNAMED.test(bare) || /^(?:them|they|her|him)\b/i.test(bare)) out.push({ name: null })
    else if (wordsOf(bare).some(w => !CAP_STOP.has(w))) out.push({ name: bare })
  }
  if (UNNAMED.test(text)) out.push({ name: null })
  // the subject of any sentence before is / are / has / was ("open door clinic is growing", "Amazing is growing") is a
  // party unless it is the lead or a pronoun; so is whoever follows "team at" ("the team at grand clinic")
  for (const m of text.matchAll(/(?:^|[.!?\n]\s*)["“'‘]?([^.!?\n]+?)\s+(?:is|are|has|have|was|were)\b/gi)) {
    const subj = m[1].trim()
    if (/^(?:we|i|it|he|she|they|you|this|that|there|here|our\s+team|everyone|(?:our|my|the)\s+(?:new\s+)?(?:clinic|office|location|space|team|doors?))$/i.test(subj) || wordsOf(subj).length === 0) continue
    out.push({ name: subj })
  }
  for (const m of text.matchAll(/\bteam\s+at\s+([^.!?,\n]+)/gi)) out.push({ name: m[1].trim() })
  for (const m of text.matchAll(/\bthe\s+((?:[\w'’-]+\s+){1,3})team\b/gi)) if (!nameIsLead(m[1].trim(), company)) out.push({ name: null })
  for (const m of text.matchAll(/(?<![\w@#.])[A-Z][\w&'’.-]*(?:[ \t]+[A-Z][\w&'’.-]*)*/g)) {
    if (nameIsLead(m[0], company)) { out.push({ name: m[0] }); continue }
    const key = (w: string) => w.toLowerCase().replace(/’/g, "'").replace(/'s?$|[^a-z0-9&'-]/g, '')
    // a capitalised run, less stop words, months, weekdays and places, is a name when it keeps 2+ words, a premises or
    // practice word ("Open Door Clinic", "The Community Clinic", "Hello Clinic"), or a word off the allow-list ("Invisalign")
    const words = m[0].split(/[ \t]+/).map(key).filter(k => k !== '' && !MONTH_DAY.test(k) && !places.has(k))
    const kept = words.filter(k => !CAP_STOP.has(k) && !CTA_WORDS.has(k))
    if (kept.length >= 2 || words.some(k => PREMISES_WORD.test(k)) || kept.some(k => !ALLOW.has(k))) out.push({ name: kept.length ? kept.join(' ') : m[0] })
  }
  return out
}
// A new-form opening at [at, end] of `excerpt` (its own clause has `prefix` before it) is the lead's own.
// Party markers, in any case: wording that brings in another practice or person without a capitalised name. "welcome(s)
// <x>", "<x> dental / location / team / family / practice / clinic" for an x that is not the lead, "says / said <x>",
// "reposted / shared <x>", "<lead> and <x>", "with <x>", "a new neighbour", "down the street", "next door".
// The words a sign-off or attribution may carry that name no one (stop words and the call-to-action words).
const CTA_WORDS = new Set(['come', 'visit', 'see', 'soon', 'book', 'booking', 'today', 'now', 'walk', 'walk-ins', 'ins', 'welcome', 'say', 'hi', 'us', 'you', 'all', 'of', 'at', 'the', 'team', 'online', 'call', 'stop', 'drop', 'pop', 'in', 'by'])
// A sign-off or attribution that names a party other than the lead, in any case: "love, <x>", "xo <x>", "cheers, <x>",
// "- <x>" / "— <x>" at the end, "from / by / hosted by / brought to you by / part of / at / via <x>". <x> is up to 4
// words that are not stop words, call-to-action words, places of the request or the opening, or the lead.
function signOffOther(text: string, lead: string, places: ReadonlySet<string>): boolean {
  const named = (x: string) => {
    if (/[@#][A-Za-z0-9_]/.test(x)) return true
    const ws = x.split(/\s+/).slice(0, 4).filter(w => { const k = w.toLowerCase().replace(/['’]s?$|[^a-z0-9&'-]/g, ''); return k !== '' && !CAP_STOP.has(k) && !CTA_WORDS.has(k) && !places.has(k) && !MONTH_DAY.test(k) })
    return ws.length > 0 && !(lead !== '' && nameIsLead(ws.join(' '), lead))
  }
  const after = (i: number) => text.slice(i).split(/[.,!?;:\n()]|\s[-–—]\s/)[0].trim()
  for (const m of text.matchAll(/\b(?:love|xo+|cheers|from|by|hosted\s+by|brought\s+to\s+you\s+by|part\s+of|at|via)\b[,:]?\s*/gi)) if (named(after((m.index ?? 0) + m[0].length))) return true
  const tail = /(?:^|\s)[-–—]\s*([^-–—\n]+?)\s*[.!]*\s*$/.exec(text)
  return !!tail && named(tail[1])
}
const TEAM_ADJ = new Set(['same', 'great', 'whole', 'amazing', 'awesome', 'wonderful', 'entire', 'friendly', 'dedicated', 'caring', 'new', 'care', 'love', 'thanks', 'thank', 'you'])
function partyMarker(quote: string, lead: string, places: ReadonlySet<string> = new Set()): boolean {
  // the lead's own name never marks another party ("Family Dental Care is growing")
  let text = lead === '' ? quote : quote.replace(new RegExp(lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => ' '.repeat(m.length))
  if (lead !== '') text = text.replace(/(?<![\w@#.])[A-Z][\w&'’.-]*(?:[ \t]+[A-Z][\w&'’.-]*)*/g, m => (nameIsLead(m, lead) ? ' '.repeat(m.length) : m))
  if (signOffOther(text, lead, places)) return true
  if (/\bwelcomes?\s+(?!to\b|you\b|all\b|everyone\b|new\s+patients\b|walk-?ins\b)[\w@#]/i.test(text)) return true
  if (/\b(?:says|said|reposted|shared|retweeted|regrammed)\b|\bwith\s+[\w@#]|\ba\s+new\s+neighbou?r|\bdown\s+the\s+street\b|\bnext\s+door\b/i.test(text)) return true
  for (const m of text.matchAll(/\b((?:[\w'’-]+\s+){1,3})(?:dental|location|team|family|practice|clinic)\b/gi)) {
    // only a team's own adjectives are no name here ("same great team"); "the community clinic" is a practice
    const x = m[1].trim().split(/\s+/).filter(w => !CAP_STOP.has(w.toLowerCase().replace(/['’]s?$/, '')) && !TEAM_ADJ.has(w.toLowerCase()) && !DESCRIPTIVE.has(w.toLowerCase())).join(' ')
    if (x !== '' && !(lead !== '' && nameIsLead(x, lead))) return true
  }
  // "<lead> and <x>": read on the quote itself, with the lead's name in place
  for (const m of quote.matchAll(/((?:[\w&'’@.-]+\s+){1,5})and\s+[\w@#]/gi)) {
    const ws = m[1].trim().split(/\s+/)
    for (let k = 1; k <= ws.length; k++) if (lead !== '' && nameIsLead(ws.slice(-k).join(' '), lead)) return true
  }
  return false
}
// "<Lead> is / has / opened / 's ...": the lead is the lead-in subject of the sentence.
function leadSubject(sentence: string, lead: string): boolean {
  const m = /^\s*(.+?)(?:\s+(?:is|are|was|were|has|have|had|just|opened|opens)\b|['’]s\b)/i.exec(sentence)
  return !!m && nameIsLead(m[1].replace(/^[^\w@]+/, ''), lead)
}
// What a quote may say besides a nobody-named opening: generic tags, emoji, punctuation and a short call to action.
const CTA = /\b(?:come\s+(?:visit(?:\s+us)?|see\s+us|say\s+hi)|book\s+(?:now|today)|see\s+you\s+soon|now\s+booking|walk-?ins\s+welcome)\b/gi
// A new-form opening at [at, end] of `excerpt` (its own clause has `prefix` before it) is the lead's own. Strict, by
// design (review on #1130 at d010a0c3): main gives unknown for every new form, so failing closed loses nothing against
// main. The rest of the quote is everything but the opening and its own place ("in Parkdale", ", Toronto").
//   (i)   first person ("Our new clinic ...", "We opened ...", "Grand opening of our new clinic"): the rest names no one
//         but the lead (no capitalised name past stop words, months, weekdays and places; no @handle; no business-name
//         #tag; no congrats target), and has no party marker.
//   (ii)  the lead named: the same, and a third-person pronoun only where the lead is the lead-in subject of the
//         pronoun's own sentence or the one before ("Family Dental Care is growing. Their new clinic is now open").
//   (iii) nobody named: the rest is empty, or only generic #tags, emoji, punctuation and a call to action ("Book now").
// #878 (review on #1130 at e0eb5d61): for a first-person or lead-named opening, the rest of the quote may say ONLY
// these: common function words and opening / celebration words, a call to action, thanks to patients or staff, the
// request's places, street addresses, phone numbers and opening hours, emoji, punctuation and generic #tags. Any other
// word ("bright smiles", "network", "owner", "competition", "told reporters") fails the opening closed.
const ALLOW = new Set(('a an the and or but so to of in on at for with as is are was be been am it this that these those ' +
  'we we\'re we\'ve we\'ll our ours us you your you\'re i i\'m me my all any some every more most very just now here there ' +
  'what when where how no yes can will do have has had get got go come see let make new great good best amazing awesome ' +
  'wonderful beautiful lovely happy excited exciting thrilled proud pleased delighted grateful thankful thank thanks share ' +
  'sharing announce announcing finally officially official big news update today day week month year time patients patient ' +
  'staff team community neighbourhood neighborhood same address location locations clinic office space home doors door open ' +
  'opened opening grand celebrate celebrating celebration growing grow accepting serving ready welcome welcoming love ' +
  'congrats congratulations hello hi hey everyone soon visit book booking online call link bio by up business second third ' +
  'fourth fifth another bigger larger brand st street ave avenue rd road blvd dr drive unit suite floor').split(' '))
const CTA_PHRASES = /\b(?:come\s+(?:visit(?:\s+us)?|see\s+us|say\s+hi|by)|stop\s+by|drop\s+by|say\s+hi|book\s+(?:now|today|online)|link\s+in\s+bio|see\s+you\s+soon|now\s+booking|walk-?ins\s+welcome)\b/gi
const DOMAIN = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.(?:com|ca|net|org|co|io|dental|dentist|clinic|health|info|biz|us|uk|care)\b(?:\/\S*)?/gi
// The words of `rest` that are not on the allow-list (with the lead's own names, handles, tags and domains, generic
// tags, places, addresses, phone numbers and hours removed first).
function unlisted(rest: string, lead: string, places: ReadonlySet<string>, pronouns: boolean): string[] {
  let t = rest.replace(DOMAIN, ' ')
    .replace(/[@#][A-Za-z0-9_.]+/g, ' ')
    .replace(new RegExp(lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
    .replace(/(?<![\w@#.])[A-Z][\w&'’.-]*(?:[ \t]+[A-Z][\w&'’.-]*)*/g, m => (nameIsLead(m, lead) ? ' ' : m))
    .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}\s*[-–]\s*\d{1,2}\b/gi, ' ')
    .replace(CTA_PHRASES, ' ')
  t = t.replace(/\bthanks?\s+(?:you\s+)?(?:to\s+)?(?:(?:all|our|my)\s+)*(?:(?:amazing|wonderful|loyal|great|lovely)\s+)*(?:patients|staff|team|community)(?:\s+and\s+(?:patients|staff|team|community))?\b/gi, ' ')
  return t.toLowerCase().replace(/’/g, "'").split(/[^a-z0-9']+/).map(w => w.replace(/^'+|'+$/g, '')).filter(w => w !== '' &&
    !ALLOW.has(w) && !CTA_WORDS.has(w) && !places.has(w) && !MONTH_DAY.test(w) && !/^\d+(?:st|nd|rd|th)?$/.test(w) &&
    !(pronouns && THIRD_PERSON.test(w)))
}
// A domain or URL host is a party unless its label is the lead's ("brightsmiles.com" is another practice).
const domainsOther = (text: string, lead: string) => [...text.matchAll(DOMAIN)].some(m => !nameIsLead('@' + m[1], lead))
// The frame of an opening match: qualifiers, the premises nouns and the open verbs ("Grand opening of our new clinic",
// "Our 5th location is now open", "opened a new office").
const OPENING_FRAME = new Set(('our its their the a an new brand grand opening of second third fourth fifth another additional is are has have ' +
  'now officially finally open opened opening opens location locations office offices clinic clinics store stores branch branches site sites ' +
  'restaurant restaurants studio studios practice practices warehouse warehouses showroom showrooms shop shops gym gyms salon salons ' +
  'factory factories hq headquarters').split(' '))
const PRACTICE_WORD = /^(?:dental|dentistry|smiles?|orthodontics?|clinic|practice|studio|centre|center|group|health)$/i
// The lead named only to set it apart ("Not Metro City Dentistry", "the same space as Metro City Dentistry").
const contrastsLead = (text: string, lead: string) => new RegExp(String.raw`\b(?:not|than|as|like|from|next\s+(?:door\s+)?to|instead\s+of|unlike)\s+(?:the\s+)?` + lead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)
export function openingAttributable(excerpt: string, at: number, end: number, prefix: string, company: string | null | undefined, places: ReadonlySet<string> = new Set()): boolean {
  const lead = company ?? ''
  if (lead === '') return false
  const match = excerpt.slice(at, end), stop = placeEnd(excerpt, end)
  // the opening's own place words are places too ("#parkdale" after "now open in Parkdale")
  // R13: the opening's own place never hides a practice ("open at Bright Smiles Dental in Parkdale")
  // R16: the opening's own words (between "new" and the premises noun, and a place inside it) are read too: only the
  // opening's frame, an ordinal, a premises adjective (dental, flagship ...), the lead's words and places may be there
  // ("New Bright Smiles Clinic is now open" is another practice's)
  const inner = /^(.*?)\b(?:in|at|on|near)\s+(.+)$/i.exec(match)
  const placeWords = [...wordsOf(excerpt.slice(end, stop)), ...(inner ? wordsOf(inner[2]) : [])], leadWords = new Set(wordsOf(lead))
  if (placeWords.some(w => PRACTICE_WORD.test(w) && !leadWords.has(w))) return false
  for (const m of (inner ? inner[2] : '').matchAll(/[A-Z][\w&'’-]*(?:[ \t]+[A-Z][\w&'’-]*)*/g)) if (wordsOf(m[0]).some(w => leadWords.has(w)) && !nameIsLead(m[0], lead)) return false
  const fillPlaces = new Set([...places, ...placeWords])
  if (wordsOf(inner ? inner[1] : match).some(w => !OPENING_FRAME.has(w) && !PREMISES_ADJ.test(w) && !leadWords.has(w) && !fillPlaces.has(w) && !/^\d+(?:st|nd|rd|th)?$/.test(w))) return false
  // a place run carrying the lead's words must be the lead itself ("at Metro City Dentistry North" is not)
  for (const m of excerpt.slice(end, stop).matchAll(/[A-Z][\w&'’-]*(?:[ \t]+[A-Z][\w&'’-]*)*/g)) if (wordsOf(m[0]).some(w => leadWords.has(w)) && !nameIsLead(m[0], lead)) return false
  if (contrastsLead(excerpt, lead)) return false
  const where = new Set([...places, ...placeWords])
  const rest = excerpt.slice(0, at) + ' . ' + excerpt.slice(stop)
  if (domainsOther(rest, lead)) return false
  const ps = [...parties(rest, lead, where), ...[...rest.matchAll(DOMAIN)].map(m => ({ name: '@' + m[1] }))]
  const onlyLead = ps.every(p => p.name !== null && nameIsLead(p.name, lead)) && !partyMarker(rest, lead, where)
  if (/^(?:grand\s+opening\s+of\s+)?our\b/i.test(match) || /\b(?:we|we['’](?:re|ve)|our)\s+(?:[a-z]+\s+){0,2}$/i.test(prefix) || /^(?:we|we['’](?:re|ve))\s*$/i.test(prefix.trim())) return onlyLead && unlisted(rest, lead, where, false).length === 0
  if (ps.length > 0) {
    if (!onlyLead || unlisted(rest, lead, where, true).length > 0) return false
    // every third-person pronoun (in the rest or the opening) must have the lead as its sentence's lead-in subject
    const blanked = excerpt.slice(0, stop).replace(/\b(?:its|their)\s+doors\b/gi, m => ' '.repeat(m.length)) + excerpt.slice(stop)
    const sentences: [number, string][] = []
    for (const m of blanked.matchAll(/[^.!?\n]+/g)) sentences.push([m.index ?? 0, m[0]])
    for (const m of blanked.matchAll(new RegExp(THIRD_PERSON.source, 'gi'))) {
      const k = sentences.findIndex(([i, t]) => (m.index ?? 0) >= i && (m.index ?? 0) < i + t.length)
      if (k < 0 || !(leadSubject(sentences[k][1], lead) || (k > 0 && leadSubject(sentences[k - 1][1], lead)))) return false
    }
    return true
  }
  // (iii) nobody named: no third-person pronoun, the opening's own included ("Grand opening of their new clinic"), and
  // nothing else in the quote but generic tags, emoji, punctuation and a call to action
  if (THIRD_PERSON.test(rest.replace(/\b(?:its|their)\s+doors\b/gi, ' ') + ' ' + match)) return false
  const left = rest.replace(/#[A-Za-z0-9_]+/g, t => (genericTag(t.slice(1), where) ? ' ' : t)).replace(CTA, ' ').replace(/[^\p{L}\p{N}#@]+/gu, ' ').trim()
  return left === ''
}
// Corporate and descriptive words a name may carry around the lead's own words ("Acme Software", "Acme HQ", "Metro City
// Dental Centre"); a place word ("North", a city) is not one of them.
const DESCRIPTIVE = new Set(['software', 'hq', 'labs', 'lab', 'technologies', 'technology', 'tech', 'inc', 'group', 'centre', 'center', 'clinic', 'clinics', 'dental', 'dentistry', 'studio', 'studios', 'co', 'corp', 'ltd', 'llc', 'limited', 'plc', 'the', 'and', 'of', 'dds', 'dmd'])
const core = (x: string) => wordsOf(x).filter(w => !DESCRIPTIVE.has(w))
// A name is the lead's only when, without corporate / descriptive words, it is exactly the lead's name: "Acme Software",
// "Metro City Dental Centre", "Bright Smiles" for "Bright Smiles Dental Studio". One shared word ("Bright Family Dentistry"
// for "Family Dental Care"), a missing one ("Metro Dental") or an extra one ("Metro City Dentistry North", "Smile Dental
// Studio Brampton") is another practice. An @handle or a one-word name is the lead's when it is the lead's whole name
// joined, or its own words joined followed only by descriptive words ("@metrocitydentistry", "@metro_city_dental";
// never "@notmetrocitydentistry", "@metrocitydentistrynorth", "@kingcitydental").
export function nameIsLead(name: string, company: string): boolean {
  const own = core(company).length ? core(company) : wordsOf(company)
  if (own.length === 0) return false
  const words = wordsOf(name)
  if (name.startsWith('@') || (words.length === 1 && own.length > 1)) {
    const h = name.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (h === wordsOf(company).join('')) return true
    const joined = own.join('')
    if (!h.startsWith(joined)) return false
    let rest = h.slice(joined.length)
    for (let prev = ''; rest !== '' && prev !== rest;) { prev = rest; for (const d of DESCRIPTIVE) if (rest.startsWith(d)) { rest = rest.slice(d.length); break } }
    return rest === ''
  }
  const theirs = core(name).length ? core(name) : words
  return theirs.join(' ') === own.join(' ')
}
// The non-funding gate exactly as main read it: any event (an opening included) in a clause whose subject is the lead.
const mainClauseEvent = (c: string, company: string | null | undefined): boolean => { const i = c.search(/\b(?:open|launch|expan|announc)/i); return showsEventSignal(c) && !subjectIsOther(c.slice(0, Math.max(0, i)), company) }
export const quoteShowsEventMain = (excerpt: string | null, company?: string | null): boolean => clauses(excerpt ?? '').some(c => mainClauseEvent(c, company))
// A new-form opening (found by `match` in a clause) the quote shows as the lead's: its clause subject is not another
// company, the place is not reported closed (a banner anywhere, or a closure in its own clause), and it is attributable.
// A new-form opening (found by `match` in a clause, as [start, end]) the quote shows as the lead's: its clause subject is
// not another company, the place is not reported closed (a banner anywhere, or a closure in its own clause), and the
// whole quote attributes it to the lead (openingAttributable).
export function newOpeningShown(excerpt: string, company: string | null | undefined, match: (clause: string) => [number, number] | null, places: ReadonlySet<string> = new Set(), not?: RegExp): boolean {
  if (closedBanner(excerpt)) return false
  return clauses(excerpt).some(c => {
    const span = match(c)
    // the lead's own handle or tag in front of the opening is no other subject ("@metrocitydentistry new clinic now open")
    if (!span) return false
    const front = company ? c.slice(0, span[0]).replace(/[@#][A-Za-z0-9_.]+/g, h => (nameIsLead('@' + h.slice(1), company) ? ' ' : h)) : c.slice(0, span[0])
    if ((not && not.test(c)) || CLAUSE_CLOSED.test(c) || subjectIsOther(front, company)) return false
    const base = Math.max(0, excerpt.indexOf(c))
    return openingAttributable(excerpt, base + span[0], base + span[1], c.slice(0, span[0]), company, places)
  })
}
// places: the request's own place words (requestPlaces), when the caller has the request.
export const quoteShowsEvent = (excerpt: string | null, signal: string | null, fundingAsked = false, company?: string | null, stage: Stage = null, places: ReadonlySet<string> = new Set()): boolean => { void signal
  const all = excerpt ?? ''
  // main's reading, plus a noun-first opening (#878) that is the lead's own
  if (!fundingAsked) return quoteShowsEventMain(all, company) || newOpeningShown(all, company, c => nounFirstOpenSpan(c, company), places)
  return clauses(all).some(c => {
    if (!mentionsFunding(c) || FUNDING_NEG.test(c) || FUNDING_HYPO.test(c)) return false
    const v = RAISE_VERB.exec(c); if (!v) return false
    return stageOk(c, stage) && !subjectIsOther(c.slice(0, v.index), company)
  }) }
export const requestAsksFunding = (query: string | null | undefined, icp: string | null | undefined): boolean => { let sig = ''; try { const j = icp ? JSON.parse(icp) as { signals?: unknown } : null; if (Array.isArray(j?.signals)) sig = j!.signals.filter((x): x is string => typeof x === 'string').join(' . ') } catch { /* none */ } return mentionsFunding(`${sig} . ${query ?? ''}`) }
// Affirmative hiring proof, not keyword co-occurrence. A CLAUSE (split on sentence ends and but / however / while / although / yet) must say the lead's OWN
// company is hiring, now, for a sales / GTM role:
//   - not negated or denied ("not hiring", "no plans to hire", "hiring freeze", "denies hiring", "rules out", "rejects reports of");
//   - not conditional, hypothetical, planned or hearsay ("only if", "once", "would", "may", "plans to", "will", "reportedly");
//   - not past ("was hiring", "previously", "hired");
//   - the sales noun must be the HEAD of the object ("hiring sales tax accountants" and "a sales operations accountant" are not sales roles);
//   - the subject must be the lead's company: another named company in front of the verb ("Separately, Othercorp is hiring sales staff") is not it.
// Anything this cannot read as plainly affirmative fails closed.
const NEGATED = /\b(?:not|no|never|none|nor|without|isn'?t|aren'?t|wasn'?t|won'?t|doesn'?t|don'?t|didn'?t|hasn'?t|haven'?t|can'?t|cannot|zero|freeze|frozen|paused?|halt(?:ed|s)?|suspend(?:ed|s)?|cancel(?:l?ed|s)?|rescind(?:ed|s)?|scrapp(?:ed|ing)|shelv(?:ed|ing)|delay(?:ed|ing)?|postpon(?:ed|ing)|abandon(?:ed|ing)|ruled?\s+out|rules?\s+out|stopped|stops?|layoffs?|laid\s+off|cut(?:ting|s)?|den(?:y|ies|ied|ying)|refut\w+|reject\w*|dismiss\w*|debunk\w*|disput\w+|disclaim\w*|untrue|false|incorrect|wrong|rumou?r\w*|reportedly|allegedly|supposedly|reports?\s+(?:of|that|say)|unconfirmed)\b/i
const HYPOTHETICAL = /\b(?:if|only\s+if|once|when|whenever|unless|until|provided|assuming|should|would|could|may|might|will|shall|plans?\s+to|planning\s+to|plan\s+is|intends?|intending|aims?\s+to|hopes?\s+to|expects?\s+to|expected\s+to|later\s+this|next\s+(?:year|quarter|month)|eventually|potentially|possibly|pending|depends?|subject\s+to|after\s+(?:the\s+)?(?:close|funding)|in\s+the\s+future)\b/i
const PAST = /\b(?:was|were|had|used\s+to|previously|formerly|last\s+(?:year|quarter|month)|no\s+longer|stopped|hired|recruited|added)\b/i
const HIRE_VERB = '(?:hir(?:e|es|ing)|recruit(?:s|ing)?|seek(?:s|ing)?|look(?:s|ing)\\s+(?:to\\s+hire|for)|add(?:s|ing)|building\\s+out)'
const FILLER = '(?:(?:a|an|our|its|their|the|first|new|senior|junior|founding|key|two|three|four|five|six|\\d+|more|several|some|additional|dedicated|experienced|full[-\\s]?time|remote|enterprise|inbound|outbound|lead|for|in|across|into|within|to\\s+the|to\\s+our|to\\s+build\\s+(?:out\\s+)?(?:our|its|the))\\s+){0,6}'
const GTM_OBJECT = '(?:head\\s+of\\s+(?:sales|growth|revenue)|account\\s+(?:executive|manager|director)s?|aes?|sdrs?|bdrs?|sales(?:\\s+(?:reps?|representatives?|people|persons?|staff|team|leaders?|managers?|directors?|engineers?|development\\s+reps?|hires?|professionals?|executives?|talent|roles?|positions?))?|business\\s+development(?:\\s+(?:reps?|representatives?|managers?|leads?))?|go[-\\s]to[-\\s]market|gtm|revenue\\s+(?:leaders?|team|roles?)|growth\\s+(?:leaders?|team|marketers?)|customer\\s+success(?:\\s+(?:managers?|reps?|team))?|solutions?\\s+(?:engineer|consultant)s?|vp\\s+(?:of\\s+)?sales|demand\\s+gen\\w*)'
// The object must END there (end of clause, punctuation, or a function word): "sales" followed by "tax accountants" / "operations accountant" is a modifier of another role.
const OBJECT_END = '(?=\\s*(?:$|[,:()-]|\\s(?:and|or|to|for|in|across|at|this|next|now|as|with|from|who|that|ahead|so|because|following|based|located|remote|globally|worldwide|today|currently)\\b))'
const HIRING_VERB_OBJECT = new RegExp(`\\b${HIRE_VERB}\\s+${FILLER}${GTM_OBJECT}${OBJECT_END}`, 'i')
const OPEN_ROLE = /\b(?:open|new|several|two|three|\d+)\s+(?:[a-z-]+\s+){0,3}(?:roles?|positions?|openings?|vacanc(?:y|ies))\b/i
const FIRST_HIRE = /\b(?:first|new|key)\s+(?:sales|ae|sdr|bdr|gtm|account\s+executive)\s+hire\b|\bjoin(?:ing)?\s+(?:our|the)\s+(?:sales|gtm)\s+team\b/i
const clauses = (t: string) => t.split(/[.;!?\n]+|\s(?:but|however|while|although|though|yet)\s/i).map(x => x.trim()).filter(Boolean)
// The subject in front of a hiring / raising verb must be the lead (case-insensitive: "othercorp is hiring" is another company just like "Othercorp").
// The prefix is cut into segments at commas / "and" / "which" / "who" / "while" / "as"; the nearest segment that says anything is the subject segment. It is the
// lead's when it names the company (not as the object of a preposition: "Acme, which works with Brightloop, is hiring" is Acme) or says nothing but generic words
// (it, the startup, the London company, raised a seed round ...). Any other word in it is another company.
const NOT_ENTITY = new Set(['the', 'it', 'its', 'we', 'our', 'they', 'their', 'now', 'also', 'still', 'currently', 'and', 'then', 'today', 'london', 'uk', 'nyc', 'new', 'york', 'us', 'saas', 'b2b', 'seed', 'series', 'startup', 'company', 'team', 'founder', 'founders', 'ceo', 'cto', 'cofounder', 'inc', 'ltd', 'llc', 'limited', 'plc', 'a', 'an', 'in', 'at', 'to', 'of', 'for', 'is', 'are', 'has', 'have', 'recently', 'just', 'actively', 'already', 'additionally', 'meanwhile', 'following', 'was', 'were', 'been', 'being', 'will', 'which', 'who', 'that', 'raised', 'raises', 'raising', 'announced', 'closed', 'secured', 'round', 'funding', 'million', 'pre', 'based', 'london-based', 'early-stage', 'young', 'growing', 'fast-growing', 'british', 'uk-based', 'this', 'month', 'week', 'year', 'separately', 'elsewhere', 'furthermore', 'however', 'but', 'sales', 'gtm', 'platform', 'software', 'firm', 'business', 'brand'])
const PREPOSITION = new Set(['with', 'from', 'by', 'at', 'for', 'of', 'to', 'via', 'behind', 'near', 'like', 'including', 'about', 'on', 'over', 'under', 'against'])
const wordsOf = (x: string) => x.toLowerCase().replace(/&/g, ' and ').replace(/['’]s\b/g, '').split(/[^a-z0-9]+/).filter(Boolean)
export function subjectIsOther(prefix: string, company: string | null | undefined): boolean {
  if (!company) return false
  const own = new Set(wordsOf(company).filter(w => !['inc', 'ltd', 'llc', 'limited', 'plc', 'the', 'co', 'corp', 'group'].includes(w)))
  if (own.size === 0) return false
  // alternating [segment, delimiter, segment, ...]; a relative pronoun (which / who / that) makes the nearest noun in front of it the subject ("partners with othercorp, which is hiring")
  const parts = prefix.split(/(,|;|\band\b|\bwhile\b|\bwhich\b|\bwho\b|\bas\b|\bthat\b)/i)
  const AUX = ['is', 'are', 'was', 'were', 'has', 'have', 'been', 'now', 'also', 'still', 'currently', 'actively', 'recently', 'just', 'already']
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    const seg = wordsOf(parts[i])
    const sayings = seg.filter(w => !AUX.includes(w))
    if (sayings.length === 0) {
      const delim = (parts[i - 1] ?? '').trim().toLowerCase()
      if (delim === 'which' || delim === 'who' || delim === 'that') {
        const before = parts.slice(0, Math.max(0, i - 1)).filter((_, k) => k % 2 === 0).map(wordsOf).reverse().find(w => w.length > 0)
        const ante = before ? before[before.length - 1] : undefined
        if (ante === undefined) return false
        return !own.has(ante) && !NOT_ENTITY.has(ante) && !/^\d/.test(ante)
      }
      continue // only auxiliaries after and / a comma: the subject is carried from the earlier segment
    }
    // A segment with no subject of its own carries the earlier one: it starts with a past-tense verb ("... and raised a seed round") or is an appositive after a comma
    // ("Brightloop, a London B2B SaaS startup with 24 employees, raised ..."). Unless it names the company itself, the walk goes on to the segment in front of it.
    const carries = !seg.some(w => own.has(w)) && ((/^[a-z]+ed$/.test(seg[0])) || (['a', 'an', 'the'].includes(seg[0]) && (parts[i - 1] ?? '').trim() === ','))
    if (carries) continue
    if (seg.some((w, k) => own.has(w) && !(k > 0 && PREPOSITION.has(seg[k - 1])))) return false
    return seg.filter(w => !(NOT_ENTITY.has(w) && !own.has(w)) && !/^\d/.test(w)).length > 0
  }
  return false
}
export const affirmativeSalesHiring = (text: string | null, company?: string | null): boolean => clauses(text ?? '').some(c => {
  if (NEGATED.test(c) || HYPOTHETICAL.test(c) || PAST.test(c)) return false
  const m = HIRING_VERB_OBJECT.exec(c)
  if (m) return !/\bsalesforce\b|\bsales\s*tax\b/i.test(m[0]) && !subjectIsOther(c.slice(0, m.index), company)
  const o = OPEN_ROLE.exec(c) ?? FIRST_HIRE.exec(c)
  return !!o && isGtmRole(c) && !subjectIsOther(c.slice(0, o.index), company)
})
export const quoteNamesSalesHiring = (excerpt: string | null, signal: string | null, company?: string | null): boolean => { void signal; return affirmativeSalesHiring(excerpt, company) } // the VERIFIED quote only: the model's claim is not evidence

const whereOf = (icp: string | null | undefined): string[] => { try { const j = icp ? JSON.parse(icp) as { where?: unknown } : null; return Array.isArray(j?.where) ? j!.where.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [] } catch { return [] } }
export interface QuoteEvidence { url: string; excerpt: string; date: string | null }
const labelOf = (host: string) => { const l = host.replace(/^www\./, '').split('.'); return (l.length >= 3 && /^(?:co|com|org|ac)$/.test(l[l.length - 2]) ? l[l.length - 3] : l[l.length - 2] ?? '').replace(/[^a-z0-9]/g, '') }
const registrable = (host: string) => { const l = host.replace(/^www\./, '').split('.'); return l.length >= 3 && /^(?:co|com|org|ac)$/.test(l[l.length - 2]) ? l.slice(-3).join('.') : l.slice(-2).join('.') }
// Evidence from ANOTHER candidate that shares only the lead's NAME is usable only when it is identity-compatible: a third-party page (news, a directory) can be
// about the company, but a page on a company-looking site of a DIFFERENT domain (brightloop.com for the brightloop.io lead, or any such site when the lead has no
// domain) is some other business with the same name.
export function evidenceCompatible(url: string, company: string, leadDomain: string | null): boolean {
  let host = ''; try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  const lab = labelOf(host), key = company.toLowerCase().replace(/&/g, 'and').replace(/\b(inc|ltd|llc|limited|plc|corp|co|the)\b/g, '').replace(/[^a-z0-9]/g, '')
  const looksOwn = lab.length >= 4 && key.length >= 3 && (lab.includes(key) || key.includes(lab))
  if (!looksOwn) return true
  return !!leadDomain && registrable(host) === registrable(leadDomain.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, ''))
}

// Place and (for evidence from another candidate) date of the event quote. The lead's own row was window-checked on its own date already; a joined quote is only usable with its own known date inside the window.
function eventQuoteUsable(q: QuoteEvidence, date: string | null, company: string, where: string[], windowDays: number, nowS: number, own: boolean): boolean {
  if (!eventPlaceOk(q.excerpt, where, company)) return false
  if (own) return true
  const t = date ? Date.parse(date) : NaN
  return Number.isFinite(t) && t <= (nowS + 86_400) * 1000 && nowS * 1000 - t <= windowDays * 86_400_000
}
// #876: a completed hire ("made its first sales hire", "hired", "appointed") is proof only when the clause is affirmative, about THIS company and
// not conditional. An open posting or "is hiring" never counts (NOT_DONE). Fail closed on anything ambiguous.
const HIRE_DONE = /\b(?:hired|appointed|named|joined|joins|welcomed|brought\s+on|onboarded)\b|\b(?:made|makes)\s+(?:(?:a|an|its|their|the)\s+)?(?:(?:first|founding|inaugural|new)\s+)?[a-z][a-z-]*\s+hires?\b/i
// Contracted negations ("hasn't made", "didn't hire", with a straight or curly apostrophe) end in n't, which the \b word list cannot see.
const NOT_DONE = /\b(?:not|no|never|yet\s+to|plans?\s+to|planning|will|would|could|may|might|seeking|looking\s+for|hiring|search(?:ing)?\s+for|reportedly|rumou?r\w*|if|whether|when|once|unless|should|after|until|assuming|cannot)\b|n['\u2019]t\b/i
export function quoteShowsCompletedHire(quote: string | null | undefined, company: string | null | undefined, roleWords: string[], first: boolean): boolean {
  // No split on "yet" here (the clause splitter elsewhere has it): "Pastco hasn't yet made its first sales hire" would leave a bare "made its first sales hire".
  return (typeof quote === 'string' ? quote : '').split(/[.;!?\n]+|\s(?:but|however|while|although|though)\s/i).map(x => x.trim()).filter(Boolean).some(k => {
    const m = HIRE_DONE.exec(k)
    if (!m || NOT_DONE.test(k)) return false
    if (!roleWords.every(w => new RegExp(`\\b${w}`, 'i').test(k))) return false
    if (first && !/\b(?:first|founding|inaugural)\b/i.test(k)) return false
    // Subject binding: another company in front of the verb is not this lead's hire. The one exception is a person joining THIS company, named right
    // after the verb ("Jane joined Pastco as head of sales"). "Otherco hired Pastco's former rep" names Pastco only as an object, so it never counts.
    const own = (company ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['inc', 'ltd', 'llc', 'the', 'corp', 'group', 'limited'].includes(w))
    const next = /^\s*(?:the\s+)?([a-z0-9]+)/.exec(k.slice(m.index + m[0].length).toLowerCase())?.[1]
    return !subjectIsOther(k.slice(0, m.index), company) || (/^join/i.test(m[0]) && !!next && own.includes(next))
  })
}
export async function applySalesHiringGate(db: Database.Database, job: JobLike, fetchImpl: typeof fetch = fetch, opts: { now?: number; quotes?: Map<string, QuoteEvidence[]>; careersGet?: Get } = {}): Promise<{ required: boolean; checked: number; passed: number; demoted: number; demotions: { company: string; url: string; reason: string }[] }> {
  const none = { required: false, checked: 0, passed: 0, demoted: 0, demotions: [] as { company: string; url: string; reason: string }[] }
  if (!salesHiringRequired(job.query, job.icp)) return none
  const demotions = none.demotions
  const roles = requestedHiringRoles(job.query, job.icp).filter(roleNeedsSourceProof)
  let signalTerms: string[] = []
  try { signalTerms = JSON.parse(job.icp ?? '{}').signals ?? [] } catch { /* no profile */ }
  const eventRequired = needsEventBeyondHiring(signalTerms, job.query ?? '')
  const stage = requestedStage(job.query, job.icp)
  const windowDays = parseWindowDays(job.query ?? '') ?? 90
  // #380 / #204: "seed funding OR first sales hire" compiled as one OR. Either branch, proven on its own clock, keeps the lead; with no such OR, both halves stay required.
  const or = salesGateOr(job.query, job.icp)
  const eventDays = or ? or.event.within_days ?? windowDays : windowDays, hireDays = or ? or.hiring.within_days ?? windowDays : windowDays
  const fundingAsked = requestAsksFunding(job.query, job.icp)
  const where = whereOf(job.icp)
  const places = requestPlaces(job.query)   // #878: the request's own place words are no other company in an opening's quote
  const now = Math.floor((opts.now ?? Date.now()) / 1000)
  const leads = db.prepare(
    `SELECT id, company, company_domain, evidence_excerpt, signal, why, dedup_key, source_url, event_date FROM leads
     WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> '' ORDER BY score DESC`,
  ).all(job.id) as { id: string; company: string; company_domain: string | null; evidence_excerpt: string | null; signal: string; why: string | null; dedup_key: string | null; source_url: string; event_date: string | null }[]
  const setWhy = db.prepare('UPDATE leads SET why = ? WHERE id = ?')
  const demote = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL')
  const counts = db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?')
  let passed = 0, demoted = 0, lookups = 0
  const passedIds: string[] = []
  // Ownership (the reclaim failure class): a reaped and re-claimed job has a higher attempts number; the stale attempt must
  // STOP writing (evidence, demotions, check rows alike - the class, not one slice). Checked per lead, inline, not assumed
  // from an earlier assert. Fail-open on a DB error: the write itself would throw loudly if the store were gone.
  const owned = () => {
    try {
      const r = db.prepare('SELECT status, attempts FROM scan_jobs WHERE id = ?').get(job.id) as { status: string; attempts: number } | undefined
      return !!r && (r.status === 'running' || r.status === 'done') && (typeof job.attempts !== 'number' || r.attempts === job.attempts)
    } catch { return true }
  }
  let stopped = false
  for (const l of leads) {
    if (!owned()) { stopped = true; break } // a newer attempt owns the job and will re-run the whole check; write nothing more
    try {
    // Evidence for THIS lead: its own saved quote, plus other verified candidates' quotes for the same company that are identity-compatible (see evidenceCompatible).
      const others = (l.dedup_key ? opts.quotes?.get(l.dedup_key) ?? [] : []).filter(q => evidenceCompatible(q.url, l.company, l.company_domain))
      const quotes: QuoteEvidence[] = [{ url: l.source_url, excerpt: l.evidence_excerpt ?? '', date: null }, ...others]
      // The EVENT half must stand on its own: the quote that shows the event agrees with the requested place, and (when it came from another candidate) carries its OWN date inside the window.
      // A current job in the right city never validates a funding quote from another place, and its date is never the funding event's date.
      // Under an OR the event branch alone can keep the lead, so the lead's own quote must carry its own date inside the event branch's clock too.
      const eventQuotes = quotes.filter((q, i) => eventQuoteUsable(q, i === 0 ? l.event_date : q.date, l.company, where, eventDays, now, i === 0 && !or))
      const demoteFor = (reason: string, why: string) => { if (demote.run(reason, (why + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++; demotions.push({ company: l.company, url: l.source_url, reason }) } }
      // The event half first: a hiring page alone (a job ad) does not show seed funding / an opening, whatever it says about the company.
      const eventShown = eventQuotes.some(q => quoteShowsEvent(q.excerpt, l.signal, fundingAsked, l.company, stage, places))
      if (or && eventShown) { passed++; passedIds.push(l.id); continue }   // the OR's event branch is proven: the hiring branch is not needed (no board lookup)
      // Under an OR, a hiring quote is proof only with its own date inside the hiring branch's clock (the lead's row date for its own quote).
      const hireQuotes = or ? quotes.filter((q, i) => { const dt = i === 0 ? l.event_date : q.date, t = dt ? Date.parse(dt) : NaN; return Number.isFinite(t) && t <= (now + 86_400) * 1000 && now * 1000 - t <= hireDays * 86_400_000 }) : quotes
      // Under an OR neither branch is proven when the lead is demoted below: the reason names both.
      const neither = or ? `Neither branch proven (the request accepts either): no source quote dated in the last ${eventDays} days affirms this company ${stage && fundingAsked ? `raised a ${stage} round` : 'had the event the request names'} (a different stage, a negated or planned raise, or another company's raise does not count), and no sales-hiring evidence. ` : ''
      if (!or && eventRequired && !eventShown) {
        demoteFor(NO_EVENT, stage && fundingAsked ? `No event evidence: no source quote affirms this company raised a ${stage} round (a different stage, a negated or planned raise, or another company's raise does not count). ` : `No event evidence: the source quote shows hiring but not the funding or event the request asks for. `)
        continue
      }
      // #876: the OR's hiring branch is a COMPLETED hire: only a dated quote saying the hire was made proves it. An open vacancy or job board never does,
      // so no board lookup is made for it.
      if (or?.hiring.kind === 'hire_made') {
        const rw = (or.hiring.role ?? '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 2 && !['of', 'the', 'and', 'for', 'an'].includes(w))
        if (hireQuotes.some(q => quoteShowsCompletedHire(q.excerpt, l.company, rw, !!or.hiring.first))) { passed++; passedIds.push(l.id); continue }
        demoteFor(NO_SALES_HIRING, `${neither}No completed-hire evidence: no dated source quote says this company made the hire (an open vacancy does not count). `)
        continue
      }
      if (!roles.length && hireQuotes.some(q => quoteNamesSalesHiring(q.excerpt, l.signal, l.company))) {
        const o = others.find(q => hireQuotes.includes(q) && quoteNamesSalesHiring(q.excerpt, l.signal, l.company))
        if (!quoteNamesSalesHiring(l.evidence_excerpt, l.signal, l.company) && o) {
          let host = ''; try { host = new URL(o.url).hostname.replace(/^www\./, '') } catch { /* keep blank */ }
          setWhy.run((`Hiring sales: named in a verified source${host ? ` (${host})` : ''}${o.date ? `, dated ${o.date}` : ''}. ${l.why ?? ''}`).trim().slice(0, WHY_MAX), l.id)
        }
        passed++; passedIds.push(l.id); continue
      }
      if (l.company_domain && lookups >= MAX_BOARD_LOOKUPS) {
        // A processing limit never lets a lead through unproven: it is held, and the card says it was not checked (unknown, not absent).
        demoteFor(NO_SALES_HIRING, `${neither}No sales-hiring evidence: not checked - this scan had more leads than the job-board lookup limit (${MAX_BOARD_LOOKUPS}). `)
        continue
      }
      if (l.company_domain) lookups++
      let boardFetchThrew = false
      const gbz = l.company_domain ? await atsGtmBoard(l.company, l.company_domain, fetchImpl, { windowDays: hireDays, now: (opts.now ?? Date.now()), ...(roles.length ? { roleMatch: (title: string) => !!matchedHiringRole(title, roles) } : {}) }).catch(() => { boardFetchThrew = true; return null }) : null
      if (l.company_domain && !owned()) { stopped = true; break } // reclaimed DURING this lead's async fetch: the resolved result is this attempt's observation but must not be WRITTEN by it - the new owner re-runs
      const g = gbz?.hiring ?? null
      // The board must be the lead's OWN: under a domain the cited page is hosted on (or the user confirmed). A board found through a domain matched only
      // by company name (a probe, a link label) could belong to a larger same-name company: its roles are not this lead's hiring.
      // The board is bound to the lead's domain when the cited page is hosted on it / the user confirmed it, or when the board's OWN postings name that same
      // domain (a company-site address or link inside the posting text).
      const heuristic = !!g && g.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(g.domain && l.company_domain && g.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
      // #533 check-history: ONE append-only row per lead per completed board check, inline in the live-fetch path (never from a
      // cached/replayed payload, so created_at is seconds after the real fetch and no replay can masquerade as a fresh check). Never
      // attempted (no domain, lookup cap, quote proof) = NO row. results is the exact pre-cap deduped listing count read from the
      // actual response; -1 when no count is honestly attributable (failure, unbound board, contradiction). A genuinely re-executed
      // fetch (new attempt, new scan) truthfully appends a second row; evidence rows stay immutable and are never rewritten.
      if (l.company_domain && gbz) {
        // Per-board truth: the SETTLED board gets the outcome row; EVERY probed-and-errored board gets its own
        // fetch_failed row (even when a later board settled - the failure is still a fact of this check); a board never
        // probed gets no row; 'no_board_found' is claimed only when every probe answered cleanly. results = the exact
        // pre-cap count of DEDUPED LISTED TITLES read from the actual response (identical titles collapse; it is not a
        // posting count), -1 when no count is honestly attributable to this lead (failure / unbound / rejected).
        const capped = (x: { listedCountAll: number; allListed: string[] }) => x.listedCountAll > x.allListed.length ? '_partial_capped' : ''
        let settled: { status: string; results: number; board: string } | null = null
        if (gbz.contradictory) settled = { status: 'checked_rejected', results: -1, board: g?.board ?? gbz.checked?.board ?? 'unknown' }
        else if (g) settled = g.via === 'domain' && !heuristic ? { status: `checked_bound${capped(g)}`, results: g.listedCountAll, board: g.board } : { status: 'checked_unbound', results: -1, board: g.board }
        else if (gbz.checked) {
          const cc = gbz.checked
          const heuristicC = cc.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(cc.domain && l.company_domain && cc.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
          settled = cc.via === 'domain' && !heuristicC ? { status: `checked_zero_match${capped(cc)}`, results: cc.listedCountAll, board: cc.board } : { status: 'checked_unbound', results: -1, board: cc.board }
        }
        if (settled) audit(db, { tenantId: job.user_id, connector: 'check:ats-board', jobId: job.id, lookup: `${l.id} (gate) ${settled.board}`.slice(0, 200), status: settled.status, results: settled.results })
        else if (gbz.probeErrors.length === 0 && !gbz.fetchAborted) audit(db, { tenantId: job.user_id, connector: 'check:ats-board', jobId: job.id, lookup: `${l.id} (gate)`.slice(0, 200), status: 'no_board_found', results: -1 })
        if (!gbz.fetchAborted) for (const b of gbz.probeErrors) if (b !== settled?.board) audit(db, { tenantId: job.user_id, connector: 'check:ats-board', jobId: job.id, lookup: `${l.id} (gate) ${b}`.slice(0, 200), status: 'fetch_failed', results: -1 }) // aborted mid-check: our own cancel is not a board failure; a COMPLETED check's row above still writes
      } else if (l.company_domain && boardFetchThrew) audit(db, { tenantId: job.user_id, connector: 'check:ats-board', jobId: job.id, lookup: `${l.id} (gate)`.slice(0, 200), status: 'fetch_failed', results: -1 })
      if (g && g.via === 'domain' && !heuristic) {
        const p = g.postings[0]
        const match = matchedHiringRole(p.title, roles)
        const line = roles.length ? `Hiring for ${p.title} (requested: ${match!.term}), posted ${p.date}. This may relate to your offer; buying need isn't verified. ` : `Hiring sales: ${p.title} posted ${p.date} on its ${BOARD_LABEL[g.board]} job board (${l.company_domain}). `
        setWhy.run((line + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
        { const dn = g.postings.length // dated postings actually READ; a '+' when the detail read itself was capped - never a masked total
          addEnrichment(db, job.user_id, l.id, { connector: `signals:${g.board}-gtm`, kind: 'hiring', value: `${dn}${g.datedCapped ? '+' : ''} sales/GTM role${dn === 1 && !g.datedCapped ? '' : 's'} posted, newest ${g.newest}`, label: (g.postings.map(x => x.title).slice(0, 3).join('; ') + ` (${Math.min(dn, 3)} of ${dn}${g.datedCapped ? '+' : ''} dated shown; ${g.listedCount} listed titles${g.listedCount > g.allTitles.length ? `, sample capped at ${g.allTitles.length}` : ''})`).slice(0, 200) || null, confidence: 70, source_url: g.url, source_date: g.newest, retrieved_at: now }) }
        const existingEvidence = db.prepare("SELECT kind, connector, value, source_date, retrieved_at, source_url FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(l.id) as import('../signals/ats-gtm.ts').ExistingEvidenceRow[]
        for (const e of withRepostHistory(postingEvidence(g, now, null), g.board, existingEvidence)) addEnrichment(db, job.user_id, l.id, { ...e, label: roles.length ? `Requested role: ${matchedHiringRole(e.value.split(' - posted ')[0], roles)!.term}; ${e.label}`.slice(0, 200) : e.label })
        { const checkedDay = new Date(now * 1000).toISOString().slice(0, 10)
          const auditRows = withRepostHistory(boardTitleAudit(g, now, checkedDay, null), g.board, existingEvidence)
          for (const e of auditRows) addEnrichment(db, job.user_id, l.id, e) // #533: board-title audit sample
          addEnrichment(db, job.user_id, l.id, boardCoverageRow(g, auditRows.length, Math.min(g.postings.length, 3), now, checkedDay)) }
        { const checkedDay2 = new Date(now * 1000).toISOString().slice(0, 10)
          const covered = new Set(g.allTitles.map(x => x.trim().toLowerCase())) // dated rows + filtered audit rows already cover the whole filtered sample
          const coveredCount = g.allListed.filter(t => covered.has(t.trim().toLowerCase())).length
          const full = withRepostHistory(fullListingAuditRows(g.board, g.boardUrl, g.allListed, covered, now, checkedDay2, null), g.board, existingEvidence)
          for (const e of full) addEnrichment(db, job.user_id, l.id, e) // #533 breadth: sampled titles in NEITHER dated nor filtered stores, so requested-role absence within the sample is auditable
          addEnrichment(db, job.user_id, l.id, fullListingCoverageRow(g.board, g.boardUrl, g.listedCountAll, g.allListed, coveredCount, full.length, now, checkedDay2)) }
        passed++; passedIds.push(l.id); continue
      }
      if (!g && gbz?.checked && !gbz.contradictory) {
        const c = gbz.checked
        const heuristicC = c.via === 'domain' && domainRelationship(db, job.user_id, l.id, l.company_domain) !== 'established' && !(c.domain && l.company_domain && c.domain.replace(/^www\./, '') === l.company_domain.replace(/^www\./, ''))
        if (c.via === 'domain' && !heuristicC) {
          const checkedDay = new Date(now * 1000).toISOString().slice(0, 10)
          const existingEvidence = db.prepare("SELECT kind, connector, value, source_date, retrieved_at, source_url FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(l.id) as import('../signals/ats-gtm.ts').ExistingEvidenceRow[]
          const checkedRows = withRepostHistory(checkedAuditRows(c, hireDays, now, checkedDay, null), c.board, existingEvidence)
          for (const e of checkedRows) addEnrichment(db, job.user_id, l.id, e) // #533 F-B: zero-match audit trail
          addEnrichment(db, job.user_id, l.id, checkedCoverageRow(c, hireDays, now, checkedDay))
          { const covered = new Set(checkedRows.map(r => r.value.replace(/^Unconfirmed: /, '').trim().toLowerCase())) // titles the zero-match audit just stored, actual inserted shapes
            const coveredCount = c.allListed.filter(t => covered.has(t.trim().toLowerCase())).length
            const full = withRepostHistory(fullListingAuditRows(c.board, c.boardUrl, c.allListed, covered, now, checkedDay, null), c.board, existingEvidence)
            for (const e of full) addEnrichment(db, job.user_id, l.id, e) // #533 breadth: sampled titles in NEITHER store - absence within the sample is auditable
            addEnrichment(db, job.user_id, l.id, fullListingCoverageRow(c.board, c.boardUrl, c.listedCountAll, c.allListed, coveredCount, full.length, now, checkedDay)) }
        }
      }
      // No usable job board: the company's OWN careers page (https, robots.txt obeyed, same domain) may list an open sales role. The domain must be established, or the careers
      // page itself must name the company and agree on the requested place (a same-name company elsewhere does not). Saved: URL, quote, retrieval time (not a posting date).
      let careersNote = ''
      if (l.company_domain && opts.careersGet) {
        const c = await careersSalesVacancy(l.company_domain, opts.careersGet, { now: opts.now, company: l.company, ...(roles.length ? { roleMatch: (title: string) => !!matchedHiringRole(title, roles) } : {}) }).catch(() => null)
        if (!owned()) { stopped = true; break } // reclaimed DURING the careers fetch: nothing the stale attempt resolved may be written (audit rows included)
        // #533 direct-career check-history: the same append-only discipline as the ATS board check. A clean absence answer
        // (page read, no open sales role / closed marker / no careers page) gets results 0; anything uncertain (fetch failed,
        // robots unreachable, unverified job, wrong domain, rejected) is -1 - never reported as 'none found'.
        if (c === null) audit(db, { tenantId: job.user_id, connector: 'check:careers-page', jobId: job.id, lookup: `${l.id} (gate) careers`.slice(0, 200), status: 'fetch_failed', results: -1 })
        else if (c.vacancy) {
          const v = c.vacancy
          const established = domainRelationship(db, job.user_id, l.id, l.company_domain) === 'established'
          const namesCompany = norm(v.pageText).includes(norm(l.company).replace(/\s/g, '')) || norm(v.pageText).replace(/\s/g, '').includes(norm(l.company).replace(/\s/g, ''))
          const place = whereOf(job.icp).length ? placeAgreement(v.pageText, whereOf(job.icp), l.company) : 'no_geography'
          if (established || (namesCompany && (place === 'agrees' || place === 'no_geography'))) {
            const day = new Date(v.retrievedAt * 1000).toISOString().slice(0, 10)
            const roleMatch = roles.length ? matchedHiringRole(v.title, roles) : null
            // #533 AC4: when the careers link IS a public ATS posting, its board-supplied first-published date is the freshness date (never
            // updated_at, never the retrieval day). Inside the window -> dated evidence; older -> long-open, repost history unknown, NOT current
            // hiring (the lead is held, as a stale board posting is). No date supplied -> unchanged: date unknown, the retrieval day is only 'checked'.
            const posted = v.posted ?? null
            const pt = posted ? Date.parse(`${posted}T00:00:00Z`) : NaN
            const longOpen = !!posted && !(Number.isFinite(pt) && pt <= (now + 86_400) * 1000 && now * 1000 - pt <= hireDays * 86_400_000)
            const dated = posted ? ` - posted ${posted}` : ''
            const dateLabel = posted ? `${BOARD_LABEL[v.postedBoard ?? 'greenhouse']} first-published date read from the linked posting; ` : ''
            const existingC = db.prepare("SELECT kind, connector, value, source_date, retrieved_at, source_url FROM lead_enrichments WHERE lead_id = ? AND kind IN ('hiring', 'hiring-role')").all(l.id) as import('../signals/ats-gtm.ts').ExistingEvidenceRow[]
            // a careers row whose posting id / URL is already stored from an ATS board (or vice versa) is labeled the same posting, counted once
            const careersRow = (kind: 'hiring' | 'hiring-role', value: string, label: string, confidence: number | null) => withRepostHistory([{ connector: 'signals:careers-gtm', kind, value: value.slice(0, 254), label: label.slice(0, 200), confidence, source_url: v.url, source_date: posted ?? day, retrieved_at: v.retrievedAt }], 'careers', existingC)[0]
            audit(db, { tenantId: job.user_id, connector: 'check:careers-page', jobId: job.id, lookup: `${l.id} (gate) careers`.slice(0, 200), status: `${roleMatch ? 'checked_vacancy_requested_role' : 'checked_vacancy'}${longOpen ? '_long_open' : ''}`, results: 1 })
            if (longOpen) {
              // Stored as an audit row (kind hiring-role, unscored), never as a hiring signal: a long-open posting is not renewed demand.
              addEnrichment(db, job.user_id, l.id, careersRow('hiring-role', `Open ${roleMatch || roles.length ? '' : 'sales '}role on its careers page: ${v.title}${dated}`, `Long-open: first published ${posted}, older than the last ${hireDays} days (repost history unknown, not renewed demand)${roleMatch ? `; requested role: ${roleMatch.term}` : ''}; ${v.quote}`, null))
              careersNote = `its careers page links ${v.title}${roleMatch ? ` (requested: ${roleMatch.term})` : ''}, but that ${BOARD_LABEL[v.postedBoard ?? 'greenhouse']} posting was first published ${posted}, older than the last ${hireDays} days (long-open; repost history unknown) - not current hiring evidence. `
            } else if (roleMatch) {
              setWhy.run((`Hiring for ${v.title} (requested: ${roleMatch.term}) on its careers page (${l.company_domain}), ${posted ? `posted ${posted}` : `checked ${day}`}. This may relate to your offer; buying need isn't verified. ` + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
              addEnrichment(db, job.user_id, l.id, careersRow('hiring', `Open role on its careers page: ${v.title}${dated}`, `Requested role: ${roleMatch.term}; ${dateLabel}${v.quote}`, 60))
              passed++; passedIds.push(l.id); continue
            } else if (!roles.length) {
              setWhy.run((`Hiring sales: ${v.title} listed on its careers page (${l.company_domain}), ${posted ? `posted ${posted}` : `checked ${day}`}. ` + (l.why ?? '')).trim().slice(0, WHY_MAX), l.id)
              addEnrichment(db, job.user_id, l.id, careersRow('hiring', `Open sales role on its careers page: ${v.title}${dated}`, `${dateLabel}${v.quote}`, 60))
              passed++; passedIds.push(l.id); continue
            } else {
              // AC3: requested roles were named and this verified vacancy matched none - generic careers hiring is recorded as
              // generic (never role-qualified) and the lead is still demoted below for the missing role match.
              addEnrichment(db, job.user_id, l.id, careersRow('hiring', `Open sales role on its careers page: ${v.title}${dated}`, `generic hiring - no requested-role match in the sampled roles; ${dateLabel}${v.quote}`, 60))
              careersNote = `its careers page lists ${v.title}, a sales/GTM role; no requested-role match among the sampled open roles (up to 3 verified per page across ${c.readPages ?? c.pages} page${(c.readPages ?? c.pages) === 1 ? '' : 's'} read - a match outside the sample is not excluded). `
            }
          } else {
            audit(db, { tenantId: job.user_id, connector: 'check:careers-page', jobId: job.id, lookup: `${l.id} (gate) careers`.slice(0, 200), status: 'checked_rejected', results: -1 })
            careersNote = `its careers page lists ${v.title} but the page is not established as this company's (${namesCompany ? 'place not confirmed' : 'company not named'}). `
          }
        } else {
          const clean = c.reason === 'no_open_sales_role' || c.reason === 'closed_marker' || c.reason === 'no_careers_page'
          audit(db, { tenantId: job.user_id, connector: 'check:careers-page', jobId: job.id, lookup: `${l.id} (gate) careers`.slice(0, 200), status: `checked_${c.reason}`.slice(0, 100), results: clean ? 0 : -1 })
          careersNote = `its careers page was checked: ${c.reason.replace(/_/g, ' ')}. `
        }
      }
      const line = heuristic
        ? `No sales-hiring evidence: a job board was found only through ${l.company_domain}, a domain matched by company name, so it is not established as this company's board. `
        : `No sales-hiring evidence: no ${roles.length ? `source-matched requested role (${roles.map(r => r.term).join(' or ')})` : 'sales or GTM posting'} dated in the last ${hireDays} days was found on a public job board tied to ${l.company_domain ?? 'a confirmed company domain (none found)'} (a board that could not be reached looks the same as none, so this is unconfirmed, not proof the company is not hiring). `
      // Under an OR a board that could not be read is said plainly: the hiring branch was not checked (held, never passed).
      const notChecked = or && !!l.company_domain && (boardFetchThrew || (!!gbz && !g && !gbz.checked && !gbz.contradictory && (gbz.probeErrors.length > 0 || gbz.fetchAborted)))
      demoteFor(NO_SALES_HIRING, neither + (notChecked ? `No sales-hiring evidence: not checked - the job-board lookup for ${l.company_domain} failed. ` : line) + careersNote)
    } catch (e) {
      // A required gate that errors on a lead is a FAIL, never a pass: the lead is held with the failure as its reason.
      if (demote.run(SALES_GATE_FAILED, `Sales-hiring check failed (${(e instanceof Error ? e.message : 'error').slice(0, 80)}): not verified. ${l.why ?? ''}`.trim().slice(0, WHY_MAX), l.id).changes) { counts.run(job.id); demoted++; demotions.push({ company: l.company, url: l.source_url, reason: SALES_GATE_FAILED }) }
    }
  }
  if (stopped) return { required: true, checked: passed + demoted, passed, demoted, demotions } // stale attempt: the new owner re-runs the whole gate; nothing more is written
  // The gate ran again and PASSED these leads: a failed-gate marker from an earlier run no longer holds them.
  releaseHeld(db, job.user_id, job.id, passedIds)
  // The DURABLE pass record. A lead the gate passed but whose record could not be written is held by default (held-state.ts), never assumed passed.
  for (const id of passedIds) {
    try { addEnrichment(db, job.user_id, id, { connector: 'scan:gate', kind: 'gate_passed', value: roles.length ? 'requested_role_v1' : 'sales_hiring', label: 'The required sales-hiring check passed', confidence: null, source_url: 'https://invalid.example/', source_date: new Date().toISOString().slice(0, 10), retrieved_at: Math.floor(Date.now() / 1000) }) } catch { /* no record: the lead stays held */ }
  }
  audit(db, { tenantId: job.user_id, connector: 'scan:sales-hiring-gate', jobId: job.id, lookup: `${leads.length} leads, window ${windowDays}d`.slice(0, 200), status: demoted ? 'demoted' : 'ok', results: passed })
  return { required: true, checked: leads.length, passed, demoted, demotions }
}

// The required gate itself failed (it threw before or between leads): every lead still verified is held. Never a pass. The held set is returned IN MEMORY whether or not the
// database write landed: "the row still says verified" is not proof the gate passed, so callers (the actionable classification, the run report) use this set, not the row.
export interface HeldLead { id: string; company: string; url: string; reason: string; written: boolean }
export function failClosedSalesHiring(db: Database.Database, job: JobLike, message: string): HeldLead[] {
  if (!salesHiringRequired(job.query, job.icp)) return []
  let rows: { id: string; company: string; source_url: string; why: string | null }[] = []
  try { rows = db.prepare("SELECT id, company, source_url, why FROM leads WHERE scan_job_id = ? AND review_reason IS NULL AND confidence IS NOT NULL AND human_confirmed_at IS NULL AND company <> ''").all(job.id) as typeof rows } catch { return [] }
  const out: HeldLead[] = []
  for (const l of rows) {
    let written = false
    try {
      const ch = db.prepare('UPDATE leads SET review_reason = ?, confidence = NULL, why = ? WHERE id = ? AND review_reason IS NULL').run(SALES_GATE_FAILED, `Sales-hiring check failed (${message.slice(0, 80)}): not verified. ${l.why ?? ''}`.trim().slice(0, WHY_MAX), l.id).changes
      if (ch) { db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?').run(job.id); written = true }
    } catch { /* the write was rejected: the lead is still held in memory */ }
    out.push({ id: l.id, company: l.company, url: l.source_url, reason: SALES_GATE_FAILED, written })
  }
  return out
}

// Persist the held state so every surface that reads the lead row agrees with the in-memory set. Two best-effort writes, each independent of the other:
//   - the marker beside the lead (read by listLeads / exportLeads, which then show the lead as held, not verified),
//   - the job's verified / needs-review counts, adjusted once per newly marked lead (campaign counts follow the same truth).
// A retry of the review write is also made. Returns how many leads were marked. Never throws.
export function persistHeldState(db: Database.Database, job: JobLike, held: HeldLead[], message: string): number {
  let marked = 0
  for (const h of held) {
    try {
      const ch = db.prepare("INSERT INTO lead_enrichments (id, lead_id, tenant_id, connector, kind, value, label, confidence, source_url, source_date, retrieved_at) VALUES (?, ?, ?, 'scan:gate', 'gate_failed', ?, ?, NULL, 'https://invalid.example/', ?, ?) ON CONFLICT (lead_id, connector, kind, value) DO NOTHING")
        .run(randomBytes(12).toString('hex'), h.id, job.user_id, SALES_GATE_FAILED, `Sales-hiring check failed: ${message}`.slice(0, 200), new Date().toISOString().slice(0, 10), Math.floor(Date.now() / 1000)).changes
      if (ch) {
        marked++
        if (!h.written) { try { db.prepare('UPDATE scan_jobs SET verified = MAX(COALESCE(verified, 0) - 1, 0), needs_review = COALESCE(needs_review, 0) + 1 WHERE id = ?').run(job.id) } catch { /* the count write was rejected too: the marker still holds */ } }
      }
    } catch { /* no marker: the in-memory set still holds this run's report, trace and classification */ }
  }
  return marked
}
