// Deterministic search queries for the hiring signal. No model call and no company list: a hiring request gets queries
// restricted to the public applicant-tracking hosts that serve open postings, with the role words and the place.
// Lever shares the second query: its public JSON carries createdAt, which the board adapter uses as the posting date.
//
// Requests are not only English (Instinct review: Portuguese and Hindi probes produced no direct queries). Hiring words,
// list separators and filler words below cover English, Portuguese, Spanish, French, German, Italian, Dutch and Hindi
// (Devanagari and romanized). Word boundaries are Unicode-aware: \b is ASCII-only, and Devanagari vowel signs are marks.
const L = '\\p{L}\\p{M}\\p{N}'
const word = (alts: string) => new RegExp(`(?<![${L}])(?:${alts})(?![${L}])`, 'iu')
export const HIRING = word([
  'hiring|hire[sd]?|jobs?|roles?|openings?|positions?|recruit\\p{L}*|vacanc\\p{L}+', // en
  'contrat(?:a|am|ar|ando|amos|ação|acao)|vagas?|recrutamento|recrutando|recrutar|empregos?|procura(?:m)?-se|procuramos|admite-se|admitimos', // pt
  'contratando|contratar|contratamos|contratan|contrata|contratas|contrataci[oó]n|vacantes?|empleos?|ofertas? de (?:trabajo|empleo)|busca[n]?|buscamos|reclutamiento|reclutando', // es
  'recrute(?:nt|r|ment)?|embauche(?:nt|r)?|offres? d.emploi|postes? à pourvoir', // fr
  'stellenangebote?|such(?:en|t)|jobangebote?|stellenausschreibung(?:en)?', // de
  'assum(?:e|iamo|ono)|cerchiamo|offerte di lavoro|posizioni aperte', // it
  'vacatures?|wij zoeken', // nl
  'भर्ती|नौकरी|नौकरियां|नौकरियाँ|रिक्ति|रिक्तियां|रिक्तियाँ|naukri|bharti', // hi
].join('|'))
const SEPARATOR = new RegExp(`,|;|/|(?<![${L}])(?:or|and|ou|o|y|e|et|oder|und|या|और)(?![${L}])`, 'u')
const NOISE = new Set([
  // en
  'find', 'finds', 'looking', 'look', 'for', 'with', 'that', 'the', 'and', 'who', 'from', 'have', 'has', 'their', 'they', 'are', 'was', 'were', 'recently', 'recent', 'just', 'newly', 'new', 'posted', 'post', 'posts', 'posting', 'postings', 'companies', 'company', 'people', 'person', 'employees', 'employee', 'staff', 'hiring', 'hire', 'hired', 'hires', 'job', 'jobs', 'role', 'roles', 'open', 'opening', 'openings', 'position', 'positions', 'team', 'remote', 'small', 'mid', 'size', 'sized', 'business', 'businesses', 'smbs', 'smb', 'any', 'all', 'some', 'near', 'based', 'into', 'about', 'also', 'more', 'than', 'least', 'between', 'over', 'under', 'this', 'last', 'week', 'weeks', 'month', 'months', 'days', 'day', 'year', 'years', 'signal', 'signals', 'buying', 'intent', 'one', 'two', 'three', 'ten', 'hundred', 'to', 'or', 'a', 'an', 'of', 'in', 'at', 'on', 'is', 'be', 'by', 'as', 'it', 'its', 'we', 'us', 'our', 'up', 'do', 'if', 'no', 'not',
  // pt
  'empresas', 'empresa', 'em', 'na', 'nas', 'nos', 'um', 'uma', 'para', 'com', 'que', 'contratar', 'contrata', 'contratam', 'contratando', 'contratamos', 'recrutando', 'recrutar', 'recrutamento', 'vaga', 'vagas', 'emprego', 'empregos', 'procura', 'procuram', 'novo', 'nova', 'pequenas', 'médias',
  // es
  'contratan', 'contratas', 'contratación', 'contratacion', 'contrata', 'contratamos', 'contratando',
  'en', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'con', 'busca', 'buscan', 'buscamos', 'vacante', 'vacantes', 'empleo', 'empleos', 'reclutando', 'reclutamiento', 'nuevo', 'nueva',
  // fr
  'entreprises', 'entreprise', 'le', 'les', 'une', 'pour', 'avec', 'qui', 'recrute', 'recrutent', 'recruter', 'recrutement', 'embauche', 'embauchent', 'poste', 'postes', 'offre', 'offres', 'emploi', 'nouveau', 'nouvelle',
  // de
  'unternehmen', 'firmen', 'im', 'mit', 'die', 'der', 'das', 'ein', 'eine', 'einen', 'einer', 'einem', 'suchen', 'sucht', 'stellen', 'stellenangebot', 'stellenangebote', 'neue', 'neuen',
  // it / nl
  'aziende', 'azienda', 'cerca', 'cerchiamo', 'assume', 'assumono', 'bedrijven', 'vacature', 'vacatures', 'zoeken',
  // hi (Devanagari and romanized)
  'में', 'के', 'की', 'का', 'लिए', 'भर्ती', 'नौकरी', 'नौकरियां', 'कंपनियां', 'कंपनी', 'रिक्ति', 'naukri', 'bharti', 'ke', 'ki', 'liye', 'mein',
])
const ONE_HOSTS = ['(site:boards.greenhouse.io OR site:job-boards.greenhouse.io)', '(site:jobs.ashbyhq.com OR site:jobs.lever.co)']
const tokens = (text: string) => text.toLowerCase().split(new RegExp(`[^${L}+#&]+`, 'u')).filter(Boolean)
// Role PHRASES, not loose words. "a payroll, HR or office manager job" used to become (payroll OR hr OR office OR manager),
// and the lone word "manager" matched every manager posting in the state. The request is split at list separators
// (comma, slash, or/and in the languages above); in each part the last run of kept words is one phrase ("office manager"),
// with "of"/"de"/"für"-style joiners allowed inside a run ("head of sales", "gerente de vendas"). Phrases are quoted so
// the search matches them exactly. The request's own words are used first; profile signals only when the request names
// no role. At most 3 phrases.
const JOINERS = new Set(['of', 'for', '&', 'de', 'da', 'do', 'del', 'des', 'du', 'di', 'von', 'für'])
// A part of the request about a FUNDING event is a different signal, not a role: ("raised seed funding" OR "sales") on a
// job board matches no posting. Funding words are cut from role extraction unless the same part also talks about hiring.
const FUNDING = word('rais(?:e|ed|es|ing)|fund(?:ing|ed|s)?|seed|series [a-e]|rounds?|invest(?:ed|ment|ments|ors?)|venture|valuation|financiamento|investimento|financiación|inversión|levée|finanzierung|finanziamento')
function phrasesIn(text: string, places: Set<string>): string[] {
  const out: string[] = []
  for (const part of text.toLowerCase().split(SEPARATOR)) {
    if (!part) continue
    if (FUNDING.test(part) && !HIRING.test(part)) continue
    let run: string[] = []; let last: string[] = []
    for (const w of tokens(part)) {
      const keep = [...w].length >= 2 && !/^\d+$/.test(w) && !NOISE.has(w) && !places.has(w) && !JOINERS.has(w)
      if (keep) run.push(w)
      else if (run.length && JOINERS.has(w)) run.push(w)
      else { while (run.length && JOINERS.has(run[run.length - 1])) run.pop(); if (run.length) last = run; run = [] }
    }
    while (run.length && JOINERS.has(run[run.length - 1])) run.pop()
    if (run.length) last = run
    if (last.length) out.push(last.slice(-3).join(' '))
  }
  return out
}
// Instruction clauses are not roles. Live acceptance run (2026-10-26, #204): requests that also said what to leave out or
// what the user needs ("exclude chains", "I need founder contacts and dated evidence", "in the past 90 days") produced
// role groups such as ("past" OR "exclude agencies" OR "need founder contacts") for the applicant-tracking hosts, a query
// no posting can match. Before phrases are extracted, exclusion/requirement clauses and the time window are cut from the
// request text. This only removes words from role extraction; it never adds a role, a host or a place, so the search
// cannot become broader, and the exclusion and window still reach the profile, the search window and the gates.
// Two kinds of cue. EXCLUSION cues always start an ancillary clause. REQUIREMENT cues (need/want/must/...) are ambiguous:
// "I need founder contacts and dated evidence" is ancillary, but "I need companies hiring a receptionist in London" is the
// lead request itself (Instinct review of #215). A requirement clause that still talks about hiring keeps its text and
// loses only the cue words; one that does not is cut as before.
const EXCL = '(?:exclud\\p{L}*|except(?:ing)?|without|skip|avoid|ignore|ignoring|only if|' +
  'exclu\\p{L}*|excluindo|sem|excluir|excluyendo|sin|exclure|excluant|sans|ausschlie\\p{L}*|ohne|escludere|senza|uitsluiten|zonder)'
const REQ = '(?:need|needs|needed|require[sd]?|requiring|must|ensure|make sure|want|wants|please|i.d like|we.d like|' +
  'preciso|precisamos|necessito|necesito|necesitamos|besoin|brauche|benötige|ho bisogno|ik heb nodig)'
const lead = `(?:(?:i|we|please|por favor|s'il vous plaît)\\s+)?`
const EXCL_CLAUSE = new RegExp(`(?<![${L}])${lead}${EXCL}(?![${L}])[^.;!?\\n]*`, 'giu')
const REQ_CLAUSE = new RegExp(`(?<![${L}])${lead}${REQ}(?![${L}])([^.;!?\\n]*)`, 'giu')
const WINDOW_CLAUSE = new RegExp(`(?<![${L}])(?:in|within|over|during|from|nos?|em|dans|innerhalb|binnen)?\\s*(?:the\\s+)?(?:past|last|ultimos?|últimos?|derniers?|letzten?|laatste)\\s+\\d+\\s*\\p{L}+|(?<![${L}])within\\s+\\d+\\s*\\p{L}+`, 'giu')
// A NEGATED hiring clause ("companies in Madrid that do NOT hire a receptionist", "no contratan recepcionista") asks for the
// opposite of an open posting. Before this cut, recognising a hiring word turned it into affirmative job-board searches for
// the very role the user wants excluded (Instinct review of #220: HOLD). The negation cue, up to one filler word, the hiring
// word and the rest of that comma/sentence clause are removed, so no role from it is searched and a request whose only hiring
// words are negated gets no direct queries at all (the model-written queries and the exclusion gates still see the request).
// Like the other cuts this only removes words; it never adds a role, host or place.
const NEG = `(?:no|not|never|nunca|ne|n[ãa]o|nicht|pas|niet|non|\\p{L}*n['’]t)`
// The negated clause also ends before a conjunction that opens a NEW hiring clause ("no contratan recepcionista y contratan
// gerente", "don't hire a receptionist and hire a manager"): Instinct's re-review of #220 found the tail swallowed the positive
// clause joined by "y"/"and". A conjunction before a plain role ("no contratan recepcionista y cocinero") does not end it.
const CONJ = '(?:y|e|and|but|pero|mas|mas|et|mais|und|aber|en|maar|e|ma|e|&)'
const NEG_TAIL = `(?:(?!\\s+${CONJ}\\s+(?:\\p{L}+\\s+){0,2}(?:${HIRING.source})(?![${L}]))[^.;,!?\\n])*`
const NEG_CLAUSE = new RegExp(`(?<![${L}])${NEG}(?![${L}])\\s+(?:\\p{L}+\\s+)?(?:${HIRING.source})${NEG_TAIL}`, 'giu')
// A short negated exclusion after a comma ("hiring a receptionist, no agencias") excludes that group; left in place its words
// became an extra OR role (Instinct re-review of #220 at b39395a). Only a bare cue right after a comma, to the end of the clause.
const NEG_NOUN = new RegExp(`,\\s*${NEG}(?![${L}])\\s+[^.;,!?\\n]*`, 'giu')
export const stripNegatedHiring = (text: string): string => text.replace(NEG_CLAUSE, ' . ').replace(NEG_NOUN, ' . ')
export function roleRequestText(request: string): string {
  return stripNegatedHiring(request).replace(EXCL_CLAUSE, ' . ')
    .replace(REQ_CLAUSE, (_m, rest: string) => HIRING.test(rest) ? ` ${rest} ` : ' . ')
    .replace(WINDOW_CLAUSE, ' ').replace(/\s+/g, ' ').trim()
}
export function rolePhrases(request: string, signals: string[], where: string[]): string[] {
  const places = new Set(where.flatMap(tokens))
  const fromRequest = phrasesIn(roleRequestText(request), places)
  const all = fromRequest.length ? fromRequest : signals.flatMap(s => phrasesIn(stripNegatedHiring(s), places))
  return [...new Set(all)].slice(0, 3)
}
// Every requested place gets its own pair of queries (Instinct review: only the first place was used). At most 3
// places, so at most 6 direct queries; the runner leaves the rest of the search budget to the model's queries.
// Order is HOST-major (every place on the first host, then every place on the second) so a truncated budget slice keeps
// one direct query per place before a second host for any place (Instinct review of #215).
export function directQueries(request: string, signals: string[], where: string[]): string[] {
  if (!HIRING.test(stripNegatedHiring(`${request} ${signals.map(stripNegatedHiring).join(' ')}`))) return []
  const places = [...new Set(where.map(w => w.replace(/[\u0000-\u001f"()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(w => w.length >= 2 && w.length <= 60))].slice(0, 3)
  const roles = rolePhrases(request, signals, where).map(r => `"${r}"`)
  if (places.length === 0 || roles.length === 0) return [] // never every state, never every role
  const group = roles.length === 1 ? roles[0] : `(${roles.join(' OR ')})`
  return ONE_HOSTS.flatMap(h => places.map(place => `${h} ${group} ${place}`))
}
